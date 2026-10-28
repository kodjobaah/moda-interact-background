import { Prisma } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { describe, expect, it, vi } from "vitest";
import type {
  WooPendingCandidate,
  WooTerminalObservation,
} from "../../../../src/services/woocommerce-recovery/contracts.js";
import {
  WooRecoveryAdmissionService,
  type WooAdmissionDatabase,
  type WooDeniedAdmission,
} from "../../../../src/services/woocommerce-recovery/woo-recovery-admission.service.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const ACTIVITY = "2026-10-24T10:00:00.000Z";
const PHONE = "+447400123456";
const DIGITS = "447400123456";

function candidate(overrides: Partial<WooPendingCandidate> = {}): WooPendingCandidate {
  return {
    source: "woocommerce", shopId: "woo-shop", checkoutToken: "woo-checkout",
    lastEventId: "woo-event-1", lastActivityAt: ACTIVITY,
    basket: { kind: "nonempty", checkout: {
      currency: "GBP", total: "34.20", items: [{ quantity: 2, productId: "product-1", total: "34.20" }],
      contact: { phone: PHONE, email: "customer@example.test" },
    } },
    ...overrides,
  };
}

const snapshot = {
  shopId: "woo-shop", installationId: "installation", credentialVersion: 1,
  customerId: "customer", customerPhoneId: "phone", canonicalRecipient: DIGITS,
  consentRevision: 1n, consentDecisionSequence: 1n, noContactRevision: 0n,
};
const grant = {
  status: "ALLOWED" as const, customerPhoneId: "phone", canonicalRecipient: DIGITS,
  consentRevision: 1n, noContactRevision: 0n, snapshot,
};
function permittedFence(overrides: Record<string, unknown> = {}) {
  return {
    customerId: "customer", customerPhoneId: "phone", customerShopId: "woo-shop",
    customerEmail: "customer@example.test", canonicalPhone: DIGITS, endedAt: null,
    shopStatus: "ACTIVE", shopPlatform: "WOOCOMMERCE", installationId: "installation",
    installationStatus: "ACTIVE", revokedAt: null, credentialVersion: 1,
    phoneVerifiedAt: NOW, consentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
    consentDecision: "GRANTED", consentSource: "WOO_MODA_CHECKBOX",
    consentVerifiedAt: NOW, providerObservedAt: NOW,
    consentRevision: 1n, decisionSequence: 1n, noContact: false, noContactReason: null,
    noContactRevision: 0n,
    ...overrides,
  };
}

type RecoveryRow = { id: string; status: string; generation: number };
function fixtures() {
  const rows: RecoveryRow[] = [];
  const created: unknown[] = [];
  const histories: unknown[] = [];
  let fence = [permittedFence()];
  let current: WooPendingCandidate | null = candidate();
  let order: WooTerminalObservation = { kind: "none-observed" };

  const findFirst = vi.fn(async () => rows.length ? rows.at(-1)! : null);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    created.push(data);
    const row = { id: `recovery-${created.length}`, status: "DETECTED", generation: 1 };
    rows.push(row);
    return row;
  });
  const historyCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    histories.push(data);
    return data;
  });
  const queryRaw = vi.fn(async () => fence);
  const db = {
    shop: { findUnique: vi.fn(async () => ({ id: "woo-shop", platform: "WOOCOMMERCE",
      status: "ACTIVE", onboardingCompleted: true, defaultCountryCode: "GB" })) },
    wooCommerceInstallation: { findUnique: vi.fn(async () => ({ id: "installation", status: "ACTIVE",
      revokedAt: null, credentialVersion: 1 })) },
    customer: { findUnique: vi.fn(async () => ({ id: "customer", shopId: "woo-shop", email: "customer@example.test" })) },
    checkoutRecovery: { findFirst },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({
      checkoutRecovery: { findFirst, create }, checkoutRecoveryStatusHistory: { create: historyCreate },
      $queryRaw: queryRaw,
    })),
  };
  const candidates = { getPending: vi.fn(async () => current), cancelPending: vi.fn(async () => "absent" as const) };
  const orders = { read: vi.fn(async () => order) };
  // This fake models the BG002 checkout-scoped critical section, independently
  // of its concrete (not-yet-wired) Redis implementation.
  let chain = Promise.resolve();
  const coordinator = { withCheckoutLock: vi.fn(async <T>(_ref: unknown, run: () => Promise<T>): Promise<T> => {
    const preceding = chain;
    let release!: () => void;
    chain = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    try { return await run(); } finally { release(); }
  }) };
  const consent = { evaluateRecipient: vi.fn(async () => grant) };
  const policy = { resolve: vi.fn(async () => ({ recoveryDelayMinutes: 30 })) };
  const execution = { evaluate: vi.fn(async () => ({ allowed: true, shopId: "woo-shop" })) };
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  } as unknown as StructuredLogger;
  const denied = vi.fn(async (_input: WooDeniedAdmission) => {});
  const service = new WooRecoveryAdmissionService({
    database: db as unknown as WooAdmissionDatabase,
    candidates, orders, coordinator, consent, policy: policy as never,
    execution: execution as never, logger, now: () => NOW, onDeniedAdmission: denied,
  });
  return { service, db, rows, created, histories, candidates, orders, coordinator, consent, policy,
    execution, logger, denied, queryRaw, create, historyCreate,
    setCandidate: (value: WooPendingCandidate | null) => { current = value; },
    setOrder: (value: WooTerminalObservation) => { order = value; },
    setFence: (value: ReturnType<typeof permittedFence>[]) => { fence = value; },
  };
}

