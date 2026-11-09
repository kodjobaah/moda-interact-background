import { afterEach, expect, it, vi } from 'vitest';
import { mergeConversationProductContext } from '@modainteract/moda-interact-shared/commerce';
import { productContextForPersistence, presentedProductContext } from './product-context-write.js';
const now = new Date('2026-11-09T12:00:00Z');
const identity = { shopId: 'shop', conversationId: 'conversation', platform: 'WOOCOMMERCE' as const, now: +now };
const pairs = [{ productId: '30', variantId: '31' }, { productId: '10', variantId: null }, { productId: '20', variantId: null }];
const context = () => mergeConversationProductContext(null, [{ toolName: 'commerce_search_products', observedAt: now.toISOString(), products: pairs.map((pair, index) => ({ ...pair, title: ['Varnish', 'Tree', 'Shirt'][index]!, url: null, available: true, unitPrice: null, currency: null, productType: null, vendor: null, observedAt: now.toISOString(), selectedOptions: [{ name: 'Finish', value: 'Green' }] })) }], identity);
afterEach(() => vi.unstubAllEnvs());
it('records actual render order separately from recency/lexical order without persisting stock authority', () => {
 const recorded = presentedProductContext(context(), pairs, now);
 expect(recorded.presentation?.references).toEqual(pairs);
 expect(recorded.references.find(ref => ref.productId === '30')?.selectedOptions).toEqual([{ name: 'Finish', value: 'Green' }]);
 expect(JSON.stringify(recorded)).not.toMatch(/stock|quantity|unitPrice/);
 expect(() => presentedProductContext(recorded, [{ productId: 'foreign', variantId: null }], now)).toThrow();
});
it.each([undefined, 'false', 'TRUE', '1', 'true'])('enables additive persistence only for literal true: %s', value => {
 if (value === undefined) vi.stubEnv('COMMERCE_PRODUCT_REFERENCE_V2_WRITE_ENABLED', undefined); else vi.stubEnv('COMMERCE_PRODUCT_REFERENCE_V2_WRITE_ENABLED', value);
 const recorded = presentedProductContext(context(), pairs, now);
 const persisted = productContextForPersistence(recorded);
 expect(persisted.presentation).toEqual(value === 'true' ? recorded.presentation : undefined);
 expect(persisted.references.map(ref => ref.selectedOptions)).toEqual(value === 'true' ? recorded.references.map(ref => ref.selectedOptions) : [undefined, undefined, undefined]);
 expect(persisted.references.map(({ selectedOptions: _options, ...ref }) => ref)).toEqual(recorded.references.map(({ selectedOptions: _options, ...ref }) => ref));
});
