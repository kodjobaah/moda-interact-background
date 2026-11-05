import { describe, expect, it } from 'vitest';
import { deduplicateTools } from '@modainteract/moda-interact-shared/commerce';
import type { ModelRequest, ModelStep } from '@modainteract/moda-interact-shared/commerce/runner';
import { hostFixture as f } from '../host.fixture.js';
import { runInitialOutreachOfferAgent } from '../../../../src/agents/initial-outreach-offer.agent.js';
import { createAdmittedRecoveryOutreachMcpSelector } from '../../../../src/services/recovery-offers/recovery-outreach-mcp-selector.service.js';
import { outreachContext } from '../../../fixtures/commerce/outreach-context.js';

const extension = 'published_store_guidance';
const finish = (): ModelStep => ({ calls: [{ name: 'submitInitialOutreachOffer', arguments: { kind: 'NO_VERIFIED_OFFER' } }], outputTokens: 10 });
function publishExtra(unrelated = false) {
  const base = f.active.capabilities[0]!;
  const featureId = unrelated ? 'unrelated-feature' : base.featureId;
  const descriptor = { toolId: 'extension-tool', toolRevisionId: 'extension-revision-1', name: extension,
    definitionVersion: '1.0.0', description: 'Read current public store guidance.',
    inputSchema: { type: 'object' as const, properties: { question: { type: 'string' as const, maxLength: 256 } },
      required: ['question'], additionalProperties: false as const } };
  f.active.capabilities.push({ capabilityId: 'extension-capability', key: extension, featureId,
    position: Math.max(...f.active.capabilities.map(cap => cap.position)) + 1, toolDescriptor: descriptor });
  if (unrelated) f.active.featureBehaviours.push({ featureId, behaviourPrompt: 'Unrelated capability' });
  refreshPublication();
  f.toolResults = { [extension]: { contractVersion: 'commerce.v1', status: 'OK', data: { summary: 'Source guidance', reference: 'policy-1' }, renderedText: 'Public store guidance.' } };
}
function refreshPublication() {
  f.active.selectedCapabilityKeys = f.active.capabilities.map(cap => cap.key);
  f.active.grantedTools = deduplicateTools(f.active.capabilities, []);
  const represented = new Set(f.active.capabilities.map(cap => cap.featureId));
  f.active.featureBehaviours = f.active.featureBehaviours.filter(feature => represented.has(feature.featureId));
  f.releases.set(f.active.releaseId, f.active);
}
function execute(invoke: (request: ModelRequest) => Promise<ModelStep>, options: { signal?: AbortSignal; now?: () => Date } = {}) {
  return runInitialOutreachOfferAgent(outreachContext(), {
    signal: options.signal ?? new AbortController().signal,
    modelInvoker: { invoke },
    createSelector: input => createAdmittedRecoveryOutreachMcpSelector(input, {
      configuration: f.config, assertFeature: async (_shop, feature) => { expect(feature).toBe('checkout_recovery'); },
    }),
    ...(options.now ? { now: options.now } : {}),
  });
}
const calls = () => f.observations.filter(observation => observation.method === 'tools/call');

