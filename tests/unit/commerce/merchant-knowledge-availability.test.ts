import { describe, expect, it, vi } from 'vitest';
import { filterMerchantKnowledgeAvailability } from '../../../src/commerce/merchant-knowledge-availability.js';
describe('optional merchant knowledge availability', () => {
  it('removes unenabled knowledge while preserving unrelated tools and tenant-scoped lookup', async () => {
    const findFirst = vi.fn(async () => null);
    const names = await filterMerchantKnowledgeAvailability({ shopFeaturePreference: { findFirst } } as never, 'shop', new Set(['merchant_knowledge_lookup', 'commerce_search_products']));
    expect([...names]).toEqual(['commerce_search_products']);
    expect(findFirst).toHaveBeenCalledWith({ where: { shopId: 'shop', enabled: true, feature: { key: 'merchant_knowledge', active: true } }, select: { id: true } });
  });
  it('retains enabled knowledge and does not query if no knowledge tool is granted', async () => {
    const findFirst = vi.fn(async () => ({ id: 'preference' }));
    const db = { shopFeaturePreference: { findFirst } } as never;
    expect((await filterMerchantKnowledgeAvailability(db, 'shop', new Set(['merchant_knowledge_lookup']))).has('merchant_knowledge_lookup')).toBe(true);
    await filterMerchantKnowledgeAvailability(db, 'shop', new Set(['commerce_search_products']));
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
