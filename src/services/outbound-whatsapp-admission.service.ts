import {
  CheckoutRecoveryStatus,
  MessageStatus,
  Prisma,
  UsageMetric,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  EffectiveBillingPolicyResolver,
  EffectiveBillingPolicyError,
  effectiveBillingPolicyResolver,
} from "./effective-billing-policy.service.js";
import type {
  BillingPolicyClient,
  EffectiveBillingPolicy,
} from "./effective-billing-policy.service.js";
import {
  PostContractRecoveryPolicyError,
  PostContractRecoveryPolicyResolver,
  type PostContractRecoveryPolicy,
} from "./post-contract-recovery-policy.service.js";
import { shopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";
import type { ShopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";
import { whatsAppService } from "./whatsapp.service.js";
import type { SendTemplateInput, SendTextInput } from "../integration/whatsapp/types.js";
import {
  OutboundMessageDeliveryService,
  TERMINAL_MESSAGE,
} from "./outbound-whatsapp-admission/outbound-message-delivery.service.js";
import type {
  OutboundAdmissionInput,
  OutboundAdmissionResult,
} from "./outbound-whatsapp-admission/outbound-whatsapp-admission.types.js";
export type {
  OutboundAdmissionInput,
  OutboundAdmissionResult,
  OutboundSuppressionReason,
} from "./outbound-whatsapp-admission/outbound-whatsapp-admission.types.js";

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
type Transaction = Prisma.TransactionClient;
type OutboundPolicy = EffectiveBillingPolicy | PostContractRecoveryPolicy;

export class OutboundWhatsAppAdmissionService {
  private readonly delivery: OutboundMessageDeliveryService;

  constructor(
    private readonly database: AdmissionDatabase = prisma,
    private readonly createPolicyResolver: PolicyResolverFactory = (client) =>
      new EffectiveBillingPolicyResolver(client),
    provider = whatsAppService,
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
    executionEligibility: Pick<ShopExecutionEligibilityService, "evaluate"> =
      shopExecutionEligibilityService,
    private readonly createPostContractPolicyResolver = (client: Prisma.TransactionClient) =>
      new PostContractRecoveryPolicyResolver(client),
  ) {
    this.delivery = new OutboundMessageDeliveryService(
      database,
      provider,
      executionEligibility,
    );
  }

  getProviderAccountId(): string {
    return this.delivery.getProviderAccountId();
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

  async reserve(
    input: OutboundAdmissionInput,
  ): Promise<OutboundAdmissionResult> {
    validateInput(input);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.reserveInTransaction(transaction, input),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async sendText(
    input: OutboundAdmissionInput & Omit<SendTextInput, "to"> & { to: string },
  ): Promise<OutboundAdmissionResult> {
    const admission = await this.reserve({ ...input, content: input.text });
    if (admission.kind !== "admitted") return admission;

    return this.sendPreparedText({
      ...admission,
      to: input.to,
      text: admission.terminal ? TERMINAL_MESSAGE : input.text,
      ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
      ...(input.replyToProviderMessageId
        ? { replyToProviderMessageId: input.replyToProviderMessageId }
        : {}),
    });
  }

  async sendTemplate(
    input: OutboundAdmissionInput &
      Omit<SendTemplateInput, "to"> & { to: string },
  ): Promise<OutboundAdmissionResult> {
    const admission = await this.reserve(input);
    if (admission.kind !== "admitted") return admission;

    return this.delivery.sendPreparedTemplate(admission, input);
  }

  async sendPreparedText(
    input: Extract<OutboundAdmissionResult, { kind: "admitted" }> & {
      to: string;
      text: string;
      previewUrl?: boolean;
      replyToProviderMessageId?: string;
    },
  ): Promise<OutboundAdmissionResult> {
    return this.delivery.sendPreparedText(input);
  }

  async failPrepared(messageId: string): Promise<void> {
    await this.delivery.failPrepared(messageId);
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

    let policy: OutboundPolicy;
    let executionScope: "general" | "recovery" = "general";
    try {
      policy = await this.createPolicyResolver(transaction).resolve(input.shopId);
    } catch (error) {
      if (
        error instanceof EffectiveBillingPolicyError &&
        error.reason === "NO_CONTRACT"
      ) {
        const continuingRecovery =
          conversation.checkoutRecovery !== null &&
          isContinuingRecoveryStatus(conversation.checkoutRecovery.status);
        const hasDurableReservation =
          input.recoveryCreditSourceKey !== undefined &&
          (await hasDurableRecoveryReservation(
            transaction,
            input.shopId,
            input.recoveryCreditSourceKey,
          ));
        if (
          !conversation.checkoutRecovery ||
          (!continuingRecovery && !hasDurableReservation)
        ) {
          return { kind: "suppressed", reason: "contract-required" };
        }
        try {
          policy = await this.createPostContractPolicyResolver(
            transaction,
          ).resolve(input.shopId);
          executionScope = "recovery";
        } catch (postContractError) {
          if (
            postContractError instanceof PostContractRecoveryPolicyError &&
            (postContractError.reason === "CONTRACT_REQUIRED" ||
              postContractError.reason === "SHOP_UNAVAILABLE")
          ) {
            return { kind: "suppressed", reason: "contract-required" };
          }
          throw postContractError;
        }
      } else if (
        error instanceof EffectiveBillingPolicyError &&
        error.reason === "SUBSCRIPTION_FROZEN"
      ) {
        return { kind: "suppressed", reason: "subscription-frozen" };
      } else {
        throw error;
      }
    }
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
    const normalLimit = policy.outboundHardLimit - policy.terminalMessageReservedSlots;
    let isTerminal = false;
    if (total >= normalLimit) {
      if (terminal) return { kind: "suppressed", reason: "terminal-already-used" };
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
        if (!isSerializationConflict(error) || attempt === this.maxRetries - 1) throw error;
      }
    }
    throw lastError;
  }
}

function isContinuingRecoveryStatus(status: CheckoutRecoveryStatus): boolean {
  return (
    status === CheckoutRecoveryStatus.MESSAGE_SENT ||
    status === CheckoutRecoveryStatus.ENGAGED
  );
}

async function hasDurableRecoveryReservation(
  transaction: Transaction,
  shopId: string,
  sourceKey: string,
): Promise<boolean> {
  const reservation = await transaction.usageReservation.findUnique({
    where: { sourceKey },
    select: {
      shopId: true,
      status: true,
      counter: { select: { counter: true } },
    },
  });
  return (
    reservation?.shopId === shopId &&
    reservation.status === UsageReservationStatus.RESERVED &&
    (reservation.counter?.counter === "PURCHASED_RECOVERY_CREDITS" ||
      reservation.counter?.counter === "LIFETIME_FREE_RECOVERY_CREDITS")
  );
}

function quantityFor(
  rows: Array<{ sourceType: string | null; _sum: { quantity: Prisma.Decimal | null }}>,
  sourceType: string,
): number {
  const row = rows.find((candidate) => candidate.sourceType === sourceType);
  return row?._sum.quantity ? Number(row._sum.quantity) : 0;
}

function validateInput(input: OutboundAdmissionInput): void {
  if (!input.shopId.trim() || !input.conversationId.trim() || !input.idempotencyKey.trim()) {
    throw new Error(
      "Outbound WhatsApp admission requires shopId, conversationId and idempotencyKey",
    );
  }
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export const outboundWhatsAppAdmissionService =
  new OutboundWhatsAppAdmissionService();

export async function runCommerceAgentAfterAdmission<TContext, TResult>({
  admission,
  to,
  context,
  runAgent,
  sendPreparedText,
  failPrepared,
}: {
  admission: Extract<OutboundAdmissionResult, { kind: "admitted" }>;
  to: string;
  context: TContext;
  runAgent: (context: TContext) => Promise<TResult>;
  sendPreparedText: (
    input: Extract<OutboundAdmissionResult, { kind: "admitted" }> & {
      to: string;
      text: string;
    },
  ) => Promise<OutboundAdmissionResult>;
  failPrepared: (messageId: string) => Promise<void>;
}): Promise<TResult | null> {
  if (admission.terminal) {
    await sendPreparedText({
      ...admission,
      to,
      text: TERMINAL_MESSAGE,
    });
    return null;
  }

  try {
    return await runAgent(context);
  } catch (error) {
    await failPrepared(admission.messageId);
    throw error;
  }
}

export { TERMINAL_MESSAGE };