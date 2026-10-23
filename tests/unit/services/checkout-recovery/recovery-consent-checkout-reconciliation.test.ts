import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));

import { CheckoutEventOrchestratorService } from "../../../../src/services/checkout-recovery/checkout-event-orchestrator.service.js";
import { RecoveryMaterializationService } from "../../../../src/services/checkout-recovery/recovery-materialization.service.js";
import { RecoveryConsentAdmissionService } from "../../../../src/services/checkout-recovery/recovery-consent-admission.service.js";

const checkoutEvent = {
  shopDomain: "shop.myshopify.com",
  checkoutToken: "checkout-consent-1",
  cartToken: "cart-1",
  checkoutCreatedAt: "2026-10-22T10:00:00Z",
  abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=private",
  activityAt: "2026-10-22T10:30:00Z",
};

const checkout = {
  completedAt: null as string | null,
  abandonedCheckoutUrl: checkoutEvent.abandonedCheckoutUrl,
  createdAt: checkoutEvent.checkoutCreatedAt,
  customer: { shopifyCustomerId: "gid://shopify/Customer/123", phone: "+447700900001" },
};

/** Test the ordinary checkout event -> matured candidate boundary, without a consent-specific scheduler. */
function scenario() {
  let granted = false;
  let paidOrderRecorded = false;
  let currentRecipient = "447700900001";
  let authorisedRecipient = "447700900001";
  let currentCheckout = { ...checkout };
  let storedRecovery: { id: string; shopId: string; checkoutToken: string; status: string; generation: number } | null = null;
  const candidates: Array<Record<string, unknown>> = [];
  const writes = { recovery: vi.fn(), attempt: vi.fn(), charge: vi.fn(), send: vi.fn() };
  const notice = { publish: vi.fn(async () => "created" as const) };
  const native = {
    evaluateRecipient: vi.fn(async (input: { recipient: string }) => granted && input.recipient === authorisedRecipient
      ? { status: "ALLOWED" as const, customerPhoneId: "phone-1", canonicalRecipient: currentRecipient, consentRevision: 2n, noContactRevision: 0n }
      : { status: "NOT_AUTHORISED" as const, reason: "NATIVE_CONSENT_NOT_GRANTED" as const }),
    evaluateStoredRecipient: vi.fn(async () => ({ status: "ALLOWED" as const, customerPhoneId: "phone-1", canonicalRecipient: currentRecipient, consentRevision: 2n, noContactRevision: 0n })),
  };
  const consent = new RecoveryConsentAdmissionService(native, notice);
  const pending = {
    scheduleFromCheckoutCreated: vi.fn(),
    refreshCandidateActivity: vi.fn(async () => ({ outcome: "not-found" as const })),
    scheduleFromCheckoutUpdated: vi.fn(async (event: typeof checkoutEvent) => {
      candidates.push({
        shopId: "shop-1", shopDomain: event.shopDomain,
        checkoutToken: event.checkoutToken, cartToken: event.cartToken,
        checkoutCreatedAt: event.checkoutCreatedAt,
        abandonedCheckoutUrl: event.abandonedCheckoutUrl,
      });
      return { outcome: "enqueued" as const, jobId: `job-${candidates.length}` };
    }),
    withCheckoutLock: vi.fn(async (_shopId: string, _checkoutToken: string, action: () => Promise<unknown>) => action()),
    hasOrderProcessed: vi.fn(async () => paidOrderRecorded),
    findCandidateJobIdByCheckout: vi.fn(async () => null),
  };
  const shop = {
    findUnique: vi.fn(async () => ({ id: "shop-1", status: "ACTIVE", platform: "SHOPIFY", onboardingCompleted: true,
      subscription: { status: "ACTIVE", lastProviderLifecycleState: null } })),
  };
  const db = { shop };
  const eligibility = {
    evaluateResolvedShop: vi.fn(() => ({ allowed: true as const, shopId: "shop-1" })),
    evaluate: vi.fn(async () => ({ allowed: true as const, shopId: "shop-1" })),
  };
  const latest = vi.fn(async () => storedRecovery);
  const lookup = {
    resolveShopDomain: vi.fn(async () => checkoutEvent.shopDomain),
    lookup: vi.fn(async () => ({ kind: "found" as const, checkout: currentCheckout })),
  };
  const snapshot = {
    serializeLineItems: vi.fn(() => []),
    build: vi.fn(async (candidate: { checkoutToken: string }) => ({
      shop: checkoutEvent.shopDomain, checkoutToken: candidate.checkoutToken,
      customer: { shopifyCustomerId: "gid://shopify/Customer/123", phone: "+447700900001" },
    })),
  };
  const recipientResolver = { resolve: vi.fn(async () => currentRecipient) };
  const initiate = vi.fn(async (seed: { checkoutToken: string }, _generation: number, recipient: string) => {
    const permitted = await consent.evaluateFirst({
      shopId: "shop-1", checkoutToken: seed.checkoutToken,
      customerId: "customer-1", shopifyCustomerId: "gid://shopify/Customer/123", recipient,
    });
    if (!permitted) return null;
    // The initiation service's separate unit tests cover the actual pre-insert and
    // post-reservation fences. These spies represent its durable writes at this boundary.
    storedRecovery = { id: "recovery-1", shopId: "shop-1", checkoutToken: seed.checkoutToken,
      status: "MESSAGE_SENT", generation: 1 };
    writes.recovery(storedRecovery);
    writes.attempt("attempt-1");
    writes.charge("credit-1");
    writes.send(recipient);
    return storedRecovery;
  });
  const orchestrator = new CheckoutEventOrchestratorService(
    db as never, pending as never, eligibility as never, latest as never,
    lookup as never, snapshot as never,
  );
  const materialization = new RecoveryMaterializationService({
    executionEligibility: eligibility as never,
    abandonedCheckoutLookup: lookup as never,
    pendingRecoveryCandidate: pending as never,
    findLatestRecovery: latest as never,
    snapshotBuilder: snapshot as never,
    recipientResolver: recipientResolver as never,
    initiate: initiate as never,
  });
  return {
    orchestrator, materialization, pending, candidates, writes, native, notice,
    lookup, initiate, recipientResolver,
    setGrant: (value: boolean) => { granted = value; },
    recordPaidOrder: () => { paidOrderRecorded = true; },
    setCheckoutCompleted: (date: string) => { currentCheckout = { ...currentCheckout, completedAt: date }; },
    setCurrentRecipient: (value: string) => { currentRecipient = value; },
    setAuthorisedRecipient: (value: string) => { authorisedRecipient = value; },
  };
}

