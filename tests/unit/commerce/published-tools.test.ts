import { describe, expect, it } from 'vitest';
import { commerceDiscountBuiltInDescriptors, deduplicateTools } from '@modainteract/moda-interact-shared/commerce';
import { assertPublishedManifest, assertPublishedToolList, publishedToolEntries } from '../../../src/commerce/published-tools.js';
import { publishedManifest } from '../../fixtures/commerce/published-discounts.js';

describe('published identity admission', () => {
  it('uses the same canonical published identities for conversation and outreach', () => {
    const manifest = publishedManifest();
    expect(() => assertPublishedManifest(manifest)).not.toThrow();
    const entries = publishedToolEntries(manifest);
    expect(entries.map(entry => entry.descriptor.name)).toEqual(['commerce_get_discount_options', 'commerce_get_discount_details']);
    expect(manifest.grantedTools.every(grant => !('kind' in grant))).toBe(true);
    expect(entries.every(entry => entry.capability.toolDescriptor.definitionVersion === '3.0.0')).toBe(true);
    expect(() => assertPublishedToolList(manifest, entries.map(entry => entry.descriptor))).not.toThrow();
  });
  it('preserves capability-key routing and legitimate per-capability descriptions', () => {
    const manifest = publishedManifest([{ name: 'arbitrary_product_read', description: 'Read products', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]);
    manifest.capabilities[0]!.key = 'feature_specific_product_read';
    manifest.selectedCapabilityKeys = ['feature_specific_product_read'];
    manifest.grantedTools = deduplicateTools(manifest.capabilities, []);
    const entries = publishedToolEntries(manifest);
    expect(() => assertPublishedToolList(manifest, [{ ...entries[0]!.descriptor, description: 'Capability-specific wording' }])).not.toThrow();
    expect(() => assertPublishedToolList(manifest, [{ ...entries[0]!.descriptor, name: 'arbitrary_product_read' }])).toThrow();
  });
  it('rejects legacy-only authority without rewriting historical data', () => {
    const historical = publishedManifest();
    historical.builtInTools = structuredClone([...commerceDiscountBuiltInDescriptors]);
    historical.grantedTools = historical.builtInTools.map(tool => ({ kind: 'BUILT_IN', toolName: tool.name, definitionVersion: tool.definitionVersion }));
    const before = structuredClone(historical);
    expect(() => assertPublishedManifest(historical)).toThrow();
    expect(historical).toEqual(before);
  });
  it('rejects duplicate canonical membership, wrong revisions, grant mismatch and schema drift', () => {
    const duplicate = publishedManifest(); duplicate.capabilities.push({ ...structuredClone(duplicate.capabilities[0]!), capabilityId: 'duplicate', position: 2, key: 'alias' });
    duplicate.selectedCapabilityKeys.push('alias'); duplicate.grantedTools = deduplicateTools(duplicate.capabilities, []);
    const old = publishedManifest(); old.capabilities[0]!.toolDescriptor.definitionVersion = '2.0.0'; old.grantedTools = deduplicateTools(old.capabilities, []);
    const forged = publishedManifest(); forged.grantedTools = [];
    for (const manifest of [duplicate, old, forged]) expect(() => assertPublishedManifest(manifest)).toThrow();
    const current = publishedManifest(); const list = publishedToolEntries(current).map(entry => entry.descriptor);
    expect(() => assertPublishedToolList(current, [list[0]!, list[0]!])).toThrow();
    expect(() => assertPublishedToolList(current, [{ ...list[0]!, inputSchema: { type: 'object' } }, list[1]!])).toThrow();
  });
});
