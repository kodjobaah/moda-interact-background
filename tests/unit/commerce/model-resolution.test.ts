import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveProductionCommerceModel,
  type ResolvedProductionCommerceModel,
} from "../../../src/commerce/model-resolution.js";

type ModelFixture = {
  id: string;
  availabilityId: string;
  provider: string;
  providerModelId: string;
  displayName: string;
  description: string;
  configurationSchemaVersion: number;
  configuration: unknown;
  enabled: boolean;
  editVersion: number;
  availability: {
    id: string;
    scope: "PLATFORM" | "SHOP";
    shopId: string | null;
    enabled: boolean;
    editVersion: number;
  };
};

const model = (
  id: string,
  scope: "PLATFORM" | "SHOP" = "PLATFORM",
  shopId: string | null = null,
): ModelFixture => ({
  id,
  availabilityId: `${scope.toLowerCase()}-availability-${shopId ?? "global"}`,
  provider: "openai",
  providerModelId: id,
  displayName: id,
  description: "",
  configurationSchemaVersion: 1,
  configuration: { temperature: 0.2 },
  enabled: true,
  editVersion: 1,
  availability: {
    id: `${scope.toLowerCase()}-availability-${shopId ?? "global"}`,
    scope,
    shopId,
    enabled: true,
    editVersion: 1,
  },
});

function fixture() {
  const state = {
    shopExists: true,
    subscription: null as null | {
      status: string;
      planId: string | null;
      plan: { shopifyPlanHandle: string } | null;
    },
    shopConfiguration: null as null | { modelId: string | null },
    platformConfiguration: { modelId: "platform-model" } as null | {
      modelId: string | null;
    },
    plans: new Map<string, {
      id: string;
      shopifyPlanHandle: string;
      commerceModelId: string | null;
      isActive?: boolean;
    }>(),
    models: new Map<string, ModelFixture>(),
  };
  state.models.set("platform-model", model("platform-model"));
  state.models.set("starter-model", model("starter-model"));
  state.models.set("growth-model", model("growth-model"));
  state.models.set("shop-model", model("shop-model", "SHOP", "shop-a"));

  const transaction = {
    shop: {
      findUnique: vi.fn(async () => state.shopExists ? { id: "shop-a" } : null),
    },
    subscription: {
      findUnique: vi.fn(async () => state.subscription),
    },
    commerceAgentConfiguration: {
      findFirst: vi.fn(async ({ where }: { where: { scope: string } }) =>
        where.scope === "SHOP"
          ? state.shopConfiguration
          : state.platformConfiguration,
      ),
    },
    merchantPricingPlan: {
      findUnique: vi.fn(async ({ where }: { where: { shopifyPlanHandle: string } }) =>
        state.plans.get(where.shopifyPlanHandle) ?? null,
      ),
    },
    commerceModelCatalogueEntry: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.models.get(where.id) ?? null,
      ),
    },
  };
  const db = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    ),
  } as unknown as PrismaClient;

  return { state, transaction, db };
}

const resolve = (db: PrismaClient, shopId = "shop-a") =>
  resolveProductionCommerceModel({ db, environment: "DEVELOPMENT", shopId });

const activeSubscription = (handle = "starter") => ({
  status: "ACTIVE",
  planId: "billing-plan-current",
  plan: { shopifyPlanHandle: handle },
});

const addPlan = (
  state: ReturnType<typeof fixture>["state"],
  handle: string,
  modelId: string | null,
  isActive = true,
) => state.plans.set(handle, {
  id: `merchant-plan-${handle}`,
  shopifyPlanHandle: handle,
  commerceModelId: modelId,
  isActive,
});

function expectWinner(
  result: ResolvedProductionCommerceModel,
  source: "SHOP" | "PRICING_PLAN" | "PLATFORM",
  modelId: string,
) {
  expect(result.selectionSource).toBe(source);
  expect(result.model.catalogueEntryId).toBe(modelId);
}

