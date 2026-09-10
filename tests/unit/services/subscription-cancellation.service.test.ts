import { describe, expect, it, vi } from "vitest";

import { SubscriptionCancellationStatus } from "@prisma/client";
import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  createMerchantBillingSystemSourceKey,
} from "@modainteract/moda-interact-shared/billing";

import { SubscriptionCancellationService } from "../../../src/services/subscription-cancellation.service.js";
import { ShopifyPartnerBillingError } from "../../../src/providers/shopify-partner-billing.provider.js";

const now = new Date("2026-09-10T12:00:00.000Z");

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "cancel-1",
    shopId: "shop-1",
    providerSubscriptionIdSnapshot: "sub-1",
    planHandleSnapshot: "growth-plan",
    mode: "END_OF_CYCLE",
    status: SubscriptionCancellationStatus.APPROVED,
    version: 2,
    attemptCount: 0,
    providerAcceptedAt: null,
    shop: { shopifyShopId: "gid://shopify/Shop/1" },
    ...overrides,
  } as never;
}

function database(row: ReturnType<typeof request>, actualStatus = row.status) {
  let claimWon = true;
  let currentStatus = actualStatus;
  const updateMany = vi.fn().mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (data.status === SubscriptionCancellationStatus.PROCESSING) {
      if (!claimWon || where.status !== currentStatus) return { count: 0 };
      claimWon = false;
      currentStatus = SubscriptionCancellationStatus.PROCESSING;
      return { count: 1 };
    }
    return { count: 1 };
  });
  const merchantSupportMessage = { upsert: vi.fn().mockResolvedValue({}) };
  const merchantSupportThread = { upsert: vi.fn().mockResolvedValue({ id: "thread-1" }) };
  const db = {
    subscriptionCancellationRequest: {
      updateMany,
      findMany: vi.fn().mockResolvedValue([row]),
    },
    merchantSupportMessage,
    merchantSupportThread,
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => callback(db)),
  };
  return { db: db as never, updateMany, merchantSupportMessage, merchantSupportThread };
}

function active(overrides: Record<string, unknown> = {}) {
  return {
    providerSubscriptionId: "sub-1",
    planHandle: "growth-plan",
    cancelAtPeriodEnd: false,
    ...overrides,
  } as never;
}

function statefulDatabase(rowOverrides: Record<string, unknown> = {}) {
  const row = {
    processingStartedAt: null,
    nextAttemptAt: null,
    lastAttemptAt: null,
    completedAt: null,
    providerErrorCode: null,
    providerResponseSummary: null,
    ...request(rowOverrides),
  } as Record<string, any>;
  const messages = new Map<string, Record<string, unknown>>();
  let threadCreated = false;

  const matchesWhere = (where: Record<string, any>) => {
    if (where.id && where.id !== row.id) return false;
    if (where.version !== undefined && where.version !== row.version) return false;
    if (where.status && where.status !== row.status) return false;
    if (where.processingStartedAt?.lte && (!row.processingStartedAt || row.processingStartedAt > where.processingStartedAt.lte)) return false;
    if (where.providerAcceptedAt === null && row.providerAcceptedAt !== null) return false;
    if (where.providerAcceptedAt && where.providerAcceptedAt.not !== null && row.providerAcceptedAt === null) return false;
    return true;
  };
  const applyData = (data: Record<string, any>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) row[key] += value.increment;
      else row[key] = value;
    }
  };
  const updateMany = vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
    if (!matchesWhere(where)) return { count: 0 };
    applyData(data);
    return { count: 1 };
  });
  const merchantSupportMessage = {
    upsert: vi.fn(async ({ where, create }: { where: { sourceKey: string }; create: Record<string, unknown> }) => {
      if (!messages.has(where.sourceKey)) messages.set(where.sourceKey, create);
      return messages.get(where.sourceKey);
    }),
  };
  const merchantSupportThread = {
    upsert: vi.fn(async () => {
      threadCreated = true;
      return { id: "thread-1" };
    }),
  };
  const db = {
    subscriptionCancellationRequest: {
      updateMany,
      findMany: vi.fn(async () => {
        const eligible = row.status === SubscriptionCancellationStatus.APPROVED
          || row.status === SubscriptionCancellationStatus.PROVIDER_ACCEPTED
          || (row.status === SubscriptionCancellationStatus.RETRYABLE && (!row.nextAttemptAt || row.nextAttemptAt <= now));
        return eligible ? [{ ...row }] : [];
      }),
    },
    merchantSupportMessage,
    merchantSupportThread,
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => callback(db)),
  };
  return { db: db as never, row, messages, updateMany, merchantSupportMessage, threadCreated: () => threadCreated };
}

