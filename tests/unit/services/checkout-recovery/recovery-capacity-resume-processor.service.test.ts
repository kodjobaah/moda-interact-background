import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryCapacityResumeProcessorService } from "../../../../src/services/checkout-recovery/recovery-capacity-resume-processor.service.js";

const blockedRecovery = {
  id: "recovery-1",
  shopId: "shop-1",
  checkoutToken: "checkout-1",
  cartToken: "cart-1",
  checkoutUrl: "https://checkout/durable",
  detectedAt: new Date("2026-09-01T00:00:00.000Z"),
  generation: 1,
  status: "DETECTED",
  admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
  customerId: "customer-1",
  shop: { domain: "shop.example", status: "ACTIVE" },
};
const suppressionBlockedRecovery = {
  ...blockedRecovery,
  admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED",
};

const currentCheckout = {
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  currencyCode: "GBP",
  totalPrice: "42.00",
  abandonedCheckoutUrl: "https://checkout/current",
  customer: null,
  lineItems: [],
  internationalContext: null,
};

function createHarness({
  reads = [blockedRecovery, blockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
  lookup = { kind: "found", checkout: currentCheckout },
  allowed = true,
  updateCount = 1,
  resolvedRecipient = null,
  customerRecipient = "15551234567",
} = {}) {
  const order: string[] = [];
  const readResults = [...reads];
  const database = {
    checkoutRecovery: {
      findUnique: vi.fn(async () => {
        order.push("recovery-read");
        return readResults.shift() ?? null;
      }),
    },
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => {
      order.push("transaction");
      return callback({
        checkoutRecovery: {
          updateMany: vi.fn(async () => {
            order.push("terminal-update");
            return { count: updateCount };
          }),
        },
        checkoutRecoveryStatusHistory: {
          create: vi.fn(async () => {
            order.push("history-create");
            return {};
          }),
        },
      });
    }),
  };
  const pendingRecoveryCandidateService = {
    withCheckoutLock: vi.fn(async (
      _shopId: string,
      _checkoutToken: string,
      callback: () => Promise<unknown>,
    ) => {
      order.push("lock");
      return callback();
    }),
  };
  const shopExecutionEligibilityService = {
    evaluate: vi.fn(async () => {
      order.push("eligibility");
      return allowed ? { allowed: true, shopId: "shop-1" } : {
        allowed: false,
        shopId: "shop-1",
        reason: "SUBSCRIPTION_FROZEN",
      };
    }),
  };
  const abandonedCheckoutLookupService = {
    lookup: vi.fn(async () => {
      order.push("lookup");
      return lookup;
    }),
  };
  const snapshotBuilder = {
    build: vi.fn(async () => ({
      shop: "shop.example",
      checkoutToken: "checkout-1",
      checkoutUrl: "https://checkout/current",
      completedAt: null,
    })),
  };
  const initiate = vi.fn(async () => undefined);
  const recipientResolver = {
    resolve: vi.fn(async () => resolvedRecipient),
    resolveForCustomerInShop: vi.fn(async () => customerRecipient),
  };
  const suppressionAdmission = {
    clearDetectedSuppression: vi.fn(async () => undefined),
  };
  const service = new RecoveryCapacityResumeProcessorService(
    database as never,
    pendingRecoveryCandidateService as never,
    shopExecutionEligibilityService as never,
    abandonedCheckoutLookupService as never,
    snapshotBuilder as never,
    initiate,
    recipientResolver as never,
    suppressionAdmission as never,
  );

  return {
    order,
    database,
    pendingRecoveryCandidateService,
    shopExecutionEligibilityService,
    abandonedCheckoutLookupService,
    snapshotBuilder,
    initiate,
    recipientResolver,
    suppressionAdmission,
    service,
  };
}

