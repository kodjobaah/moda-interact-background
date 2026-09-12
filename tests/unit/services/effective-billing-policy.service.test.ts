import { describe, expect, it } from "vitest";
import {
  EffectiveBillingPolicyError,
  EffectiveBillingPolicyResolver,
} from "../../../src/services/effective-billing-policy.service.js";

const now = new Date("2026-09-07T20:00:00.000Z");

function client(overrides: Record<string, unknown> = {}) {
  const plan = {
    id: "plan-free",
    shopifyPlanHandle: "free",
    kind: "FREE",
    active: true,
    shopifyUsageEventHandle: null,
    defaultOutboundSoftLimit: 10,
    defaultOutboundHardLimit: 20,
    terminalMessageReservedSlots: 1,
    updatedAt: now,
    features: [{ feature: "CHECKOUT_RECOVERY", enabled: true }],
  };

  return {
    subscription: {
      findUnique: async () => ({
        id: "subscription-1",
        status: "ACTIVE",
        plan,
        billingPeriod: null,
        shop: { status: "ACTIVE" },
      }),
    },
    platformBillingPolicy: {
      findUnique: async () => ({
        absoluteOutboundHardLimit: 15,
        globalPauseNewRecoveries: false,
        globalPauseAutomatedWhatsapp: false,
        version: 3,
      }),
    },
    shopBillingPolicyOverride: { findUnique: async () => null },
    shopEntitlementCounter: {
      findUnique: async () => ({ grantedQuantity: 5, committedQuantity: 2, reservedQuantity: 1 }),
    },
    billingPeriodEntitlementCounter: {
      findUnique: async () => ({
        id: "period-counter-1",
        shopId: "shop-1",
        billingPeriodId: "period-1",
        grantedQuantity: 10,
        committedQuantity: 2,
        reservedQuantity: 1,
        forfeitedQuantity: 0,
      }),
    },
    ...overrides,
  } as never;
}

