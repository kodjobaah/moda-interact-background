import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooOrderCapture } from "../../../../src/events/woo-order-capture.js";
import type {
  WooCheckoutRef,
  WooPendingCandidate,
  WooCheckoutCoordinator,
} from "../../../../src/services/woocommerce-recovery/contracts.js";
import {
  WOO_ORDER_EVIDENCE_TTL_MS,
  WooOrderReconciliationService,
  WooOrderTerminalEvidenceStore,
  type WooOrderEvidenceStore,
  type WooStoredOrderObservation,
} from "../../../../src/services/woocommerce-recovery/woo-order-reconciliation.service.js";

const TIME = "2026-10-23T12:00:00.000Z";
const later = "2026-10-23T12:00:03.000Z";

type Status = "DETECTED" | "MESSAGE_SENT" | "ENGAGED" | "COMPLETED" | "CANCELLED" | "EXPIRED";
type Row = { id: string; shopId: string; checkoutToken: string; status: Status; generation: number; completedAt?: Date; expiredAt?: Date };
type Attempt = { id: string; checkoutRecoveryId: string; status: string; sentAt: Date | null; closedAt?: Date; billed: number };
type History = { checkoutRecoveryId: string; fromStatus: string; toStatus: string; source: string; reason: string; metadata: { orderId: string; eventId: string }; occurredAt: Date };

function event(kind: WooOrderCapture["eventType"], overrides: Partial<WooOrderCapture> = {}): WooOrderCapture {
  return {
    schemaVersion: "woo.activity.v1",
    shopId: "woo-shop-one",
    checkoutKey: "secret-checkout-token-one",
    eventId: `event-${kind.toLowerCase()}`,
    eventType: kind,
    occurredAt: TIME,
    order: { orderId: "12345", checkoutKey: "secret-checkout-token-one", status: "processing" },
    ...overrides,
  };
}

