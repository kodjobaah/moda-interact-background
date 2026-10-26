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
    if (input.responseBody.length > MAX_WHATSAPP_TEXT_LENGTH) {
      return { kind: "rejected", reason: "OUTPUT_TOO_LONG" };
    }
    const responseDigest = digest(input.responseBody);
    try {
      // The caller may retain an already prepared, already moderated outbound
      // result across retries. It MUST be scoped to this conversation/message and
      // original response, even when an Admin later switches the active slot.
      if (input.previousApplication) {
        const prior = input.previousApplication;
        if (prior.kind !== "rendered" || prior.source !== input.source ||
            prior.messageIdentity !== input.messageIdentity || prior.responseDigest !== responseDigest ||
            prior.body.length > MAX_WHATSAPP_TEXT_LENGTH ||
            !prior.body.includes(input.responseBody) ||
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
      }));
      if (choices === "invalid") return this.refuse("rejected", "INVALID_LANGUAGE", input);
      const locale = choices.map((tag) => slot.definition.locales.find((row) => row.languageTag === tag))
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
      const rendered = renderPreparedWrapper({ prepared: projection.prepared,
        context, responseBody: input.responseBody });
      if (rendered.kind !== "rendered") return this.refuse("rejected", rendered.reason, input);
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