describe("resolveProductionCommerceModel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses a valid Platform selection when no Shop or current Price Plan model applies", async () => {
    const f = fixture();
    const result = await resolve(f.db);
    expectWinner(result, "PLATFORM", "platform-model");
    expect(result).toMatchObject({
      selectionShopId: null,
      merchantPricingPlanId: null,
      shopifyPlanHandle: null,
      model: { sourceScope: "PLATFORM", sourceShopId: null },
    });
    expect(f.db.$transaction).toHaveBeenCalledOnce();
    expect(f.transaction.shop.findUnique).toHaveBeenCalledOnce();
    expect(f.transaction.subscription.findUnique).toHaveBeenCalledOnce();
  });

  it.each([
    ["Platform availability", model("shop-choice-platform")],
    ["own-Shop availability", model("shop-choice-private", "SHOP", "shop-a")],
  ])("accepts an explicit Shop model from %s", async (_label, selected) => {
    const f = fixture();
    f.state.models.set(selected.id, selected);
    f.state.shopConfiguration = { modelId: selected.id };
    f.state.platformConfiguration = null;
    const result = await resolve(f.db);
    expectWinner(result, "SHOP", selected.id);
    expect(result.selectionShopId).toBe("shop-a");
  });

  it("accepts a valid Shop override without querying Price Plan or Platform configuration", async () => {
    const f = fixture();
    f.state.shopConfiguration = { modelId: "shop-model" };
    f.state.subscription = activeSubscription();
    f.state.platformConfiguration = null;
    const result = await resolve(f.db);
    expectWinner(result, "SHOP", "shop-model");
    expect(f.transaction.merchantPricingPlan.findUnique).not.toHaveBeenCalled();
    expect(f.transaction.subscription.findUnique).not.toHaveBeenCalled();
    expect(f.transaction.commerceAgentConfiguration.findFirst).toHaveBeenCalledOnce();
  });

  it.each([
    ["cross-Shop availability", model("foreign-model", "SHOP", "shop-b")],
    ["disabled model", { ...model("disabled-model"), enabled: false }],
    ["disabled availability", {
      ...model("disabled-availability-model"),
      availability: { ...model("disabled-availability-model").availability, enabled: false },
    }],
  ])("fails closed for an explicit Shop selection with %s", async (_label, selected) => {
    const f = fixture();
    f.state.models.set(selected.id, selected);
    f.state.shopConfiguration = { modelId: selected.id };
    await expect(resolve(f.db)).rejects.toThrow("Commerce model is unavailable");
    expect(f.transaction.merchantPricingPlan.findUnique).not.toHaveBeenCalled();
  });

  it.each(["ACTIVE", "TRIALING"])(
    "uses the exact current Price Plan assignment for %s subscriptions",
    async (status) => {
      const f = fixture();
      f.state.subscription = { ...activeSubscription(), status };
      addPlan(f.state, "starter", "starter-model");
      f.state.platformConfiguration = null;
      const result = await resolve(f.db);
      expectWinner(result, "PRICING_PLAN", "starter-model");
      expect(result).toMatchObject({
        selectionShopId: "shop-a",
        merchantPricingPlanId: "merchant-plan-starter",
        shopifyPlanHandle: "starter",
        model: { sourceScope: "PLATFORM", sourceShopId: null },
      });
    },
  );

  it.each(["NO_CONTRACT", "UNMAPPED", "SYNC_ERROR", "FROZEN", "FUTURE_STATUS"])(
    "does not grant a Price Plan model for %s subscriptions",
    async (status) => {
      const f = fixture();
      f.state.subscription = { ...activeSubscription(), status };
      addPlan(f.state, "starter", "starter-model");
      expectWinner(await resolve(f.db), "PLATFORM", "platform-model");
      expect(f.transaction.merchantPricingPlan.findUnique).not.toHaveBeenCalled();
    },
  );

  it("ignores pending plan changes while the current plan handle remains current", async () => {
    const f = fixture();
    f.state.subscription = activeSubscription("starter");
    addPlan(f.state, "starter", "starter-model");
    addPlan(f.state, "growth", "growth-model");
    const result = await resolve(f.db);
    expectWinner(result, "PRICING_PLAN", "starter-model");
    expect(f.transaction.merchantPricingPlan.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopifyPlanHandle: "starter" } }),
    );
  });

  it("falls through when no matching plan exists or the matching plan has no model", async () => {
    const missing = fixture();
    missing.state.subscription = activeSubscription("missing");
    expectWinner(await resolve(missing.db), "PLATFORM", "platform-model");

    const unassigned = fixture();
    unassigned.state.subscription = activeSubscription();
    addPlan(unassigned.state, "starter", null);
    expectWinner(await resolve(unassigned.db), "PLATFORM", "platform-model");
  });

  it("uses an inactive MerchantPricingPlan assignment for an existing subscriber", async () => {
    const f = fixture();
    f.state.subscription = activeSubscription();
    addPlan(f.state, "starter", "starter-model", false);
    expectWinner(await resolve(f.db), "PRICING_PLAN", "starter-model");
  });

  it("uses a valid Price Plan model even when Platform selection is invalid", async () => {
    const f = fixture();
    f.state.subscription = activeSubscription();
    addPlan(f.state, "starter", "starter-model");
    f.state.platformConfiguration = null;
    expectWinner(await resolve(f.db), "PRICING_PLAN", "starter-model");
  });

  it.each([
    ["missing model", "missing-model", undefined],
    ["disabled model", "disabled-plan-model", { ...model("disabled-plan-model"), enabled: false }],
    ["Shop-only model", "shop-only-plan-model", model("shop-only-plan-model", "SHOP", "shop-a")],
  ])("fails closed for a Price Plan assignment with %s", async (_label, modelId, selected) => {
    const f = fixture();
    f.state.subscription = activeSubscription();
    addPlan(f.state, "starter", modelId);
    if (selected) f.state.models.set(selected.id, selected);
    await expect(resolve(f.db)).rejects.toThrow("Commerce model is unavailable");
  });

  it("lets an explicit Shop model win over an otherwise valid Price Plan model", async () => {
    const f = fixture();
    f.state.subscription = activeSubscription();
    addPlan(f.state, "starter", "starter-model");
    f.state.shopConfiguration = { modelId: "shop-model" };
    expectWinner(await resolve(f.db), "SHOP", "shop-model");
    expect(f.transaction.merchantPricingPlan.findUnique).not.toHaveBeenCalled();
  });

  it("observes current subscription and model-assignment changes on the next resolution", async () => {
    const f = fixture();
    f.state.subscription = activeSubscription("starter");
    addPlan(f.state, "starter", "starter-model");
    addPlan(f.state, "growth", "growth-model");
    expectWinner(await resolve(f.db), "PRICING_PLAN", "starter-model");

    f.state.subscription = activeSubscription("growth");
    expectWinner(await resolve(f.db), "PRICING_PLAN", "growth-model");

    addPlan(f.state, "growth", "starter-model");
    expectWinner(await resolve(f.db), "PRICING_PLAN", "starter-model");
  });

  it("fails when Shop or Platform selection is missing or disabled", async () => {
    const missing = fixture();
    missing.state.shopExists = false;
    await expect(resolve(missing.db)).rejects.toThrow("Commerce model is unavailable");

    const noPlatform = fixture();
    noPlatform.state.platformConfiguration = null;
    await expect(resolve(noPlatform.db)).rejects.toThrow("Commerce model is unavailable");

    const disabled = fixture();
    disabled.state.models.set("platform-model", {
      ...model("platform-model"),
      enabled: false,
    });
    await expect(resolve(disabled.db)).rejects.toThrow("Commerce model is unavailable");
  });

  it("preserves malformed persisted model configuration errors without mutating selections", async () => {
    const f = fixture();
    const before = structuredClone({
      shop: f.state.shopConfiguration,
      platform: f.state.platformConfiguration,
      plans: [...f.state.plans],
    });
    f.state.models.set("platform-model", {
      ...model("platform-model"),
      configuration: { api_key: "not-allowed" },
    });
    const failure = await resolve(f.db).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toBe("Commerce model is unavailable");
    expect({
      shop: f.state.shopConfiguration,
      platform: f.state.platformConfiguration,
      plans: [...f.state.plans],
    }).toEqual(before);
  });

  it("preserves unexpected database failures for operational diagnosis", async () => {
    const f = fixture();
    const databaseFailure = new Error("database connection failed");
    f.transaction.shop.findUnique.mockRejectedValueOnce(databaseFailure);

    await expect(resolve(f.db)).rejects.toBe(databaseFailure);
  });
});