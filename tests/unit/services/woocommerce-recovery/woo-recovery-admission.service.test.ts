import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
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
const SHOP_DOMAIN = "https://store.example.com";
const CANONICAL_SITE_URL = `${SHOP_DOMAIN}/shop`;

function candidate(overrides: Partial<WooPendingCandidate> = {}): WooPendingCandidate {
  return {
    source: "woocommerce", shopId: "woo-shop", checkoutToken: "woo-checkout",
    generation: 1,
    lastEventId: "woo-event-1", lastActivityAt: ACTIVITY,
    basket: { kind: "nonempty", checkout: {
      restoration: { schemaVersion: "woo.cart-restore.v1", kind: "supported",
        appliedCouponCodes: [], lines: [{ productId: 42, quantity: 2 }] },
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
    canonicalSiteUrl: CANONICAL_SITE_URL, shopDomain: SHOP_DOMAIN,
    consentVerifiedAt: NOW, providerObservedAt: NOW,
    consentRevision: 1n, decisionSequence: 1n, noContact: false, noContactReason: null,
    noContactRevision: 0n,
    ...overrides,
  };
}

type RecoveryRow = { id: string; status: string; generation: number; lastExternalActivityAt: Date;
  checkoutUrl?: string | null; statusHistory: Array<Record<string, unknown>> };
function fixtures() {
  const rows: RecoveryRow[] = [];
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const histories: unknown[] = [];
  let fence = [permittedFence()];
  let current: WooPendingCandidate | null = candidate();
  let order: WooTerminalObservation = { kind: "none-observed" };

  const findFirst = vi.fn(async () => rows.length ? rows.at(-1)! : null);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    created.push(data);
    const row = { id: `recovery-${created.length}`, status: "DETECTED", generation: Number(data.generation),
      lastExternalActivityAt: data.lastExternalActivityAt as Date, checkoutUrl: data.checkoutUrl as string | null,
      statusHistory: [] as Array<Record<string, unknown>> };
    rows.push(row);
    return row;
  });
  const historyCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    histories.push(data);
    const recovery = rows.find((row) => row.id === data.checkoutRecoveryId);
    recovery?.statusHistory.push(data);
    return data;
  });
  const update = vi.fn(async (args: Record<string, unknown>) => {
    updated.push(args);
    return args;
  });
  const queryRaw = vi.fn(async () => fence);
  const db = {
    shop: { findUnique: vi.fn(async () => ({ id: "woo-shop", domain: SHOP_DOMAIN, platform: "WOOCOMMERCE",
      status: "ACTIVE", onboardingCompleted: true, defaultCountryCode: "GB" })) },
    wooCommerceInstallation: { findUnique: vi.fn(async () => ({ id: "installation", status: "ACTIVE",
      revokedAt: null, credentialVersion: 1, canonicalSiteUrl: CANONICAL_SITE_URL })) },
    customer: { findUnique: vi.fn(async () => ({ id: "customer", shopId: "woo-shop", email: "customer@example.test" })) },
    checkoutRecovery: { findFirst },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({
      checkoutRecovery: { findFirst, create, update }, checkoutRecoveryStatusHistory: { create: historyCreate },
      $queryRaw: queryRaw,
    })),
  };
  const candidates = { getPending: vi.fn(async () => current), cancelPending: vi.fn(async () => "absent" as const) };
  const watermarks = { read: vi.fn(async () => {
    if (!current) return null;
    const digest = current.basket.kind === "nonempty"
      ? createHash("sha256").update(JSON.stringify(current.basket.checkout)).digest("hex") : "0".repeat(64);
    return { generation: current.generation!, lastEventId: current.lastEventId,
      lastActivityAt: current.lastActivityAt, checkoutDigest: digest,
      state: current.basket.kind === "nonempty" ? "nonempty" : current.basket.kind } as const;
  }) };
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
    execution: execution as never, logger, watermarks, now: () => NOW, onDeniedAdmission: denied,
  });
  return { service, db, rows, created, updated, histories, candidates, orders, coordinator, consent, policy,
    execution, logger, denied, queryRaw, create, update, historyCreate, watermarks,
    setCandidate: (value: WooPendingCandidate | null) => { current = value; },
    setOrder: (value: WooTerminalObservation) => { order = value; },
    setFence: (value: ReturnType<typeof permittedFence>[]) => { fence = value; },
  };
}