describe("ARCH-048-BACKGROUND-003 Woo first-recovery admission", () => {
  it("inserts exactly one DETECTED recovery plus initial history, with correct tenant/customer/basket; never sends", async () => {
    const f = fixtures();
    expect(await f.service.evaluateMatured(candidate(), { jobId: "job-1" }))
      .toEqual({ kind: "created", recoveryId: "recovery-1" });
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({ shopId: "woo-shop", checkoutToken: "woo-checkout",
      customerId: "customer", generation: 1, status: "DETECTED", cartToken: null,
      currency: "GBP", checkoutUrl: null, lastExternalActivityAt: new Date(ACTIVITY),
      lineItems: [{ quantity: 2, productId: "product-1", total: "34.20" }],
    });
    expect(f.histories).toHaveLength(1);
    expect(f.histories[0]).toMatchObject({ toStatus: "DETECTED", fromStatus: null, source: "WOOCOMMERCE" });
    expect(f.logger.info).toHaveBeenCalledWith("woocommerce.recovery.admission.evaluated",
      expect.objectContaining({ outcome: "created", recoveryId: "recovery-1", jobIdHash: expect.any(String) }));
    expect(JSON.stringify(vi.mocked(f.logger.info).mock.calls)).not.toContain(PHONE);
    expect(JSON.stringify(vi.mocked(f.logger.info).mock.calls)).not.toContain("woo-checkout");
    expect(f.denied).not.toHaveBeenCalled();
  });

  it("returns the durable existing row even if the delayed job/index is gone, including sent/expired generations", async () => {
    const f = fixtures();
    f.rows.push({ id: "previous", status: "MESSAGE_SENT", generation: 1 });
    f.setCandidate(null);
    expect(await f.service.evaluateMatured(candidate())).toEqual({
      kind: "already-exists", recoveryId: "previous", status: "MESSAGE_SENT",
    });
    expect(f.candidates.getPending).not.toHaveBeenCalled();
    expect(f.consent.evaluateRecipient).not.toHaveBeenCalled();
    expect(f.created).toHaveLength(0);
    f.rows[0]!.status = "EXPIRED";
    expect(await f.service.evaluateMatured(candidate())).toMatchObject({ kind: "already-exists", status: "EXPIRED" });
  });

  it("serialises two concurrent maturity evaluations; one creation survives retries", async () => {
    const f = fixtures();
    const [a, b] = await Promise.all([
      f.service.evaluateMatured(candidate()), f.service.evaluateMatured(candidate()),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["already-exists", "created"]);
    expect(f.created).toHaveLength(1);
    expect(f.histories).toHaveLength(1);
  });

  it("never admits absent/currently superseded/same-second conflicting evidence", async () => {
    const f = fixtures();
    f.setCandidate(null);
    expect(await f.service.evaluateMatured(candidate())).toEqual({ kind: "deferred", reason: "CANDIDATE_NOT_AVAILABLE" });
    f.setCandidate(candidate({ lastEventId: "event-2" }));
    expect(await f.service.evaluateMatured(candidate())).toEqual({ kind: "superseded", reason: "EVENT_WATERMARK_CHANGED" });
    f.setCandidate(candidate({ basket: { kind: "empty" } }));
    expect((await f.service.evaluateMatured(candidate())).kind).toBe("superseded");
    expect(f.created).toHaveLength(0);
  });

  it.each([
    [{ kind: "order-placed", orderId: "order-1" }, "superseded"],
    [{ kind: "order-paid", orderId: "order-1" }, "superseded"],
    [{ kind: "order-cancelled", orderId: "order-1" }, "superseded"],
    [{ kind: "ambiguous", reason: "same-second-conflict" }, "deferred"],
  ] as const)("fences observed order state %j", async (state, resultKind) => {
    const f = fixtures();
    f.setOrder(state);
    expect((await f.service.evaluateMatured(candidate())).kind).toBe(resultKind);
    expect(f.created).toHaveLength(0);
  });

  it.each([
    [{ kind: "empty" }, "denied"],
    [{ kind: "unknown", reason: "items-omitted" }, "deferred"],
    [{ kind: "unknown", reason: "conflicting-events" }, "deferred"],
  ] as const)("rejects %j basket evidence", async (basket, expected) => {
    const f = fixtures();
    const incoming = candidate({ basket });
    f.setCandidate(incoming);
    expect((await f.service.evaluateMatured(incoming)).kind).toBe(expected);
    expect(f.created).toHaveLength(0);
  });

  it("rejects oversized, unpriced, unidentifiable and missing-recipient baskets", async () => {
    const f = fixtures();
    const base = candidate().basket;
    if (base.kind !== "nonempty") throw new Error("invalid fixture");
    for (const checkout of [
      { ...base.checkout, items: Array.from({ length: 51 }, () => ({ quantity: 1, title: "Product" })) },
      { ...base.checkout, currency: "US", total: "12" },
      { ...base.checkout, items: [{ quantity: 1 }] },
      { ...base.checkout, contact: undefined },
    ]) {
      const incoming = candidate({ basket: { kind: "nonempty", checkout: checkout as never } });
      f.setCandidate(incoming);
      expect((await f.service.evaluateMatured(incoming)).kind).toBe("denied");
    }
    expect(f.created).toHaveLength(0);
  });

  it("requires maturity, shop platform/onboarding, installation and matching consent customer", async () => {
    const f = fixtures();
    const early = candidate({ lastActivityAt: "2026-10-24T11:45:00.000Z" });
    f.setCandidate(early);
    expect(await f.service.evaluateMatured(early)).toMatchObject({ kind: "deferred", reason: "CANDIDATE_NOT_MATURE" });
    f.setCandidate(candidate());
    f.db.shop.findUnique.mockResolvedValueOnce({ id: "woo-shop", platform: "SHOPIFY",
      status: "ACTIVE", onboardingCompleted: true, defaultCountryCode: "GB" });
    expect((await f.service.evaluateMatured(candidate())).kind).toBe("denied");
    f.db.wooCommerceInstallation.findUnique.mockResolvedValueOnce({ id: "installation", status: "REVOKED",
      revokedAt: NOW, credentialVersion: 1 });
    expect((await f.service.evaluateMatured(candidate())).kind).toBe("denied");
    f.db.customer.findUnique.mockResolvedValueOnce({ id: "customer", shopId: "another-shop", email: null });
    expect((await f.service.evaluateMatured(candidate())).kind).toBe("denied");
    expect(f.created).toHaveLength(0);
  });

  it.each([
    [{ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" }, "denied", "CONSENT_NO_CONTACT"],
    [{ status: "NOT_AUTHORISED", reason: "WOO_MARKETING_CONSENT_NOT_GRANTED" }, "denied", "CONSENT_NOT_GRANTED"],
    [{ status: "NOT_AUTHORISED", reason: "ACTIVE_RECIPIENT_NOT_FOUND" }, "denied", "CONSENT_RECIPIENT_UNVERIFIED"],
    [{ status: "AMBIGUOUS", reason: "RECIPIENT_SHARED_BY_CUSTOMERS" }, "denied", "CONSENT_AMBIGUOUS"],
    [{ status: "UNAVAILABLE", reason: "CONSENT_READ_FAILED" }, "deferred", "CONSENT_UNAVAILABLE"],
  ] as const)("preserves explicit consent state %j without INSERT", async (state, kind, reason) => {
    const f = fixtures();
    f.consent.evaluateRecipient.mockResolvedValueOnce(state as never);
    expect(await f.service.evaluateMatured(candidate())).toMatchObject({ kind, reason });
    expect(f.created).toHaveLength(0);
    expect(f.denied).toHaveBeenCalledTimes(kind === "denied" ? 1 : 0);
  });

  it("checks current consent again inside a short PostgreSQL transaction", async () => {
    const f = fixtures();
    f.setFence([permittedFence({ noContact: true, noContactReason: "CUSTOMER_STOP", noContactRevision: 1n })]);
    expect(await f.service.evaluateMatured(candidate())).toMatchObject({ kind: "denied", reason: "CONSENT_CHANGED" });
    expect(f.created).toHaveLength(0);
    expect(f.queryRaw).toHaveBeenCalledOnce();
  });

  it("cannot mark an uncertain unique transaction failure as created or already-exists", async () => {
    const f = fixtures();
    const fault = new Prisma.PrismaClientKnownRequestError("another unique index", {
      code: "P2002", clientVersion: "6.19.3", meta: { target: ["otherColumn"] },
    });
    f.create.mockRejectedValueOnce(fault);
    await expect(f.service.evaluateMatured(candidate())).rejects.toBe(fault);
    expect(f.histories).toHaveLength(0);
  });

  it("recovers only a proven concurrent (shopId, checkoutToken, generation) collision", async () => {
    const f = fixtures();
    const conflict = new Prisma.PrismaClientKnownRequestError("recovery unique key", {
      code: "P2002", clientVersion: "6.19.3", meta: { target: ["shopId", "checkoutToken", "generation"] },
    });
    f.create.mockImplementationOnce(async () => {
      f.rows.push({ id: "racing-recovery", status: "MESSAGE_SENT", generation: 1 });
      throw conflict;
    });
    expect(await f.service.evaluateMatured(candidate())).toEqual({
      kind: "already-exists", recoveryId: "racing-recovery", status: "MESSAGE_SENT",
    });
    expect(f.histories).toHaveLength(0);
  });

  it.each(["candidate", "terminal", "consent", "db", "transaction", "redis-lock", "denied-hook"] as const)(
    "propagates unexpected %s errors unchanged, logs failed and has no false success", async (where) => {
      const f = fixtures();
      const failure = new Error("sensitive-customer-and-checkout-value");
      switch (where) {
        case "candidate": f.candidates.getPending.mockRejectedValueOnce(failure); break;
        case "terminal": f.orders.read.mockRejectedValueOnce(failure); break;
        case "consent": f.consent.evaluateRecipient.mockRejectedValueOnce(failure); break;
        case "db": f.db.checkoutRecovery.findFirst.mockRejectedValueOnce(failure); break;
        case "transaction": f.db.$transaction.mockRejectedValueOnce(failure); break;
        case "redis-lock": f.coordinator.withCheckoutLock.mockRejectedValueOnce(failure); break;
        case "denied-hook":
          f.consent.evaluateRecipient.mockResolvedValueOnce({ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" } as never);
          f.denied.mockRejectedValueOnce(failure);
          break;
      }
      await expect(f.service.evaluateMatured(candidate())).rejects.toBe(failure);
      expect(f.created).toHaveLength(0);
      expect(f.logger.error).toHaveBeenCalledWith("woocommerce.recovery.admission.failed",
        expect.objectContaining({ outcome: "failed", errorType: "Error" }));
      expect(vi.mocked(f.logger.error).mock.lastCall?.[1].errorMessage).toBe(failure.message);
    },
  );
});
