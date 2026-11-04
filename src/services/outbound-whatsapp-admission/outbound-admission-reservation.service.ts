import { MessageStatus, Prisma, UsageMetric } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../../lib/db.js";
import { EffectiveBillingPolicyResolver } from "../effective-billing-policy.service.js";
import type { BillingPolicyClient } from "../effective-billing-policy.service.js";
import { PostContractRecoveryPolicyResolver } from "../post-contract-recovery-policy.service.js";
import { OutboundAdmissionPolicyService } from "./outbound-admission-policy.service.js";
import { TERMINAL_MESSAGE } from "./outbound-message-delivery.service.js";
import { failedRecipientOutreach } from "./failed-outreach-admission.js";
import type {
  InitialOutreachAdmissionLookup,
  InitialOutreachAdmissionScope,
  OutboundAdmissionInput,
  OutboundAdmissionResult,
} from "./outbound-whatsapp-admission.types.js";

const MAX_TRANSACTION_RETRIES = 3;
const PENDING_CONTENT = "[Pending automated WhatsApp message]";

type AdmissionDatabase = Pick<
  PrismaClient,
  | "$transaction"
  | "conversation"
  | "conversationMessage"
  | "usageEvent"
  | "usageReservation"
  | "recoveryOutreachAttempt"
>;
type PolicyResolverFactory = (
  client: BillingPolicyClient,
) => Pick<EffectiveBillingPolicyResolver, "resolve">;
type PostContractPolicyResolverFactory = (
  client: Prisma.TransactionClient,
) => Pick<PostContractRecoveryPolicyResolver, "resolve">;
type Transaction = Prisma.TransactionClient;

export class OutboundAdmissionReservationService {
  private readonly policy: OutboundAdmissionPolicyService;

  constructor(
    private readonly database: AdmissionDatabase = prisma,
    createPolicyResolver: PolicyResolverFactory = (client) =>
      new EffectiveBillingPolicyResolver(client),
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
    createPostContractPolicyResolver: PostContractPolicyResolverFactory =
      (client) => new PostContractRecoveryPolicyResolver(client),
  ) {
    this.policy = new OutboundAdmissionPolicyService(
      createPolicyResolver,
      createPostContractPolicyResolver,
    );
  }

  async findExistingAdmission(idempotencyKey: string) {
    const usage = await this.database.usageEvent.findUnique({
      where: { idempotencyKey },
      select: { sourceId: true },
    });
    if (!usage?.sourceId) {
      const historical = await failedRecipientOutreach(this.database, idempotencyKey);
      return historical?.message ?? null;
    }
    return this.database.conversationMessage.findUnique({
      where: { id: usage.sourceId },
      select: { id: true, conversationId: true, status: true, sentAt: true, providerFailureCode: true },
    });
  }

