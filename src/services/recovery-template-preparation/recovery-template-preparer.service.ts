import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { whatsAppService } from "../whatsapp.service.js";
import { BindingUnavailable, RecoveryVariableResolver } from "./recovery-template-brand.js";
import { prepareFrozenComponents } from "./recovery-template-bindings.js";
import { PrismaRecoveryTemplateRepository } from "./recovery-template-repository.js";
import { purposeFor, selectRecoveryAssignment } from "./recovery-template-selection.js";
import type {
  BrandMediaResolver,
  PreparedRecoveryTemplate,
  PreparationResult,
  RecoveryTemplatePreparationInput,
  RecoveryTemplatePurpose,
  RecoveryTemplateRepository,
  TemplateUnavailable,
  TemplateUnavailableReason,
} from "./recovery-template.types.js";

export type {
  RecoveryTemplatePreparationInput, PreparationResult, PreparedRecoveryTemplate,
  TemplateUnavailable, TemplateUnavailableReason, RecoveryTemplateRepository,
  ReadyBrandMedia, BrandMediaResolver,
} from "./recovery-template.types.js";

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

const noReadyMedia: BrandMediaResolver = async () => null;

/**
 * Purely read-only template preparation facade. An approved provider template
 * is NOT permission to send: consent/STOP, moderation, credits and the final
 * database send fence are still independently enforced by later BG006/BG007.
 */
export class RecoveryTemplatePreparer {
  constructor(
    private readonly repository: RecoveryTemplateRepository = new PrismaRecoveryTemplateRepository(),
    private readonly resolveConfiguredSenderWaba: () => Promise<string | null> =
      () => whatsAppService.getProviderAccountId(),
    private readonly resolveReadyShopBrandMedia: BrandMediaResolver = noReadyMedia,
    /** Architecture-approved R2 derivative hosts. Empty means fail closed. */
    private readonly approvedMediaHosts: readonly string[] = [],
    private readonly clock: () => Date = () => new Date(),
    private readonly logger: Pick<StructuredLogger, "warn" | "error"> = defaultLogger,
  ) {}

  async prepare(input: RecoveryTemplatePreparationInput): Promise<PreparationResult> {
    let purpose: RecoveryTemplatePurpose | null = null;
    const unavailable = (reason: TemplateUnavailableReason): TemplateUnavailable => {
      this.logger.warn("recovery_template.prepare.unavailable", {
        shopId: typeof input?.shopId === "string" ? input.shopId : "unknown",
        purpose: purpose ?? "unknown",
        reason,
      });
      return { outcome: "unavailable", reason, purpose };
    };

    try {
      if (!input || typeof input.shopId !== "string" || !input.shopId.trim() ||
          typeof input.senderWabaId !== "string" || !input.senderWabaId.trim() ||
          !["INITIAL", "FOLLOW_UP"].includes(input.stage) ||
          !["NO_OFFER", "CODE_OFFER", "AUTOMATIC_OFFER"].includes(input.offerPresentation)) {
        return unavailable("INVALID_REQUEST");
      }
      purpose = purposeFor(input.stage, input.offerPresentation);
      // This trust check is required even though the caller passes a resolved
      // WABA. No request-supplied string can select another provider account.
      const configuredSender = await this.resolveConfiguredSenderWaba();
      if (!configuredSender) return unavailable("SENDER_UNAVAILABLE");
      if (configuredSender !== input.senderWabaId) return unavailable("SENDER_MISMATCH");

      const catalogue = await this.repository.readCatalogue({
        shopId: input.shopId, senderWabaId: configuredSender, purpose,
      });
      if (!catalogue.shop || catalogue.shop.status !== "ACTIVE") return unavailable("SHOP_UNAVAILABLE");

      const selected = selectRecoveryAssignment({
        shop: catalogue.shop, shopId: input.shopId, senderWabaId: configuredSender,
        purpose, variants: catalogue.variants,
        stage: input.stage, offer: input.offerPresentation,
        conversationLanguageTag: input.conversationLanguageTag,
        merchantLanguageTag: input.merchantLanguageTag,
        platformFallbackEnabled: input.platformFallbackEnabled ?? false,
        platformFallbackLanguageTag: input.platformFallbackLanguageTag ?? null,
        logger: this.logger,
      });
      if (selected.outcome === "unavailable") return unavailable(selected.reason);
      const { variant, canonicalLanguageTag, selectionSource } = selected.value;
      const registration = variant.metaRegistration!;
      const variables = new RecoveryVariableResolver(
        input, (shopId) => this.repository.readShopBrand(shopId),
        this.resolveReadyShopBrandMedia, this.approvedMediaHosts, this.clock,
        (shopId, languageTag) => this.repository.readShopCategory(shopId, languageTag), canonicalLanguageTag,
      );
      const prepared = await prepareFrozenComponents({ registration, variables });
      return {
        outcome: "prepared", shopId: input.shopId, senderWabaId: configuredSender,
        purpose, variantId: variant.id, registrationId: registration.id,
        definitionId: registration.locale.definition.id,
        providerTemplateId: registration.providerTemplateId!,
        providerTemplateName: registration.providerTemplateName,
        providerLanguageCode: registration.providerLanguageCode,
        canonicalLanguageTag, selectionSource,
        submittedContentHash: registration.submittedContentHash,
        bindingFingerprint: prepared.bindingFingerprint,
        template: {
          name: registration.providerTemplateName,
          language: { code: registration.providerLanguageCode },
          components: prepared.components,
        },
      } satisfies PreparedRecoveryTemplate;
    } catch (error) {
      if (error instanceof BindingUnavailable) {
        // This is a typed business rejection, not a swallowed operational
        // error. The reason (never the customer, offer or checkout URL) is logged.
        this.logger.warn("recovery_template.prepare.binding_unavailable", {
          shopId: typeof input?.shopId === "string" ? input.shopId : "unknown",
          purpose: purpose ?? "unknown",
          reason: error.reason,
          errorType: error.name,
          errorMessage: error instanceof Error ? error.message : String(error),
          error: error,
        });
        return { outcome: "unavailable", reason: error.reason, purpose };
      }
      // Unexpected DB, sender-config, integrity or media-reader exceptions
      // must remain retryable upstream. Do not log exception.message/stack:
      // arbitrary external errors can include PII, checkout links or tokens.
      this.logger.error("recovery_template.prepare.failed", {
        shopId: typeof input?.shopId === "string" ? input.shopId : "unknown",
        purpose: purpose ?? "unknown",
        errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
      throw error;
    }
  }
}

export const recoveryTemplatePreparer = new RecoveryTemplatePreparer();
