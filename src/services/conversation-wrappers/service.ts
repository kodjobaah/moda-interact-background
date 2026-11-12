import { prepareRecoveryReplyBody, hasPreparedRecoveryShopHeader, type RecoveryShopHeaderReceipt } from "./recovery-shop-header.js";
import { wrapperApplicationKey } from "./application-key.js";
import { validRecoveryCheckoutFooterUrl, hasPreparedRecoveryCheckoutFooter, recoveryReplyContentPreserved } from "./recovery-checkout-footer.js";
import { prepareConversationDelivery } from "../conversation-product-media.js";
import { ConversationDeliveryPlanSchema, composeCommerceWhatsAppPreview } from "@modainteract/moda-interact-shared/commerce/presentation";
import {
  createLogger, type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type {
  RenderConversationResponseInput, WrappedResult, WrapperReadPort,
  WrapperRefusal, WrapperRenderResult, PreparedWrapper,
} from "./contracts.js";
import { digest, readPreparedWrapper, stableJson } from "./projection.js";
import { PrismaConversationWrapperReadRepository } from "./repository.js";
import { renderPreparedWrapper, MAX_WHATSAPP_TEXT_LENGTH } from "./render.js";
import { chooseSlot, languageChoices, validDefinition } from "./selection.js";
import { canonicalTag } from "./selection.js";
import { resolveModaConfigurationLocale } from "@modainteract/moda-interact-shared/internationalization";

const defaultLogger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export type ConversationWrapperDependencies = Readonly<{
  repository?: WrapperReadPort;
  mediaDependencies?: Parameters<typeof prepareConversationDelivery>[1];
  logger?: StructuredLogger;
  /** No wrapper is returned as unavailable unless policy opts into safe passthrough. */
  onMissingSlot?: "unavailable" | "passthrough";
  platformFallbackLanguageTag?: string | null;
}>;

/** Prepared message only. BG008/BG009 own whole-message moderation and sending. */
export class ConversationWrapperService {
  private readonly repository: WrapperReadPort;
  private readonly logger: StructuredLogger;

  constructor(private readonly dependencies: ConversationWrapperDependencies = {}) {
    this.repository = dependencies.repository ?? new PrismaConversationWrapperReadRepository();
    this.logger = dependencies.logger ?? defaultLogger;
  }

  async renderConversationResponse(input: RenderConversationResponseInput): Promise<WrapperRenderResult> {
    if (!input || !["AI", "HUMAN"].includes(input.source) ||
        !input.conversationId || typeof input.conversationId !== "string" || input.conversationId.length > 128 ||
        !input.messageIdentity || typeof input.messageIdentity !== "string" || input.messageIdentity.length > 128 ||
        typeof input.responseBody !== "string" || !input.responseBody.trim()) {
      return { kind: "rejected", reason: "INVALID_INPUT" };
    }
    if (input.commercePresentation && input.source !== "AI") return { kind: "rejected", reason: "INVALID_INPUT" };
    const candidates = input.commercePresentation ? undefined : input.hostComposedReplyCandidates;
    const presentationDigest = input.commercePresentation ? digest(stableJson({envelope: input.commercePresentation.envelope, verified: input.commercePresentation.verified, productPairs: input.commercePresentation.productPairs ?? [], verifiedProducts: input.commercePresentation.verifiedProducts ?? null})) : null;
    if (candidates !== undefined && (input.source !== "AI" || !Array.isArray(candidates) ||
        candidates.length < 1 || candidates.length > 3 ||
        candidates.some((candidate) => typeof candidate !== "string" || !candidate.trim() || candidate.length > MAX_WHATSAPP_TEXT_LENGTH) ||
        candidates[0] !== input.responseBody)) {
      return { kind: "rejected", reason: "INVALID_INPUT" };
    }
    const responseBodies = candidates ?? [input.responseBody];
    if (!input.commercePresentation && input.responseBody.length > MAX_WHATSAPP_TEXT_LENGTH) {
      return { kind: "rejected", reason: "OUTPUT_TOO_LONG" };
    }
    try {
      // The caller may retain an already prepared, already moderated outbound
      // result across retries. It MUST be scoped to this conversation/message and
      // original response, even when an Admin later switches the active slot.
      if (input.previousApplication) {
        const prior = input.previousApplication;
        const matchedBody = presentationDigest !== null
          ? ((prior.deliveryPlan ? ConversationDeliveryPlanSchema.safeParse(prior.deliveryPlan).success && prior.deliveryPlan.body === prior.body && digest(stableJson({presentationDigest, deliveryPlan: prior.deliveryPlan})) === prior.responseDigest : presentationDigest === prior.responseDigest) ? input.responseBody : undefined)
          : responseBodies.find((body) => digest(body) === prior.responseDigest);
        if (prior.kind !== "rendered" || prior.source !== input.source ||
            prior.messageIdentity !== input.messageIdentity || !matchedBody ||
            prior.body.length > MAX_WHATSAPP_TEXT_LENGTH ||
            (prior.recoveryCheckoutUrl !== undefined && (!validRecoveryCheckoutFooterUrl(prior.recoveryCheckoutUrl) ||
              !hasPreparedRecoveryCheckoutFooter(prior.body, prior.recoveryCheckoutUrl))) ||
            (prior.recoveryShopHeader !== undefined && !hasPreparedRecoveryShopHeader(prior.body, prior.recoveryShopHeader)) ||
            (!presentationDigest && (prior.recoveryCheckoutUrl
              ? !recoveryReplyContentPreserved(matchedBody, prior.body, prior.recoveryCheckoutUrl) : !prior.body.includes(matchedBody))) ||
            prior.applicationKey !== wrapperApplicationKey({
              conversationId: input.conversationId, messageIdentity: prior.messageIdentity,
              source: prior.source, wrapperDefinitionId: prior.wrapperDefinitionId, localeId: prior.localeId,
              contentHash: prior.contentHash, editVersion: prior.slotEditVersion, responseDigest: prior.responseDigest,
              body: prior.body, ...(prior.recoveryCheckoutUrl ? {recoveryCheckoutUrl: prior.recoveryCheckoutUrl} : {}),
              ...(prior.recoveryShopHeader ? {recoveryShopHeader: prior.recoveryShopHeader} : {}),
              ...(prior.deliveryPlan ? {deliveryPlan: prior.deliveryPlan} : {}),
            })) return this.refuse("rejected", "REPLAY_MISMATCH", input);
        this.logger.info("conversation_wrapper.replay_reused", {
          conversationId: input.conversationId, source: input.source,
          definitionId: prior.wrapperDefinitionId, localeId: prior.localeId,
          applicationKey: prior.applicationKey,
        });
        return { ...prior, replayed: true };
      }

      const context = await this.repository.loadContext(input.conversationId);
      if (context === "TENANT_MISMATCH") return this.refuse("rejected", "TENANT_MISMATCH", input);
      if (!context) return this.refuse("unavailable", "CONVERSATION_UNAVAILABLE", input);
      const checkoutUrl = context.checkoutAvailable
        ? context.variables["checkout.url"] : undefined;
      if (checkoutUrl !== undefined && !validRecoveryCheckoutFooterUrl(checkoutUrl)) {
        return this.refuse("rejected", "VARIABLE_UNAVAILABLE", input);
      }
      const slots = await this.repository.loadSlots();
      if (input.commercePresentation) {
        const compositionInput = {
          responseStyle: "AGENT" as const,
          envelope: input.commercePresentation.envelope,
          presentation: input.commercePresentation.verified,
          ...(context.conversationLanguageTag ? { locale: context.conversationLanguageTag } : {}),
          brandName: context.variables["shopBrand.brandName"] ?? context.variables["shop.name"] ?? null,
          wrapper: { slots, context, digest, platformFallbackLanguageTag: this.dependencies.platformFallbackLanguageTag ?? null },
        };
        let composed = composeCommerceWhatsAppPreview(compositionInput);
        // A checkout-only suffix can resemble an already-wrapped AI answer.
        // Retry only that refusal without the optional checkout conditional;
        // unrelated published header/footer guards still run unchanged.
        if (composed.kind === "refused" && composed.reason === "ALREADY_WRAPPED" && checkoutUrl) {
          composed = composeCommerceWhatsAppPreview({...compositionInput,
            wrapper: {...compositionInput.wrapper, context: {...context, checkoutAvailable: false}}});
        }
        try { this.logger.info('commerce.response.composition', {
          stage: 'RESULT', purpose: 'live', conversationId: input.conversationId,
          messageIdentity: input.messageIdentity, outcome: composed.kind,
          disposition: input.commercePresentation.verified.disposition,
          productCount: input.commercePresentation.verified.products.length,
          optionCount: input.commercePresentation.verified.optionFacts.length,
          detailCount: (input.commercePresentation.verified.productFacts?.length ?? 0),
          reason: composed.kind === 'refused' ? composed.reason : null,
          ...(composed.kind === 'refused' ? {failureCode: composed.reason === 'DEADLINE' ? 'DEADLINE' : composed.reason === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'INVALID_FINAL', failureStage: 'response.compose', reasonCode: composed.reason} : {}),
        }); } catch { /* Diagnostics must never affect delivery. */ }
        if (composed.kind === "refused") return this.refuse("rejected", composed.reason as WrapperRefusal, input);
        const selected = composed.wrapper ? chooseSlot(slots, "AI") : null;
        let prepared: PreparedWrapper | undefined;
        if (composed.wrapper) {
          if (!selected || selected === "invalid") return this.refuse("rejected", "DEFINITION_UNAVAILABLE", input);
          const localeRow = selected.definition.locales.find(row => row.id === composed.wrapper!.localeId)!;
          const projection = readPreparedWrapper(localeRow.localeAst, localeRow.contentHash);
          if (projection.kind !== "ok") return this.refuse("rejected", "PREPARED_INVALID", input);
          prepared = projection.prepared;
        }
        const footer = prepareRecoveryReplyBody({body: composed.body, source: input.source, context, ...(prepared ? {prepared} : {})});
        if (footer.kind === "rejected") return this.refuse("rejected", footer.reason, input);
        const body = footer.body;
        const p = input.commercePresentation.verified;
        const facts = p.disposition === 'PRODUCT_DETAILS' ? p.productFacts : p.disposition === 'PRODUCT_OPTIONS' ? p.optionFacts : null;
        const presentedPairs = input.commercePresentation.envelope.answerKind === 'ANSWER'
          ? facts ? facts.map(({productId, variantId}) => ({productId, variantId})) : [...(input.commercePresentation.productPairs ?? [])] : [];
        const planInput = {body, shopId: context.shopId, displayedPairs: presentedPairs,
          verifiedProducts: input.commercePresentation.verifiedProducts,
          deadlineAt: input.commercePresentation.deadlineAt ?? Date.now(), signal: input.commercePresentation.signal};
        if (!composed.wrapper) {
          const {plan} = await prepareConversationDelivery(planInput, this.dependencies.mediaDependencies);
          return {kind: "no-wrapper", body, reason: "NOT_CONFIGURED", ...(footer.recoveryCheckoutUrl ? {recoveryCheckoutUrl: footer.recoveryCheckoutUrl} : {}), ...(footer.recoveryShopHeader ? {recoveryShopHeader: footer.recoveryShopHeader} : {}), presentedPairs, deliveryPlan: plan};
        }
        if (!selected || selected === "invalid") return this.refuse("rejected", "DEFINITION_UNAVAILABLE", input);
        const mediaResult = await prepareConversationDelivery({...planInput, binding: prepared?.productImage}, this.dependencies.mediaDependencies);
        const deliveryPlan = mediaResult.plan;
        const mediaLog = mediaResult.mediaOmission === "IMAGE_IDENTITY_MISMATCH" ? this.logger.error.bind(this.logger) : this.logger.info.bind(this.logger);
        mediaLog("conversation.product_media", {shopId:context.shopId,conversationId:input.conversationId,
          messageIdentity:input.messageIdentity,planKind:deliveryPlan.kind, omission:mediaResult.mediaOmission,
          stage:mediaResult.mediaStage, durationMs:mediaResult.durationMs, productId:presentedPairs[0]?.productId ?? null, variantId:presentedPairs[0]?.variantId ?? null});
        const responseDigest = digest(stableJson({presentationDigest, deliveryPlan}));
        const applicationKey = wrapperApplicationKey({
          conversationId: input.conversationId, messageIdentity: input.messageIdentity, source: input.source,
          wrapperDefinitionId: composed.wrapper.definitionId, localeId: composed.wrapper.localeId,
          contentHash: composed.wrapper.contentHash, editVersion: composed.wrapper.slotEditVersion,
          responseDigest, body, deliveryPlan,
          ...(footer.recoveryCheckoutUrl ? {recoveryCheckoutUrl: footer.recoveryCheckoutUrl} : {}),
          ...(footer.recoveryShopHeader ? {recoveryShopHeader: footer.recoveryShopHeader} : {}),
        });
        return { kind: "rendered", body, wrapperDefinitionId: composed.wrapper.definitionId,
          localeId: composed.wrapper.localeId, contentHash: composed.wrapper.contentHash,
          slotEditVersion: composed.wrapper.slotEditVersion, audience: selected.audience as WrappedResult["audience"],
          languageTag: selected.definition.locales.find(row => row.id === composed.wrapper!.localeId)?.languageTag ?? "en",
          messageIdentity: input.messageIdentity, source: input.source, applicationKey, responseDigest, deliveryPlan, replayed: false, ...(footer.recoveryCheckoutUrl ? {recoveryCheckoutUrl: footer.recoveryCheckoutUrl} : {}), ...(footer.recoveryShopHeader ? {recoveryShopHeader: footer.recoveryShopHeader} : {}), ...(presentedPairs ? { presentedPairs } : {}) };
      }
      const slot = chooseSlot(slots, input.source);
      if (slot === "invalid") return this.refuse("rejected", "DEFINITION_UNAVAILABLE", input);
      if (!slot) {
        if (this.dependencies.onMissingSlot === "passthrough") {
          this.logger.info("conversation_wrapper.passthrough", {
            conversationId: input.conversationId, source: input.source, reason: "NOT_CONFIGURED",
          });
          const footer = prepareRecoveryReplyBody({body: input.responseBody, source: input.source, context});
          if (footer.kind === "rejected") return this.refuse("rejected", footer.reason, input);
          return { kind: "no-wrapper", body: footer.body, reason: "NOT_CONFIGURED",
            ...(footer.recoveryCheckoutUrl ? {recoveryCheckoutUrl: footer.recoveryCheckoutUrl} : {}), ...(footer.recoveryShopHeader ? {recoveryShopHeader: footer.recoveryShopHeader} : {}) };
        }
        return this.refuse("unavailable", "NOT_CONFIGURED", input);
      }
      if (!validDefinition(slot.definition, slot)) return this.refuse("rejected", "DEFINITION_UNAVAILABLE", input);
      const choices = languageChoices({
        conversationTag: context.conversationLanguageTag,
        merchantTag: context.merchantLanguageTag,
        preferredTag: input.languageTag,
        platformFallbackTag: this.dependencies.platformFallbackLanguageTag ?? null,
      }, (error) => this.logger.warn("conversation_wrapper.invalid_language_exception", {
        conversationId: input.conversationId, errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
        error,
      }));
      if (choices === "invalid") return this.refuse("rejected", "INVALID_LANGUAGE", input);
      let lookupChoices = choices;
      if (candidates !== undefined) {
        try {
          const effectiveTag = canonicalTag(context.conversationLanguageTag);
          const bodyLocale = resolveModaConfigurationLocale(effectiveTag);
          const locale = new Intl.Locale(bodyLocale);
          const ordered = [effectiveTag, bodyLocale, ...choices].filter((tag): tag is string => tag !== null);
          lookupChoices = [...new Set(ordered)].filter((tag) => {
            const candidateLocale = new Intl.Locale(tag);
            return candidateLocale.language === locale.language &&
              resolveModaConfigurationLocale(tag) === bodyLocale;
          });
        } catch { return this.refuse("rejected", "INVALID_LANGUAGE", input); }
      }
      const locale = lookupChoices.map((tag) => slot.definition.locales.find((row) => row.languageTag === tag))
        .find((found) => found !== undefined);
      if (!locale) return this.refuse("unavailable", "LOCALE_UNAVAILABLE", input);
      const sourceLocale = locale.languageTag === "en";
      if (locale.status !== (sourceLocale ? "SOURCE_SAVED" : "REVIEWED") ||
          locale.providerLanguageCode !== null ||
          (!sourceLocale && (!locale.reviewedAt || !locale.reviewedByAdminId))) {
        return this.refuse("rejected", "LOCALE_UNAVAILABLE", input);
      }
      const projection = readPreparedWrapper(locale.localeAst, locale.contentHash);
      if (projection.kind !== "ok") return this.refuse("rejected",
        projection.kind === "missing" ? "PREPARED_MISSING" : "PREPARED_INVALID", input);
      let rendered: ReturnType<typeof renderPreparedWrapper> | undefined;
      let responseDigest = digest(input.responseBody);
      let recoveryCheckoutUrl: string | undefined;
      let recoveryShopHeader: RecoveryShopHeaderReceipt | undefined;
      for (const body of responseBodies) {
        rendered = renderPreparedWrapper({ prepared: projection.prepared, context, responseBody: body });
        if (rendered.kind === "rejected" && rendered.reason === "ALREADY_WRAPPED" && checkoutUrl) {
          rendered = renderPreparedWrapper({prepared: projection.prepared,
            context: {...context, checkoutAvailable: false}, responseBody: body});
        }
        responseDigest = digest(body);
        if (rendered.kind === "rendered") {
          const footer = prepareRecoveryReplyBody({body: rendered.body, source: input.source, context, prepared: projection.prepared});
          if (footer.kind === "ready") {
            rendered = {kind: "rendered", body: footer.body};
            recoveryCheckoutUrl = footer.recoveryCheckoutUrl;
            recoveryShopHeader = footer.recoveryShopHeader;
            break;
          }
          rendered = footer;
        }
        if (rendered.reason !== "OUTPUT_TOO_LONG") return this.refuse("rejected", rendered.reason, input);
      }
      if (!rendered || rendered.kind !== "rendered") return this.refuse("rejected", "OUTPUT_TOO_LONG", input);
      const applicationKey = wrapperApplicationKey({
        conversationId: input.conversationId, messageIdentity: input.messageIdentity, source: input.source,
        wrapperDefinitionId: slot.definitionId, localeId: locale.id, contentHash: locale.contentHash!,
        editVersion: slot.editVersion, responseDigest, body: rendered.body,
        ...(recoveryCheckoutUrl ? {recoveryCheckoutUrl} : {}), ...(recoveryShopHeader ? {recoveryShopHeader} : {}),
      });
      const value: WrappedResult = {
        kind: "rendered", body: rendered.body, wrapperDefinitionId: slot.definitionId,
        localeId: locale.id, audience: slot.audience as WrappedResult["audience"],
        slotEditVersion: slot.editVersion, languageTag: locale.languageTag,
        contentHash: locale.contentHash!, source: input.source,
        messageIdentity: input.messageIdentity, applicationKey, responseDigest,
        replayed: false,
        ...(recoveryCheckoutUrl ? {recoveryCheckoutUrl} : {}), ...(recoveryShopHeader ? {recoveryShopHeader} : {}),
      };
      this.logger.info("conversation_wrapper.rendered", {
        conversationId: input.conversationId, source: input.source,
        definitionId: slot.definitionId, localeId: locale.id,
        slotEditVersion: slot.editVersion, outputLength: value.body.length,
        applicationKey,
      });
      return value;
    } catch (error) {
      // Exception is never turned into a missing-template response. Preserve retry
      // semantics; do not log sensitive response text, checkout URLs or DB payloads.
      this.logger.error("conversation_wrapper.render_exception", {
        conversationId: input.conversationId, source: input.source,
        errorType: error instanceof Error ? error.name : "unknown",
        errorCode: error && typeof error === "object" && "code" in error &&
          typeof error.code === "string" ? error.code.slice(0, 48) : undefined,
      });
      throw error;
    }
  }

  private refuse(kind: "unavailable" | "rejected", reason: WrapperRefusal,
    input: RenderConversationResponseInput): WrapperRenderResult {
    this.logger.warn("conversation_wrapper.refused", {
      conversationId: input.conversationId, source: input.source, reason, kind,
    });
    return { kind, reason };
  }
}

export const conversationWrapperService = new ConversationWrapperService();
export async function renderConversationResponse(input: RenderConversationResponseInput): Promise<WrapperRenderResult> {
  return conversationWrapperService.renderConversationResponse(input);
}