  async inspectInitialOutreachAdmission(
    scope: InitialOutreachAdmissionScope,
  ): Promise<InitialOutreachAdmissionLookup> {
    const conflict = { kind: "held", reason: "lineage-conflict" } as const;
    const unknown = { kind: "held", reason: "provider-outcome-unknown" } as const;
    if (!scope.shopId || !scope.recoveryId || !/^[A-Za-z0-9_-]+$/.test(scope.outreachAttemptId))
      return conflict;
    return this.database.$transaction(async (tx) => {
      const attempt = await tx.recoveryOutreachAttempt.findUnique({
        where: { id: scope.outreachAttemptId },
        include: { checkoutRecovery: { select: { shopId: true, status: true } } },
      });
      if (!attempt || attempt.sequence !== 1 || attempt.trigger !== "INITIAL" ||
          attempt.checkoutRecoveryId !== scope.recoveryId ||
          attempt.checkoutRecovery.shopId !== scope.shopId || !attempt.recipient)
        return conflict;

      const usage = await tx.usageEvent.findUnique({
        where: { idempotencyKey: `recovery-outreach:${scope.outreachAttemptId}` },
      });
      if (usage && (!usage.sourceId || usage.shopId !== scope.shopId ||
          usage.metric !== UsageMetric.OUTBOUND_AUTOMATED_MESSAGE ||
          usage.sourceType !== "OUTBOUND_AUTOMATED_MESSAGE" || Number(usage.quantity) !== 1 ||
          (attempt.outboundMessageId && attempt.outboundMessageId !== usage.sourceId)))
        return conflict;
      const conversation = await tx.conversation.findUnique({
        where: { checkoutRecoveryId: scope.recoveryId },
        select: { id: true, type: true, shopId: true },
      });
      if (!conversation || conversation.type !== "RECOVERY" ||
          (conversation.shopId !== null && conversation.shopId !== scope.shopId))
        return conflict;

      const eligible = (attempt.status === "PENDING" || attempt.status === "CAPACITY_BLOCKED") &&
        attempt.checkoutRecovery.status === "DETECTED" && !attempt.sentAt &&
        !attempt.outboundMessageId && !attempt.followUpDueAt && !attempt.closedAt;
      const messageId = usage?.sourceId ?? attempt.outboundMessageId;
      if (!messageId) {
        if (!eligible) return conflict;
        const orphan = await tx.conversationMessage.findFirst({
          where: { conversationId: conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
            recoveryOutreachAttempt: null },
          select: { id: true },
        });
        return orphan ? conflict : { kind: "absent" };
      }
      const row = await tx.conversationMessage.findUnique({
        where: { id: messageId },
        include: {
          merchantSendCommand: { select: { id: true } },
          recoveryOutreachAttempt: { select: { id: true } },
        },
      });
      if (!row || row.conversationId !== conversation.id || row.direction !== "OUTBOUND" ||
          row.senderType !== "AUTOMATION" || row.merchantSendCommand ||
          (row.recoveryOutreachAttempt && row.recoveryOutreachAttempt.id !== attempt.id))
        return conflict;

      const message = {
        id: row.id, conversationId: row.conversationId, status: row.status,
        providerMessageId: row.providerMessageId, sentAt: row.sentAt,
        deliveredAt: row.deliveredAt, readAt: row.readAt, failedAt: row.failedAt,
        providerDispatchKey: row.providerDispatchKey,
        providerDispatchAdmittedAt: row.providerDispatchAdmittedAt,
        providerDispatchControlRevision: row.providerDispatchControlRevision,
        providerFailureCode: row.providerFailureCode,
      };
      const noPermit = row.providerDispatchKey === null && row.providerDispatchAdmittedAt === null &&
        row.providerDispatchControlRevision === null;
      const fullPermit = row.providerDispatchKey !== null && row.providerDispatchAdmittedAt !== null &&
        row.providerDispatchControlRevision !== null;
      const noReceipt = !row.providerMessageId && !row.sentAt && !row.deliveredAt && !row.readAt && !row.failedAt;
      if (row.status === "PENDING") {
        if (!noPermit || !noReceipt || row.providerFailureCode) return unknown;
        return eligible && usage ? { kind: "prepared", message } : conflict;
      }
      if (attempt.sentAt && (!row.sentAt || attempt.sentAt.getTime() !== row.sentAt.getTime()))
        return conflict;
      if (row.sentAt && row.providerMessageId && !row.failedAt && !row.providerFailureCode &&
          (noPermit || fullPermit) &&
          (row.status === "SENT" || (row.status === "DELIVERED" && row.deliveredAt) ||
            (row.status === "READ" && row.readAt))) {
        return { kind: "confirmed", message: { ...message, sentAt: row.sentAt } };
      }
      if (row.status === "FAILED" && !row.sentAt && !row.deliveredAt && !row.readAt) {
        if (noPermit && noReceipt && !row.providerFailureCode &&
            (usage || attempt.failureCode === "PRE_PROVIDER_REFUSED"))
          return { kind: "failed", message, disposition: "pre-permit-refused" };
        if (fullPermit && !row.providerMessageId && row.failedAt &&
            (row.providerFailureCode || attempt.failureCode === "PROVIDER_REJECTED"))
          return { kind: "failed", message, disposition: row.providerFailureCode === "131026"
            ? "recipient-unreachable" : "provider-rejected" };
      }
      return unknown;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async reserve(input: OutboundAdmissionInput): Promise<OutboundAdmissionResult> {
    validateInput(input);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.reserveInTransaction(transaction, input),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  private async reserveInTransaction(
    transaction: Transaction,
    input: OutboundAdmissionInput,
  ): Promise<OutboundAdmissionResult> {
    const existing = await transaction.usageEvent.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { sourceId: true },
    });
    if (existing) return { kind: "suppressed", reason: "duplicate" };
    const historical = await failedRecipientOutreach(transaction, input.idempotencyKey);
    if (historical?.shopId === input.shopId &&
        historical.message.conversationId === input.conversationId) {
      return { kind: "suppressed", reason: "duplicate" };
    }

    const conversation = await transaction.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        shopId: true,
        checkoutRecovery: { select: { shopId: true, status: true } },
      },
    });
    const conversationShopId =
      conversation?.shopId ?? conversation?.checkoutRecovery?.shopId;
    if (!conversation || conversationShopId !== input.shopId) {
      return { kind: "suppressed", reason: "conversation-invalid" };
    }

