import { publishedManifest } from "../../../fixtures/commerce/published-discounts.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommerceToolOutputs } from "@modainteract/moda-interact-shared/commerce";
import {
  RecoveryOutreachMcpSelectorService,
  type OutreachMcpToolDescriptor,
} from "../../../../src/services/recovery-offers/recovery-outreach-mcp-selector.service.js";
import type { McpConfiguration } from "../../../../src/commerce/mcp-client.js";

const optionsDescriptor: OutreachMcpToolDescriptor = {
  name: "commerce_get_discount_options",
  description: "List shop discount options",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: ["string", "null"], maxLength: 2048 } },
    required: ["limit"],
    additionalProperties: false,
  },
};

const detailsDescriptor: OutreachMcpToolDescriptor = {
  name: "commerce_get_discount_details",
  description: "Read one observed discount",
  inputSchema: {
    type: "object",
    properties: { offerId: { type: "string", minLength: 1, maxLength: 128 } },
    required: ["offerId"],
    additionalProperties: false,
  },
};

function makeFixture(input: {
  tools?: OutreachMcpToolDescriptor[];
  callResult?: unknown;
} = {}) {
  const listed = input.tools ?? [optionsDescriptor, detailsDescriptor, { name: "commerce_delete_customer", description: "not allowed", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
  const manifest = publishedManifest([...new Map(listed.map(tool => [tool.name, tool])).values()] as never);
  const client = {
    manifest: vi.fn(async () => manifest),
    connect: vi.fn(async () => undefined),
    tools: vi.fn(async () => listed),
    call: vi.fn(async () => input.callResult ?? {
      contractVersion: "commerce.v1",
      status: "OK",
      data: { mode: "AI_BEST_APPLICABLE", offers: [], cursor: null, truncated: false },
      renderedText: "No discounts found.",
    }),
    close: vi.fn(async () => undefined),
  };
  const service = new RecoveryOutreachMcpSelectorService(
    { shopId: "shop-1", signal: new AbortController().signal },
    {
      configuration: () => ({ endpoint: new URL("https://mcp.example/api/mcp") } satisfies McpConfiguration),
      clientFactory: () => client,
      validateRelease: async () => undefined,
    },
  );
  return { service, client, manifest };
}

describe("RecoveryOutreachMcpSelectorService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("discovers only the four approved names and closes one connection once", async () => {
    const { service, client } = makeFixture();
    await service.connect();
    const tools = await service.tools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "commerce_get_discount_options",
      "commerce_get_discount_details",
    ]);
    await service.close();
    await service.close();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("validates arguments against both the listed descriptor and published schemas", async () => {
    const { service, client } = makeFixture();
    await service.connect();
    await service.tools();

    const result = await service.call("commerce_get_discount_options", { limit: 10, cursor: null });
    expect(CommerceToolOutputs.commerce_get_discount_options.safeParse(result.data).success).toBe(true);
    await expect(service.call("commerce_get_discount_options", { limit: 10, unexpected: true }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.call("commerce_delete_customer", {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(client.call).toHaveBeenCalledOnce();
  });

  it("rejects duplicate listed names and a malformed successful feature payload", async () => {
    const duplicate = makeFixture({ tools: [optionsDescriptor, optionsDescriptor, detailsDescriptor] });
    await duplicate.service.connect();
    await expect(duplicate.service.tools()).rejects.toMatchObject({ code: "DENIED" });

    const malformed = makeFixture({ callResult: {
      contractVersion: "commerce.v1",
      status: "OK",
      data: { mode: "AI_BEST_APPLICABLE", offers: "bad" },
      renderedText: "Malformed data.",
    } });
    await malformed.service.connect();
    await malformed.service.tools();
    await expect(malformed.service.call("commerce_get_discount_options", { limit: 5 }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
it('pins one attempt and rejects changed release/revision before client calls', async () => {
  for (const change of ['release', 'revision']) {
    const f = makeFixture(); await f.service.connect(); await f.service.tools();
    if (change === 'release') f.manifest.releaseId = 'other-release';
    else f.manifest.capabilities[0]!.toolDescriptor.toolRevisionId = 'other-revision';
    await expect(f.service.call('commerce_get_discount_options', { limit: 5 })).rejects.toThrow();
    expect(f.client.call).not.toHaveBeenCalled();
  }
});
it('missing published discount membership is unavailable and unrelated tools never expand the allowlist', async () => {
  const missing = makeFixture({ tools: [optionsDescriptor] }); await missing.service.connect();
  await expect(missing.service.tools()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(missing.client.call).not.toHaveBeenCalled();
  const f = makeFixture(); await f.service.connect(); await f.service.tools();
  await expect(f.service.call('commerce_delete_customer', {})).rejects.toThrow();
  expect(f.client.call).not.toHaveBeenCalled();
});
it('checkout recovery host admission runs before selector/client construction', async () => {
  const { createAdmittedRecoveryOutreachMcpSelector } = await import('../../../../src/services/recovery-offers/recovery-outreach-mcp-selector.service.js');
  const { EntitlementError } = await import('../../../../src/services/entitlement.service.js');
  const clientFactory = vi.fn();
  const assertFeature = vi.fn(async () => { throw new EntitlementError('FEATURE_NOT_AVAILABLE', 'denied'); });
  await expect(createAdmittedRecoveryOutreachMcpSelector({ shopId: 'shop-1', signal: new AbortController().signal }, {
    assertFeature, clientFactory,
  })).rejects.toMatchObject({ code: 'DENIED' });
  expect(assertFeature).toHaveBeenCalledWith('shop-1', 'checkout_recovery');
  expect(clientFactory).not.toHaveBeenCalled();
});