describe("EffectiveBillingPolicyResolver", () => {
  it("resolves the plan-independent lifetime Free grant from the durable counter", async () => {
    const policy = await new EffectiveBillingPolicyResolver(client()).resolve("shop-1", now);

    expect(policy.freeAllowance).toEqual({
      grant: 5,
      effective: 5,
      committed: 2,
      reserved: 1,
      remaining: 2,
    });
    expect(policy.outboundHardLimit).toBe(15);
    expect(policy.features.CHECKOUT_RECOVERY).toBe(true);
  });

  it("does not impose a local hard stop on paid metered plans", async () => {
    const fake = client({
      subscription: {
        findUnique: async () => ({
          id: "subscription-1",
          status: "TRIALING",
          plan: {
            id: "plan-paid",
            shopifyPlanHandle: "basic",
            kind: "PAID_METERED",
            active: true,
            shopifyUsageEventHandle: "basic-usage",
            defaultOutboundSoftLimit: 10,
            defaultOutboundHardLimit: 20,
            terminalMessageReservedSlots: 1,
            updatedAt: now,
            features: [],
          },
          billingPeriod: {
            id: "period-1",
            shopId: "shop-1",
            subscriptionId: "subscription-1",
            periodStart: new Date("2026-09-01T00:00:00.000Z"),
            periodEnd: new Date("2026-10-01T00:00:00.000Z"),
            status: "OPEN",
          },
          billingPeriodId: "period-1",
          currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
          shop: { status: "ACTIVE" },
        }),
      },
    });
    const policy = await new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now);
    expect(policy.freeAllowance).toMatchObject({ grant: 5, effective: 5, committed: 2, reserved: 1 });
    expect(policy.shopifyUsageEventHandle).toBe("basic-usage");
    expect(policy.billingPeriod?.start).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(policy.billingPeriod?.status).toBe("OPEN");
    expect(policy.billingPeriod?.includedCounter.grantedQuantity).toBe(10);
  });

  it("fails closed when the lifetime Free counter is missing", async () => {
    const fake = client({
      shopEntitlementCounter: { findUnique: async () => null },
    });

    await expect(
      new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now),
    ).rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({
      reason: "INVALID_CONFIGURATION",
    });
  });

  it("fails closed when lifetime usage exceeds the durable grant", async () => {
    const fake = client({
      shopEntitlementCounter: {
        findUnique: async () => ({ grantedQuantity: 2, committedQuantity: 1, reservedQuantity: 2 }),
      },
    });

    await expect(new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now))
      .rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({
        reason: "INVALID_CONFIGURATION",
      });
  });

  it("ignores expired overrides and always bounds hard limits by platform", async () => {
    const fake = client({
      shopBillingPolicyOverride: {
        findUnique: async () => ({
          outboundSoftLimit: 18,
          outboundHardLimit: 100,
          pauseNewRecoveries: true,
          pauseAutomatedWhatsapp: false,
          expiresAt: new Date("2026-09-06T00:00:00.000Z"),
          updatedAt: now,
        }),
      },
    });

    const policy = await new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now);
    expect(policy.outboundSoftLimit).toBe(10);
    expect(policy.outboundHardLimit).toBe(15);
    expect(policy.newRecoveriesPaused).toBe(false);
    expect(policy.automatedWhatsappPaused).toBe(false);
    expect(policy.pauseReasons).toEqual([]);
  });

  it("uses valid active shop overrides within the platform cap", async () => {
    const fake = client({
      shopBillingPolicyOverride: {
        findUnique: async () => ({
          outboundSoftLimit: 12,
          outboundHardLimit: 14,
          pauseNewRecoveries: false,
          pauseAutomatedWhatsapp: false,
          expiresAt: new Date("2026-09-08T00:00:00.000Z"),
          updatedAt: now,
        }),
      },
    });

    const policy = await new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now);
    expect(policy.outboundSoftLimit).toBe(12);
    expect(policy.outboundHardLimit).toBe(14);
  });

  it("bounds an active shop hard override by the platform cap", async () => {
    const fake = client({
      shopBillingPolicyOverride: {
        findUnique: async () => ({
          outboundSoftLimit: 18,
          outboundHardLimit: 100,
          pauseNewRecoveries: false,
          pauseAutomatedWhatsapp: false,
          expiresAt: new Date("2026-09-08T00:00:00.000Z"),
          updatedAt: now,
        }),
      },
    });

    const policy = await new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now);
    expect(policy.outboundSoftLimit).toBe(15);
    expect(policy.outboundHardLimit).toBe(15);
  });

  it("exposes independent pause dimensions and every active source", async () => {
    const fake = client({
      platformBillingPolicy: {
        findUnique: async () => ({
          absoluteOutboundHardLimit: 15,
          globalPauseNewRecoveries: true,
          globalPauseAutomatedWhatsapp: true,
          version: 3,
        }),
      },
      shopBillingPolicyOverride: {
        findUnique: async () => ({
          outboundSoftLimit: null,
          outboundHardLimit: null,
          pauseNewRecoveries: true,
          pauseAutomatedWhatsapp: true,
          expiresAt: new Date("2026-09-08T00:00:00.000Z"),
          updatedAt: now,
        }),
      },
    });

    const policy = await new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now);
    expect(policy.newRecoveriesPaused).toBe(true);
    expect(policy.automatedWhatsappPaused).toBe(true);
    expect(policy.paused).toBe(true);
    expect(policy.pauseReasons).toEqual([
      "GLOBAL_NEW_RECOVERIES_PAUSED",
      "SHOP_NEW_RECOVERIES_PAUSED",
      "GLOBAL_AUTOMATED_WHATSAPP_PAUSED",
      "SHOP_AUTOMATED_WHATSAPP_PAUSED",
    ]);
  });

  it("does not conflate a global recovery pause with a shop WhatsApp pause", async () => {
    const fake = client({
      platformBillingPolicy: {
        findUnique: async () => ({
          absoluteOutboundHardLimit: 15,
          globalPauseNewRecoveries: true,
          globalPauseAutomatedWhatsapp: false,
          version: 3,
        }),
      },
      shopBillingPolicyOverride: {
        findUnique: async () => ({
          outboundSoftLimit: null,
          outboundHardLimit: null,
          pauseNewRecoveries: false,
          pauseAutomatedWhatsapp: true,
          expiresAt: new Date("2026-09-08T00:00:00.000Z"),
          updatedAt: now,
        }),
      },
    });

    const policy = await new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now);
    expect(policy.newRecoveriesPaused).toBe(true);
    expect(policy.automatedWhatsappPaused).toBe(true);
    expect(policy.pauseReasons).toEqual([
      "GLOBAL_NEW_RECOVERIES_PAUSED",
      "SHOP_AUTOMATED_WHATSAPP_PAUSED",
    ]);
  });

  it("fails closed for unmapped, sync-error and inactive-plan subscriptions", async () => {
    for (const [status, reason] of [
      ["UNMAPPED", "UNMAPPED_PLAN"],
      ["SYNC_ERROR", "SYNC_ERROR"],
    ] as const) {
      const fake = client({
        subscription: {
          findUnique: async () => ({
            id: "subscription-1",
            status,
            plan: client().subscription,
            billingPeriod: null,
            shop: { status: "ACTIVE" },
          }),
        },
      });
      await expect(
        new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now),
      ).rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({ reason });
    }

    const inactive = client({
      subscription: {
        findUnique: async () => ({
          id: "subscription-1",
          status: "ACTIVE",
          plan: {
            id: "plan-free",
            shopifyPlanHandle: "free",
            kind: "FREE",
            active: false,
            shopifyUsageEventHandle: null,
            defaultOutboundSoftLimit: 10,
            defaultOutboundHardLimit: 20,
            terminalMessageReservedSlots: 1,
            updatedAt: now,
            features: [],
          },
          billingPeriod: null,
          shop: { status: "ACTIVE" },
        }),
      },
    });
    await expect(
      new EffectiveBillingPolicyResolver(inactive).resolve("shop-1", now),
    ).rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({ reason: "UNMAPPED_PLAN" });
  });

  it.each([0, -1, 15, 16, 1.5])(
    "rejects invalid terminal reserved slots: %s",
    async (terminalMessageReservedSlots) => {
      const fake = client({
        subscription: {
          findUnique: async () => ({
            id: "subscription-1",
            status: "ACTIVE",
            plan: {
              id: "plan-free",
              shopifyPlanHandle: "free",
              kind: "FREE",
              active: true,
              shopifyUsageEventHandle: null,
              defaultOutboundSoftLimit: 10,
              defaultOutboundHardLimit: 20,
              terminalMessageReservedSlots,
              updatedAt: now,
              features: [],
            },
            billingPeriod: null,
            shop: { status: "ACTIVE" },
          }),
        },
      });
      await expect(
        new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now),
      ).rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({
        reason: "INVALID_CONFIGURATION",
      });
    },
  );

  it("fails closed when a paid subscription has no current billing period", async () => {
    const fake = client({
      subscription: {
        findUnique: async () => ({
          id: "subscription-1",
          status: "ACTIVE",
          plan: {
            id: "plan-paid",
            shopifyPlanHandle: "basic",
            kind: "PAID_METERED",
            active: true,
            shopifyUsageEventHandle: "basic-usage",
            defaultOutboundSoftLimit: 10,
            defaultOutboundHardLimit: 20,
            terminalMessageReservedSlots: 14,
            updatedAt: now,
            features: [],
          },
          billingPeriod: null,
          shop: { status: "ACTIVE" },
        }),
      },
      platformBillingPolicy: {
        findUnique: async () => ({
          absoluteOutboundHardLimit: 15,
          globalPauseNewRecoveries: false,
          globalPauseAutomatedWhatsapp: false,
          version: 3,
        }),
      },
    });

    await expect(new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now))
      .rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({ reason: "INVALID_CONFIGURATION" });
  });

  it("fails closed when a paid plan has no usage event handle", async () => {
    const fake = client({
      subscription: {
        findUnique: async () => ({
          id: "subscription-1",
          status: "ACTIVE",
          plan: {
            id: "plan-paid",
            shopifyPlanHandle: "basic",
            kind: "PAID_METERED",
            active: true,
            shopifyUsageEventHandle: null,
            defaultOutboundSoftLimit: 10,
            defaultOutboundHardLimit: 20,
            terminalMessageReservedSlots: 1,
            updatedAt: now,
            features: [],
          },
          billingPeriod: null,
          shop: { status: "ACTIVE" },
        }),
      },
    });

    await expect(
      new EffectiveBillingPolicyResolver(fake).resolve("shop-1", now),
    ).rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({
      reason: "INVALID_CONFIGURATION",
    });
  });

  it("fails closed for missing contracts and invalid limits", async () => {
    const noContract = client({
      subscription: {
        findUnique: async () => null,
      },
    });
    await expect(
      new EffectiveBillingPolicyResolver(noContract).resolve("shop-1", now),
    ).rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({ reason: "NO_CONTRACT" });

    const invalid = client({
      platformBillingPolicy: {
        findUnique: async () => ({
          absoluteOutboundHardLimit: 0,
          globalPauseNewRecoveries: false,
          globalPauseAutomatedWhatsapp: false,
          version: 3,
        }),
      },
    });
    await expect(
      new EffectiveBillingPolicyResolver(invalid).resolve("shop-1", now),
    ).rejects.toMatchObject<Partial<EffectiveBillingPolicyError>>({
      reason: "INVALID_CONFIGURATION",
    });
  });
});
