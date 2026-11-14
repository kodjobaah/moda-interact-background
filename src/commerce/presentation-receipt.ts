import {
  CommerceVerifiedPresentationSchema,
  renderCommerceProductFacts,
  renderProductOptionFacts,
  renderRecommendationReply,
} from '@modainteract/moda-interact-shared/commerce/presentation';
import type { CommercePresentationInput } from '../services/conversation-wrappers/contracts.js';
import type { PresentedPair } from './product-context-write.js';

/** Candidate metadata comes from verified render inputs, never customer/model text. */
export function presentationCandidates(input: CommercePresentationInput, options: { completePrefixes?: boolean } = {}): { body: string; pairs: readonly PresentedPair[] }[] {
  const p = CommerceVerifiedPresentationSchema.parse(input.verified);
  if (input.envelope.answerKind !== 'ANSWER') return [];
  const facts = p.disposition === 'PRODUCT_DETAILS' ? p.productFacts
    : p.disposition === 'PRODUCT_OPTIONS' ? p.optionFacts : null;
  const pairs = facts ? facts.map(({ productId, variantId }) => ({ productId, variantId })) : input.productPairs ?? [];
  if (!facts && !p.products.length) return [];
  if (!facts && pairs.length !== p.products.length) throw new Error('PRODUCT_PRESENTATION_RECEIPT_MISSING');
  const render = (count: number): string => {
    if (p.disposition === 'PRODUCT_DETAILS') return renderCommerceProductFacts(p.productFacts.slice(0, count), p.locale);
    if (p.disposition === 'PRODUCT_OPTIONS') return renderProductOptionFacts(p.optionFacts.slice(0, count), p.locale);
    return renderRecommendationReply({
      locale: p.locale, disposition: p.disposition, storeUrl: p.storeUrl,
      products: p.products.slice(0, count).map(product => ({
        ...product, regularPrice: product.regularPrice ?? null,
        offerTerms: (product.offerTerms ?? []).map(term => ({
          kind: term.kind,
          ...(term.value !== undefined ? { value: term.value } : {}),
          ...(term.currency !== undefined ? { currency: term.currency } : {}),
          ...(term.code !== undefined ? { code: term.code } : {}),
          ...(term.automatic !== undefined ? { automatic: term.automatic } : {}),
        })),
      })),
      includeNoVerifiedOffer: count > 0 && p.includeNoVerifiedOffer,
      requiresShipping: p.requiresShipping, policyUrl: p.policyUrl,
    });
  };
  const counts = options.completePrefixes ? Array.from({ length: pairs.length }, (_, index) => pairs.length - index)
    : [pairs.length, ...(pairs.length > 1 ? [1] : []), 0];
  return counts
    .map(count => ({ body: render(count), pairs: pairs.slice(0, count) }));
}
