import { MessageStatus, UsageMetric } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../../lib/db.js";
import type { SendTemplateInput } from "../../integration/whatsapp/types.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type {
  ShopExecutionDenialReason,
  ShopExecutionEligibilityService,
} from "../shop-execution-eligibility.service.js";
import { whatsAppService } from "../whatsapp.service.js";
import type {
  OutboundAdmissionResult,
  OutboundSuppressionReason,
} from "./outbound-whatsapp-admission.types.js";

export const TERMINAL_MESSAGE =
  "I am unable to continue this conversation right now. Please try again later.";

type DeliveryDatabase = Pick<
  PrismaClient,
  "$transaction" | "conversation" | "conversationMessage" | "usageEvent"
>;

type AdmittedOutbound = Extract<
  OutboundAdmissionResult,
  { kind: "admitted" }
>;

export class OutboundMessageDeliveryService {
  constructor(
    private readonly database: DeliveryDatabase = prisma,
    private readonly provider = whatsAppService,
    private readonly executionEligibility: Pick<
      ShopExecutionEligibilityService,
      "evaluate"
    > = shopExecutionEligibilityService,
  ) {}

  getProviderAccountId(): string {
    return this.provider.getProviderAccountId();
  }

  async sendPreparedText({
    messageId,
    shopId,
    conversationId,
    terminal,
    executionScope = "general",
    to,
    text,
    previewUrl,
    replyToProviderMessageId,
  }: AdmittedOutbound & {
    to: string;
    text: string;
    previewUrl?: boolean;
    replyToProviderMessageId?: string;
  }): Promise<OutboundAdmissionResult> {
    const outboundText = terminal ? TERMINAL_MESSAGE : text;
    const suppression = await this.revalidateBeforeProvider({
      kind: "admitted",
      shopId,
      messageId,
      conversationId,
      terminal,
      executionScope,
    });
    if (suppression) return suppression;

    await this.database.conversationMessage.update({
      where: { id: messageId },
      data: { content: outboundText },
    });

    try {
      const result = await this.provider.sendWhatsAppText({
        to,
        text: outboundText,
        ...(previewUrl !== undefined ? { previewUrl } : {}),
        ...(replyToProviderMessageId
          ? { replyToProviderMessageId }
          : {}),
      });
      await this.markSent(messageId, result.providerMessageId);
      return {
        kind: "admitted",
        shopId,
        messageId,
        conversationId,
        terminal,
        executionScope,
      };
    } catch (error) {
      await this.markProviderFailure(messageId, error);
      throw error;
    }
  }

  async sendPreparedTemplate(
    admission: AdmittedOutbound,
    input: Omit<SendTemplateInput, "to"> & { to: string },
  ): Promise<OutboundAdmissionResult> {
    const suppression = await this.revalidateBeforeProvider(admission);
    if (suppression) return suppression;

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
            ...(input.imageHeader ? { imageHeader: input.imageHeader } : {}),
            ...(input.dynamicUrlButton
              ? { dynamicUrlButton: input.dynamicUrlButton }
              : {}),
          });
      await this.markSent(admission.messageId, result.providerMessageId);
      return admission;
    } catch (error) {
      await this.markProviderFailure(admission.messageId, error);
      throw error;
    }
  }

  async failPrepared(messageId: string): Promise<void> {
    await this.database.conversationMessage.update({
      where: { id: messageId },
      data: { status: MessageStatus.FAILED },
    });
    await this.database.usageEvent.deleteMany({
      where: {
        sourceId: messageId,
        metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE,
      },
    });
  }

  private async revalidateBeforeProvider(
    admission: AdmittedOutbound,
  ): Promise<Extract<OutboundAdmissionResult, { kind: "suppressed" }> | null> {
    const execution =
      admission.executionScope === "recovery"
        ? await this.executionEligibility.evaluate(
            admission.shopId,
            undefined,
            "recovery",
          )
        : await this.executionEligibility.evaluate(admission.shopId);
    if (execution.allowed) return null;

    await this.failPrepared(admission.messageId);
    return {
      kind: "suppressed",
      reason: suppressionReason(execution.reason),
    };
  }

  private async markSent(
    messageId: string,
    providerMessageId: string,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.conversationMessage.update({
        where: { id: messageId },
        data: {
          providerMessageId,
          status: MessageStatus.SENT,
          sentAt: new Date(),
        },
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

  private async markProviderFailure(
    messageId: string,
    error: unknown,
  ): Promise<void> {
    const definitive =
      error instanceof Error &&
      error.name === "WhatsAppServiceError" &&
      ["configuration-missing", "provider-rejected"].includes(
        (error as Error & { code?: string }).code ?? "",
      );
    if (definitive) await this.failPrepared(messageId);
  }
}

function suppressionReason(
  reason: ShopExecutionDenialReason,
): OutboundSuppressionReason {
  if (reason === "CONTRACT_REQUIRED") return "contract-required";
  if (reason === "SUBSCRIPTION_FROZEN") return "subscription-frozen";
  return "shop-unavailable";
}
