import { describe, expect, it, vi } from "vitest";
import {
  MerchantPricingPlanKind,
  MerchantPricingPlanPublicationStatus,
  Prisma,
} from "@prisma/client";
import { BillingPlanMaterializationService } from "../../../src/services/billing-plan-materialization.service.js";

const oldPlan = {
  id: "old-billing-id",
  shopifyPlanHandle: "start",
  name: "Starter",
  active: true,
  kind: "PAID_METERED",
  shopifyUsageEventHandle: "start",
  shopifyRecoveryCreditPackEventHandle: null,
  recoveryCreditPackEnabled: false,
  includedRecoveryConversationAllowance: 25,
};
const newPlan = {
  ...oldPlan,
  id: "new-billing-id",
  shopifyPlanHandle: "starter",
  shopifyUsageEventHandle: "starter",
  includedRecoveryConversationAllowance: 100,
};
const catalogue = {
  id: "catalogue-starter",
  isActive: true,
  publicationStatus: MerchantPricingPlanPublicationStatus.READY,
  displayName: "Starter",
  planKind: MerchantPricingPlanKind.PAID_METERED,
  includedRecoveryCredits: 100,
  shopifyRecoveryUsageEventHandle: "starter",
  features: [
    { featureId: "feature-1", configuration: { enabledRegions: ["GB"] } },
  ],
};

