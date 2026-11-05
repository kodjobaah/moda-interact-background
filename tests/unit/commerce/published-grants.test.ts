import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commerceDiscountBuiltInDescriptors } from '@modainteract/moda-interact-shared/commerce';
const db = vi.hoisted(() => ({ commerceRelease: { findUnique: vi.fn() }, commerceConversationGrant: { findUnique: vi.fn(), create: vi.fn() } }));
vi.mock('../../../src/lib/db.js', () => ({ default: db }));
import { persistGrant, readGrant, validateRelease } from '../../../src/commerce/grants.js';
import { publishedManifest } from '../../fixtures/commerce/published-discounts.js';
import { runnerVersion } from '@modainteract/moda-interact-shared/commerce/runner';
const turn = { shopId: 'shop-1', checkoutRecoveryId: 'recovery-1', conversationId: 'conversation-1', inboundVersion: 1 };
let manifest = publishedManifest();
function stored() {
  return { ...manifest, capabilities: manifest.capabilities.map(cap => ({ capabilityId: cap.capabilityId,
    featureId: cap.featureId, toolId: cap.toolDescriptor.toolId, toolRevisionId: cap.toolDescriptor.toolRevisionId,
    capability: { key: cap.key }, toolRevision: { status: 'PUBLISHED', definitionVersion: cap.toolDescriptor.definitionVersion,
      definition: cap.toolDescriptor } })) };
}
beforeEach(() => { vi.resetAllMocks(); manifest = publishedManifest(); db.commerceRelease.findUnique.mockImplementation(async () => stored()); });
describe('published grant persistence', () => {
  it('persists exact published grants for the canonical immutable revisions', async () => {
    db.commerceConversationGrant.create.mockImplementation(async ({ data }) => ({ ...data, id: 'grant-1', createdAt: new Date(), expiresAt: null }));
    const grant = await persistGrant(turn, manifest);
    expect(grant.grantedTools).toEqual(manifest.grantedTools);
    expect(db.commerceConversationGrant.create.mock.calls[0]![0].data.releaseId).toBe(manifest.releaseId);
  });
  it.each(['missing', 'revision', 'draft', 'capability', 'definition'] as const)('refuses %s storage identity before persistence', async change => {
    const release = stored();
    if (change === 'missing') db.commerceRelease.findUnique.mockResolvedValue(null);
    else {
      if (change === 'revision') release.capabilities[0]!.toolRevisionId = 'wrong';
      if (change === 'draft') release.capabilities[0]!.toolRevision.status = 'DRAFT';
      if (change === 'capability') release.capabilities[0]!.capability.key = 'wrong';
      if (change === 'definition') release.capabilities[0]!.toolRevision.definition = { ...release.capabilities[0]!.toolRevision.definition, name: 'wrong' };
      db.commerceRelease.findUnique.mockResolvedValue(release);
    }
    await expect(persistGrant(turn, manifest)).rejects.toMatchObject({ code: 'INCOMPATIBLE_VERSION' });
    expect(db.commerceConversationGrant.create).not.toHaveBeenCalled();
  });
  it('rejects historical built-in grants and leaves their persisted rows untouched', async () => {
    const historical = { id: 'grant-history', shopId: turn.shopId, conversationId: turn.conversationId,
      initialInboundVersion: 1, releaseId: manifest.releaseId, selectedCapabilityKeys: [], runnerVersion,
      grantedTools: commerceDiscountBuiltInDescriptors.map(tool => ({ kind: 'BUILT_IN', toolName: tool.name, definitionVersion: tool.definitionVersion })),
      createdAt: new Date(), expiresAt: null };
    const before = structuredClone(historical); db.commerceConversationGrant.findUnique.mockResolvedValue(historical);
    await expect(readGrant(turn)).rejects.toMatchObject({ code: 'INCOMPATIBLE_VERSION' });
    expect(historical).toEqual(before); expect(db.commerceConversationGrant.create).not.toHaveBeenCalled();
  });
  it('does not accept a fabricated grant projection even for a real release', async () => {
    manifest.grantedTools = [];
    await expect(validateRelease(manifest)).rejects.toMatchObject({ code: 'INCOMPATIBLE_VERSION' });
    expect(db.commerceRelease.findUnique).not.toHaveBeenCalled();
  });
});
