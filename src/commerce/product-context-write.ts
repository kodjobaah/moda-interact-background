import { CommerceConversationProductContextSchema, recordCommerceProductPresentation, type CommerceConversationProductContext } from '@modainteract/moda-interact-shared/commerce';
export type PresentedPair = { productId: string; variantId: string | null };
/** Readers always accept v1 extensions; only literal true enables persistence. */
export function productContextForPersistence(context: CommerceConversationProductContext, enabled = process.env.COMMERCE_PRODUCT_REFERENCE_V2_WRITE_ENABLED === 'true'): CommerceConversationProductContext {
  const parsed = CommerceConversationProductContextSchema.parse(context);
  if (enabled) return parsed;
  const { presentation: _presentation, ...legacy } = parsed;
  return { ...legacy, references: legacy.references.map(({ selectedOptions: _options, ...reference }) => reference) };
}
export function presentedProductContext(context: CommerceConversationProductContext, pairs: readonly PresentedPair[], now: Date): CommerceConversationProductContext {
  return recordCommerceProductPresentation(context, pairs, { shopId: context.shopId, conversationId: context.conversationId, platform: context.platform, now: now.getTime() });
}
