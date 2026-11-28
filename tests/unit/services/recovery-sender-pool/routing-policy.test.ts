import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import { sha256 } from "../../../../src/services/recovery-multipart/frozen.js";
import {
  decodeRoutingAgentPolicy,
  readRoutingPolicy,
  assertCurrentRoutingPolicy,
} from "../../../../src/services/recovery-sender-pool/routing-policy.js";

vi.mock("../../../../src/commerce/model-resolution.js", () => ({
  resolveProductionCommerceModel: vi.fn(),
}));
import { resolveProductionCommerceModel } from "../../../../src/commerce/model-resolution.js";

export const policy = {
  schemaVersion: 1,
  enabled: true,
  modelBinding: { kind: "FIXED_CATALOGUE", modelCatalogueEntryId: "model-a" },
  promptRevisionId: "prompt-a",
  wrapperAudience: "ROUTER",
  confidenceThreshold: 83,
  budget: { deadlineMs: 5000, outputTokens: 512, toolCalls: 1 },
  retry: { maxAttempts: 2, backoffMs: 0 },
  input: {
    maxHistoryMessages: 5,
    maxInputCharacters: 30000,
    maxCandidates: 12,
  },
  decisionTTLms: 60000,
  retentionMs: 120000,
};
function fixture(value: unknown = policy) {
  const promptText = "Classify checkout routing only.";
  const model = {
    id: "model-a",
    availabilityId: "available-a",
    provider: "deepseek",
    providerModelId: "deepseek-chat",
    configurationSchemaVersion: 1,
    configuration: { temperature: 0.1 },
    enabled: true,
    editVersion: 4,
    availability: {
      id: "available-a",
      scope: "PLATFORM",
      shopId: null,
      enabled: true,
      editVersion: 2,
    },
  };
  const prompt = {
    id: "prompt-a",
    status: "PUBLISHED",
    publishedAt: new Date(),
    promptText,
    contentHash: sha256(promptText),
    sourceContext: { schemaVersion: 1, purpose: "RECOVERY_ROUTING" },
    prompt: { scope: "PLATFORM", shopId: null },
  };
  const db = {
    platformConfiguration: {
      findUnique: vi.fn().mockResolvedValue({
        id: "config-a",
        environment: "test",
        key: "recovery.routingAgent",
        version: 3,
        value,
      }),
    },
    commerceAgentPromptRevision: {
      findUnique: vi.fn().mockResolvedValue(prompt),
    },
    commerceAgentConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
    commerceModelCatalogueEntry: {
      findUnique: vi.fn().mockResolvedValue(model),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: "config-a" }]),
  };
  return {
    db: db as unknown as Prisma.TransactionClient,
    raw: db,
    model,
    prompt,
  };
}
const client = (db: Prisma.TransactionClient) =>
  db as unknown as Parameters<typeof readRoutingPolicy>[0];

