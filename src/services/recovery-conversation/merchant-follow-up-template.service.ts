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
    if (command.kind !== "RECOVERY_FOLLOW_UP_TEMPLATE" || !command.templateName ||
        !command.templateLanguageCode ||
        // The legacy merchant API can still persist raw parameters. Never
        // accept them as a source of truth or silently ignore injected values.
        (command.templateParameters !== null && command.templateParameters !== undefined &&
         !(Array.isArray(command.templateParameters) && command.templateParameters.length === 0))) {
      return { kind: "unavailable", reason: "template_not_allowed" };
    }
    try {
      const conversation = await this.database.conversation.findUnique({
        where: { id: command.conversationId },
        select: { shopId: true, checkoutRecoveryId: true, languageTag: true },
      });
      if (!conversation || (conversation.shopId !== null && conversation.shopId !== command.shopId) ||
          conversation.checkoutRecoveryId !== recoveryId) {
        return { kind: "unavailable", reason: "template_not_allowed" };
      }
      const policy = await this.policy.resolve(command.shopId);
      const selection = await this.templates.prepare({
        shopId: command.shopId, recoveryId, stage: "FOLLOW_UP", policy,
        conversationLanguageTag: conversation.languageTag ?? null,
      });
      if (selection.kind !== "prepared") {
        this.log.warn("arch047.merchant_follow_up.unavailable", {
          commandId: command.id, shopId: command.shopId, reason: selection.reason,
        });
        return { kind: "unavailable", reason: "follow_up_unavailable" };
      }
      const { prepared, send } = selection;
      const registration = send.templateRegistration;
      if (!registration || !send.recoveryPromise ||
          prepared.purpose !== `FOLLOW_UP_${send.recoveryPromise.kind}` ||
          prepared.shopId !== command.shopId ||
          registration.shopId !== command.shopId ||
          registration.purpose !== prepared.purpose ||
          registration.senderWabaId !== prepared.senderWabaId ||
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
        return { kind: "unavailable", reason: "template_not_allowed" };
      }
      // A configured discount cannot quietly become a customer-facing
      // NO_OFFER when the independent checkout eligibility reader is absent.
      if (policy.recoveryOfferMode !== "NONE" && send.recoveryPromise?.kind === "NO_OFFER") {
        return { kind: "unavailable", reason: "follow_up_unavailable" };
      }
      return selection;
    } catch (error) {
      this.log.error("arch047.merchant_follow_up.prepare_failed", {
        commandId: command.id, shopId: command.shopId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }
}

export const merchantFollowUpTemplateService = new MerchantFollowUpTemplateService();