function harness() {
  const rows: Row[] = [];
  const attempts: Attempt[] = [];
  const history: History[] = [];
  const order: string[] = [];
  const remembered = new Map<string, WooStoredOrderObservation>();
  const candidates = new Set<string>();
  const key = (ref: WooCheckoutRef) => `${ref.shopId}:${ref.checkoutToken}`;
  const evidence: WooOrderEvidenceStore = {
    inspect: vi.fn(async (ref: WooCheckoutRef) => remembered.get(key(ref)) ?? null),
    read: vi.fn(async (ref: WooCheckoutRef) => {
      const value = remembered.get(key(ref));
      return value?.ambiguity ? { kind: "ambiguous", reason: value.ambiguity }
        : value ? { kind: value.kind, orderId: value.orderId } : { kind: "none-observed" };
    }),
    persist: vi.fn(async (ref: WooCheckoutRef, value: WooStoredOrderObservation) => {
      remembered.set(key(ref), value);
      order.push("evidence-persist");
    }),
  };
  const candidate = {
    getPending: vi.fn(async (_ref: WooCheckoutRef): Promise<WooPendingCandidate | null> => null),
    cancelPending: vi.fn(async (ref: WooCheckoutRef) => {
      order.push("candidate-cancel");
      const existed = candidates.delete(key(ref));
      return existed ? "cancelled" as const : "absent" as const;
    }),
  };
  // A deterministic checkout-scoped mutex, so a concurrent maturity evaluation
  // can wait behind an order event while sharing the exact same coordinator.
  const locks = new Map<string, Promise<void>>();
  const coordinator: WooCheckoutCoordinator = {
    withCheckoutLock: vi.fn(async <T>(ref: WooCheckoutRef, run: () => Promise<T>): Promise<T> => {
      const id = key(ref);
      const prior = locks.get(id) ?? Promise.resolve();
      let release!: () => void;
      const following = new Promise<void>((resolve) => { release = resolve; });
      locks.set(id, prior.then(() => following));
      await prior;
      try { return await run(); } finally { release(); }
    }),
  };
  const findLatest = vi.fn(async (input: { where: { shopId: string; checkoutToken: string } }) => {
    order.push("postgres-recovery-lookup");
    const latest = [...rows].filter(row => row.shopId === input.where.shopId &&
      row.checkoutToken === input.where.checkoutToken).sort((a, b) => b.generation - a.generation)[0];
    // Prisma findFirst returns an independent result, not a mutable reference to
    // a row subsequently changed by updateMany in this in-memory fake.
    return latest === undefined ? null : structuredClone(latest);
  });
  const findHistory = vi.fn(async (input: { where: { checkoutRecoveryId: string; source: string } }) => {
    return [...history].reverse().find(h => h.checkoutRecoveryId === input.where.checkoutRecoveryId &&
      h.source === input.where.source) ?? null;
  });
  const update = vi.fn(async (input: { where: { id: string; shopId: string; checkoutToken: string; status: Status }; data: { status: Status; completedAt?: Date; expiredAt?: Date } }) => {
    const row = rows.find(r => r.id === input.where.id && r.shopId === input.where.shopId &&
      r.checkoutToken === input.where.checkoutToken && r.status === input.where.status);
    if (!row) return { count: 0 };
    row.status = input.data.status;
    row.completedAt = input.data.completedAt;
    row.expiredAt = input.data.expiredAt;
    order.push("postgres-recovery-transition");
    return { count: 1 };
  });
  const historyCreate = vi.fn(async (input: { data: History }) => {
    history.push(input.data);
    order.push("postgres-history-create");
    return input.data;
  });
  const cancelAttempts = vi.fn(async (input: { where: { checkoutRecoveryId: string }; data: { status: string; closedAt: Date } }) => {
    for (const attempt of attempts) {
      if (attempt.checkoutRecoveryId === input.where.checkoutRecoveryId && !attempt.sentAt &&
          ["PENDING", "WAITING_FOR_RESPONSE"].includes(attempt.status)) {
        attempt.status = input.data.status;
        attempt.closedAt = input.data.closedAt;
      }
    }
    order.push("postgres-cancel-unsent");
    return { count: 1 };
  });
  const transaction = {
    checkoutRecovery: { findFirst: findLatest, updateMany: update },
    checkoutRecoveryStatusHistory: { create: historyCreate },
    recoveryOutreachAttempt: { updateMany: cancelAttempts },
  };
  const database = {
    checkoutRecovery: { findFirst: findLatest },
    checkoutRecoveryStatusHistory: { findFirst: findHistory },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => {
      const oldRows = structuredClone(rows);
      const oldHistory = structuredClone(history);
      const oldAttempts = structuredClone(attempts);
      try { return await callback(transaction); }
      catch (error) {
        rows.splice(0, rows.length, ...oldRows);
        history.splice(0, history.length, ...oldHistory);
        attempts.splice(0, attempts.length, ...oldAttempts);
        throw error;
      }
    }),
  };
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const service = new WooOrderReconciliationService(
    database as never, candidate, coordinator, evidence, logger as unknown as StructuredLogger,
  );
  return { service, rows, attempts, history, remembered, candidates, key, evidence, candidate,
    coordinator, database, findLatest, findHistory, update, historyCreate, cancelAttempts, logger, order };
}