describe("ARCH-048-BACKGROUND-003 Woo first-recovery admission", () => {
  it("inserts exactly one DETECTED recovery plus initial history, with correct tenant/customer/basket; never sends", async () => {
    const f = fixtures();
    expect(await f.service.evaluateMatured(candidate(), { jobId: "job-1" }))
      .toEqual({ kind: "created", recoveryId: "recovery-1", generation: 1 });
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({ shopId: "woo-shop", checkoutToken: "woo-checkout",
      customerId: "customer", generation: 1, status: "DETECTED", cartToken: null,
      currency: "GBP", checkoutUrl: null, lastExternalActivityAt: new Date(ACTIVITY),
      lineItems: [{ quantity: 2, productId: "product-1", total: "34.20" }],
      wooRestoreSnapshot: { schemaVersion: "woo.cart-restore.v1", kind: "supported",
        appliedCouponCodes: [], lines: [{ productId: 42, quantity: 2 }] },
    });
    expect(f.histories).toHaveLength(1);
    expect(f.histories[0]).toMatchObject({ toStatus: "DETECTED", fromStatus: null, source: "WOOCOMMERCE",
      reason: "FIRST_MATURE_CHECKOUT_ADMISSION", metadata: { generation: 1, lastEventId: "woo-event-1",
        checkoutUrlDisposition: "ISSUED" } });
    const issuedUrl = new URL((f.updated[0] as { data: { checkoutUrl: string } }).data.checkoutUrl);
    expect(issuedUrl.origin).toBe(SHOP_DOMAIN);
    expect(issuedUrl.pathname).toBe("/shop/");
    expect(issuedUrl.searchParams.get("moda_interact_resume")).toBe("1");
    expect(issuedUrl.searchParams.get("r")).toBe("recovery-1");
    expect(issuedUrl.searchParams.get("t")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.logger.info).toHaveBeenCalledWith("woocommerce.recovery.admission.evaluated",
      expect.objectContaining({ outcome: "created", recoveryId: "recovery-1", jobIdHash: expect.any(String) }));
    expect(JSON.stringify(vi.mocked(f.logger.info).mock.calls)).not.toContain(PHONE);
    expect(JSON.stringify(vi.mocked(f.logger.info).mock.calls)).not.toContain("woo-checkout");
    expect(JSON.stringify(vi.mocked(f.logger.info).mock.calls)).not.toContain(SHOP_DOMAIN);
    expect(JSON.stringify(vi.mocked(f.logger.info).mock.calls)).not.toContain(issuedUrl.searchParams.get("t"));
    expect(f.denied).not.toHaveBeenCalled();
  });

  it.each([
    ["supported", {
      schemaVersion: "woo.cart-restore.v1", kind: "supported",
      appliedCouponCodes: ["summer10"], lines: [{ productId: 42, quantity: 2 }],
    }],
    ["unsupported", {
      schemaVersion: "woo.cart-restore.v1", kind: "unsupported",
      appliedCouponCodes: [], reason: "unsupported-product-type",
    }],
  ] as const)("persists the complete %s restoration evidence without changing display lineItems", async (_kind, restoration) => {
    const f = fixtures();
    const incoming = candidate({ basket: { kind: "nonempty", checkout: {
      currency: "GBP", total: "34.20", restoration,
      items: [{ quantity: 2, productId: "product-1", total: "34.20" }],
      contact: { phone: PHONE, email: "customer@example.test" },
    } } });
    f.setCandidate(incoming);

    expect(await f.service.evaluateMatured(incoming)).toMatchObject({ kind: "created", generation: 1 });
    expect(f.created[0]).toMatchObject({
      wooRestoreSnapshot: restoration,
      lineItems: [{ quantity: 2, productId: "product-1", total: "34.20" }],
    });
  });

  it.each([
    ["host mismatch", "https://other.example.com", CANONICAL_SITE_URL, "SHOP_HOST_MISMATCH"],
    ["invalid canonical site", SHOP_DOMAIN, "http://store.example.com/shop", "CANONICAL_SITE_INVALID"],
  ] as const)("omits the link and records the bounded reason for %s", async (_case, shopDomain, canonicalSiteUrl, reason) => {
    const f = fixtures();
    f.db.shop.findUnique.mockResolvedValueOnce({ id: "woo-shop", domain: shopDomain,
      platform: "WOOCOMMERCE", status: "ACTIVE", onboardingCompleted: true, defaultCountryCode: "GB" });
    f.db.wooCommerceInstallation.findUnique.mockResolvedValueOnce({ id: "installation", status: "ACTIVE",
      revokedAt: null, credentialVersion: 1, canonicalSiteUrl });
    f.setFence([permittedFence({ shopDomain, canonicalSiteUrl })]);

    expect(await f.service.evaluateMatured(candidate())).toMatchObject({ kind: "created" });
    expect(f.created[0]).toMatchObject({ checkoutUrl: null });
    expect(f.updated).toHaveLength(0);
    expect(f.histories[0]).toMatchObject({ metadata: {
      checkoutUrlDisposition: "OMITTED", checkoutUrlOmissionReason: reason,
    } });
  });

  it.each([
    ["absent", undefined, "RESTORE_SNAPSHOT_ABSENT"],
    ["unsupported", { schemaVersion: "woo.cart-restore.v1", kind: "unsupported",
      appliedCouponCodes: [], reason: "unsupported-product-type" }, "RESTORE_SNAPSHOT_UNSUPPORTED"],
  ] as const)("omits the recovery link for %s restoration evidence and records a bounded reason", async (_kind, restoration, reason) => {
    const f = fixtures();
    const base = candidate().basket;
    if (base.kind !== "nonempty") throw new Error("invalid fixture");
    const { restoration: _ignored, ...checkout } = base.checkout;
    const incoming = candidate({ basket: { kind: "nonempty", checkout: {
      ...checkout, ...(restoration ? { restoration } : {}),
    } } });
    f.setCandidate(incoming);

    expect(await f.service.evaluateMatured(incoming)).toMatchObject({ kind: "created" });
    expect(f.created[0]).toMatchObject({ checkoutUrl: null });
    expect(f.updated).toHaveLength(0);
    expect(f.histories[0]).toMatchObject({ metadata: {
      checkoutUrlDisposition: "OMITTED", checkoutUrlOmissionReason: reason,
    } });
  });

  it("repairs only the exact admission-origin row when the delayed job/index is gone", async () => {
    const f = fixtures();
    f.rows.push({ id: "previous", status: "DETECTED", generation: 1,
      lastExternalActivityAt: new Date(ACTIVITY), statusHistory: [{ fromStatus: null, toStatus: "DETECTED",
        source: "WOOCOMMERCE", reason: "FIRST_MATURE_CHECKOUT_ADMISSION",
        metadata: { generation: 1, lastEventId: "woo-event-1" } }] });
    f.setCandidate(null);
    expect(await f.service.evaluateMatured(candidate())).toEqual({
      kind: "already-exists", recoveryId: "previous", status: "DETECTED", generation: 1, repairInitial: true,
    });
    expect(f.candidates.getPending).not.toHaveBeenCalled();
    expect(f.consent.evaluateRecipient).not.toHaveBeenCalled();
    expect(f.created).toHaveLength(0);
    f.rows[0]!.status = "MESSAGE_SENT";
    expect(await f.service.evaluateMatured(candidate())).toMatchObject({ kind: "already-exists",
      status: "MESSAGE_SENT", repairInitial: false });
    expect(await f.service.evaluateMatured(candidate({ lastEventId: "different-event" })))
      .toMatchObject({ kind: "superseded", reason: "ADMISSION_PROVENANCE_MISMATCH" });
  });

  it("serialises two concurrent maturity evaluations; one creation survives retries", async () => {
    const f = fixtures();
    const [a, b] = await Promise.all([
      f.service.evaluateMatured(candidate()), f.service.evaluateMatured(candidate()),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["already-exists", "created"]);
    expect(f.created).toHaveLength(1);
    expect(f.updated).toHaveLength(1);
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
    expect(await f.service.evaluateMatured(candidate())).toEqual({
      kind: "denied", reason: "INSTALLATION_INACTIVE",
    });
    expect(f.created).toHaveLength(0);
    expect(f.updated).toHaveLength(0);
    expect(f.histories).toHaveLength(0);
    expect(JSON.stringify([
      vi.mocked(f.logger.info).mock.calls,
      vi.mocked(f.logger.warn).mock.calls,
      vi.mocked(f.logger.error).mock.calls,
    ])).not.toContain("t=");
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
    expect(f.queryRaw).toHaveBeenCalledTimes(2); // prior-row lock, then current-consent fence
  });

  it("denies a revocation discovered by the locked transaction fence without writing admission state", async () => {
    const f = fixtures();
    f.setFence([permittedFence({ installationStatus: "REVOKED", revokedAt: NOW })]);

    expect(await f.service.evaluateMatured(candidate())).toEqual({
      kind: "denied", reason: "CONSENT_CHANGED",
    });
    expect(f.created).toHaveLength(0);
    expect(f.updated).toHaveLength(0);
    expect(f.histories).toHaveLength(0);
    expect(f.queryRaw).toHaveBeenCalledTimes(2); // prior-row lock, then the revoked installation fence
    expect(JSON.stringify([
      vi.mocked(f.logger.info).mock.calls,
      vi.mocked(f.logger.warn).mock.calls,
      vi.mocked(f.logger.error).mock.calls,
    ])).not.toContain("t=");
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
      f.rows.push({ id: "racing-recovery", status: "DETECTED", generation: 1,
        lastExternalActivityAt: new Date(ACTIVITY), statusHistory: [{ fromStatus: null, toStatus: "DETECTED",
          source: "WOOCOMMERCE", reason: "FIRST_MATURE_CHECKOUT_ADMISSION",
          metadata: { generation: 1, lastEventId: "woo-event-1" } }] });
      throw conflict;
    });
    expect(await f.service.evaluateMatured(candidate())).toEqual({
      kind: "already-exists", recoveryId: "racing-recovery", status: "DETECTED", generation: 1, repairInitial: true,
    });
    expect(f.histories).toHaveLength(0);
  });

  it("admits generation 2 only after a provenance-backed checkout resumption and freezes generation 1", async () => {
    const f = fixtures();
    f.rows.push({ id: "generation-1", status: "CANCELLED", generation: 1,
      lastExternalActivityAt: new Date("2026-10-24T10:30:00.000Z"),
      checkoutUrl: "https://store.example.com/shop/?moda_interact_resume=1&r=old&t=old-token", statusHistory: [
        { fromStatus: null, toStatus: "DETECTED", source: "WOOCOMMERCE", reason: "FIRST_MATURE_CHECKOUT_ADMISSION",
          metadata: { generation: 1, lastEventId: "old-event" } },
        { fromStatus: "DETECTED", toStatus: "CANCELLED", source: "woocommerce.checkout", reason: "CHECKOUT_RESUMED",
          metadata: { eventId: "resume-event", nextGeneration: 2 } },
      ] });
    const next = candidate({ generation: 2, lastEventId: "new-event", basket: {
      kind: "nonempty", checkout: { currency: "USD", total: "99.00",
        restoration: { schemaVersion: "woo.cart-restore.v1", kind: "supported",
          appliedCouponCodes: ["new-generation"], lines: [{ productId: 77, quantity: 3 }] },
        items: [{ productId: "new-product", quantity: 3, total: "99.00" }], contact: { phone: PHONE } },
    } });
    f.setCandidate(next);
    expect(await f.service.evaluateMatured(next)).toEqual({
      kind: "created", recoveryId: "recovery-1", generation: 2,
    });
    expect(f.created[0]).toMatchObject({ generation: 2, currency: "USD", totalPrice: expect.anything(),
      wooRestoreSnapshot: { appliedCouponCodes: ["new-generation"], lines: [{ productId: 77, quantity: 3 }] },
      lineItems: [{ productId: "new-product", quantity: 3 }] });
    const generation2Url = new URL((f.updated[0] as { data: { checkoutUrl: string } }).data.checkoutUrl);
    expect(generation2Url.searchParams.get("r")).toBe("recovery-1");
    expect(generation2Url.searchParams.get("t")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generation2Url.href).not.toBe(f.rows[0]?.checkoutUrl);
    expect(f.histories[0]).toMatchObject({ reason: "MATURE_CHECKOUT_REENTRY_ADMISSION", source: "WOOCOMMERCE",
      metadata: { generation: 2, lastEventId: "new-event" } });
    expect(f.rows[0]).toMatchObject({ id: "generation-1", status: "CANCELLED", generation: 1 });
    expect(await f.service.evaluateMatured(next)).toMatchObject({ kind: "already-exists",
      recoveryId: "recovery-1", generation: 2, repairInitial: true });
    expect(f.updated).toHaveLength(1);
  });

  it.each([
    [{ status: "CANCELLED", generation: 1, statusHistory: [] }, "PRIOR_GENERATION_NOT_REENTERABLE"],
    [{ status: "COMPLETED", generation: 1, statusHistory: [] }, "PRIOR_GENERATION_NOT_REENTERABLE"],
    [{ status: "MESSAGE_SENT", generation: 1, statusHistory: [] }, "PRIOR_GENERATION_ACTIVE"],
    [{ status: "CANCELLED", generation: 1, statusHistory: [{ source: "woocommerce.order",
      metadata: { orderId: "order-1", eventId: "event-1", orderKind: "order-cancelled" } }] }, "PRIOR_GENERATION_NOT_REENTERABLE"],
  ] as const)("does not admit generation 2 after unsafe prior state %j", async (prior, reason) => {
    const f = fixtures();
    f.rows.push({ id: "previous", lastExternalActivityAt: new Date(ACTIVITY),
      statusHistory: prior.statusHistory as Array<Record<string, unknown>>, ...prior });
    const next = candidate({ generation: 2, lastEventId: "new-event" });
    f.setCandidate(next);
    expect(await f.service.evaluateMatured(next)).toMatchObject({ kind: reason === "PRIOR_GENERATION_ACTIVE" ? "deferred" : "superseded", reason });
    expect(f.created).toHaveLength(0);
  });

  it("requires candidate generation and watermark to match the accepted current state", async () => {
    const missing = candidate({ generation: undefined });
    const f = fixtures();
    expect(await f.service.evaluateMatured(missing)).toMatchObject({ kind: "denied", reason: "INVALID_CANDIDATE" });
    f.watermarks.read.mockResolvedValueOnce({ generation: 2, lastEventId: "other", lastActivityAt: ACTIVITY,
      checkoutDigest: "0".repeat(64), state: "nonempty" });
    expect(await f.service.evaluateMatured(candidate())).toEqual({
      kind: "superseded", reason: "ACTIVITY_WATERMARK_CHANGED",
    });
    expect(f.created).toHaveLength(0);
  });

  it("supersedes a late generation-1 job after generation 2 exists", async () => {
    const f = fixtures();
    f.rows.push({ id: "generation-2", status: "DETECTED", generation: 2,
      lastExternalActivityAt: new Date(ACTIVITY), statusHistory: [] });
    expect(await f.service.evaluateMatured(candidate())).toEqual({
      kind: "superseded", reason: "GENERATION_SUPERSEDED",
    });
    expect(f.candidates.getPending).not.toHaveBeenCalled();
  });

  it("retries on corrupt resumption metadata instead of treating it as permission to re-enter", async () => {
    const f = fixtures();
    f.rows.push({ id: "generation-1", status: "CANCELLED", generation: 1,
      lastExternalActivityAt: new Date(ACTIVITY), statusHistory: [{ reason: "CHECKOUT_RESUMED",
        source: "woocommerce.checkout", toStatus: "CANCELLED", fromStatus: "DETECTED",
        metadata: { nextGeneration: "2" } }] });
    const next = candidate({ generation: 2, lastEventId: "next-event" });
    f.setCandidate(next);
    await expect(f.service.evaluateMatured(next)).rejects.toThrow("Corrupt Woo checkout-resumption history metadata");
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
      expect(JSON.stringify(vi.mocked(f.logger.error).mock.calls)).not.toContain(failure.message);
    },
  );
});