export function registerDynamicOutreachTests() {
  describe('actual outreach agent → selector → client → loopback MCP dynamic capability execution', () => {
    it('advertises an additional supported member, lets the agent choose it first and returns its result to the next model step', async () => {
      publishExtra(); const requests: ModelRequest[] = [];
      const result = await execute(async request => {
        requests.push(request);
        if (requests.length === 1) {
          expect(request.tools.map(tool => tool.name)).toContain(extension);
          return { calls: [{ name: extension, arguments: { question: 'delivery guidance' } }], outputTokens: 10 };
        }
        expect(request.messages).toEqual([expect.objectContaining({ tool: extension, result: expect.objectContaining({
          status: 'OK', data: { summary: 'Source guidance', reference: 'policy-1' },
        }) })]);
        return finish();
      });
      expect(result).toMatchObject({ kind: 'NO_VERIFIED_OFFER', discoveryIncomplete: false });
      expect(calls().map(call => call.params.name)).toEqual([extension]);
      expect(calls()[0]!.claims).toEqual({ shopId: 'shop-fixture', toolContext: { purpose: 'INITIAL_RECOVERY_OUTREACH' } });
      expect(f.db.commerceConversationGrant.create).not.toHaveBeenCalled();
      expect(f.db.$transaction).not.toHaveBeenCalled();
    });
    it.each(['removed', 'revoked', 'unrelated', 'invented'] as const)('denies a %s member without a tool request', async mode => {
      publishExtra(mode === 'unrelated');
      const result = await execute(async request => {
        if (mode === 'unrelated' || mode === 'invented') expect(request.tools.map(tool => tool.name)).not.toContain(mode === 'invented' ? 'invented_tool' : extension);
        if (mode === 'removed') { f.active.capabilities = f.active.capabilities.filter(cap => cap.key !== extension); refreshPublication(); }
        if (mode === 'revoked') f.revoked = true;
        return { calls: [{ name: mode === 'invented' ? 'invented_tool' : extension, arguments: { question: 'guidance' } }], outputTokens: 10 };
      });
      expect(result).toMatchObject({ kind: 'FAILURE' }); expect(calls()).toEqual([]);
    });
    it('retains conversation Feature scope without widening or rewriting its historical grant', async () => {
      await f.run(async () => f.final());
      const historical = structuredClone(f.grants.get(f.state.id));
      f.active = structuredClone(f.active); f.active.releaseId = 'release-with-unrelated-feature';
      publishExtra(true);
      await f.run(async request => {
        expect(request.tools.map(tool => tool.name)).not.toContain(extension);
        return f.final();
      });
      expect(f.grants.get(f.state.id)).toEqual(historical);
      expect(calls()).toEqual([]);
    });
    it('accepts MCP-selected compatible activation between discovery and execution', async () => {
      publishExtra(); let step = 0;
      const result = await execute(async () => {
        if (step++ > 0) return finish();
        f.active = structuredClone(f.active); f.active.releaseId = 'compatible-current-release';
        f.active.capabilities.find(cap => cap.key === extension)!.toolDescriptor.toolRevisionId = 'extension-revision-2';
        refreshPublication();
        return { calls: [{ name: extension, arguments: { question: 'guidance' } }], outputTokens: 10 };
      });
      expect(result.kind).toBe('NO_VERIFIED_OFFER'); expect(calls()).toHaveLength(1);
      expect(calls()[0]!.claims).not.toHaveProperty('releaseId');
    });
    it('caps arbitrary supported-member calls with the aggregate remote-call budget', async () => {
      publishExtra(); let sequence = 0;
      const result = await execute(async () => ({ calls: Array.from({ length: 3 }, () => ({
        name: extension, arguments: { question: `guidance-${sequence++}` },
      })), outputTokens: 10 }));
      expect(result).toMatchObject({ kind: 'FAILURE', code: 'BUDGET_EXHAUSTED' });
      expect(calls()).toHaveLength(16);
    });
    it('cancels the dynamic path before dispatch', async () => {
      publishExtra(); const controller = new AbortController();
      const result = await execute(async () => {
        controller.abort(); return { calls: [{ name: extension, arguments: { question: 'guidance' } }], outputTokens: 10 };
      }, { signal: controller.signal });
      expect(result).toMatchObject({ kind: 'FAILURE' }); expect(calls()).toEqual([]);
    });
    it('enforces the aggregate deadline and bounded generic tool-result boundary', async () => {
      publishExtra(); let clock = new Date('2026-11-05T12:00:00Z');
      const deadline = await execute(async () => {
        clock = new Date(clock.getTime() + 45001); return { calls: [{ name: extension, arguments: { question: 'guidance' } }], outputTokens: 10 };
      }, { now: () => clock });
      expect(deadline).toMatchObject({ kind: 'FAILURE', code: 'BUDGET_EXHAUSTED' }); expect(calls()).toEqual([]);
      f.toolResults = { [extension]: { contractVersion: 'commerce.v1', status: 'OK', data: { text: 'x'.repeat(40000) }, renderedText: '' } };
      const oversized = await execute(async () => ({ calls: [{ name: extension, arguments: { question: 'guidance' } }], outputTokens: 10 }));
      expect(oversized).toMatchObject({ kind: 'FAILURE' }); expect(calls()).toHaveLength(1);
    });
    it('does not inject an exact named-tool call when final source facts are absent', async () => {
      publishExtra(); const result = await execute(async () => finish());
      expect(result.kind).toBe('NO_VERIFIED_OFFER'); expect(calls()).toEqual([]);
    });
  });
}