async function matureNext(ctx: ReturnType<typeof scenario>) {
  const candidate = ctx.candidates.shift();
  if (!candidate) throw new Error("Expected an ordinary checkout event to enqueue a candidate");
  return ctx.materialization.materialize(candidate as never);
}

describe("ARCH-045 checkout-event-only consent re-evaluation", () => {
  it("does nothing on grant alone, then admits only after a separate legitimate checkout event", async () => {
    const ctx = scenario();
    expect(await ctx.orchestrator.handleCheckoutUpdatedContract(checkoutEvent)).toMatchObject({ kind: "pending" });
    expect((await matureNext(ctx)).outcome).toBe("discarded-admission-denied");
    expect(ctx.native.evaluateRecipient).toHaveBeenCalledTimes(1);
    expect(ctx.notice.publish).toHaveBeenCalledWith(expect.objectContaining({ reason: "NO_VERIFIED_OPT_IN" }));
    for (const action of Object.values(ctx.writes)) expect(action).not.toHaveBeenCalled();

    // Native consent webhook/CustomerPhone projection alone does not invoke the
    // checkout event orchestrator or retain a consent-wait candidate.
    ctx.setGrant(true);
    expect(ctx.candidates).toHaveLength(0);
    expect(ctx.pending.scheduleFromCheckoutUpdated).toHaveBeenCalledTimes(1);
    expect(ctx.pending.scheduleFromCheckoutCreated).not.toHaveBeenCalled();
    expect(ctx.initiate).toHaveBeenCalledTimes(1);
    for (const action of Object.values(ctx.writes)) expect(action).not.toHaveBeenCalled();

    expect(await ctx.orchestrator.handleCheckoutUpdatedContract({
      ...checkoutEvent, activityAt: "2026-10-22T11:30:00Z",
    })).toMatchObject({ kind: "pending" });
    expect((await matureNext(ctx)).outcome).toBe("recovery-created");
    expect(ctx.native.evaluateRecipient).toHaveBeenCalledTimes(2);
    for (const action of Object.values(ctx.writes)) expect(action).toHaveBeenCalledTimes(1);
    expect(ctx.writes.send).toHaveBeenCalledWith("447700900001");
    expect(ctx.candidates).toHaveLength(0);
  });

  it("does not resurrect a completed checkout after a later grant and genuine checkout update", async () => {
    const ctx = scenario();
    ctx.setGrant(true);
    ctx.setCheckoutCompleted("2026-10-22T11:00:00Z");
    await ctx.orchestrator.handleCheckoutUpdatedContract(checkoutEvent);
    expect((await matureNext(ctx)).outcome).toBe("discarded-not-recoverable");
    expect(ctx.native.evaluateRecipient).not.toHaveBeenCalled();
    for (const action of Object.values(ctx.writes)) expect(action).not.toHaveBeenCalled();
  });

  it("loses the paid-order race under the checkout lock without recovery, billing or provider send", async () => {
    const ctx = scenario();
    ctx.setGrant(true);
    await ctx.orchestrator.handleCheckoutUpdatedContract(checkoutEvent);
    ctx.pending.withCheckoutLock.mockImplementationOnce(async (_shopId, _token, action) => {
      // Order completion wins immediately before candidate admission obtains the lock.
      ctx.recordPaidOrder();
      return action();
    });
    expect((await matureNext(ctx)).outcome).toBe("discarded-order-completed");
    expect(ctx.pending.hasOrderProcessed).toHaveBeenCalledOnce();
    expect(ctx.lookup.lookup).not.toHaveBeenCalled();
    expect(ctx.native.evaluateRecipient).not.toHaveBeenCalled();
    for (const action of Object.values(ctx.writes)) expect(action).not.toHaveBeenCalled();
  });

  it("deduplicates a repeated matured candidate against the persisted recovery", async () => {
    const ctx = scenario();
    ctx.setGrant(true);
    await ctx.orchestrator.handleCheckoutUpdatedContract(checkoutEvent);
    const first = { ...ctx.candidates[0] };
    expect((await matureNext(ctx)).outcome).toBe("recovery-created");
    expect(await ctx.materialization.materialize(first as never)).toMatchObject({ outcome: "no-op-existing" });
    expect(ctx.initiate).toHaveBeenCalledOnce();
    expect(ctx.native.evaluateRecipient).toHaveBeenCalledOnce();
    for (const action of Object.values(ctx.writes)) expect(action).toHaveBeenCalledTimes(1);
  });

  it("checks a changed active phone instead of reusing the old phone's consent", async () => {
    const ctx = scenario();
    ctx.setGrant(true);
    ctx.setCurrentRecipient("447700900002");
    await ctx.orchestrator.handleCheckoutUpdatedContract(checkoutEvent);
    expect((await matureNext(ctx)).outcome).toBe("discarded-admission-denied");
    expect(ctx.native.evaluateRecipient).toHaveBeenCalledWith(expect.objectContaining({
      recipient: "447700900002",
    }));
    for (const action of Object.values(ctx.writes)) expect(action).not.toHaveBeenCalled();

    // Granting the old number must never authorise the new active recipient.
    // Only a fresh native grant for that number on a separate checkout event can.
    ctx.setAuthorisedRecipient("447700900002");
    await ctx.orchestrator.handleCheckoutUpdatedContract({
      ...checkoutEvent, activityAt: "2026-10-22T11:30:00Z",
    });
    expect((await matureNext(ctx)).outcome).toBe("recovery-created");
    expect(ctx.native.evaluateRecipient).toHaveBeenLastCalledWith(expect.objectContaining({
      recipient: "447700900002",
    }));
    expect(ctx.writes.send).toHaveBeenCalledWith("447700900002");
    expect(ctx.writes.send).not.toHaveBeenCalledWith("447700900001");
  });
});
