import { MessageStatus } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
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
import {
  recoveryStoredConsentService, type StoredRecoveryConsentReader,
} from "../recovery-conversation/recovery-stored-consent.service.js";
import type { RecoveryMarketingPermit } from "../recovery-conversation/outbound-send-fence.service.js";
import { WooInitialSendFenceService, type WooInitialFinalPermitInput } from "../woocommerce-recovery/woo-initial-send-fence.service.js";

const deliveryLogger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
const templateSuppression = (reason: string) =>
  reason === "TEMPLATE_REGISTRATION_UNAVAILABLE" ||
  reason === "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" ||
  reason === "TEMPLATE_PROVIDER_STATUS_STALE";

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
    private readonly recoveryConsent: StoredRecoveryConsentReader = recoveryStoredConsentService,
    private readonly wooInitialFence: Pick<WooInitialSendFenceService, "admitFinalSend"> = new WooInitialSendFenceService(database),
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
      shopId, conversationId, messageId, to, expectedContent: outboundText,
      executionScope, deliveryKind: "TEXT",
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
    return this.sendPreparedTemplateInternal(admission, input);
  }

  /** Explicit Woo-only entrypoint. It shares all moderation/provider/failure
   * handling with normal sends but CANNOT fall back to the generic recovery
   * permit, which deliberately does not validate the Woo consent snapshot.
   */
  async sendPreparedWooInitialTemplate(
    admission: AdmittedOutbound,
    input: Omit<SendTemplateInput, "to"> & { to: string },
    scope: Omit<WooInitialFinalPermitInput,
      "shopId" | "conversationId" | "messageId" | "recipient" | "expectedContent" | "templateName" | "languageCode" | "verifiedCategory" | "templateRegistration">,
  ): Promise<OutboundAdmissionResult> {
    return this.sendPreparedTemplateInternal(admission, input, scope);
  }

  private async sendPreparedTemplateInternal(
    admission: AdmittedOutbound,
    input: Omit<SendTemplateInput, "to"> & { to: string; expectedControlRevision?: number },
    wooScope?: Omit<WooInitialFinalPermitInput,
      "shopId" | "conversationId" | "messageId" | "recipient" | "expectedContent" | "templateName" | "languageCode" | "verifiedCategory" | "templateRegistration">,
  ): Promise<OutboundAdmissionResult> {
    if (await this.hasCompletedPreparation(admission.messageId))
      return { kind: "suppressed", reason: "duplicate" };
    // The Woo initial recovery MUST send an approved Marketing template. Never
    // substitute the hard-limit terminal TEXT message on this path.
    if (wooScope && admission.terminal) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "normal-cap-reached" };
    }
    const suppression = await this.revalidateBeforeProvider(admission);
    if (suppression) return suppression;
    // Automated recovery may never silently fall back to the old, unlinked
    // Meta catalogue, even if another caller forgets the BG001 identity.
    if ((wooScope || admission.executionScope === "recovery") && !admission.terminal &&
        !input.templateRegistration) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "TEMPLATE_REGISTRATION_UNAVAILABLE" };
    }
    if (input.templateRegistration && (
        input.templateRegistration.shopId !== admission.shopId ||
        input.templateRegistration.providerTemplateName !== input.templateName ||
        input.templateRegistration.providerLanguageCode !== input.languageCode ||
        input.templateRegistration.senderWabaId !== await this.getProviderAccountId())) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "TEMPLATE_REGISTRATION_UNAVAILABLE" };
    }
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
      } catch (error) {
        deliveryLogger.error("outbound.template.preparation.failed", {
          shopId: admission.shopId, conversationId: admission.conversationId,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        // Known local validation failures are refusals, not retryable provider
        // faults. Unexpected exceptions are always logged and propagated so
        // the worker can retry rather than acknowledging a false refusal.
        await this.failPrepared(admission.messageId);
        const invalidTemplateInput = error instanceof Error && [
          "automated_template_unsupported", "automated_template_invalid_parameters",
          "automated_template_promise_mismatch", "automated_template_invalid_header",
          "automated_template_invalid_media", "automated_template_invalid_button",
          "automated_template_input_too_large",
        ].includes(error.message);
        if (wooScope || !invalidTemplateInput) throw error;
        return { kind: "suppressed", reason: "conversation-invalid" };
      }
    }
    if (!(await this.prepareUnadmittedContent(admission.messageId, outboundText)))
      return { kind: "suppressed", reason: "duplicate" };
    let moderationAllowed: boolean;
    try {
      moderationAllowed = await this.approvePreparedOutbound({
        shopId: admission.shopId, conversationId: admission.conversationId,
        messageId: admission.messageId, outboundText,
      });
    } catch (error) {
      // Woo has not requested the SQL permit. A failed moderation dependency
      // cannot hold a completed provider admission or count as a refusal.
      try {
        await this.failPrepared(admission.messageId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "WOO_PRE_PERMIT_MODERATION_CLEANUP_FAILED", { cause: cleanupError });
      }
      throw error;
    }
    if (!moderationAllowed) {
      await this.failPrepared(admission.messageId);
      return { kind: "suppressed", reason: "conversation-invalid" };
    }
    if (wooScope) {
      // BG001 compilation already established immutable Marketing purpose.
      // The *actual* registration approval and latest Meta observation are
      // re-read under the existing Woo final SQL permit, never over Meta HTTP.
      const permit = await this.wooInitialFence.admitFinalSend({
        ...wooScope,
        shopId: admission.shopId, conversationId: admission.conversationId,
        messageId: admission.messageId, recipient: input.to,
        expectedContent: outboundText, templateName: input.templateName,
        languageCode: input.languageCode, verifiedCategory: "MARKETING",
        templateRegistration: input.templateRegistration!,
      });
      if (permit.kind === "suppressed") {
        // A previously committed permit can already have reached Meta. Never
        // roll it back or release its usage/credit on a duplicate replay.
        if (permit.reason === "already-admitted-or-sent")
          return { kind: "suppressed", reason: "duplicate" };
        await this.failPrepared(admission.messageId);
        return { kind: "suppressed", reason: templateSuppression(permit.reason)
          ? permit.reason as "TEMPLATE_REGISTRATION_UNAVAILABLE" | "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" | "TEMPLATE_PROVIDER_STATUS_STALE"
          : "conversation-invalid" };
      }
    } else {
      const fenced = await this.fenceProviderSend({
        shopId: admission.shopId, conversationId: admission.conversationId,
        messageId: admission.messageId, to: input.to, expectedContent: outboundText,
        ...(admission.executionScope === undefined ? {} : { executionScope: admission.executionScope }),
        deliveryKind: prepared ? "TEMPLATE" : "TEXT",
        ...(input.expectedControlRevision === undefined ? {} : { expectedControlRevision: input.expectedControlRevision }),
        ...(!admission.terminal ? { template: { name: input.templateName, languageCode: input.languageCode,
          ...(input.templateRegistration ? { registration: input.templateRegistration } : {}) } } : {}),
      });
      if (fenced) return fenced;
    }

    try {
      const result = prepared
        ? await this.provider.sendWhatsAppTemplate(prepared.providerInput)
        : await this.provider.sendWhatsAppText({ to: input.to, text: TERMINAL_MESSAGE });
      await this.markSent(admission.messageId, result.providerMessageId);
      return admission;
    } catch (error) {
      try {
        await this.providerFailure.afterProviderError(admission.messageId, input.to, error, wooScope !== undefined);
      } catch (reconciliationError) {
        // Retain BOTH the provider/local-send error and the reconciliation
        // failure. The Woo worker must not acknowledge an uncertain outcome.
        if (wooScope) {
          throw new AggregateError([error, reconciliationError],
            "WOO_PROVIDER_OUTCOME_RECONCILIATION_FAILED", { cause: reconciliationError });
        }
        throw reconciliationError;
      }
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
    } catch (error) {
      // Woo technical dependency failures must retry; only an explicit
      // moderation deny is a known pre-permit suppression.
      deliveryLogger.error("outbound.template.moderation.failed", {
        shopId: input.shopId, conversationId: input.conversationId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      // A moderation dependency exception is not a customer refusal. Propagate
      // for retry, with the existing pre-permit cleanup in the caller.
      throw error;
    }
  }

  /** Both general and recovery sends must commit a final Shop-ordered permit
   * before Meta I/O. Never recapture a recovery turn revision after takeover.
   */
  private async fenceProviderSend(input: {
    shopId: string; conversationId: string; messageId: string; to: string;
    expectedContent: string; expectedControlRevision?: number;
    executionScope?: "general" | "recovery";
    template?: { name: string; languageCode: string;
      registration?: import("../recovery-template-integration/final-template-registration.service.js").FinalTemplateIdentity };
    deliveryKind: "TEXT" | "TEMPLATE";
  }): Promise<Extract<OutboundAdmissionResult, { kind: "suppressed" }> | null> {
    const ownership = await this.ownership.readTurnOwnership(input.conversationId);
    if (!ownership) {
      // A recovery-scoped reservation may not bypass the recovery consent/STOP
      // fence merely because ownership resolution returned no row.
      if (input.executionScope === "recovery") {
        await this.failPrepared(input.messageId);
        return { kind: "suppressed", reason: "conversation-invalid" };
      }
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
    let proactive: RecoveryMarketingPermit | undefined;
    if (input.template) {
      // Stored-consent preflight is performed outside SQL; no Meta GET.
      // A changed consent/STOP revision is independently caught inside the
      // Shop-locked final permit; this check cannot perform Shopify GraphQL.
      const permission = await this.recoveryConsent.preflight({
        shopId: input.shopId, recoveryId: ownership.recoveryId, recipient: input.to,
      });
      if (permission.kind !== "allowed") {
        await this.failPrepared(input.messageId);
        return { kind: "suppressed", reason: "conversation-invalid" };
      }
      // BG007's legacy HUMAN sender can still use its own provider verifier
      // until it migrates. Automated recovery *must* carry BG001 registration.
      if (!input.template.registration) {
        await this.failPrepared(input.messageId);
        return { kind: "suppressed", reason: "TEMPLATE_REGISTRATION_UNAVAILABLE" };
      }
      proactive = {
        verifiedCategory: "MARKETING", templateName: input.template.name,
        languageCode: input.template.languageCode, consent: permission.snapshot,
        templateRegistration: input.template.registration,
      };
    }
    const permit = await this.recoveryFence.admitFinalSend({
      senderType: message.senderType,
      conversationId: input.conversationId, shopId: input.shopId,
      recoveryId: ownership.recoveryId,
      expectedControlRevision: input.expectedControlRevision ?? ownership.revision,
      messageId: input.messageId, recipient: input.to, now: new Date(),
      ...(proactive ? { proactive } : {}),
      deliveryKind: input.deliveryKind,
    });
    if (permit.kind === "admitted") return null;
    if (permit.reason !== "already-admitted-or-sent") {
      await this.failPrepared(input.messageId);
    }
    return { kind: "suppressed", reason: templateSuppression(permit.reason)
      ? permit.reason as "TEMPLATE_REGISTRATION_UNAVAILABLE" | "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" | "TEMPLATE_PROVIDER_STATUS_STALE"
      : "conversation-invalid" };
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
