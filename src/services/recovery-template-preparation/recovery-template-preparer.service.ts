import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { whatsAppService } from "../whatsapp.service.js";
import { BindingUnavailable, RecoveryVariableResolver } from "./recovery-template-brand.js";
import { createProductionShopBrandMediaAdapter } from "../shop-brand-media-runtime/resolver.js";
import {
  createProductionRecoveryProductImageResolver,
  type PreparedOutreachProductMedia,
  type RecoveryProductImageResolver,
} from "../recovery-product-media/recovery-product-image-resolver.js";
import { prepareFrozenComponents } from "./recovery-template-bindings.js";
import { PrismaRecoveryTemplateRepository } from "./recovery-template-repository.js";
import { purposeFor, selectRecoveryAssignment } from "./recovery-template-selection.js";
import type {
  BrandMediaResolver, MediaApprovedHosts,
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
    private readonly resolveReadyShopBrandMedia?: BrandMediaResolver,
    /** Test-injectable allowlist; production derives hosts from Admin publicMedia. */
    private readonly approvedMediaHosts?: MediaApprovedHosts,
    private readonly clock: () => Date = () => new Date(),
    private readonly logger: Pick<StructuredLogger, "warn" | "error"> = defaultLogger,
    private readonly createProductImageResolver: () => Pick<RecoveryProductImageResolver, "prepareForBinding"> =
      createProductionRecoveryProductImageResolver,
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
          !["NO_OFFER", "CODE_OFFER", "AUTOMATIC_OFFER"].includes(input.offerPresentation) ||
          (input.stage === "INITIAL" && !["CHECKOUT", "ALTERNATIVE_PRODUCT"].includes(String(input.promotionTarget)))) {
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

      const selectionInput = {
        shop: catalogue.shop, shopId: input.shopId, senderWabaId: configuredSender,
        purpose, variants: catalogue.variants,
        stage: input.stage, offer: input.offerPresentation,
        offerCount: input.verifiedOffer?.codes?.length ?? 1,
        ...(input.promotionTarget ? { promotionTarget: input.promotionTarget } : {}),
        conversationLanguageTag: input.conversationLanguageTag,
        merchantLanguageTag: input.merchantLanguageTag,
        platformFallbackEnabled: input.platformFallbackEnabled ?? false,
        platformFallbackLanguageTag: input.platformFallbackLanguageTag ?? null,
        logger: this.logger,
      } as const;
      const select = (headerFormat: "TEXT" | "IMAGE") => selectRecoveryAssignment({
        ...selectionInput, headerFormat,
      });
      let selectedFormat: "TEXT" | "IMAGE" = "TEXT";
      let selected = input.stage === "INITIAL" && input.productImage
        ? select("IMAGE")
        : { outcome: "unavailable" as const, reason: "NO_APPROVED_ASSIGNMENT" as const };
      let productMedia: PreparedOutreachProductMedia | undefined;
      if (selected.outcome === "selected" && input.productImage) {
        productMedia = await this.createProductImageResolver().prepareForBinding(input.productImage);
        if (productMedia.result.kind === "READY") selectedFormat = "IMAGE";
        else selected = { outcome: "unavailable", reason: "NO_APPROVED_ASSIGNMENT" };
      }
      if (selected.outcome !== "selected") {
        if (selected.reason === "IDENTITY_MISMATCH") return unavailable(selected.reason);
        selected = select("TEXT");
        selectedFormat = "TEXT";
        productMedia = undefined;
      }
      if (selected.outcome === "unavailable") return unavailable(selected.reason);

      let selectedAssignment = selected.value;
      let registration = selectedAssignment.variant.metaRegistration!;
      // Lazy operation-scoped adapter: TEXT-only messages never read publicMedia,
      // and no platform config is cached across separate preparations.
      const productionMedia = !this.resolveReadyShopBrandMedia || !this.approvedMediaHosts
        ? createProductionShopBrandMediaAdapter() : null;
      const variablesFor = (readyProduct?: PreparedOutreachProductMedia) => new RecoveryVariableResolver(
        input, (shopId) => this.repository.readShopBrand(shopId),
        this.resolveReadyShopBrandMedia ?? productionMedia!.resolve,
        this.approvedMediaHosts ?? productionMedia!.approvedHosts, this.clock,
        (shopId, languageTag) => this.repository.readShopCategory(shopId, languageTag),
        selectedAssignment.canonicalLanguageTag,
        readyProduct?.result.kind === "READY" ? readyProduct.result.publicImageUrl : undefined,
        readyProduct?.result.kind === "READY" ? readyProduct.validateBeforeBinding : undefined,
      );
      let preparedBindings: Awaited<ReturnType<typeof prepareFrozenComponents>>;
      try {
        preparedBindings = await prepareFrozenComponents({ registration, variables: variablesFor(productMedia) });
      } catch (error) {
        if (selectedFormat !== "IMAGE" || !(error instanceof BindingUnavailable) ||
            error.reason !== "MEDIA_NOT_READY") throw error;
        const textFallback = select("TEXT");
        if (textFallback.outcome !== "selected") return unavailable(textFallback.reason);
        selectedAssignment = textFallback.value;
        selectedFormat = "TEXT";
        registration = selectedAssignment.variant.metaRegistration!;
        preparedBindings = await prepareFrozenComponents({ registration, variables: variablesFor(undefined) });
      }
      return {
        outcome: "prepared", shopId: input.shopId, senderWabaId: configuredSender,
        purpose, variantId: selectedAssignment.variant.id, registrationId: registration.id,
        definitionId: registration.locale.definition.id,
        providerTemplateId: registration.providerTemplateId!,
        providerTemplateName: registration.providerTemplateName,
        providerLanguageCode: registration.providerLanguageCode,
        canonicalLanguageTag: selectedAssignment.canonicalLanguageTag,
        selectionSource: selectedAssignment.selectionSource,
        submittedContentHash: registration.submittedContentHash,
        bindingFingerprint: preparedBindings.bindingFingerprint,
        template: {
          name: registration.providerTemplateName,
          language: { code: registration.providerLanguageCode },
          components: preparedBindings.components,
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
        // The Shared logger performs bounded, stack-free Error serialization.
        // Do not duplicate arbitrary provider/database messages into fields.
        error: error,
      });
      throw error;
    }
  }
}

export const recoveryTemplatePreparer = new RecoveryTemplatePreparer();
