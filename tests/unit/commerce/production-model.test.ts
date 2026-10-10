import type { PrismaClient } from "@prisma/client";
import {
  CommerceModelInvocationFailure,
  type CommerceModelInvoker,
  type ModelRequest,
  type ModelStep,
} from "@modainteract/moda-interact-shared/commerce/runner";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { OpenRouterCredentialResolutionFailure } from "../../../src/commerce/openrouter-credential-failure.js";
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
  logger?: StructuredLogger;
  conversationId?: string;
  inboundVersion?: number;
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
        onDiagnostic: expect.any(Function),
      },
      {
        provider: "openai",
        providerModelId: "model-A",
        configurationSchemaVersion: 1,
        configuration: { temperature: 0.2 },
        credential: "credential-B",
        onDiagnostic: expect.any(Function),
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

  it("classifies an unexpected provider exception without leaking the provider payload", async () => {
    const deps = dependencies(["credential-A"]);
    deps.createClient.mockImplementation(() => ({
      invoke: vi.fn(async () => { throw new Error("provider payload credential-A"); }),
    }));
    const invoker = await createInvoker(deps);
    await expect(invoker.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      name: "CommerceModelInvocationFailure",
      message: "Commerce model unavailable",
      diagnostic: { reasonCode: "MODEL_INVOCATION_FAILED" },
    });
  });
});

describe("production Commerce model failure diagnostics", () => {
  const logger = () => {
    const warn = vi.fn();
    return { warn, value: { warn } as unknown as StructuredLogger };
  };

  it("preserves rate-limit and authentication diagnostics from the Shared model client", async () => {
    for (const [status, reason] of [
      [429, "PROVIDER_RATE_LIMITED"],
      [401, "PROVIDER_AUTH_FAILED"],
    ] as const) {
      const deps = dependencies(["credential-A"]);
      const logs = logger();
      deps.createClient.mockImplementation((options: any) => ({
        invoke: vi.fn(async () => {
          options.onDiagnostic({ stage: "provider", reason, statusCode: status });
          throw new CommerceModelInvocationFailure({
            stage: "model.invoke", reasonCode: reason,
            providerStage: "provider", statusCode: status,
          }, new Error("provider body contains credential-A"));
        }),
      }));
      const invoker = await createInvoker({
        ...deps, logger: logs.value,
        conversationId: "conversation-a", inboundVersion: 7,
      });
      await expect(invoker.invoke(request, new AbortController().signal)).rejects.toMatchObject({
        name: "CommerceModelInvocationFailure",
        diagnostic: { reasonCode: reason, statusCode: status },
      });
      const providerLog = logs.warn.mock.calls.find(([event]) => event === "commerce.model.provider_diagnostic");
      expect(providerLog?.[1]).toMatchObject({
        reasonCode: reason, statusCode: status,
        conversationId: "conversation-a", inboundVersion: 7,
        selectionSource: "PRICING_PLAN", shopId: "shop-a",
        reasonMessage: expect.any(String), operatorAction: expect.any(String),
      });
      expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("credential-A");
    }
  });

  it("reports a provider response validation failure without including the response body", async () => {
    const deps = dependencies(["credential-A"]);
    const logs = logger();
    deps.createClient.mockImplementation((options: any) => ({
      invoke: vi.fn(async () => {
        options.onDiagnostic({ stage: "response", reason: "PROVIDER_RESPONSE_USAGE_INVALID" });
        throw new CommerceModelInvocationFailure({
          stage: "model.invoke", reasonCode: "PROVIDER_RESPONSE_USAGE_INVALID",
          providerStage: "response",
        }, new Error("raw provider response credential-A"));
      }),
    }));
    const invoker = await createInvoker({ ...deps, logger: logs.value });
    await expect(invoker.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      diagnostic: { reasonCode: "PROVIDER_RESPONSE_USAGE_INVALID" },
    });
    expect(logs.warn.mock.calls).toEqual(expect.arrayContaining([
      ["commerce.model.provider_diagnostic", expect.objectContaining({
        reasonCode: "PROVIDER_RESPONSE_USAGE_INVALID",
        reasonMessage: expect.stringContaining("output-token"),
      })],
    ]));
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("credential-A");
  });

  it("distinguishes missing credentials from failed database lookups", async () => {
    for (const [reason, runnerReason] of [
      ["CREDENTIAL_NOT_CONFIGURED", "MODEL_CREDENTIAL_INVALID"],
      ["CREDENTIAL_LOOKUP_FAILED", "MODEL_INVOCATION_FAILED"],
    ] as const) {
      const deps = dependencies([]);
      const logs = logger();
      deps.resolve.mockRejectedValueOnce(new OpenRouterCredentialResolutionFailure(
        reason, new Error("secret credential store error"),
      ));
      const invoker = await createInvoker({ ...deps, logger: logs.value });
      await expect(invoker.invoke(request, new AbortController().signal)).rejects.toMatchObject({
        diagnostic: { reasonCode: runnerReason },
      });
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(logs.warn.mock.calls).toEqual(expect.arrayContaining([
        ["commerce.model.credential_failed", expect.objectContaining({
          reasonCode: reason, reasonMessage: expect.any(String),
          operatorAction: expect.any(String),
        })],
      ]));
      expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("secret credential store error");
    }
  });

  it("distinguishes client construction failures without disclosing the original error", async () => {
    const deps = dependencies(["credential-A"]);
    const logs = logger();
    deps.createClient.mockImplementation(() => { throw new Error("secret construction detail"); });
    const invoker = await createInvoker({ ...deps, logger: logs.value });
    await expect(invoker.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      diagnostic: { reasonCode: "MODEL_ADAPTER_INITIALIZATION_FAILED" },
    });
    expect(logs.warn.mock.calls).toEqual(expect.arrayContaining([
      ["commerce.model.invocation_failed", expect.objectContaining({
        reasonCode: "MODEL_ADAPTER_INITIALIZATION_FAILED",
      })],
    ]));
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("secret construction detail");
  });

  it("preserves outcomes when the diagnostic logger throws", async () => {
    const deps = dependencies(["credential-A"]);
    const logs = { warn: vi.fn(() => { throw new Error("sink is offline"); }) } as unknown as StructuredLogger;
    deps.createClient.mockImplementation((options: any) => ({
      invoke: vi.fn(async () => {
        options.onDiagnostic({ stage: "provider", reason: "PROVIDER_RATE_LIMITED", statusCode: 429 });
        return step;
      }),
    }));
    const invoker = await createInvoker({ ...deps, logger: logs });
    await expect(invoker.invoke(request, new AbortController().signal)).resolves.toBe(step);
  });

  it("does not include raw provider text from unexpected exceptions", async () => {
    const deps = dependencies(["credential-A"]);
    const logs = logger();
    deps.createClient.mockImplementation(() => ({
      invoke: vi.fn(async () => { throw new Error("secret token credential-A"); }),
    }));
    const invoker = await createInvoker({ ...deps, logger: logs.value });
    await expect(invoker.invoke(request, new AbortController().signal)).rejects.toMatchObject({
      diagnostic: { reasonCode: "MODEL_INVOCATION_FAILED" },
    });
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("credential-A");
  });
});
