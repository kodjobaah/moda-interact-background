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
    properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: ["string", "null"] } },
    required: ["limit"],
    additionalProperties: false,
  },
};

const detailsDescriptor: OutreachMcpToolDescriptor = {
  name: "commerce_get_discount_details",
  description: "Read one observed discount",
  inputSchema: {
    type: "object",
    properties: { offerId: { type: "string", minLength: 1 } },
    required: ["offerId"],
    additionalProperties: false,
  },
};

function makeFixture(input: {
  tools?: OutreachMcpToolDescriptor[];
  callResult?: unknown;
} = {}) {
  const client = {
    connect: vi.fn(async () => undefined),
    tools: vi.fn(async () => input.tools ?? [
      optionsDescriptor,
      detailsDescriptor,
      { name: "commerce_delete_customer", description: "not allowed", inputSchema: { type: "object" } },
    ]),
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
    },
  );
  return { service, client };
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
    await expect(duplicate.service.tools()).rejects.toMatchObject({ code: "INVALID_INPUT" });

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