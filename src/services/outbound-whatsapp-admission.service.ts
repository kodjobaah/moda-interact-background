import {
  MessageSenderType,
  MessageStatus,
  Prisma,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  EffectiveBillingPolicyResolver,
  effectiveBillingPolicyResolver,
} from "./effective-billing-policy.service.js";
import type {
  BillingPolicyClient,
  EffectiveBillingPolicy,
} from "./effective-billing-policy.service.js";
import { whatsAppService } from "./whatsapp.service.js";
import type {
  SendMessageResult,
  SendTemplateInput,
} from "../integration/whatsapp/types.js";

const MAX_TRANSACTION_RETRIES = 3;
const PENDING_CONTENT = "[Pending automated WhatsApp message]";
const TERMINAL_MESSAGE =
  "I am unable to continue this conversation right now. Please try again later.";

type AdmissionDatabase = Pick<
  PrismaClient,
  "$transaction" | "conversation" | "conversationMessage" | "usageEvent"
>;
type PolicyResolverFactory = (
  client: BillingPolicyClient,
) => Pick<EffectiveBillingPolicyResolver, "resolve">;
type Transaction = Prisma.TransactionClient;

export type OutboundAdmissionInput = {
  shopId: string;
  conversationId: string;
  idempotencyKey: string;
  senderType: Extract<MessageSenderType, "AGENT" | "AUTOMATION">;
  content?: string;
};

export type OutboundAdmissionResult =
  | {
      kind: "admitted";
      messageId: string;
      conversationId: string;
      terminal: boolean;
    }
  | { kind: "suppressed"; reason: OutboundSuppressionReason };

export type OutboundSuppressionReason =
  | "paused"
  | "normal-cap-reached"
  | "terminal-already-used"
  | "duplicate"
  | "conversation-invalid"
  | "shop-unavailable";

export class OutboundWhatsAppAdmissionService {
  constructor(
    private readonly database: AdmissionDatabase = prisma,
    private readonly createPolicyResolver: PolicyResolverFactory = (client) =>
      new EffectiveBillingPolicyResolver(client),
    private readonly provider = whatsAppService,
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
  ) {}

  getProviderAccountId(): string {
    return this.provider.getProviderAccountId();
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
    input: OutboundAdmissionInput & { to: string; text: string },
  ): Promise<OutboundAdmissionResult> {
    const admission = await this.reserve({ ...input, content: input.text });
    if (admission.kind !== "admitted") return admission;

    return this.sendPreparedText({
      ...admission,
      to: input.to,
      text: admission.terminal ? TERMINAL_MESSAGE : input.text,
    });
  }

  async sendTemplate(
    input: OutboundAdmissionInput &
      Omit<SendTemplateInput, "to"> & { to: string },
  ): Promise<OutboundAdmissionResult> {
    const admission = await this.reserve(input);
    if (admission.kind !== "admitted") return admission;

    try {
      const result = admission.terminal
        ? await this.provider.sendWhatsAppText({
            to: input.to,
            text: TERMINAL_MESSAGE,
          })
        : await this.provider.sendWhatsAppTemplate({
            to: input.to,
            templateName: input.templateName,
            languageCode: input.languageCode,
            ...(input.bodyParameters
              ? { bodyParameters: input.bodyParameters }
              : {}),
          });
      await this.markSent(admission.messageId, result.providerMessageId);
      return admission;
    } catch (error) {
      await this.markProviderFailure(admission.messageId, error);
      throw error;
    }
  }

  async sendPreparedText({
    messageId,
    conversationId,
    terminal,
    to,
    text,
  }: Extract<OutboundAdmissionResult, { kind: "admitted" }> & {
    to: string;
    text: string;
  }): Promise<OutboundAdmissionResult> {
    const outboundText = terminal ? TERMINAL_MESSAGE : text;
    await this.database.conversationMessage.update({
      where: { id: messageId },
      data: { content: outboundText },
    });

    try {
      const result = await this.provider.sendWhatsAppText({
        to,
        text: outboundText,
      });
      await this.markSent(messageId, result.providerMessageId);
      return { kind: "admitted", messageId, conversationId, terminal };
    } catch (error) {
      await this.markProviderFailure(messageId, error);
      throw error;
    }
  }

  async failPrepared(messageId: string): Promise<void> {
    await this.database.conversationMessage.update({
      where: { id: messageId },
      data: { status: MessageStatus.FAILED },
    });
    await this.database.usageEvent.deleteMany({
      where: { sourceId: messageId, metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE },
    });
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

    const policy = await this.createPolicyResolver(transaction).resolve(input.shopId);
    if (policy.automatedWhatsappPaused) return { kind: "suppressed", reason: "paused" };

    const conversation = await transaction.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        shopId: true,
        checkoutRecovery: { select: { shopId: true } },
      },
    });
    const conversationShopId =
      conversation?.shopId ?? conversation?.checkoutRecovery?.shopId;
    if (!conversation || conversationShopId !== input.shopId) {
      return { kind: "suppressed", reason: "conversation-invalid" };
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
      messageId: message.id,
      conversationId: input.conversationId,
      terminal: isTerminal,
    };
  }

  private async markSent(messageId: string, providerMessageId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.conversationMessage.update({
        where: { id: messageId },
        data: { providerMessageId, status: MessageStatus.SENT, sentAt: new Date() },
      });
      const message = await transaction.conversationMessage.findUnique({
        where: { id: messageId },
        select: { conversationId: true },
      });
      if (message) {
        await transaction.conversation.update({
          where: { id: message.conversationId },
          data: { lastMessageAt: new Date() },
        });
      }
    });
  }

  private async markProviderFailure(messageId: string, error: unknown): Promise<void> {
    const definitive =
      error instanceof Error &&
      error.name === "WhatsAppServiceError" &&
      ["configuration-missing", "provider-rejected"].includes(
        (error as Error & { code?: string }).code ?? "",
      );
    if (definitive) await this.failPrepared(messageId);
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