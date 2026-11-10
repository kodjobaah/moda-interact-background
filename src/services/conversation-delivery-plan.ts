import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import { ConversationDeliveryPlanSchema, type ConversationDeliveryPlan } from '@modainteract/moda-interact-shared/commerce/presentation';
/** Receipt is host verified selection metadata, separate from persisted plan JSON. */
export type ConversationDeliveryReceipt = {conversationId: string; messageId: string; inboundVersion: number; controlRevision: number; shopId: string; firstPair: {productId: string; variantId: string | null} | null};
export function sameConversationPlan(actual: unknown, expected: ConversationDeliveryPlan): boolean {
 const parsed = ConversationDeliveryPlanSchema.safeParse(actual);
 return parsed.success && canonicalJson(parsed.data) === canonicalJson(expected);
}
export function validConversationPlan(plan: ConversationDeliveryPlan, body: string, shopId: string, receipt?: ConversationDeliveryReceipt): boolean {
 const parsed = ConversationDeliveryPlanSchema.safeParse(plan);
 if (!parsed.success || plan.body !== body) return false;
 if (plan.kind === 'TEXT') return true;
 return !!receipt && receipt.shopId === shopId && plan.image.shopId === shopId &&
  receipt.firstPair?.productId === plan.image.productId && receipt.firstPair.variantId === plan.image.variantId;
}

export function matchesConversationReceipt(receipt: ConversationDeliveryReceipt | undefined, identity: {shopId: string; conversationId: string; messageId: string; expectedInboundVersion?: number; expectedControlRevision?: number}): boolean {
 return !!receipt && receipt.shopId === identity.shopId && receipt.conversationId === identity.conversationId &&
  receipt.messageId === identity.messageId && receipt.inboundVersion === identity.expectedInboundVersion &&
  receipt.controlRevision === identity.expectedControlRevision;
}
