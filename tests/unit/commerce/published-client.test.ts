import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deduplicateTools } from '@modainteract/moda-interact-shared/commerce';
const sdk = vi.hoisted(() => ({ connect: vi.fn(), readResource: vi.fn(), listTools: vi.fn(), callTool: vi.fn(), close: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = sdk.connect; readResource = sdk.readResource; listTools = sdk.listTools; callTool = sdk.callTool; close = sdk.close; } }));
import { CommerceMcpClient, encodeCommerceContext } from '../../../src/commerce/mcp-client.js';
import { publishedToolEntries } from '../../../src/commerce/published-tools.js';
import { publishedManifest } from '../../fixtures/commerce/published-discounts.js';
const identity = { shopId: 'shop-safe', toolContext: { purpose: 'INITIAL_RECOVERY_OUTREACH' as const } };
let manifest = publishedManifest();
beforeEach(() => {
  vi.resetAllMocks(); manifest = publishedManifest();
  sdk.readResource.mockImplementation(async () => ({ contents: [{ uri: 'commerce://capabilities', text: JSON.stringify(manifest) }] }));
  sdk.listTools.mockImplementation(async () => ({ tools: publishedToolEntries(manifest).map(entry => entry.descriptor) }));
  sdk.callTool.mockResolvedValue({ isError: false, structuredContent: { contractVersion: 'commerce.v1', status: 'OK', data: { mode: 'NONE', offers: [], truncated: false }, renderedText: '' } });
});
const client = () => new CommerceMcpClient({ endpoint: new URL('http://localhost/api/mcp') }, identity, new AbortController().signal);

describe('pinned published MCP calls', () => {
  it('requires list-before-call and maps an underlying tool name to its published capability key', async () => {
    const c = client();
    await expect(c.call('commerce_get_discount_options', {})).rejects.toMatchObject({ code: 'DENIED' });
    manifest = publishedManifest([{ name: 'read_product', description: 'Read product', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]);
    manifest.capabilities[0]!.key = 'feature_product_read'; manifest.selectedCapabilityKeys = ['feature_product_read'];
    manifest.grantedTools = deduplicateTools(manifest.capabilities, []);
    await c.tools(); await c.call('read_product', {});
    expect(sdk.callTool.mock.calls[0]![0]).toEqual({ name: 'feature_product_read', arguments: {} });
  });
  it.each(['release', 'revision', 'permission'] as const)('refuses a changed %s before sending a tool call', async change => {
    const c = client(); await c.tools();
    if (change === 'release') manifest.releaseId = 'different-release';
    if (change === 'revision') { manifest.capabilities[0]!.toolDescriptor.toolRevisionId = 'different-revision'; manifest.grantedTools = deduplicateTools(manifest.capabilities, []); }
    if (change === 'permission') { manifest.capabilities = []; manifest.selectedCapabilityKeys = []; manifest.grantedTools = []; manifest.featureBehaviours = []; }
    await expect(c.call('commerce_get_discount_options', {})).rejects.toMatchObject({ code: 'INCOMPATIBLE_VERSION' });
    expect(sdk.callTool).not.toHaveBeenCalled();
  });
  it('discards a result when release activation races the read-only tool call', async () => {
    const c = client(); await c.tools();
    sdk.callTool.mockImplementation(async () => { manifest.releaseId = 'activated-during-call'; return { isError: false, structuredContent: { contractVersion: 'commerce.v1', status: 'OK', data: {}, renderedText: '' } }; });
    await expect(c.call('commerce_get_discount_options', {})).rejects.toMatchObject({ code: 'INCOMPATIBLE_VERSION' });
    expect(sdk.callTool).toHaveBeenCalledOnce();
  });
  it('keeps trusted purpose outside model arguments and denies forged purpose', () => {
    expect(JSON.parse(Buffer.from(encodeCommerceContext(identity), 'base64url').toString())).toEqual(identity);
    expect(() => encodeCommerceContext({ ...identity, toolContext: { purpose: 'OTHER' } } as never)).toThrow();
  });
});
