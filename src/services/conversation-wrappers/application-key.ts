import type { ConversationMediaDeliveryPlan } from "@modainteract/moda-interact-shared/commerce/presentation";
import type { RecoveryShopHeaderReceipt, WrapperSource } from "./contracts.js";
import { digest, stableJson } from "./projection.js";

/** One local preparation/replay/final-permit algorithm; absent additions keep legacy keys unchanged. */
export function wrapperApplicationKey(input: {conversationId: string; messageIdentity: string; source: WrapperSource;
 wrapperDefinitionId: string; localeId: string; contentHash: string; editVersion: number; responseDigest: string;
 compositeReceipt?: import("../recovery-multipart/composite.js").CompositeReceipt;
 commonLayout?: import("../recovery-multipart/common-layout.js").CommonLayoutReceipt; multipartPlan?: import("@modainteract/moda-interact-shared/commerce/presentation").RecoveryCompositeMultipartDeliveryPlanV2;
 body: string; recoveryCheckoutUrl?: string | undefined; recoveryShopHeader?: RecoveryShopHeaderReceipt | undefined; deliveryPlan?: ConversationMediaDeliveryPlan | undefined}): string {
 return digest(stableJson({conversationId: input.conversationId, messageIdentity: input.messageIdentity,
  source: input.source, wrapperDefinitionId: input.wrapperDefinitionId, localeId: input.localeId,
  contentHash: input.contentHash, editVersion: input.editVersion, responseDigest: input.responseDigest,
  bodyDigest: digest(input.body),
  ...(input.compositeReceipt ? {compositeReceiptDigest:digest(stableJson(input.compositeReceipt))} : {}),
  ...(input.commonLayout ? {commonLayoutDigest:digest(stableJson(input.commonLayout))} : {}),
  ...(input.multipartPlan ? {multipartPlanDigest:digest(stableJson(input.multipartPlan))} : {}),
  ...(input.recoveryCheckoutUrl ? {recoveryCheckoutUrlDigest: digest(input.recoveryCheckoutUrl)} : {}),
  ...(input.recoveryShopHeader ? {recoveryShopHeaderDigest: digest(stableJson(input.recoveryShopHeader))} : {}),
  ...(input.deliveryPlan ? {deliveryPlanDigest: digest(stableJson(input.deliveryPlan))} : {})}));
}