    if (input.initialOutreach) {
      const scope = input.initialOutreach;
      if (input.senderType !== "AUTOMATION" || scope.shopId !== input.shopId ||
          input.idempotencyKey !== `recovery-outreach:${scope.outreachAttemptId}` ||
          !input.recoveryCreditSourceKey)
        return { kind: "suppressed", reason: "conversation-invalid" };
      const attempt = await transaction.recoveryOutreachAttempt.findFirst({
        where: { id: scope.outreachAttemptId, checkoutRecoveryId: scope.recoveryId,
          sequence: 1, trigger: "INITIAL", status: { in: ["PENDING", "CAPACITY_BLOCKED"] },
          outboundMessageId: null, sentAt: null, followUpDueAt: null, closedAt: null,
          checkoutRecovery: { shopId: input.shopId, status: "DETECTED",
            conversation: { id: input.conversationId } } },
        select: { id: true },
      });
      if (!attempt) return { kind: "suppressed", reason: "conversation-invalid" };
    }

    const resolved = await this.policy.resolve(transaction, input, conversation);
    if (resolved.kind === "suppressed") return resolved;
    const { policy, executionScope } = resolved;

    if (policy.automatedWhatsappPaused) {
      return { kind: "suppressed", reason: "paused" };
    }

    const outboundMessages = await transaction.conversationMessage.findMany({
      where: {
        conversationId: input.conversationId,
        direction: "OUTBOUND",
        senderType: { in: ["AGENT", "AUTOMATION"] },
      },
      select: { id: true },
    });
    const counts = outboundMessages.length
      ? await transaction.usageEvent.groupBy({
          by: ["sourceType"],
          where: {
            shopId: input.shopId,
            metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE,
            sourceId: { in: outboundMessages.map((message) => message.id) },
          },
          _sum: { quantity: true },
        })
      : [];
    const total = quantityFor(counts, "OUTBOUND_AUTOMATED_MESSAGE");
    const terminal = quantityFor(counts, "OUTBOUND_AUTOMATED_TERMINAL") > 0;
    const normalLimit =
      policy.outboundHardLimit - policy.terminalMessageReservedSlots;
    let isTerminal = false;
    if (total >= normalLimit) {
      if (input.initialOutreach) return { kind: "suppressed", reason: "normal-cap-reached" };
      if (terminal) {
        return { kind: "suppressed", reason: "terminal-already-used" };
      }
      isTerminal = true;
    }

    const message = await transaction.conversationMessage.create({
      data: {
        conversationId: input.conversationId,
        direction: "OUTBOUND",
        senderType: input.senderType,
        status: MessageStatus.PENDING,
        content: isTerminal ? TERMINAL_MESSAGE : input.content ?? PENDING_CONTENT,
      },
      select: { id: true },
    });
    await transaction.usageEvent.create({
      data: {
        shopId: input.shopId,
        metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE,
        quantity: 1,
        idempotencyKey: input.idempotencyKey,
        sourceType: isTerminal
          ? "OUTBOUND_AUTOMATED_TERMINAL"
          : "OUTBOUND_AUTOMATED_MESSAGE",
        sourceId: message.id,
        billingPeriodId: policy.billingPeriod?.id ?? null,
      },
    });

    return {
      kind: "admitted",
      shopId: input.shopId,
      messageId: message.id,
      conversationId: input.conversationId,
      terminal: isTerminal,
      executionScope,
    };
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (
          !isSerializationConflict(error) ||
          attempt === this.maxRetries - 1
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

function quantityFor(
  rows: Array<{
    sourceType: string | null;
    _sum: { quantity: Prisma.Decimal | null };
  }>,
  sourceType: string,
): number {
  const row = rows.find((candidate) => candidate.sourceType === sourceType);
  return row?._sum.quantity ? Number(row._sum.quantity) : 0;
}

function validateInput(input: OutboundAdmissionInput): void {
  if (
    !input.shopId.trim() ||
    !input.conversationId.trim() ||
    !input.idempotencyKey.trim()
  ) {
    throw new Error(
      "Outbound WhatsApp admission requires shopId, conversationId and idempotencyKey",
    );
  }
}

function isSerializationConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
  );
}
