import type { PrismaClient } from "@prisma/client";
import type { CommerceModelInvoker, ModelRequest, ModelStep } from "@modainteract/moda-interact-shared/commerce/runner";
import type { ResolvedCommerceModel } from "@modainteract/moda-interact-shared/commerce/model";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveProductionCommerceModel } = vi.hoisted(() => ({
  resolveProductionCommerceModel: vi.fn(),
}));

vi.mock("../../../src/commerce/model-resolution.js", () => ({
  resolveProductionCommerceModel,
}));

import { createProductionCommerceModelInvoker } from "../../../src/commerce/production-model.js";
import type { OpenRouterCredentialResolver } from "../../../src/commerce/openrouter-credential.js";

const model = (providerModelId: string): ResolvedCommerceModel => ({
  environment: "DEVELOPMENT",
  sourceScope: "PLATFORM",
  sourceShopId: null,
  catalogueEntryId: `entry-${providerModelId}`,
  provider: "openai",
  providerModelId,
  configurationSchemaVersion: 1,
  configuration: { temperature: 0.2 },
});

const selection = (resolvedModel: ResolvedCommerceModel) => ({
  selectionSource: "PRICING_PLAN",
  selectionShopId: "shop-a",
  merchantPricingPlanId: "plan-starter",
  shopifyPlanHandle: "starter",
  model: resolvedModel,
});

const request = {
  instructions: [],
  context: {},
  history: [],
  messages: [],
  tools: [],
  maxOutputTokens: 50,
} satisfies ModelRequest;

const step: ModelStep = { calls: [], outputTokens: 12 };

beforeEach(() => {
  resolveProductionCommerceModel.mockReset();
  resolveProductionCommerceModel.mockResolvedValue(selection(model("model-A")));
});

function dependencies(credentials: string[]) {
  const resolve = vi.fn(async () => {
    const next = credentials.shift();
    if (!next) throw new Error("no test credential");
    return next;
  });
  const credentialResolver = { resolve } as unknown as OpenRouterCredentialResolver;
  const created: Array<{ options: unknown; client: CommerceModelInvoker }> = [];
  const createClient = vi.fn((options: any) => {
    const client = { invoke: vi.fn(async () => step) };
    created.push({ options, client });
    return client;
  });
  return { credentialResolver, resolve, created, createClient };
}

const createInvoker = (options: {
  credentialResolver: OpenRouterCredentialResolver;
  createClient: (options: any) => CommerceModelInvoker;
}) => createProductionCommerceModelInvoker({
  db: {} as PrismaClient,
  environment: "DEVELOPMENT",
  shopId: "shop-a",
  ...options,
});

describe("createProductionCommerceModelInvoker", () => {
  it("resolves model identity once and resolves a fresh credential/client per invocation", async () => {
    const deps = dependencies(["credential-A", "credential-B"]);
    const invoker = await createInvoker(deps);
    resolveProductionCommerceModel.mockResolvedValue(selection(model("model-B")));

    expect(await invoker.invoke(request, new AbortController().signal)).toBe(step);
    expect(await invoker.invoke(request, new AbortController().signal)).toBe(step);

    expect(resolveProductionCommerceModel).toHaveBeenCalledOnce();
    expect(resolveProductionCommerceModel).toHaveBeenCalledWith({
      db: expect.anything(),
      environment: "DEVELOPMENT",
      shopId: "shop-a",
    });
    expect(deps.resolve).toHaveBeenCalledTimes(2);
    expect(deps.createClient).toHaveBeenCalledTimes(2);
    expect(deps.created.map(({ options }) => options)).toEqual([
      {
        provider: "openai",
        providerModelId: "model-A",
        configurationSchemaVersion: 1,
        configuration: { temperature: 0.2 },
        credential: "credential-A",
      },
      {
        provider: "openai",
        providerModelId: "model-A",
        configurationSchemaVersion: 1,
        configuration: { temperature: 0.2 },
        credential: "credential-B",
      },
    ]);
    expect(deps.created[0]?.client.invoke).toHaveBeenCalledWith(
      request,
      expect.any(AbortSignal),
    );
    expect(invoker.selection).toMatchObject({
      selectionSource: "PRICING_PLAN",
      merchantPricingPlanId: "plan-starter",
    });
  });

  it("passes the exact request and cancellation signal through to the Shared client", async () => {
    const deps = dependencies(["credential-A"]);
    const invoker = await createInvoker(deps);
    const controller = new AbortController();
    await invoker.invoke(request, controller.signal);
    expect(deps.created[0]?.client.invoke).toHaveBeenCalledWith(request, controller.signal);
    expect(deps.resolve).toHaveBeenCalledWith({
      environment: "DEVELOPMENT",
      signal: controller.signal,
    });
  });

  it("does not resolve a credential or construct a client after cancellation", async () => {
    const deps = dependencies(["credential-A"]);
    const invoker = await createInvoker(deps);
    const controller = new AbortController();
    controller.abort();
    await expect(invoker.invoke(request, controller.signal)).rejects.toThrow(
      "Commerce model invocation failed",
    );
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it("maps Shared provider failures to a bounded non-sensitive error", async () => {
    const deps = dependencies(["credential-A"]);
    deps.createClient.mockImplementation(() => ({
      invoke: vi.fn(async () => { throw new Error("provider payload credential-A"); }),
    }));
    const invoker = await createInvoker(deps);
    await expect(invoker.invoke(request, new AbortController().signal)).rejects.toThrow(
      "Commerce model invocation failed",
    );
  });
});