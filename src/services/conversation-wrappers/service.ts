import { presentationCandidates } from "../../commerce/presentation-receipt.js";
import { composeCommerceWhatsAppPreview } from "@modainteract/moda-interact-shared/commerce/presentation";
import {
  createLogger, type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type {
  RenderConversationResponseInput, WrappedResult, WrapperReadPort,
  WrapperRefusal, WrapperRenderResult,
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
    const presentationDigest = input.commercePresentation ? digest(stableJson(input.commercePresentation)) : null;
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
          ? (presentationDigest === prior.responseDigest ? input.responseBody : undefined)
          : responseBodies.find((body) => digest(body) === prior.responseDigest);
        if (prior.kind !== "rendered" || prior.source !== input.source ||
            prior.messageIdentity !== input.messageIdentity || !matchedBody ||
            prior.body.length > MAX_WHATSAPP_TEXT_LENGTH ||
            (!presentationDigest && !prior.body.includes(matchedBody)) ||
            prior.applicationKey !== digest(stableJson({
              conversationId: input.conversationId, messageIdentity: prior.messageIdentity,
              source: prior.source, wrapperDefinitionId: prior.wrapperDefinitionId,
              localeId: prior.localeId, contentHash: prior.contentHash,
              editVersion: prior.slotEditVersion, responseDigest: prior.responseDigest,
              bodyDigest: digest(prior.body),
            }))) return this.refuse("rejected", "REPLAY_MISMATCH", input);
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
      const slots = await this.repository.loadSlots();
      if (input.commercePresentation) {
        const composed = composeCommerceWhatsAppPreview({
          envelope: input.commercePresentation.envelope,
          presentation: input.commercePresentation.verified,
          ...(context.conversationLanguageTag ? { locale: context.conversationLanguageTag } : {}),
          brandName: context.variables["shopBrand.brandName"] ?? context.variables["shop.name"] ?? null,
          wrapper: { slots, context, digest, platformFallbackLanguageTag: this.dependencies.platformFallbackLanguageTag ?? null },
        });
        if (composed.kind === "refused") return this.refuse("rejected", composed.reason as WrapperRefusal, input);
        const receipts = presentationCandidates(input.commercePresentation);
        if (!composed.wrapper) return { kind: "no-wrapper", body: composed.body, reason: "NOT_CONFIGURED",
          ...(receipts.length ? { presentedPairs: receipts.find(receipt => receipt.body === composed.body)?.pairs ?? [] } : {}) };
        const selected = chooseSlot(slots, "AI");
        if (!selected || selected === "invalid") return this.refuse("rejected", "DEFINITION_UNAVAILABLE", input);
        const localeRow = selected.definition.locales.find(row => row.id === composed.wrapper!.localeId)!;
        const prepared = readPreparedWrapper(localeRow.localeAst, localeRow.contentHash);
        if (prepared.kind !== "ok") return this.refuse("rejected", "PREPARED_INVALID", input);
        // Replay the same bounded candidate rendering to retain the chosen candidate's native pairs.
        const chosen = composed.candidates.find(candidate => renderPreparedWrapper({ prepared: prepared.prepared, context, responseBody: candidate }).kind === "rendered");
        const presentedPairs = receipts.length ? receipts.find(receipt => receipt.body === chosen)?.pairs ?? [] : undefined;
        const responseDigest = presentationDigest!;
        const applicationKey = digest(stableJson({
          conversationId: input.conversationId, messageIdentity: input.messageIdentity, source: input.source,
          wrapperDefinitionId: composed.wrapper.definitionId, localeId: composed.wrapper.localeId,
          contentHash: composed.wrapper.contentHash, editVersion: composed.wrapper.slotEditVersion,
          responseDigest, bodyDigest: digest(composed.body),
        }));
        return { kind: "rendered", body: composed.body, wrapperDefinitionId: composed.wrapper.definitionId,
          localeId: composed.wrapper.localeId, contentHash: composed.wrapper.contentHash,
          slotEditVersion: composed.wrapper.slotEditVersion, audience: selected.audience as WrappedResult["audience"],
          languageTag: selected.definition.locales.find(row => row.id === composed.wrapper!.localeId)?.languageTag ?? "en",
          messageIdentity: input.messageIdentity, source: input.source, applicationKey, responseDigest, replayed: false, ...(presentedPairs ? { presentedPairs } : {}) };
      }
      const slot = chooseSlot(slots, input.source);
      if (slot === "invalid") return this.refuse("rejected", "DEFINITION_UNAVAILABLE", input);
      if (!slot) {
        if (this.dependencies.onMissingSlot === "passthrough") {
          this.logger.info("conversation_wrapper.passthrough", {
            conversationId: input.conversationId, source: input.source, reason: "NOT_CONFIGURED",
          });
          return { kind: "no-wrapper", body: input.responseBody, reason: "NOT_CONFIGURED" };
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
      for (const body of responseBodies) {
        rendered = renderPreparedWrapper({ prepared: projection.prepared, context, responseBody: body });
        responseDigest = digest(body);
        if (rendered.kind === "rendered") break;
        if (rendered.reason !== "OUTPUT_TOO_LONG") return this.refuse("rejected", rendered.reason, input);
      }
      if (!rendered || rendered.kind !== "rendered") return this.refuse("rejected", "OUTPUT_TOO_LONG", input);
      const applicationKey = digest(stableJson({
        conversationId: input.conversationId, messageIdentity: input.messageIdentity,
        source: input.source, wrapperDefinitionId: slot.definitionId,
        localeId: locale.id, contentHash: locale.contentHash,
        editVersion: slot.editVersion, responseDigest, bodyDigest: digest(rendered.body),
      }));
      const value: WrappedResult = {
        kind: "rendered", body: rendered.body, wrapperDefinitionId: slot.definitionId,
        localeId: locale.id, audience: slot.audience as WrappedResult["audience"],
        slotEditVersion: slot.editVersion, languageTag: locale.languageTag,
        contentHash: locale.contentHash!, source: input.source,
        messageIdentity: input.messageIdentity, applicationKey, responseDigest,
        replayed: false,
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
