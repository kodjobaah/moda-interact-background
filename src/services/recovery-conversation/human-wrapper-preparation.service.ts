import { readRecoveryShopHeader, withRecoveryShopHeader } from "../conversation-wrappers/recovery-shop-header.js";
import type { RecoveryShopHeaderReceipt } from "../conversation-wrappers/contracts.js";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type { WrapperRefusal, WrappedResult } from "../conversation-wrappers/contracts.js";
import { validRecoveryCheckoutFooterUrl, withHumanRecoveryCheckoutFooter } from "../conversation-wrappers/recovery-checkout-footer.js";
import { ConversationWrapperService } from "../conversation-wrappers/service.js";

/** ARCH-047-BG009: deterministic rendering only; SQL freezing owns moderation identity. */
export type HumanWrapperPreparation =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "passthrough"; body: string; recoveryCheckoutUrl?: string; recoveryShopHeader?: RecoveryShopHeaderReceipt }>
  | Readonly<{ kind: "prepared"; body: string; application: WrappedResult }>
  | Readonly<{ kind: "refused"; reason: WrapperRefusal | "CONTENT_MISMATCH" }>;

export type HumanWrapperCommand = Readonly<{
  id: string;
  conversationId: string;
  kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE";
  textBody: string | null;
}>;

type WrapperRenderer = Pick<ConversationWrapperService, "renderConversationResponse">;

const defaultLogger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

/**
 * Keeps the immutable, merchant-authored command input distinct from rendered
 * output. BG005 resolves the current HUMAN/SHARED slot, locale and verified
 * checkout context. Only HumanPreparedCommandService may freeze this output;
 * the dispatcher never sends this uncommitted result directly.
 */
export class HumanWrapperPreparationService {
  constructor(
    private readonly renderer: WrapperRenderer = new ConversationWrapperService({
      onMissingSlot: "passthrough",
    }),
    private readonly logger: StructuredLogger = defaultLogger,
  ) {}

  async prepare(command: HumanWrapperCommand): Promise<HumanWrapperPreparation> {
    if (command.kind !== "HUMAN_TEXT") return { kind: "not-applicable" };
    if (!command.textBody?.trim()) return { kind: "refused", reason: "INVALID_INPUT" };
    try {
      const rendered = await this.renderer.renderConversationResponse({
        conversationId: command.conversationId,
        source: "HUMAN",
        messageIdentity: command.id,
        responseBody: command.textBody,
      });
      if (rendered.kind === "no-wrapper") {
        const header = rendered.recoveryShopHeader === undefined ? null : readRecoveryShopHeader(rendered.recoveryShopHeader);
        if (rendered.recoveryShopHeader !== undefined && !header) return {kind: "refused", reason: "CONTENT_MISMATCH"};
        if (rendered.recoveryCheckoutUrl !== undefined && !validRecoveryCheckoutFooterUrl(rendered.recoveryCheckoutUrl)) return {kind: "refused", reason: "CONTENT_MISMATCH"};
        const footerBody = rendered.recoveryCheckoutUrl ? withHumanRecoveryCheckoutFooter(command.textBody, rendered.recoveryCheckoutUrl) : command.textBody;
        const expected = header ? withRecoveryShopHeader(footerBody, header) : footerBody;
        return rendered.body === expected ? {kind: "passthrough", body: rendered.body,
          ...(rendered.recoveryCheckoutUrl ? {recoveryCheckoutUrl: rendered.recoveryCheckoutUrl} : {}),
          ...(header ? {recoveryShopHeader: header} : {})} : {kind: "refused", reason: "CONTENT_MISMATCH"};
      }
      if (rendered.kind === "rendered") {
        if (rendered.source !== "HUMAN" || rendered.messageIdentity !== command.id ||
            !rendered.body.includes(command.textBody)) {
          return { kind: "refused", reason: "CONTENT_MISMATCH" };
        }
        return { kind: "prepared", body: rendered.body, application: rendered };
      }
      return { kind: "refused", reason: rendered.reason };
    } catch (error) {
      // Never convert an unexpected database/render exception into passthrough.
      this.logger.error("arch047.human_wrapper.prepare_failed", {
        commandId: command.id,
        errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
      throw error;
    }
  }
}