describe("explicit routing policy decoder", () => {
  it("preserves every explicit business value without defaults", () =>
    expect(decodeRoutingAgentPolicy(policy)).toEqual(policy));
  it.each([
    "budget",
    "retry",
    "input",
    "modelBinding",
    "confidenceThreshold",
    "decisionTTLms",
    "retentionMs",
  ])("rejects missing %s", (key) => {
    const value = { ...policy };
    delete (value as Record<string, unknown>)[key];
    expect(() => decodeRoutingAgentPolicy(value)).toThrow();
  });
  it.each([
    { ...policy, budget: { ...policy.budget, toolCalls: -1 } },
    { ...policy, retry: { maxAttempts: 0, backoffMs: 0 } },
    { ...policy, input: { ...policy.input, maxCandidates: 0 } },
    { ...policy, retentionMs: 1 },
    { ...policy, credentials: "secret" },
    {
      ...policy,
      modelBinding: {
        kind: "VERIFIED_SHOP_INHERIT",
        modelCatalogueEntryId: "model-a",
      },
    },
  ])("rejects malformed or unauthorized policy %j", (value) =>
    expect(() => decodeRoutingAgentPolicy(value)).toThrow(),
  );
  it("accepts zero tools/history as explicit safe-disable budgets", () =>
    expect(
      decodeRoutingAgentPolicy({
        ...policy,
        budget: { ...policy.budget, toolCalls: 0 },
        input: { ...policy.input, maxHistoryMessages: 0 },
      }).budget.toolCalls,
    ).toBe(0));
});
describe("saved routing model and prompt references", () => {
  it("logs the original sanitized database failure while holding the routing policy", async () => {
    const { db, raw } = fixture();
    raw.platformConfiguration.findUnique.mockRejectedValueOnce(
      new Error("database connection refused"),
    );
    const logger = { warn: vi.fn() };
    expect(
      await readRoutingPolicy(client(db), { environment: "test" }, logger),
    ).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "recovery.routing.policy_read_failed",
      expect.objectContaining({
        internalError: expect.objectContaining({
          message: "database connection refused",
        }),
      }),
    );
  });

  it("reads fixed platform model and only safe immutable evidence", async () => {
    const { db } = fixture();
    const snapshot = await readRoutingPolicy(client(db), {
      environment: "test",
      verifiedShopId: "shop-a",
    });
    expect(snapshot?.model?.catalogueEditVersion).toBe(4);
    expect(snapshot?.commerceEnvironment).toBe("TEST");
    expect(canonicalJson(snapshot?.configurationSnapshot)).not.toContain(
      "Classify checkout routing only.",
    );
    expect(snapshot?.configurationSnapshot).not.toHaveProperty("credential");
  });
  it("holds missing/disabled policy", async () => {
    const { db, raw } = fixture({ ...policy, enabled: false });
    expect(
      await readRoutingPolicy(client(db), { environment: "test" }),
    ).toBeNull();
    raw.platformConfiguration.findUnique.mockResolvedValue(null);
    expect(
      await readRoutingPolicy(client(db), { environment: "test" }),
    ).toBeNull();
  });
  it.each([
    "DRAFT",
    "foreign-scope",
    "untagged",
    "wrong-hash",
    "normal-active",
  ])("holds invalid prompt %s", async (condition) => {
    const { db, raw, prompt } = fixture();
    if (condition === "DRAFT") prompt.status = "DRAFT";
    if (condition === "foreign-scope") prompt.prompt.scope = "SHOP";
    if (condition === "untagged") prompt.sourceContext.purpose = "COMMERCE";
    if (condition === "wrong-hash") prompt.contentHash = "0".repeat(64);
    if (condition === "normal-active")
      raw.commerceAgentConfiguration.findFirst.mockResolvedValue({
        id: "normal",
      } as never);
    expect(
      await readRoutingPolicy(client(db), { environment: "test" }),
    ).toBeNull();
  });
  it.each([
    "disabled",
    "foreign-shop",
    "availability-disabled",
    "invalid-provider-config",
  ])("holds invalid fixed model %s", async (condition) => {
    const { db, model } = fixture();
    if (condition === "disabled") model.enabled = false;
    if (condition === "foreign-shop") model.availability.scope = "SHOP";
    if (condition === "availability-disabled")
      model.availability.enabled = false;
    if (condition === "invalid-provider-config")
      model.configuration = { model: "override" } as never;
    expect(
      await readRoutingPolicy(client(db), { environment: "test" }),
    ).toBeNull();
  });
  it("never inherits a model before verified shop proof", async () => {
    vi.mocked(resolveProductionCommerceModel).mockClear();
    const { db, raw } = fixture({
      ...policy,
      modelBinding: { kind: "VERIFIED_SHOP_INHERIT" },
    });
    const snapshot = await readRoutingPolicy(client(db), {
      environment: "test",
    });
    expect(snapshot?.model).toBeNull();
    expect(raw.commerceModelCatalogueEntry.findUnique).not.toHaveBeenCalled();
    expect(resolveProductionCommerceModel).not.toHaveBeenCalled();
  });
  it("uses existing verified shop inheritance and preserves its selection evidence", async () => {
    const { db } = fixture({
      ...policy,
      modelBinding: { kind: "VERIFIED_SHOP_INHERIT" },
    });
    vi.mocked(resolveProductionCommerceModel).mockResolvedValue({
      selectionSource: "PLATFORM",
      selectionShopId: null,
      merchantPricingPlanId: null,
      shopifyPlanHandle: null,
      model: {
        environment: "TEST",
        sourceScope: "PLATFORM",
        sourceShopId: null,
        catalogueEntryId: "model-a",
        provider: "deepseek",
        providerModelId: "deepseek-chat",
        configurationSchemaVersion: 1,
        configuration: { temperature: 0.1 },
      },
    });
    expect(
      (
        await readRoutingPolicy(client(db), {
          environment: "test",
          verifiedShopId: "shop-a",
        })
      )?.model?.selectionSource,
    ).toBe("PLATFORM");
    expect(resolveProductionCommerceModel).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: "shop-a", environment: "TEST" }),
    );
  });
  it("revalidates full policy/model/prompt under final SQL locks", async () => {
    const { db, model, raw } = fixture();
    const snapshot = (await readRoutingPolicy(client(db), {
      environment: "test",
      verifiedShopId: "shop-a",
    }))!;
    await expect(
      assertCurrentRoutingPolicy(db, snapshot),
    ).resolves.toBeUndefined();
    expect(raw.$queryRawUnsafe.mock.calls[0]?.[0]).toContain("FOR SHARE");
    model.editVersion += 1;
    await expect(assertCurrentRoutingPolicy(db, snapshot)).rejects.toThrow(
      "ROUTING_POLICY_CHANGED",
    );
  });
});
