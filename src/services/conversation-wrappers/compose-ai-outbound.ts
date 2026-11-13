import { readCommonLayoutReceipt,commonLayoutBody } from "../recovery-multipart/common-layout.js";
import type { BrandMediaPolicyRef } from "../conversation-brand-media.js";
import { wrapperApplicationKey } from "./application-key.js";
import { readRecoveryShopHeader, withRecoveryShopHeader, hasPreparedRecoveryShopHeader } from "./recovery-shop-header.js";
import type { RecoveryShopHeaderReceipt } from "./contracts.js";
import { validRecoveryCheckoutFooterUrl, withRecoveryCheckoutFooter, withLegacyRecoveryCheckoutFooter, hasPreparedRecoveryCheckoutFooter } from "./recovery-checkout-footer.js";
import type { ConversationMediaDeliveryPlan } from "@modainteract/moda-interact-shared/commerce/presentation";
import type {
  RenderConversationResponseInput,
  CommercePresentationInput,
  WrapperRefusal,
  WrapperRenderResult,
} from "./contracts.js";

/**
 * Narrow adapter between the customer-visible AI turn and BG005. No provider,
 * authoring AST, moderation, billing or checkout access belongs here.
 *
 * A missing active slot is a deliberate unwrapped reply, while a configured
 * slot that cannot be safely rendered must never fall back to raw model text.
 */
export type AiOutboundComposition =
  | Readonly<{
      kind: "ready";
      text: string;
      commonLayout?: import("../recovery-multipart/common-layout.js").CommonLayoutReceipt;
      multipartPlan?: import("@modainteract/moda-interact-shared/commerce/presentation").RecoveryMultipartDeliveryPlan;
      recoveryShopHeader?: RecoveryShopHeaderReceipt;
      brandMediaPolicy?: BrandMediaPolicyRef; deliveryPlan?: ConversationMediaDeliveryPlan;
      presentedPairs?: readonly { productId: string; variantId: string | null }[];
      wrapper: null | Readonly<{
        applicationKey: string;
        wrapperDefinitionId: string;
        localeId: string;
        contentHash: string;
        slotEditVersion: number;
        replayed: boolean;
      }>;
    }>
  | Readonly<{ kind: "refused"; reason: WrapperRefusal }>;

export type AiConversationWrapper = Readonly<{
  renderConversationResponse(
    input: RenderConversationResponseInput,
  ): Promise<WrapperRenderResult>;
}>;

export async function composeAiOutbound(
  wrapper: AiConversationWrapper,
  input: Readonly<{
    conversationId: string;
    messageId: string;
    generatedResponse: string;
    hostComposedReplyCandidates?: readonly string[];
    commercePresentation?: CommercePresentationInput;
  }>,
): Promise<AiOutboundComposition> {
  const result = await wrapper.renderConversationResponse({
    conversationId: input.conversationId,
    messageIdentity: input.messageId,
    responseBody: input.generatedResponse,
    ...(input.hostComposedReplyCandidates ? { hostComposedReplyCandidates: input.hostComposedReplyCandidates } : {}),
    ...(input.commercePresentation ? { commercePresentation: input.commercePresentation } : {}),
    source: "AI",
    // BG005 reads the committed conversation language itself. Passing the
    // model's low-confidence guess here could contradict that durable choice.
  });
  if (result.kind === "rendered") {
    if (result.commonLayout && (!readCommonLayoutReceipt(result.commonLayout,input.conversationId) || commonLayoutBody(result.commonLayout)!==result.body || !result.multipartPlan)) throw new Error("AI_WRAPPER_PROVENANCE_MISMATCH");
    if (result.messageIdentity !== input.messageId || result.source !== "AI" ||
        (result.recoveryShopHeader !== undefined && !hasPreparedRecoveryShopHeader(result.body, result.recoveryShopHeader)) ||
        result.applicationKey !== wrapperApplicationKey({conversationId: input.conversationId, messageIdentity: result.messageIdentity, source: result.source, wrapperDefinitionId: result.wrapperDefinitionId, localeId: result.localeId, contentHash: result.contentHash, editVersion: result.slotEditVersion, responseDigest: result.responseDigest, body: result.body, ...(result.commonLayout?{commonLayout:result.commonLayout}:{}), ...(result.multipartPlan?{multipartPlan:result.multipartPlan}:{}), recoveryCheckoutUrl: result.recoveryCheckoutUrl, recoveryShopHeader: result.recoveryShopHeader, deliveryPlan: result.deliveryPlan})) {
      throw new Error("AI_WRAPPER_PROVENANCE_MISMATCH");
    }
    return {
      kind: "ready",
      text: result.body,
      ...(result.commonLayout?{commonLayout:result.commonLayout,multipartPlan:result.multipartPlan}:{}),
      ...(result.recoveryShopHeader ? {recoveryShopHeader: result.recoveryShopHeader} : {}),
      ...(result.brandMediaPolicy ? {brandMediaPolicy:result.brandMediaPolicy} : {}), ...(result.deliveryPlan ? {deliveryPlan: result.deliveryPlan} : {}),
      ...(result.presentedPairs ? { presentedPairs: result.presentedPairs } : {}),
      wrapper: {
        applicationKey: result.applicationKey,
        wrapperDefinitionId: result.wrapperDefinitionId,
        localeId: result.localeId,
        contentHash: result.contentHash,
        slotEditVersion: result.slotEditVersion,
        replayed: result.replayed,
      },
    };
  }
  if (result.kind === "no-wrapper") {
    // Only the trusted recovery footer may augment an unwrapped plain reply.
    if (result.recoveryCheckoutUrl !== undefined && (!validRecoveryCheckoutFooterUrl(result.recoveryCheckoutUrl) ||
        !hasPreparedRecoveryCheckoutFooter(result.body, result.recoveryCheckoutUrl))) {
      throw new Error("AI_WRAPPER_PASSTHROUGH_MISMATCH");
    }
    const header = result.recoveryShopHeader === undefined ? null : readRecoveryShopHeader(result.recoveryShopHeader);
    if (result.recoveryShopHeader !== undefined && (!header || !hasPreparedRecoveryShopHeader(result.body, header))) throw new Error("AI_WRAPPER_PASSTHROUGH_MISMATCH");
    const decorate = (body: string) => header ? withRecoveryShopHeader(body, header) : body;
    const expectedBody = decorate( result.recoveryCheckoutUrl
      ? withRecoveryCheckoutFooter(input.generatedResponse, result.recoveryCheckoutUrl) : input.generatedResponse);
    const legacyBody = decorate(result.recoveryCheckoutUrl ? withLegacyRecoveryCheckoutFooter(input.generatedResponse, result.recoveryCheckoutUrl) : input.generatedResponse);
    if (!input.commercePresentation && result.body !== expectedBody && result.body !== legacyBody) {
      throw new Error("AI_WRAPPER_PASSTHROUGH_MISMATCH");
    }
    return { kind: "ready", text: result.body,
      ...(result.recoveryShopHeader ? {recoveryShopHeader: result.recoveryShopHeader} : {}), ...(result.brandMediaPolicy ? {brandMediaPolicy:result.brandMediaPolicy} : {}), ...(result.deliveryPlan ? {deliveryPlan: result.deliveryPlan} : {}), ...(result.presentedPairs ? { presentedPairs: result.presentedPairs } : {}), wrapper: null };
  }
  return { kind: "refused", reason: result.reason };
}