function harness({
  operational = null as typeof oldPlan | null,
  pricing = catalogue as typeof catalogue | null,
} = {}) {
  const transaction = {
    billingPlan: {
      findUnique: vi.fn().mockResolvedValue(operational),
      create: vi.fn().mockResolvedValue(newPlan),
    },
    merchantPricingPlan: {
      findUnique: vi.fn().mockResolvedValue(pricing),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const database = {
    billingPlan: { findUnique: vi.fn().mockResolvedValue(operational) },
    merchantPricingPlan: { findUnique: vi.fn() },
    $transaction: vi.fn(
      async (callback: (trx: typeof transaction) => unknown) =>
        callback(transaction),
    ),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new BillingPlanMaterializationService(
    database as never,
    logger as never,
  );
  return { transaction, database, logger, service };
}

describe("BillingPlanMaterializationService", () => {
  it("reuses a legacy exact-handle operational plan without consulting or modifying catalogue records", async () => {
    const test = harness({ operational: oldPlan });
    expect(await test.service.resolve("start")).toEqual(oldPlan);
    expect(test.database.$transaction).not.toHaveBeenCalled();
    expect(test.transaction.billingPlan.create).not.toHaveBeenCalled();
    expect(
      test.transaction.merchantPricingPlan.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("creates a separate operational plan for the new handle, copies features, and marks materialised atomically", async () => {
    const test = harness();
    expect(await test.service.resolve("starter")).toEqual(newPlan);
    expect(test.database.billingPlan.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopifyPlanHandle: "starter" } }),
    );
    expect(
      test.transaction.merchantPricingPlan.findUnique,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopifyPlanHandle: "starter" } }),
    );
    expect(test.transaction.billingPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shopifyPlanHandle: "starter",
          kind: "PAID_METERED",
          active: true,
          shopifyUsageEventHandle: "starter",
          includedRecoveryConversationAllowance: 100,
          recoveryCreditPackEnabled: false,
          features: {
            create: [
              {
                featureId: "feature-1",
                enabled: true,
                configuration: { enabledRegions: ["GB"] },
              },
            ],
          },
        }),
      }),
    );
    expect(test.transaction.merchantPricingPlan.update).toHaveBeenCalledWith({
      where: { id: "catalogue-starter" },
      data: { materializedAt: expect.any(Date) },
    });
    expect(test.database.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
    expect(test.logger.info).toHaveBeenCalledWith(
      "billing.plan_materialized",
      expect.objectContaining({ shopifyPlanHandle: "starter" }),
    );
  });

  const unavailableCatalogues: Array<{
    reason: string;
    pricing: typeof catalogue | null;
  }> = [
    { reason: "missing", pricing: null },
    { reason: "inactive", pricing: { ...catalogue, isActive: false } },
    {
      reason: "not ready",
      pricing: {
        ...catalogue,
        publicationStatus: MerchantPricingPlanPublicationStatus.TRANSLATING,
      },
    },
  ];
  it.each(unavailableCatalogues)(
    "does not materialize a $reason catalogue entry",
    async ({ pricing }) => {
      const test = harness({ pricing });
      expect(await test.service.resolve("starter")).toBeNull();
      expect(test.transaction.billingPlan.create).not.toHaveBeenCalled();
      expect(
        test.transaction.merchantPricingPlan.update,
      ).not.toHaveBeenCalled();
    },
  );

  it("preserves an existing inactive operational plan rather than reactivating it", async () => {
    const disabled = { ...oldPlan, active: false };
    const test = harness({ operational: disabled });
    expect(await test.service.resolve("start")).toEqual(disabled);
    expect(test.database.$transaction).not.toHaveBeenCalled();
  });

  it("uses a concurrently committed plan instead of overwriting it", async () => {
    const test = harness();
    test.transaction.billingPlan.findUnique.mockResolvedValue(newPlan);
    expect(await test.service.resolve("starter")).toEqual(newPlan);
    expect(
      test.transaction.merchantPricingPlan.findUnique,
    ).not.toHaveBeenCalled();
    expect(test.transaction.billingPlan.create).not.toHaveBeenCalled();
  });

  it("recovers a winning concurrent insert after a unique constraint race", async () => {
    const test = harness();
    test.database.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on BillingPlan.shopifyPlanHandle",
        { code: "P2002", clientVersion: "6.19.3" },
      ),
    );
    test.database.billingPlan.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(newPlan);
    expect(await test.service.resolve("starter")).toEqual(newPlan);
  });

  it("retains the original database error and logs it when no competing plan committed", async () => {
    const test = harness();
    const original = new Error("database unavailable: connection refused");
    test.database.$transaction.mockRejectedValue(original);
    await expect(test.service.resolve("starter")).rejects.toBe(original);
    expect(test.logger.error).toHaveBeenCalledWith(
      "billing.plan_materialization_failed",
      expect.objectContaining({
        shopifyPlanHandle: "starter",
        errorMessage: original.message,
        error: original,
      }),
    );
  });

  it("treats invalid catalogue configuration as an unmapped plan, not a sync failure", async () => {
    const invalid = [{ ...catalogue, includedRecoveryCredits: -1 }];
    for (const pricing of invalid) {
      const test = harness({ pricing });
      expect(await test.service.resolve("starter")).toBeNull();
      expect(test.transaction.billingPlan.create).not.toHaveBeenCalled();
      expect(
        test.transaction.merchantPricingPlan.update,
      ).not.toHaveBeenCalled();
      expect(test.logger.warn).toHaveBeenCalledWith(
        "billing.plan_catalogue_unavailable",
        expect.objectContaining({
          shopifyPlanHandle: "starter",
          unavailableReason: expect.any(String),
        }),
      );
    }
  });

  it("materializes a Paid plan when its optional App Events reporting handle is absent", async () => {
    const test = harness({
      pricing: { ...catalogue, shopifyRecoveryUsageEventHandle: null },
    });
    await test.service.resolve("starter");
    expect(test.transaction.billingPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "PAID_METERED",
          shopifyUsageEventHandle: null,
        }),
      }),
    );
  });

  it("does not reject a Free plan because an App Events reporting handle is populated", async () => {
    const test = harness({
      pricing: {
        ...catalogue,
        planKind: MerchantPricingPlanKind.FREE,
        shopifyRecoveryUsageEventHandle: "legacy-reporting-handle",
      },
    });
    await test.service.resolve("starter");
    expect(test.transaction.billingPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "FREE",
          shopifyUsageEventHandle: null,
        }),
      }),
    );
  });

  it("keeps ordinary recovery-meter mapping separate from catalogue credit-pack offers", async () => {
    const test = harness({
      pricing: {
        ...catalogue,
        shopifyRecoveryUsageEventHandle: "  recovery-meter  ",
      },
    });
    await test.service.resolve("starter");
    expect(test.transaction.billingPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shopifyUsageEventHandle: "recovery-meter",
          recoveryCreditPackEnabled: false,
          recoveryCreditsPerPack: null,
          shopifyRecoveryCreditPackEventHandle: null,
        }),
      }),
    );
  });
});