describe("ARCH-048-BACKGROUND-002 Woo order reconciliation", () => {
  it.each([
    ["ORDER_PLACED", "placed-suppressed", "order-placed"],
    ["ORDER_PAID", "paid-terminal", "order-paid"],
    ["ORDER_CANCELLED", "cancelled-terminal", "order-cancelled"],
  ] as const)("%s order-first fences checkout without a recovery or candidate", async (type, outcome, observed) => {
    const h = harness();
    const result = await h.service.reconcileOrder(event(type));
    expect(result).toEqual({ kind: outcome });
    // The preflight order-identity check and the in-transaction lifecycle read
    // are both mandatory, including the order-first / no-candidate case.
    expect(h.database.checkoutRecovery.findFirst).toHaveBeenCalledTimes(2);
    expect(h.candidate.cancelPending).toHaveBeenCalledOnce();
    expect(await h.evidence.read({ shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one" }))
      .toEqual({ kind: observed, orderId: "12345" });
    expect(h.history).toHaveLength(0);
    expect(h.logger.info).toHaveBeenCalledWith("woocommerce.recovery.order.reconciled", expect.objectContaining({ outcome }));
  });

  it("reconciles an existing DETECTED row even when the BullMQ candidate is absent", async () => {
    const h = harness();
    h.rows.push({ id: "recovery-1", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "DETECTED", generation: 1 });
    const result = await h.service.reconcileOrder(event("ORDER_PAID"));
    expect(result).toEqual({ kind: "paid-terminal", recoveryId: "recovery-1" });
    expect(h.rows[0]?.status).toBe("COMPLETED");
    expect(h.history).toMatchObject([{
      checkoutRecoveryId: "recovery-1", fromStatus: "DETECTED", toStatus: "COMPLETED",
      source: "woocommerce.order", metadata: { orderId: "12345", eventId: "event-order_paid" },
    }]);
    expect(h.order.indexOf("evidence-persist")).toBeLessThan(h.order.indexOf("candidate-cancel"));
    expect(h.order.indexOf("candidate-cancel")).toBeLessThan(h.order.indexOf("postgres-recovery-transition"));
  });

  it("placed-but-unpaid cancels existing outreach without misclassifying order as paid", async () => {
    const h = harness();
    h.rows.push({ id: "recovery-placed", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "ENGAGED", generation: 1 });
    const result = await h.service.reconcileOrder(event("ORDER_PLACED"));
    expect(result.kind).toBe("placed-suppressed");
    expect(h.rows[0]?.status).toBe("CANCELLED");
    expect(h.rows[0]?.completedAt).toBeUndefined();
    expect(h.history[0]?.reason).toBe("woo-order-placed");
  });

  it("preserves already-sent initial usage and cancels only unsent automatic attempts after queue deletion", async () => {
    const h = harness();
    h.rows.push({ id: "sent-recovery", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "MESSAGE_SENT", generation: 1 });
    h.attempts.push(
      { id: "initial", checkoutRecoveryId: "sent-recovery", status: "WAITING_FOR_RESPONSE", sentAt: new Date(TIME), billed: 10 },
      { id: "queued-followup", checkoutRecoveryId: "sent-recovery", status: "PENDING", sentAt: null, billed: 0 },
    );
    await expect(h.service.reconcileOrder(event("ORDER_CANCELLED"))).resolves.toMatchObject({
      kind: "cancelled-terminal", recoveryId: "sent-recovery",
    });
    expect(h.rows[0]?.status).toBe("CANCELLED");
    expect(h.attempts[0]).toMatchObject({ status: "WAITING_FOR_RESPONSE", billed: 10 });
    expect(h.attempts[1]).toMatchObject({ status: "CANCELLED", billed: 0 });
    expect(h.history).toHaveLength(1);
  });

  it("repairs an interrupted transition on duplicate replay rather than skipping the PostgreSQL row", async () => {
    const h = harness();
    h.rows.push({ id: "pending", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "DETECTED", generation: 1 });
    const fail = new Error("postgres unavailable");
    h.database.$transaction.mockRejectedValueOnce(fail);
    await expect(h.service.reconcileOrder(event("ORDER_PAID"))).rejects.toBe(fail);
    expect(h.remembered.size).toBe(1);
    expect(h.rows[0]?.status).toBe("DETECTED");
    await expect(h.service.reconcileOrder(event("ORDER_PAID"))).resolves.toEqual({ kind: "ignored-duplicate", reason: "event-replayed" });
    expect(h.rows[0]?.status).toBe("COMPLETED");
    expect(h.history).toHaveLength(1);
    expect(h.candidate.cancelPending).toHaveBeenCalledTimes(2);
  });

  it("replays a terminal event after the maturity job disappears without a second status or billing transition", async () => {
    const h = harness();
    h.rows.push({ id: "sent", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "MESSAGE_SENT", generation: 1 });
    await h.service.reconcileOrder(event("ORDER_PAID"));
    expect((await h.service.reconcileOrder(event("ORDER_PAID"))).kind).toBe("ignored-duplicate");
    expect(h.history).toHaveLength(1);
    expect(h.update).toHaveBeenCalledOnce();
    expect(h.findLatest).toHaveBeenCalledTimes(4); // preflight + transactional lookup per callback
  });

  it("suppresses old PLACED replay and prevents old events from overriding observed PAID state", async () => {
    const h = harness();
    await h.service.reconcileOrder(event("ORDER_PAID", { occurredAt: later, eventId: "paid-new" }));
    const stale = await h.service.reconcileOrder(event("ORDER_PLACED", { occurredAt: TIME, eventId: "placed-old" }));
    expect(stale).toEqual({ kind: "ignored-stale", reason: "older-event" });
    expect([...h.remembered.values()][0]?.kind).toBe("order-paid");
  });

  it("defers equal-second conflicting order changes and different order IDs without weakening the fence", async () => {
    const h = harness();
    await h.service.reconcileOrder(event("ORDER_PLACED"));
    const equal = await h.service.reconcileOrder(event("ORDER_PAID", { eventId: "paid-equal" }));
    expect(equal).toEqual({ kind: "deferred-conflict", reason: "equal-time-conflict" });
    const otherOrder = await h.service.reconcileOrder(event("ORDER_PAID", {
      occurredAt: later, eventId: "different-order", order: { orderId: "another", checkoutKey: "secret-checkout-token-one", status: "processing" },
    }));
    expect(otherOrder).toEqual({ kind: "deferred-conflict", reason: "different-order-id" });
    expect([...h.remembered.values()][0]?.orderId).toBe("12345");
    expect(await h.evidence.read({ shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one" }))
      .toEqual({ kind: "ambiguous", reason: "different-order-id" });
    expect(h.logger.warn).toHaveBeenCalledWith("woocommerce.recovery.order.deferred", expect.any(Object));
  });

  it("quarantines incompatible payloads reusing the same eventId", async () => {
    const h = harness();
    await h.service.reconcileOrder(event("ORDER_PLACED"));
    const conflict = await h.service.reconcileOrder(event("ORDER_PAID", {
      eventId: "event-order_placed", occurredAt: later,
    }));
    expect(conflict).toEqual({ kind: "deferred-conflict", reason: "same-event-id-conflict" });
    expect(await h.evidence.read({ shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one" }))
      .toEqual({ kind: "ambiguous", reason: "same-event-id-conflict" });
  });

  it("never changes an unrelated tenant with an identical checkout token", async () => {
    const h = harness();
    h.rows.push(
      { id: "shop-one", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "DETECTED", generation: 1 },
      { id: "shop-two", shopId: "woo-shop-two", checkoutToken: "secret-checkout-token-one", status: "DETECTED", generation: 1 },
    );
    await h.service.reconcileOrder(event("ORDER_PAID"));
    expect(h.rows.map(row => row.status)).toEqual(["COMPLETED", "DETECTED"]);
    expect(h.history).toHaveLength(1);
    expect(h.history[0]?.checkoutRecoveryId).toBe("shop-one");
  });

  it("rejects unequal order checkoutKey instead of inferring from a phone, customer or shared token", async () => {
    const h = harness();
    const mismatch = event("ORDER_PAID", { order: { orderId: "12345", checkoutKey: "different", status: "processing" } });
    await expect(h.service.reconcileOrder(mismatch)).rejects.toThrow("woo-order-event-invalid");
    expect(h.findLatest).not.toHaveBeenCalled();
    expect(h.candidate.cancelPending).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith("woocommerce.recovery.order.failed", expect.objectContaining({ stage: "validation" }));
  });

  it("does not overwrite an independently recorded PostgreSQL order ID when Redis evidence expired", async () => {
    const h = harness();
    h.rows.push({ id: "terminal", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "COMPLETED", generation: 1 });
    h.history.push({ checkoutRecoveryId: "terminal", fromStatus: "DETECTED", toStatus: "COMPLETED", source: "woocommerce.order", reason: "woo-order-paid", metadata: { orderId: "recorded", eventId: "prior" }, occurredAt: new Date(TIME) });
    const outcome = await h.service.reconcileOrder(event("ORDER_PAID"));
    expect(outcome).toEqual({ kind: "deferred-conflict", reason: "recorded-order-id-conflict" });
    expect(h.remembered.size).toBe(0);
    expect(h.history).toHaveLength(1);
  });

  it("keeps placed cancellation terminal if payment is observed later, while retaining paid evidence", async () => {
    const h = harness();
    h.rows.push({ id: "placed-then-paid", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "DETECTED", generation: 1 });
    const first = await h.service.reconcileOrder(event("ORDER_PLACED"));
    expect(first.kind).toBe("placed-suppressed");
    const newerPaid = await h.service.reconcileOrder(event("ORDER_PAID", {
      occurredAt: later, eventId: "paid-later",
    }));
    expect(newerPaid).toEqual({ kind: "already-terminal", reason: "recovery-cancelled" });
    expect(h.rows[0]?.status).toBe("CANCELLED");
    expect(h.history).toHaveLength(1);
    expect(await h.evidence.read({ shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one" }))
      .toEqual({ kind: "order-paid", orderId: "12345" });
  });

  it("retries a concurrent recovery CAS conflict even during a replay", async () => {
    const h = harness();
    h.rows.push({ id: "race", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "DETECTED", generation: 1 });
    const input = event("ORDER_PAID");
    h.remembered.set(h.key({ shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one" }), {
      kind: "order-paid", eventId: input.eventId, orderId: input.order.orderId, occurredAt: input.occurredAt,
    });
    h.update.mockResolvedValueOnce({ count: 0 });
    await expect(h.service.reconcileOrder(input)).rejects.toThrow("woo-recovery-transition-concurrent-update");
    expect(h.logger.error).toHaveBeenCalledWith("woocommerce.recovery.order.failed", expect.any(Object));
    expect(h.logger.info).not.toHaveBeenCalled();
  });

  it("never reopens a terminal row when a later, distinct order event arrives", async () => {
    const h = harness();
    h.rows.push({ id: "terminal", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "CANCELLED", generation: 1 });
    await expect(h.service.reconcileOrder(event("ORDER_PAID"))).resolves.toEqual({ kind: "already-terminal", reason: "recovery-cancelled" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.history).toHaveLength(0);
  });

  it("fences a maturity read queued behind the order event using one checkout coordinator", async () => {
    const h = harness();
    const ref = { shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one" };
    let resolveWrite!: () => void;
    const barrier = new Promise<void>((resolve) => { resolveWrite = resolve; });
    const persist = h.evidence.persist;
    vi.mocked(h.evidence.persist).mockImplementationOnce(async (r, value) => {
      await barrier;
      await persist(r, value);
    });
    const first = h.service.reconcileOrder(event("ORDER_PAID"));
    // Yield until the order handler is within its protected Redis write.
    for (let tries = 0; tries < 20 && vi.mocked(h.evidence.persist).mock.calls.length === 0; tries++) {
      await Promise.resolve();
    }
    const maturity = h.coordinator.withCheckoutLock(ref, async () => h.evidence.read(ref));
    resolveWrite();
    await first;
    expect(await maturity).toEqual({ kind: "order-paid", orderId: "12345" });
  });

  it.each([
    "evidence-read", "evidence-write", "recovery-lookup", "candidate-cancel",
    "recovery-transition", "history-create", "attempt-cancel", "lease",
  ] as const)("propagates original %s errors and emits only failed, never reconciled", async (stage) => {
    const h = harness();
    h.rows.push({ id: "pending", shopId: "woo-shop-one", checkoutToken: "secret-checkout-token-one", status: "DETECTED", generation: 1 });
    const failure = new Error(`private-provider-sensitive-detail-${stage}`);
    if (stage === "evidence-read") vi.mocked(h.evidence.inspect).mockRejectedValueOnce(failure);
    else if (stage === "evidence-write") vi.mocked(h.evidence.persist).mockRejectedValueOnce(failure);
    else if (stage === "recovery-lookup") h.findLatest.mockRejectedValueOnce(failure);
    else if (stage === "candidate-cancel") h.candidate.cancelPending.mockRejectedValueOnce(failure);
    else if (stage === "recovery-transition") h.update.mockRejectedValueOnce(failure);
    else if (stage === "history-create") h.historyCreate.mockRejectedValueOnce(failure);
    else if (stage === "attempt-cancel") h.cancelAttempts.mockRejectedValueOnce(failure);
    else vi.mocked(h.coordinator.withCheckoutLock).mockRejectedValueOnce(failure);
    await expect(h.service.reconcileOrder(event("ORDER_PAID"))).rejects.toBe(failure);
    expect(h.logger.error).toHaveBeenCalledWith("woocommerce.recovery.order.failed", expect.any(Object));
    expect(h.logger.info).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
    const logged = JSON.stringify(h.logger.error.mock.calls);
    expect(logged).not.toContain("secret-checkout-token-one");
    expect(logged).not.toContain("private-provider-sensitive-detail");
  });
});

describe("WooOrderTerminalEvidenceStore retention and isolation", () => {
  let values: Map<string, { value: string; expires: number }>;
  let now: number;
  let redis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    values = new Map();
    now = 0;
    redis = {
      get: vi.fn(async (key: string) => {
        const stored = values.get(key);
        return stored && stored.expires > now ? stored.value : null;
      }),
      set: vi.fn(async (key: string, value: string, mode: string, ttl: number) => {
        expect(mode).toBe("PX");
        values.set(key, { value, expires: now + ttl });
        return "OK";
      }),
    };
  });
  const ref = { shopId: "woo-shop-one", checkoutToken: "session-key-not-for-logs" };
  const paid: WooStoredOrderObservation = { kind: "order-paid", eventId: "evt", orderId: "ord", occurredAt: TIME };

  it("keeps pre-recovery fences past one hour and the maximum seven-day delay + 48h replay horizon", async () => {
    const store = new WooOrderTerminalEvidenceStore(redis);
    await store.persist(ref, paid);
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), JSON.stringify(paid), "PX", WOO_ORDER_EVIDENCE_TTL_MS);
    expect(JSON.stringify(redis.set.mock.calls)).not.toContain(ref.checkoutToken);
    now = 60 * 60 * 1000 + 1;
    expect(await store.read(ref)).toEqual({ kind: "order-paid", orderId: "ord" });
    now = 7 * 24 * 60 * 60 * 1000 + 1;
    expect(await store.read(ref)).toEqual({ kind: "order-paid", orderId: "ord" });
    now = WOO_ORDER_EVIDENCE_TTL_MS;
    expect(await store.read(ref)).toEqual({ kind: "none-observed" });
  });

  it("does not reuse another tenant's evidence, and malformed Redis data fails closed", async () => {
    const store = new WooOrderTerminalEvidenceStore(redis);
    await store.persist(ref, paid);
    expect(await store.read({ ...ref, shopId: "different-shop" })).toEqual({ kind: "none-observed" });
    values.set([...values.keys()][0]!, { value: "{corrupt", expires: WOO_ORDER_EVIDENCE_TTL_MS });
    await expect(store.read(ref)).rejects.toThrow("woo-order-evidence-invalid");
  });

  it("rejects a Redis write that was not confirmed", async () => {
    redis.set.mockResolvedValueOnce(null);
    const store = new WooOrderTerminalEvidenceStore(redis);
    await expect(store.persist(ref, paid)).rejects.toThrow("woo-order-evidence-write-unconfirmed");
  });
});
