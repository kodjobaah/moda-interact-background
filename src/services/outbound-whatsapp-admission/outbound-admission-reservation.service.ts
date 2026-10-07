import { MessageStatus, Prisma, UsageMetric } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../../lib/db.js";
import { EffectiveBillingPolicyResolver } from "../effective-billing-policy.service.js";
import type { BillingPolicyClient } from "../effective-billing-policy.service.js";
import { PostContractRecoveryPolicyResolver } from "../post-contract-recovery-policy.service.js";
import { OutboundAdmissionPolicyService } from "./outbound-admission-policy.service.js";
import { TERMINAL_MESSAGE } from "./outbound-message-delivery.service.js";
import type {
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
    if (!usage?.sourceId) return null;
    return this.database.conversationMessage.findUnique({
      where: { id: usage.sourceId },
      select: { id: true, conversationId: true, status: true, sentAt: true },
    });
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
