import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import { runCommerceAgent } from "../../../src/agents/commerce.agent.js";
import type { RecoveryAgentContext } from "../../../src/agents/types.js";

const host = vi.hoisted(() => vi.fn(async () => ({
  replyText: "Hello",
  detectedLanguageTag: null,
  detectedLanguageConfidence: null,
})));
const productionResolution = vi.hoisted(() => ({
  readKeyring: vi.fn(() => { throw new Error("keyring should not be read"); }),
  resolveCredential: vi.fn(() => { throw new Error("credential should not be read"); }),
  createModel: vi.fn(() => { throw new Error("production model should not be resolved"); }),
}));

vi.mock("../../../src/commerce/host.js", () => ({ executeCommerceHost: host }));
vi.mock("../../../src/commerce/credential-keyring.js", () => ({
  readCommerceCredentialKeyring: productionResolution.readKeyring,
}));
vi.mock("../../../src/commerce/openrouter-credential.js", () => ({
  createOpenRouterCredentialResolver: productionResolution.resolveCredential,
}));
vi.mock("../../../src/commerce/production-model.js", () => ({
  createProductionCommerceModelInvoker: productionResolution.createModel,
}));
vi.mock("../../../src/commerce/model-environment.js", () => ({
  resolveCommerceEnvironment: vi.fn(() => "DEVELOPMENT"),
}));

const context: RecoveryAgentContext = {
  shopId: "shop-test",
  shop: "test-shop.myshopify.com",
  recovery: {
    id: "recovery-1",
    status: "ENGAGED",
    checkoutToken: "checkout-token",
    completedAt: null,
    totalPrice: "24.95",
  },
  customer: null,
  conversation: {
    conversationId: "conversation-1",
    shop: "test-shop.myshopify.com",
    type: "RECOVERY",
    summary: null,
    version: 1,
    messages: [{ role: "user", content: "Hello" }],
  },
};

beforeEach(() => {
  host.mockClear();
  productionResolution.readKeyring.mockClear();
  productionResolution.resolveCredential.mockClear();
  productionResolution.createModel.mockClear();
});

describe("CommerceAgent model injection", () => {
  it("uses the injected CommerceModelInvoker without resolving production models or credentials", async () => {
    const model = { invoke: vi.fn() } satisfies CommerceModelInvoker;

    await expect(runCommerceAgent(context, { model })).resolves.toMatchObject({
      replyText: "Hello",
    });

    expect(host).toHaveBeenCalledWith(context, expect.objectContaining({ model }));
    expect(productionResolution.readKeyring).not.toHaveBeenCalled();
    expect(productionResolution.resolveCredential).not.toHaveBeenCalled();
    expect(productionResolution.createModel).not.toHaveBeenCalled();
  });

  it("does not use the obsolete Commerce Groq setting", async () => {
    const model = { invoke: vi.fn() } satisfies CommerceModelInvoker;
    vi.stubEnv(["GROQ", "COMMERCE_MODEL"].join("_"), "obsolete-model-id");

    await expect(runCommerceAgent(context, { model })).resolves.toMatchObject({
      replyText: "Hello",
    });
    expect(host).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});