describe("RecoveryCapacityResumeProcessorService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores missing or no-longer-blocked durable recoveries before eligibility work", async () => {
    const harness = createHarness({ reads: [null] });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "ignored",
      reason: "not-capacity-blocked",
    });
    expect(harness.shopExecutionEligibilityService.evaluate).not.toHaveBeenCalled();
    expect(harness.pendingRecoveryCandidateService.withCheckoutLock).not.toHaveBeenCalled();
  });

  it("stops before lookup when execution is denied", async () => {
    const harness = createHarness({ allowed: false });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "ignored",
      reason: "SUBSCRIPTION_FROZEN",
    });
    expect(harness.pendingRecoveryCandidateService.withCheckoutLock).not.toHaveBeenCalled();
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
  });

  it("re-reads durable block state and rechecks eligibility after acquiring the checkout lock", async () => {
    const harness = createHarness({
      reads: [blockedRecovery, blockedRecovery],
    });
    harness.shopExecutionEligibilityService.evaluate
      .mockResolvedValueOnce({ allowed: true, shopId: "shop-1" })
      .mockResolvedValueOnce({
        allowed: false,
        shopId: "shop-1",
        reason: "SUBSCRIPTION_FROZEN",
      });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "ignored",
      reason: "SUBSCRIPTION_FROZEN",
    });
    expect(harness.order).toEqual([
      "recovery-read",
      "lock",
      "recovery-read",
    ]);
    expect(harness.shopExecutionEligibilityService.evaluate).toHaveBeenCalledTimes(2);
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["provider-error", { kind: "provider-error", message: "temporary" }],
    ["ambiguous", { kind: "ambiguous" }],
    ["bounded-limit-exceeded", { kind: "bounded-limit-exceeded" }],
  ] as const)("keeps %s lookup failures retryable", async (_kind, lookup) => {
    const harness = createHarness({ lookup });

    await expect(harness.service.resume("recovery-1")).rejects.toThrow();
    expect(harness.database.$transaction).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it("terminalises not-found in one guarded transaction and records history only after the CAS", async () => {
    const harness = createHarness({
      lookup: { kind: "not-found" },
      reads: [blockedRecovery, blockedRecovery],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "terminal",
      reason: "not-found",
    });
    expect(harness.order).toEqual([
      "recovery-read",
      "eligibility",
      "lock",
      "recovery-read",
      "eligibility",
      "lookup",
      "transaction",
      "terminal-update",
      "history-create",
    ]);
  });

  it("preserves the found return reason quirk for a completed checkout", async () => {
    const harness = createHarness({
      lookup: { kind: "found", checkout: { ...currentCheckout, completedAt: "2026-09-02T00:00:00Z" } },
      reads: [blockedRecovery, blockedRecovery],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "terminal",
      reason: "found",
    });
    expect(harness.database.$transaction).toHaveBeenCalledOnce();
  });

  it("uses the Shop-scoped current phone for generation-one re-entry", async () => {
    const harness = createHarness({
      reads: [blockedRecovery, blockedRecovery, null],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "initiated",
      status: "DETECTED",
    });
    expect(harness.snapshotBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop-1",
        shopDomain: "shop.example",
        checkoutToken: "checkout-1",
        checkoutCreatedAt: blockedRecovery.detectedAt.toISOString(),
      }),
      "shop.example",
      currentCheckout,
    );
    expect(harness.initiate).toHaveBeenCalledOnce();
    expect(harness.recipientResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ checkoutToken: "checkout-1" }));
    expect(harness.recipientResolver.resolveForCustomerInShop).toHaveBeenCalledWith("customer-1", "shop-1");
    expect(harness.initiate).toHaveBeenCalledWith(expect.any(Object), 1, "15551234567");
  });

  it("re-evaluates a suppression-blocked recovery from fresh checkout state under its lock", async () => {
    const harness = createHarness({
      reads: [
        suppressionBlockedRecovery,
        suppressionBlockedRecovery,
        { status: "MESSAGE_SENT", admissionBlockReason: null },
      ],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "initiated",
      status: "MESSAGE_SENT",
    });
    expect(harness.order).toEqual([
      "recovery-read",
      "eligibility",
      "lock",
      "recovery-read",
      "eligibility",
      "lookup",
      "recovery-read",
    ]);
    expect(harness.snapshotBuilder.build).toHaveBeenCalledOnce();
    expect(harness.initiate).toHaveBeenCalledOnce();
    expect(harness.initiate.mock.calls[0][2]).toBe("15551234567");
  });

  it("uses a changed current number as an independent recipient key", async () => {
    const harness = createHarness({
      reads: [suppressionBlockedRecovery, suppressionBlockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
      resolvedRecipient: "447700900123",
    });

    await harness.service.resume("recovery-1");

    expect(harness.recipientResolver.resolveForCustomerInShop).not.toHaveBeenCalled();
    expect(harness.initiate).toHaveBeenCalledWith(expect.any(Object), 1, "447700900123");
  });

  it("clears an expired suppression block and does not initiate when no current phone exists", async () => {
    const harness = createHarness({
      reads: [suppressionBlockedRecovery, suppressionBlockedRecovery],
      customerRecipient: null,
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "suppressed",
      reason: "no-recipient",
    });

    expect(harness.suppressionAdmission.clearDetectedSuppression).toHaveBeenCalledWith("recovery-1");
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it("uses the Shop-scoped stored phone when the fresh checkout has no customer phone", async () => {
    const harness = createHarness({
      reads: [suppressionBlockedRecovery, suppressionBlockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
      customerRecipient: "15558675309",
    });

    await harness.service.resume("recovery-1");

    expect(harness.recipientResolver.resolveForCustomerInShop).toHaveBeenCalledWith("customer-1", "shop-1");
    expect(harness.initiate).toHaveBeenCalledWith(expect.any(Object), 1, "15558675309");
  });

  it("passes later recovery generations to canonical initiation", async () => {
    const harness = createHarness({
      reads: [
        { ...blockedRecovery, generation: 3 },
        { ...blockedRecovery, generation: 3 },
        { status: "MESSAGE_SENT", admissionBlockReason: null },
      ],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "initiated",
      status: "MESSAGE_SENT",
    });
    expect(harness.initiate.mock.calls[0]).toHaveLength(3);
    expect(harness.initiate.mock.calls[0][1]).toBe(3);
    expect(harness.initiate.mock.calls[0][2]).toBe("15551234567");
  });

  it("reports capacity exhaustion while the durable block remains and makes replay a no-op after it clears", async () => {
    const harness = createHarness({
      reads: [
        blockedRecovery,
        blockedRecovery,
        { status: "DETECTED", admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED" },
        { ...blockedRecovery, status: "MESSAGE_SENT", admissionBlockReason: null },
      ],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "capacity-exhausted",
    });
    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "ignored",
      reason: "not-capacity-blocked",
    });
    expect(harness.abandonedCheckoutLookupService.lookup).toHaveBeenCalledOnce();
    expect(harness.initiate).toHaveBeenCalledOnce();
  });
});