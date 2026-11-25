import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import { readMetaCommonIdentity } from "../recovery-template-preparation/recovery-template-common.js";
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
        outreachAttemptId: command.recoveryOutreachAttemptId,
        conversationLanguageTag: conversation.languageTag ?? null,
        requestedTemplate: { templateName: command.templateName, languageCode: command.templateLanguageCode },
      });
      if (selection.kind !== "prepared") {
        this.log.warn("arch047.merchant_follow_up.preparation_unavailable", {
          commandId: command.id, shopId: command.shopId, reason: selection.reason,
        });
        return unavailable("follow_up_unavailable");
      }
      const { prepared, send } = selection;
      const registration = send.templateRegistration;
      // New common-layout templates bind the trusted checkout URL in the BODY
      // instead of a legacy dynamic button. Require exact prepared evidence;
      // the locked final registration check independently revalidates the
      // current layout, checkout, frozen binding positions and parameters.
      const common = prepared.commonLayout === undefined ? null : readMetaCommonIdentity(prepared.commonLayout, command.shopId);
      const commonCheckout = common !== null && registration?.commonLayout !== undefined &&
        canonicalJson(registration.commonLayout) === canonicalJson(common) &&
        canonicalJson(common.parameters) === canonicalJson({ header: send.textHeader === undefined ? [] : [send.textHeader], body: send.bodyParameters ?? [] }) &&
        common.parameters.body.includes(common.variables["checkout.url"]);
      const legacyCheckout = prepared.commonLayout === undefined && registration?.commonLayout === undefined &&
        send.dynamicUrlButton?.index === 0 && typeof send.dynamicUrlButton.text === "string" && Boolean(send.dynamicUrlButton.text);
      if ((!commonCheckout && !legacyCheckout) ||
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
