import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";
import { automatedRecoveryTemplateService } from "../recovery-template-integration/automated-recovery-template.service.js";
import type { AutomatedTemplateResult } from "../recovery-template-integration/automated-recovery-template.service.js";
import type { HumanCommand } from "./merchant-send-command.service.js";

const logger = createLogger({
  serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName(),
});

export type MerchantFollowUpTemplate = Extract<AutomatedTemplateResult, { kind: "prepared" }>;
export type MerchantFollowUpResolution =
  | MerchantFollowUpTemplate
  | { kind: "unavailable"; reason: "template_not_allowed" | "follow_up_unavailable" };

/** Only the persisted merchant selection is an assertion. The prepared Meta
 * identity, language, image, bindings and checkout CTA are derived from current
 * tenant-scoped recovery state, NEVER from merchant-provided parameter arrays.
 */
export class MerchantFollowUpTemplateService {
  constructor(
    private readonly database: Pick<typeof prisma, "conversation"> = prisma,
    private readonly policy: Pick<typeof recoveryPolicyService, "resolve"> = recoveryPolicyService,
    private readonly templates: Pick<typeof automatedRecoveryTemplateService, "prepare"> = automatedRecoveryTemplateService,
    private readonly log: Pick<StructuredLogger, "error" | "warn"> = logger,
  ) {}

  async resolve(command: HumanCommand, recoveryId: string): Promise<MerchantFollowUpResolution> {
    const unavailable = (reason: "template_not_allowed" | "follow_up_unavailable"): MerchantFollowUpResolution => {
      // A refusal is a normal typed outcome, but still needs durable operational
      // visibility. Never log customer, checkout or provider parameter values.
      this.log.warn("arch047.merchant_follow_up.refused", {
        commandId: command.id, shopId: command.shopId, reason,
      });
      return { kind: "unavailable", reason };
    };
    if (command.kind !== "RECOVERY_FOLLOW_UP_TEMPLATE" || !command.templateName ||
        !command.templateLanguageCode || !command.recoveryOutreachAttemptId ||
        command.textBody !== null ||
        // The legacy merchant API can still persist raw parameters. Never
        // accept them as a source of truth or silently ignore injected values.
        (command.templateParameters !== null && command.templateParameters !== undefined &&
         !(Array.isArray(command.templateParameters) && command.templateParameters.length === 0))) {
      return unavailable("template_not_allowed");
    }
    try {
      const conversation = await this.database.conversation.findUnique({
        where: { id: command.conversationId },
        select: { shopId: true, checkoutRecoveryId: true, languageTag: true },
      });
      if (!conversation || (conversation.shopId !== null && conversation.shopId !== command.shopId) ||
          conversation.checkoutRecoveryId !== recoveryId) {
        return unavailable("template_not_allowed");
      }
      const policy = await this.policy.resolve(command.shopId);
      const selection = await this.templates.prepare({
        shopId: command.shopId, recoveryId, stage: "FOLLOW_UP", policy,
        conversationLanguageTag: conversation.languageTag ?? null,
      });
      if (selection.kind !== "prepared") {
        this.log.warn("arch047.merchant_follow_up.preparation_unavailable", {
          commandId: command.id, shopId: command.shopId, reason: selection.reason,
        });
        return unavailable("follow_up_unavailable");
      }
      const { prepared, send } = selection;
      const registration = send.templateRegistration;
      // Every merchant post-window recovery follow-up must use the checkout
      // CTA that BG001 bound to the authenticated recovery. A static/no-button
      // template must not silently turn into a message with no recovery link.
      // The provider parameters are forwarded unchanged after this check.
      if (!send.dynamicUrlButton || send.dynamicUrlButton.index !== 0 ||
          typeof send.dynamicUrlButton.text !== "string" || !send.dynamicUrlButton.text ||
          (send.imageHeader !== undefined && send.textHeader !== undefined) ||
          (send.textHeader !== undefined &&
           (typeof send.textHeader !== "string" || !send.textHeader.trim())) ||
          (send.imageHeader !== undefined &&
           (!send.imageHeader || typeof send.imageHeader.link !== "string" ||
            !send.imageHeader.link))) {
        return unavailable("follow_up_unavailable");
      }
      if (!registration || !send.recoveryPromise ||
          prepared.purpose !== `FOLLOW_UP_${send.recoveryPromise.kind}` ||
          prepared.shopId !== command.shopId ||
          registration.shopId !== command.shopId ||
          registration.purpose !== prepared.purpose ||
          registration.senderWabaId !== prepared.senderWabaId ||
          registration.providerTemplateName !== prepared.providerTemplateName ||
          registration.providerLanguageCode !== prepared.providerLanguageCode ||
          registration.variantId !== prepared.variantId ||
          registration.registrationId !== prepared.registrationId ||
          registration.definitionId !== prepared.definitionId ||
          registration.providerTemplateId !== prepared.providerTemplateId ||
          registration.submittedContentHash !== prepared.submittedContentHash ||
          registration.bindingFingerprint !== prepared.bindingFingerprint ||
          command.templateName !== prepared.providerTemplateName ||
          command.templateLanguageCode !== prepared.providerLanguageCode ||
          send.templateName !== prepared.providerTemplateName ||
          send.languageCode !== prepared.providerLanguageCode) {
        return unavailable("template_not_allowed");
      }
      // A configured discount cannot quietly become a customer-facing
      // NO_OFFER when the independent checkout eligibility reader is absent.
      if (policy.recoveryOfferMode !== "NONE" && send.recoveryPromise?.kind === "NO_OFFER") {
        return unavailable("follow_up_unavailable");
      }
      return selection;
    } catch (error) {
      this.log.error("arch047.merchant_follow_up.prepare_failed", {
        commandId: command.id, shopId: command.shopId,
        errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
      throw error;
    }
  }
}

export const merchantFollowUpTemplateService = new MerchantFollowUpTemplateService();
