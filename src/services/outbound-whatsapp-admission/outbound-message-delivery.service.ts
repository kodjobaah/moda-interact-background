import { MessageStatus, UsageMetric } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../../lib/db.js";
import type { SendTemplateInput } from "../../integration/whatsapp/types.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { ShopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import { whatsAppService } from "../whatsapp.service.js";
import { AiTurnOwnershipService } from "../recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../recovery-conversation/outbound-send-fence.service.js";
import { recoveryRuntimeEligibility } from "../recovery-conversation/recovery-runtime-eligibility.service.js";
import { moderationAssessmentService, type ModerationAssessmentService } from "../conversation-moderation/moderation-assessment.service.js";
import { moderationConfig } from "../conversation-moderation/moderation-policy.js";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";
import { prepareAutomatedTemplateInput } from "../conversation-moderation/automated-template-input.js";
import type { OutboundAdmissionResult } from "./outbound-whatsapp-admission.types.js";
import { definitiveProviderFailure, suppressionReason } from "./outbound-delivery-errors.js";

export const TERMINAL_MESSAGE =
  "I am unable to continue this conversation right now. Please try again later.";

type DeliveryDatabase = Pick<
  PrismaClient,
  "$transaction" | "$queryRawUnsafe" | "conversation" | "conversationMessage" | "usageEvent"
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
    private readonly ownership = new AiTurnOwnershipService(),
    private readonly recoveryFence = new OutboundSendFenceService(undefined, recoveryRuntimeEligibility),
    private readonly moderation: ModerationAssessmentService = moderationAssessmentService,
  ) {}

  async getProviderAccountId(): Promise<string> {
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
    expectedControlRevision,
  }: AdmittedOutbound & {
    to: string;
    text: string;
    previewUrl?: boolean;
    replyToProviderMessageId?: string;
    expectedControlRevision?: number;
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
    if (!(await this.approvePreparedOutbound({ shopId, conversationId, messageId, outboundText }))) {
      await this.failPrepared(messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    // General as well as recovery-linked sends must honour local STOP.
    if (await hasLocalNoContact(this.database, { shopId, recipient: to })) {
      await this.failPrepared(messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    const fenced = await this.fenceRecoverySend({
      shopId, conversationId, messageId, to,
      ...(expectedControlRevision === undefined ? {} : { expectedControlRevision }),
    });
    if (fenced) return fenced;

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
    input: Omit<SendTemplateInput, "to"> & { to: string; expectedControlRevision?: number },
  ): Promise<OutboundAdmissionResult> {
    const suppression = await this.revalidateBeforeProvider(admission);
    if (suppression) return suppression;
    // DATABASE-005 has no structured automated-template columns: persist the
    // *exact* deterministic template/parameter input as the prepared message
    // TEXT before assessing it. Only those parameters are classified, not the
    // unseen Meta-managed static template body (whose approval is independent).
    // Terminal sends continue to moderate and send their fixed text instead.
    let prepared: ReturnType<typeof prepareAutomatedTemplateInput> | null = null;
    let outboundText = TERMINAL_MESSAGE;
    if (!admission.terminal) {
      try {
        prepared = prepareAutomatedTemplateInput(input);
        outboundText = prepared.effectiveText;
      } catch {
        await this.failPrepared(admission.messageId);
        return { kind: "suppressed", reason: "conversation-invalid" };
      }
    }
    await this.database.conversationMessage.update({
      where: { id: admission.messageId }, data: { content: outboundText },
    });
    if (!(await this.approvePreparedOutbound({
      shopId: admission.shopId, conversationId: admission.conversationId,
      messageId: admission.messageId, outboundText,
    }))) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    if (await hasLocalNoContact(this.database, { shopId: admission.shopId, recipient: input.to })) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    const fenced = await this.fenceRecoverySend({
      shopId: admission.shopId, conversationId: admission.conversationId,
      messageId: admission.messageId, to: input.to,
      ...(input.expectedControlRevision === undefined ? {} : { expectedControlRevision: input.expectedControlRevision }),
    });
    if (fenced) return fenced;

    try {
      const result = prepared
        ? await this.provider.sendWhatsAppTemplate(prepared.providerInput)
        : await this.provider.sendWhatsAppText({ to: input.to, text: TERMINAL_MESSAGE });
      await this.markSent(admission.messageId, result.providerMessageId);
      return admission;
    } catch (error) {
      await this.markProviderFailure(admission.messageId, error);
      throw error;
    }
  }

  private async approvePreparedOutbound(input: {
    shopId: string; conversationId: string; messageId: string; outboundText: string;
  }): Promise<boolean> {
    try {
      const message = await this.database.conversationMessage.findUnique({
        where: { id: input.messageId }, select: { senderType: true, content: true },
      });
      if (!message || message.content !== input.outboundText ||
          (message.senderType !== "AGENT" && message.senderType !== "AUTOMATION")) return false;
      const subject = { kind: message.senderType === "AGENT" ? "AGENT_MESSAGE" as const : "AUTOMATION_MESSAGE" as const,
        messageId: input.messageId };
      const policyVersion = moderationConfig().policyVersion;
      const outcome = await this.moderation.assessText({
        subject, shopId: input.shopId, conversationId: input.conversationId,
        effectiveText: input.outboundText, inputKind: "TEXT", policyVersion, now: new Date(),
      });
      return outcome.kind === "allow" && await this.moderation.requireCurrentAllowance({
        subject, effectiveText: input.outboundText, policyVersion,
      });
    } catch {
      return false;
    }
  }

  /** Atomic provider permit for recovery-linked automated sends. Preflight alone
   * cannot protect the interval between a model await and Meta submission.
   * Never recapture a supplied turn revision after a takeover/resume cycle.
   */
  private async fenceRecoverySend(input: {
    shopId: string; conversationId: string; messageId: string; to: string;
    expectedControlRevision?: number;
  }): Promise<Extract<OutboundAdmissionResult, { kind: "suppressed" }> | null> {
    const ownership = await this.ownership.readTurnOwnership(input.conversationId);
    if (!ownership) return null; // Existing non-recovery scope.
    const message = await this.database.conversationMessage.findUnique({
      where: { id: input.messageId }, select: { senderType: true },
    });
    if (!message || (message.senderType !== "AGENT" && message.senderType !== "AUTOMATION")) {
      await this.failPrepared(input.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    const permit = await this.recoveryFence.admitFinalSend({
      senderType: message.senderType,
      conversationId: input.conversationId, shopId: input.shopId,
      recoveryId: ownership.recoveryId,
      expectedControlRevision: input.expectedControlRevision ?? ownership.revision,
      messageId: input.messageId, recipient: input.to, now: new Date(),
    });
    if (permit.kind === "admitted") return null;
    if (permit.reason !== "already-admitted-or-sent") {
      await this.failPrepared(input.messageId);
    }
    return { kind: "suppressed", reason: "conversation-invalid" };
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
    if (definitiveProviderFailure(error)) await this.failPrepared(messageId);
  }
}