describe("SubscriptionCancellationService", () => {
  it("does not call the provider mutation when the approved identity changed", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ providerSubscriptionId: "sub-2" })),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: SubscriptionCancellationStatus.NEEDS_ATTENTION }),
    }));
  });

  it("completes an already deferred end-of-cycle cancellation without a duplicate call", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ cancelAtPeriodEnd: true })),
      cancelSubscription: vi.fn(),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.completed).toBe(1);
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it("completes an immediate cancellation when Partner reports no contract", async () => {
    const test = database(request({ mode: "IMMEDIATE_NO_PRORATION" }));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(null),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it("records provider acceptance without prematurely completing", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockResolvedValue({ summary: "accepted" }),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.accepted).toBe(1);
    expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED }),
    }));
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ providerErrorCode: null }),
    }));
  });

  it("preserves approved identity and mode across a retryable provider failure", async () => {
    const test = database(request({
      status: SubscriptionCancellationStatus.RETRYABLE,
      nextAttemptAt: new Date("2026-09-10T11:00:00.000Z"),
      providerErrorCode: "http-503",
    }));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockRejectedValue(new Error("network unavailable")),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.retryable).toBe(1);
    expect(provider.cancelSubscription).toHaveBeenCalledWith({
      shopifyShopId: "gid://shopify/Shop/1",
      mode: "END_OF_CYCLE",
    });
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: SubscriptionCancellationStatus.RETRYABLE,
        providerErrorCode: "unknown-provider-error",
      }),
    }));
  });

  it("includes the selected lifecycle status in the claim CAS", async () => {
    const test = database(request(), SubscriptionCancellationStatus.RETRYABLE);
    const provider = {
      getActiveSubscription: vi.fn(),
      cancelSubscription: vi.fn(),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.claimed).toBe(0);
    expect(provider.getActiveSubscription).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "cancel-1",
        version: 2,
        status: SubscriptionCancellationStatus.APPROVED,
      }),
    }));
  });

  it("uses the default batch and deterministic due ordering query", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ cancelAtPeriodEnd: true })),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue(100);

    expect(test.db.subscriptionCancellationRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 25,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { status: SubscriptionCancellationStatus.APPROVED },
          { status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED },
          {
            status: SubscriptionCancellationStatus.RETRYABLE,
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
        ]),
      }),
    }));
  });

  it("uses approved identity snapshots rather than a newer local projection", async () => {
    const test = statefulDatabase({
      providerSubscriptionIdSnapshot: "approved-subscription",
      planHandleSnapshot: "approved-plan",
      mode: "IMMEDIATE_PRORATED",
    });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({
        providerSubscriptionId: "approved-subscription",
        planHandle: "approved-plan",
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ summary: "accepted" }),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect((test.db as { subscription?: unknown }).subscription).toBeUndefined();
    expect(provider.cancelSubscription).toHaveBeenCalledWith({
      shopifyShopId: "gid://shopify/Shop/1",
      mode: "IMMEDIATE_PRORATED",
    });
  });

  it("uses one deterministic completion source key across replay attempts", async () => {
    const test = statefulDatabase({
      status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
      providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
      mode: "IMMEDIATE_NO_PRORATION",
    });
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(null), cancelSubscription: vi.fn() };
    const service = new SubscriptionCancellationService(test.db, provider, () => now);

    await service.processDue();
    await service.processDue();

    const sourceKey = createMerchantBillingSystemSourceKey(
      "shop-1",
      BILLING_SYSTEM_MESSAGE_CODES.CANCELLATION_COMPLETED,
      "cancel-1",
      ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
    );
    expect(test.messages.size).toBe(1);
    expect(test.messages.get(sourceKey)).toMatchObject({
      sourceKey,
      systemCode: BILLING_SYSTEM_MESSAGE_CODES.CANCELLATION_COMPLETED,
    });
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it("persists bounded secret-free retryable provider failures", async () => {
    const secret = "partner-access-token-secret";
    const test = statefulDatabase({ nextAttemptAt: new Date("2026-09-10T11:00:00.000Z") });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockRejectedValue(new ShopifyPartnerBillingError(`access_token=${secret}:${"x".repeat(2200)}`, "http-503", true)),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(test.row.status).toBe(SubscriptionCancellationStatus.RETRYABLE);
    expect(test.row.providerErrorCode).toBe("http-503");
    expect(test.row.providerResponseSummary).not.toContain(secret);
    expect(test.row.providerResponseSummary.length).toBeLessThanOrEqual(2000);
  });

  it.each([
    "Authorization: Bearer partner-secret",
    "Authorization=Bearer partner-secret",
    "X-Shopify-Access-Token: partner-secret",
    "X-Shopify-Access-Token=partner-secret",
    "access_token=partner-secret",
    "access-token: partner-secret",
    "Bearer partner-secret",
  ])("redacts persisted credential form: %s", async (credential) => {
    const test = statefulDatabase({ nextAttemptAt: new Date("2026-09-10T11:00:00.000Z") });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockRejectedValue(new ShopifyPartnerBillingError(`${credential}; ${"x".repeat(2200)}`, "http-429", true)),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(test.row.status).toBe(SubscriptionCancellationStatus.RETRYABLE);
    expect(test.row.providerErrorCode).toBe("http-429");
    expect(test.row.providerResponseSummary).not.toContain("partner-secret");
    expect(test.row.providerResponseSummary.length).toBeLessThanOrEqual(2000);
  });

  it("persists bounded secret-free permanent provider failures", async () => {
    const secret = "partner-access-token-secret";
    const test = statefulDatabase();
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockRejectedValue(new ShopifyPartnerBillingError(`access_token=${secret}:${"x".repeat(2200)}`, "http-403", false)),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(test.row.status).toBe(SubscriptionCancellationStatus.NEEDS_ATTENTION);
    expect(test.row.providerErrorCode).toBe("http-403");
    expect(test.row.providerResponseSummary).not.toContain(secret);
    expect(test.row.providerResponseSummary.length).toBeLessThanOrEqual(2000);
  });

  it("confirms immediate cancellation only when no active subscription remains", async () => {
    const test = database(request({
      status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
      providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
      mode: "IMMEDIATE_PRORATED",
    }));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(null),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it.each(["IMMEDIATE_NO_PRORATION", "IMMEDIATE_PRORATED", "IMMEDIATE_SKIP_FINAL_USAGE"] as const)(
    "completes immediate mode %s only after no active subscription",
    async (mode) => {
      const test = database(request({
        mode,
        status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
        providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
      }));
      const provider = {
        getActiveSubscription: vi.fn().mockResolvedValue(active()),
        cancelSubscription: vi.fn(),
      };

      const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

      expect(result.retryable).toBe(1);
      expect(provider.cancelSubscription).not.toHaveBeenCalled();
      expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
    },
  );

  it("does not falsely complete end-of-cycle cancellation when confirmation has no contract", async () => {
    const test = database(request({
      status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
      providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
    }));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(null),
      cancelSubscription: vi.fn(),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.retryable).toBe(1);
    expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
  });

  it("recovers stale processing leases into retry and provider verification paths", async () => {
    const test = database(request({ status: SubscriptionCancellationStatus.PROCESSING }), SubscriptionCancellationStatus.PROCESSING);
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn(),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: SubscriptionCancellationStatus.PROCESSING,
        providerAcceptedAt: null,
      }),
      data: expect.objectContaining({ status: SubscriptionCancellationStatus.RETRYABLE }),
    }));
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: SubscriptionCancellationStatus.PROCESSING,
        providerAcceptedAt: { not: null },
      }),
      data: expect.objectContaining({ status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED }),
    }));
  });

  it("recovers a stale provider-accepted lease, verifies it, and completes without mutation", async () => {
    const test = statefulDatabase({
      status: SubscriptionCancellationStatus.PROCESSING,
      providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
      processingStartedAt: new Date("2026-09-10T11:49:00.000Z"),
      mode: "END_OF_CYCLE",
    });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ cancelAtPeriodEnd: true })),
      cancelSubscription: vi.fn(),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.completed).toBe(1);
    expect(test.row.status).toBe(SubscriptionCancellationStatus.COMPLETED);
    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it("recovers a stale processing lease without provider acceptance into retryable work", async () => {
    const test = statefulDatabase({
      status: SubscriptionCancellationStatus.PROCESSING,
      providerAcceptedAt: null,
      processingStartedAt: new Date("2026-09-10T11:49:00.000Z"),
    });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockRejectedValue(new ShopifyPartnerBillingError("temporary", "http-503", true)),
    };

    await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(test.row.status).toBe(SubscriptionCancellationStatus.RETRYABLE);
    expect(test.row.providerAcceptedAt).toBeNull();
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["END_OF_CYCLE", true, "completed"],
    ["END_OF_CYCLE", false, "retryable"],
  ] as const)("confirms end-of-cycle state (%s, cancelAtPeriodEnd=%s) as %s", async (mode, cancelAtPeriodEnd, outcome) => {
    const test = statefulDatabase({
      mode,
      status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
      providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
    });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ cancelAtPeriodEnd })),
      cancelSubscription: vi.fn(),
    };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result[outcome]).toBe(1);
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(outcome === "completed" ? 1 : 0);
  });

  it("does not complete end-of-cycle confirmation when the provider returns no active subscription", async () => {
    const test = statefulDatabase({
      status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
      providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
    });
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(null), cancelSubscription: vi.fn() };

    const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

    expect(result.retryable).toBe(1);
    expect(test.row.status).toBe(SubscriptionCancellationStatus.RETRYABLE);
    expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
  });

  it.each(["IMMEDIATE_NO_PRORATION", "IMMEDIATE_PRORATED", "IMMEDIATE_SKIP_FINAL_USAGE"] as const)(
    "confirms %s when no active subscription remains",
    async (mode) => {
      const test = statefulDatabase({
        mode,
        status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
        providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
      });
      const provider = { getActiveSubscription: vi.fn().mockResolvedValue(null), cancelSubscription: vi.fn() };

      const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

      expect(result.completed).toBe(1);
      expect(provider.cancelSubscription).not.toHaveBeenCalled();
      expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["IMMEDIATE_NO_PRORATION", "IMMEDIATE_PRORATED", "IMMEDIATE_SKIP_FINAL_USAGE"] as const)(
    "keeps %s in verification when the approved subscription remains active",
    async (mode) => {
      const test = statefulDatabase({
        mode,
        status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED,
        providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z"),
      });
      const provider = { getActiveSubscription: vi.fn().mockResolvedValue(active()), cancelSubscription: vi.fn() };

      const result = await new SubscriptionCancellationService(test.db, provider, () => now).processDue();

      expect(result.retryable).toBe(1);
      expect(provider.cancelSubscription).not.toHaveBeenCalled();
      expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
    },
  );

  it("selects due retryable rows, excludes future retries, and keeps provider acceptance eligible", async () => {
    const due = statefulDatabase({ status: SubscriptionCancellationStatus.RETRYABLE, nextAttemptAt: new Date("2026-09-10T11:00:00.000Z") });
    const dueProvider = { getActiveSubscription: vi.fn().mockResolvedValue(active()), cancelSubscription: vi.fn().mockRejectedValue(new Error("retry")) };
    await new SubscriptionCancellationService(due.db, dueProvider, () => now).processDue();
    expect(dueProvider.getActiveSubscription).toHaveBeenCalledTimes(1);

    const future = statefulDatabase({ status: SubscriptionCancellationStatus.RETRYABLE, nextAttemptAt: new Date("2026-09-10T13:00:00.000Z") });
    const futureProvider = { getActiveSubscription: vi.fn(), cancelSubscription: vi.fn() };
    const futureResult = await new SubscriptionCancellationService(future.db, futureProvider, () => now).processDue();
    expect(futureResult.scanned).toBe(0);
    expect(futureProvider.getActiveSubscription).not.toHaveBeenCalled();

    const accepted = statefulDatabase({ status: SubscriptionCancellationStatus.PROVIDER_ACCEPTED, providerAcceptedAt: new Date("2026-09-10T11:00:00.000Z") });
    const acceptedProvider = { getActiveSubscription: vi.fn().mockResolvedValue(null), cancelSubscription: vi.fn() };
    await new SubscriptionCancellationService(accepted.db, acceptedProvider, () => now).processDue();
    expect(acceptedProvider.getActiveSubscription).toHaveBeenCalledTimes(1);
  });

  it("allows only one concurrent CAS claimant", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active()),
      cancelSubscription: vi.fn().mockResolvedValue({ summary: "accepted" }),
    };
    const service = new SubscriptionCancellationService(test.db, provider, () => now);

    await service.processDue();
    await service.processDue();

    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(test.merchantSupportMessage.upsert).not.toHaveBeenCalled();
  });

  it("emits one completion message when completion is replayed", async () => {
    const test = database(request());
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(active({ cancelAtPeriodEnd: true })),
      cancelSubscription: vi.fn(),
    };
    const service = new SubscriptionCancellationService(test.db, provider, () => now);

    await service.processDue();
    await service.processDue();

    expect(test.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });
});