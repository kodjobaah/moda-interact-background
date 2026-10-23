import { MessageStatus } from "@prisma/client";
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
import { prepareAutomatedTemplateInput } from "../conversation-moderation/automated-template-input.js";
import type { OutboundAdmissionResult } from "./outbound-whatsapp-admission.types.js";
import { OutboundProviderFailureService } from "./outbound-provider-failure.service.js";
import { suppressionReason } from "./outbound-delivery-errors.js";
import { GeneralOutboundSendFenceService } from "./general-outbound-send-fence.service.js";

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
    private readonly providerFailure = new OutboundProviderFailureService(database),
    private readonly generalFence = new GeneralOutboundSendFenceService(database),
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
    // Check the durable admission before any failure/usage side effects. An
    // already-admitted message must never be re-prepared or dispatched again.
    if (await this.hasCompletedPreparation(messageId))
      return { kind: "suppressed", reason: "duplicate" };
    const suppression = await this.revalidateBeforeProvider({
      kind: "admitted",
      shopId,
      messageId,
      conversationId,
      terminal,
      executionScope,
    });
    if (suppression) return suppression;

    if (!(await this.prepareUnadmittedContent(messageId, outboundText)))
      return { kind: "suppressed", reason: "duplicate" };
    if (!(await this.approvePreparedOutbound({ shopId, conversationId, messageId, outboundText }))) {
      await this.failPrepared(messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    const fenced = await this.fenceProviderSend({
      shopId, conversationId, messageId, to, expectedContent: outboundText, deliveryKind: "TEXT",
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
      await this.providerFailure.afterProviderError(messageId, to, error);
      throw error;
    }
  }

  async sendPreparedTemplate(
    admission: AdmittedOutbound,
    input: Omit<SendTemplateInput, "to"> & { to: string; expectedControlRevision?: number },
  ): Promise<OutboundAdmissionResult> {
    if (await this.hasCompletedPreparation(admission.messageId))
      return { kind: "suppressed", reason: "duplicate" };
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
    if (!(await this.prepareUnadmittedContent(admission.messageId, outboundText)))
      return { kind: "suppressed", reason: "duplicate" };
    if (!(await this.approvePreparedOutbound({
      shopId: admission.shopId, conversationId: admission.conversationId,
      messageId: admission.messageId, outboundText,
    }))) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    const fenced = await this.fenceProviderSend({
      shopId: admission.shopId, conversationId: admission.conversationId,
      messageId: admission.messageId, to: input.to, expectedContent: outboundText,
      deliveryKind: prepared ? "TEMPLATE" : "TEXT",
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
      await this.providerFailure.afterProviderError(admission.messageId, input.to, error);
      throw error;
    }
  }

  /** A read avoids cleanup or moderation side effects on a replay; the guarded
   * write below is the definitive protection against an admission racing it.
   */
  private async hasCompletedPreparation(messageId: string): Promise<boolean> {
    const message = await this.database.conversationMessage.findUnique({
      where: { id: messageId },
      select: {
        status: true, providerDispatchKey: true, providerDispatchAdmittedAt: true,
      },
    });
    return !message || message.status !== MessageStatus.PENDING ||
      message.providerDispatchKey !== null || message.providerDispatchAdmittedAt !== null;
  }

  /** Never change persisted content once any sender has acquired a dispatch
   * permit. The unique id plus AND predicates form an atomic compare-and-set.
   * Nullable unique fields belong in a nested WhereInput, not at the top level
   * of Prisma's WhereUniqueInput (which rejects null for providerDispatchKey).
   */
  private async prepareUnadmittedContent(messageId: string, content: string): Promise<boolean> {
    try {
      await this.database.conversationMessage.update({
        where: {
          id: messageId,
          AND: {
            status: MessageStatus.PENDING,
            providerDispatchKey: null,
            providerDispatchAdmittedAt: null,
          },
        },
        data: { content },
      });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2025")
        return false;
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

  /** Both general and recovery sends must commit a final Shop-ordered permit
   * before Meta I/O. Never recapture a recovery turn revision after takeover.
   */
  private async fenceProviderSend(input: {
    shopId: string; conversationId: string; messageId: string; to: string;
    expectedContent: string; expectedControlRevision?: number;
    deliveryKind: "TEXT" | "TEMPLATE";
  }): Promise<Extract<OutboundAdmissionResult, { kind: "suppressed" }> | null> {
    const ownership = await this.ownership.readTurnOwnership(input.conversationId);
    if (!ownership) {
      const permit = await this.generalFence.admitFinalSend({
        shopId: input.shopId, conversationId: input.conversationId,
        messageId: input.messageId, recipient: input.to,
        expectedContent: input.expectedContent,
      });
      if (permit.kind === "admitted") return null;
      if (permit.reason === "already-admitted-or-sent")
        return { kind: "suppressed", reason: "duplicate" };
      await this.failPrepared(input.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
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
      deliveryKind: input.deliveryKind,
    });
    if (permit.kind === "admitted") return null;
    if (permit.reason !== "already-admitted-or-sent") {
      await this.failPrepared(input.messageId);
    }
    return { kind: "suppressed", reason: "conversation-invalid" };
  }

  async failPrepared(messageId: string): Promise<void> {
    await this.providerFailure.failPrepared(messageId);
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

}
