import { renderInitialOutreachPreview, InitialOutreachRenderInputSchema, type InitialOutreachRenderInput } from "@modainteract/moda-interact-shared/commerce/outreach";
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
import { decideInitialCheckoutItemsBinding } from "./initial-checkout-items-policy.js";
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
      if (input.stage === "INITIAL" && input.promotionTarget !== "CHECKOUT") return unavailable("OUTSIDE_CHECKOUT");
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
        hasCustomerFirstName: Boolean(input.customerFirstName?.trim()),
        offerCount: input.verifiedOffer?.codes?.length ?? 1,
        ...(input.promotionTarget ? { promotionTarget: input.promotionTarget } : {}),
        conversationLanguageTag: input.conversationLanguageTag,
        merchantLanguageTag: input.merchantLanguageTag,
        platformFallbackEnabled: input.platformFallbackEnabled ?? false,
        platformFallbackLanguageTag: input.platformFallbackLanguageTag ?? null,
        logger: this.logger,
      } as const;
      const select = (headerFormat: "TEXT" | "IMAGE") => selectRecoveryAssignment({
        ...selectionInput, headerFormat, checkoutProductHeaderAvailable: Boolean(input.productImage),
      });
      let selectedFormat: "TEXT" | "IMAGE" = "TEXT";
      let selected = input.stage === "INITIAL"
        ? select("IMAGE")
        : { outcome: "unavailable" as const, reason: "NO_APPROVED_ASSIGNMENT" as const };
      let productMedia: PreparedOutreachProductMedia | undefined;
      if (selected.outcome === "selected") {
        const bindings = selected.value.variant.metaRegistration!.parameterBindingsSnapshot as { headerMediaRole?: string };
        if (bindings.headerMediaRole === "CHECKOUT_PRODUCT" && input.productImage) {
          productMedia = await this.createProductImageResolver().prepareForBinding(input.productImage);
        }
        // Retain the approved IMAGE assignment until its mandatory BODY
        // evidence has been validated. Only header availability may select TEXT.
        selectedFormat = "IMAGE";
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
      let checkoutItemsDecision = decideInitialCheckoutItemsBinding({
        stage: input.stage, parameterBindingsSnapshot: registration.parameterBindingsSnapshot,
      });
      if (!checkoutItemsDecision.ok) return unavailable(checkoutItemsDecision.reason);
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
      let renderedText: string | undefined;
      let headerAvailabilityFailure = false;
      const prepareSelected = async (readyProduct?: PreparedOutreachProductMedia) => {
        const variables = variablesFor(readyProduct);
        if (input.stage !== "INITIAL") return prepareFrozenComponents({ registration, variables });
        if (!input.outreachEvaluation || input.outreachEvaluation.shopId !== input.shopId) throw new BindingUnavailable("INVALID_REQUEST");
        if (!input.checkoutItems || input.checkoutItems.shopId !== input.shopId || !Array.isArray(input.checkoutItems.lineItems) || input.checkoutItems.lineItems.length === 0) throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        if (input.checkoutItems.lineItems.length !== input.outreachEvaluation.lines.length || input.checkoutItems.lineItems.some((raw, index) => {
          const line = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
          const verified = input.outreachEvaluation!.lines[index]!;
          return !line || !Number.isSafeInteger(line.quantity) || Number(line.quantity) <= 0 || line.quantity !== verified.quantity ||
            typeof line.productId === "string" && line.productId !== verified.productId ||
            (typeof line.variantId === "string" || line.variantId === null) && line.variantId !== verified.variantId;
        })) throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        // Preserve host-owned mandatory saved-brand/media validation. Shared's
        // generic shopName cannot supply a missing required semantic binding.
        const bindings = registration.parameterBindingsSnapshot as { header?: { variable: string }[]; body?: { variable: string }[] };
        for (const binding of [...(bindings.header ?? []), ...(bindings.body ?? [])]) {
          if (binding.variable !== "checkout.itemsSummary") await variables.resolve(binding.variable as Parameters<typeof variables.resolve>[0]);
        }
        const checkoutUrl = variables.checkout();
        if (!URL.canParse(checkoutUrl) || new URL(checkoutUrl).protocol !== "https:") throw new BindingUnavailable("CHECKOUT_UNTRUSTED");
        const preparedBrand = await variables.preparedBrand();
        const textKeys = new Set([...(bindings.header ?? []), ...(bindings.body ?? [])].map(binding => binding.variable));
        const preparedBrandMedia = {
          logo: textKeys.has("shopBrand.logoUrl") ? await variables.preparedBrandMedia("LOGO") : null,
          squareLogo: textKeys.has("shopBrand.squareLogoUrl") ? await variables.preparedBrandMedia("SQUARE_LOGO") : null,
          coverImage: textKeys.has("shopBrand.coverImageUrl") ? await variables.preparedBrandMedia("COVER_IMAGE") : null,
        };
        const role = (registration.parameterBindingsSnapshot as { headerMediaRole?: "LOGO" | "SQUARE_LOGO" | "COVER_IMAGE" | "CHECKOUT_PRODUCT" }).headerMediaRole;
        let headerMedia: InitialOutreachRenderInput["headerMedia"] = null;
        try {
          if (selectedFormat === "IMAGE" && role) headerMedia = { shopId: input.shopId, role,
            status: "READY", kind: "R2_DERIVATIVE", httpsUrl: await variables.imageHeader(role) };
        } catch (error) {
          headerAvailabilityFailure = error instanceof BindingUnavailable && error.reason === "MEDIA_NOT_READY";
          throw error;
        }
        const projection = JSON.parse(JSON.stringify(selectedAssignment));
        const renderInput = { schemaVersion: 1, evaluation: input.outreachEvaluation,
          preparedProjection: projection as InitialOutreachRenderInput["preparedProjection"],
          preparedBrand, preparedBrandMedia,
          variables: { shopName: await variables.resolve("shop.name"), customerFirstName: input.customerFirstName ?? null,
            checkoutUrl, shopCategory: JSON.stringify(registration.parameterBindingsSnapshot).includes("shop.categoryName")
              ? await variables.resolve("shop.categoryName") : null }, headerMedia } as const;
        const checkedInput = InitialOutreachRenderInputSchema.safeParse(renderInput);
        if (!checkedInput.success) throw new BindingUnavailable(checkedInput.error.issues.some(issue => issue.path.includes("componentsSnapshot") || issue.path.includes("parameterBindingsSnapshot")) ? "BINDINGS_INVALID" : "INVALID_REQUEST");
        const rendered = renderInitialOutreachPreview(checkedInput.data);
        if (rendered.kind !== "ready") throw new BindingUnavailable(rendered.reasonCode);
        renderedText = rendered.renderedText;
        return { components: rendered.parameters, bindingFingerprint: rendered.templateProvenance.bindingFingerprint };
      };
      let preparedBindings: Awaited<ReturnType<typeof prepareFrozenComponents>>;
      try {
        preparedBindings = await prepareSelected(productMedia);
      } catch (error) {
        if (selectedFormat !== "IMAGE" || !(error instanceof BindingUnavailable) ||
            error.reason !== "MEDIA_NOT_READY" || (input.stage === "INITIAL" && !headerAvailabilityFailure)) throw error;
        const textFallback = select("TEXT");
        if (textFallback.outcome !== "selected") return unavailable(textFallback.reason);
        selectedAssignment = textFallback.value;
        selectedFormat = "TEXT";
        registration = selectedAssignment.variant.metaRegistration!;
        checkoutItemsDecision = decideInitialCheckoutItemsBinding({
          stage: input.stage, parameterBindingsSnapshot: registration.parameterBindingsSnapshot,
        });
        if (!checkoutItemsDecision.ok) return unavailable(checkoutItemsDecision.reason);
        preparedBindings = await prepareSelected(undefined);
      }
      return {
        ...(renderedText !== undefined ? { renderedText } : {}),
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
        initialCheckoutItemsBodyPosition: checkoutItemsDecision.bodyPosition,
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
