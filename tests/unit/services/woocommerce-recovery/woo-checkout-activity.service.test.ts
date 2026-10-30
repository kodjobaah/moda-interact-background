import { describe, expect, it, vi } from "vitest";

// Service modules import production adapters, but injected unit harnesses do
// not connect to Redis/PostgreSQL or require local integration credentials.
vi.mock("../../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));

import type { WooCheckoutCapture } from "../../../../src/events/woo-checkout-capture.js";
import {
  WooCheckoutActivityService,
  type WooCheckoutActivityDependencies,
} from "../../../../src/services/woocommerce-recovery/woo-checkout-activity.service.js";
import type {
  WooCheckoutRef,
  WooPendingCandidate,
  WooTerminalObservation,
} from "../../../../src/services/woocommerce-recovery/contracts.js";
import type { WooLatestRecovery } from "../../../../src/services/woocommerce-recovery/woo-checkout-activity.adapters.js";
import type { WooActivityWatermark } from "../../../../src/services/woocommerce-recovery/woo-activity-watermark.store.js";

const NOW = Date.parse("2026-10-24T11:05:00.000Z");
const at = (minute: number) => new Date(Date.parse("2026-10-24T11:00:00.000Z") + minute * 60_000).toISOString();
const key = (ref: WooCheckoutRef) => `${ref.shopId}/${ref.checkoutToken}`;

function event(id: string, minute = 0, changes: Partial<WooCheckoutCapture> = {}): WooCheckoutCapture {
  return {
    schemaVersion: "woo.activity.v1", eventId: id, eventType: "CHECKOUT_UPDATED",
    shopId: "shop-a", checkoutKey: "checkout-1", occurredAt: at(minute),
    checkout: {
      currency: "GBP", total: "29.99",
      items: [{ productId: "sku-1", quantity: 1, total: "29.99" }],
      contact: { email: "customer@example.test", phone: "+447000000000" },
    },
    ...changes,
  };
}

function harness() {
  const candidates = new Map<string, WooPendingCandidate>();
  const watermarks = new Map<string, WooActivityWatermark>();
  const recoveries = new Map<string, WooLatestRecovery>();
  const terminal = new Map<string, WooTerminalObservation>();
  const lockTails = new Map<string, Promise<void>>();
  const calls: string[] = [];
  const schedule = vi.fn(async ({ candidate }: { candidate: WooPendingCandidate }) => {
    const name = key(candidate);
    const updated = candidates.has(name);
    candidates.set(name, candidate);
    return updated ? "rescheduled" as const : "scheduled" as const;
  });
  const cancel = vi.fn(async (ref: WooCheckoutRef) => {
    const removed = candidates.delete(key(ref));
    return removed ? "cancelled" as const : "absent" as const;
  });
  const findExisting = vi.fn(async (ref: WooCheckoutRef) => {
    calls.push("recovery");
    return recoveries.get(key(ref)) ?? null;
  });
  const recordExternalActivity = vi.fn(async () => { calls.push("external-activity"); });
  const closeForResumption = vi.fn(async ({ ref, recovery, occurredAt, eventId, nextGeneration }) => {
    const changed = { ...recovery, status: "CANCELLED" as const, lastExternalActivityAt: occurredAt,
      resumption: { eventId, nextGeneration } };
    recoveries.set(key(ref), changed);
    return true;
  });
  const logOutcome = vi.fn();
  const withCheckoutLock = vi.fn(async <T>(ref: WooCheckoutRef, run: () => Promise<T>): Promise<T> => {
    const name = key(ref);
    const previous = lockTails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    lockTails.set(name, completed);
    await previous;
    try { return await run(); } finally { release(); }
  });
  const deps: WooCheckoutActivityDependencies = {
    now: () => NOW,
    coordinator: { withCheckoutLock },
    observedOrders: {
      read: vi.fn(async (ref) => {
        calls.push("order");
        return terminal.get(key(ref)) ?? { kind: "none-observed" };
      }),
    },
    candidates: {
      getPending: vi.fn(async (ref) => candidates.get(key(ref)) ?? null),
      cancelPending: cancel,
      schedulePending: schedule,
    },
    watermarks: {
      read: vi.fn(async (ref) => watermarks.get(key(ref)) ?? null),
      write: vi.fn(async (ref, wm, ttlMs) => {
        expect(ttlMs).toBeGreaterThanOrEqual(24 * 60 * 60_000);
        watermarks.set(key(ref), wm);
      }),
    },
    recoveries: {
      findExisting, recordExternalActivity,
      closeForResumption,
    },
    shops: { evaluate: vi.fn(async () => ({ allowed: true, shopDomain: "from-db.example.test" })) },
    resolveDelayMinutes: vi.fn(async () => 30),
    logOutcome,
  };
  return {
    service: new WooCheckoutActivityService(deps), deps, candidates, watermarks,
    recoveries, terminal, schedule, cancel, calls, findExisting,
    recordExternalActivity, logOutcome, withCheckoutLock, closeForResumption,
  };
}

describe("ARCH-048-BACKGROUND-001 Woo checkout activity (injected dependencies)", () => {
  it("schedules one typed Woo candidate with bounded latest event evidence and merchant delay", async () => {
    const h = harness();
    const result = await h.service.handleCheckout(event("evt-1"));
    expect(result).toEqual({ kind: "scheduled", dueAt: at(30), generation: 1 });
    expect(h.schedule).toHaveBeenCalledOnce();
    expect(h.schedule.mock.calls[0]?.[0]).toMatchObject({
      delayMinutes: 30, dueAtMs: Date.parse(at(30)),
      retentionMs: expect.any(Number),
      candidate: {
        source: "woocommerce", shopId: "shop-a", checkoutToken: "checkout-1",
        lastActivityAt: at(0), lastEventId: "evt-1",
        basket: { kind: "nonempty", checkout: { currency: "GBP", total: "29.99" } },
      },
    });
    expect(h.calls).toEqual(["recovery", "order"]);
    expect(h.logOutcome).toHaveBeenCalledWith("shop-a", result);
  });

  it("reschedules using only the later received basket/contact and never creates a recovery", async () => {
    const h = harness();
    await h.service.handleCheckout(event("evt-1"));
    const later = event("evt-2", 2, { checkout: {
      currency: "EUR", total: "44.50",
      items: [{ productId: "new", quantity: 2, total: "44.50" }],
      contact: { phone: "+447000000111" },
    } });
    expect(await h.service.handleCheckout(later)).toEqual({ kind: "rescheduled", dueAt: at(32), generation: 1 });
    expect(h.candidates.get("shop-a/checkout-1")?.basket).toEqual({ kind: "nonempty", checkout: later.checkout });
    expect(h.schedule).toHaveBeenCalledTimes(2);
    expect(h.findExisting).toHaveBeenCalledTimes(2);
  });

  it("deduplicates stable eventId and ignores older events without rewriting candidate", async () => {
    const h = harness();
    await h.service.handleCheckout(event("evt-new", 4));
    expect(await h.service.handleCheckout(event("evt-new", 4))).toMatchObject({ kind: "ignored-stale", reason: "duplicate_event" });
    expect(await h.service.handleCheckout(event("evt-old", 1))).toMatchObject({ kind: "ignored-stale", reason: "older_event" });
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.candidates.get("shop-a/checkout-1")?.lastEventId).toBe("evt-new");
  });

  it("cancels a previously valid basket on an explicit empty snapshot, and permits a later refill", async () => {
    const h = harness();
    await h.service.handleCheckout(event("evt-1"));
    expect(await h.service.handleCheckout(event("evt-empty", 2, { checkout: {
      currency: "GBP", total: "0.00", items: [],
    } }))).toEqual({ kind: "cancelled-empty", reason: "explicit_empty_basket" });
    expect(h.candidates.size).toBe(0);
    expect(h.watermarks.get("shop-a/checkout-1")?.state).toBe("empty");
    expect((await h.service.handleCheckout(event("evt-refill", 3))).kind).toBe("scheduled");
    expect(h.candidates.get("shop-a/checkout-1")?.basket.kind).toBe("nonempty");
  });

  it.each(["omitted", "oversized"])("treats %s items as unknown, never empty or admissible", async (mode) => {
    const h = harness();
    await h.service.handleCheckout(event("evt-1"));
    const missing = event("evt-missing", 1, { checkout: {
      currency: "GBP", total: "29.99",
      ...(mode === "oversized"
        ? { items: Array.from({ length: 51 }, () => ({ quantity: 1 })) }
        : {}),
    } });
    expect(await h.service.handleCheckout(missing)).toMatchObject({ kind: "deferred-ambiguous" });
    expect(h.candidates.size).toBe(0);
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.watermarks.get("shop-a/checkout-1")?.state).toBe("unknown");
    expect((await h.service.handleCheckout(event("evt-new", 2))).kind).toBe("scheduled");
  });

  it("quarantines same-time different versions including reused eventId/payload edits", async () => {
    const h = harness();
    await h.service.handleCheckout(event("evt-1"));
    expect(await h.service.handleCheckout(event("evt-2"))).toEqual({ kind: "deferred-ambiguous", reason: "same_time_conflict" });
    expect(h.candidates.size).toBe(0);
    expect(h.watermarks.get("shop-a/checkout-1")?.state).toBe("conflicting");
    expect((await h.service.handleCheckout(event("evt-1"))).kind).toBe("deferred-ambiguous");
    expect(h.schedule).toHaveBeenCalledOnce();
    expect((await h.service.handleCheckout(event("evt-3", 1))).kind).toBe("scheduled");
    expect((await h.service.handleCheckout(event("evt-3", 2))).kind).toBe("deferred-ambiguous");
  });

  it("quarantines distinct versions in the same source second even with different milliseconds", async () => {
    const h = harness();
    await h.service.handleCheckout(event("evt-1"));
    const subsecond = event("evt-2", 0, { occurredAt: "2026-10-24T11:00:00.900Z" });
    expect(await h.service.handleCheckout(subsecond)).toEqual({
      kind: "deferred-ambiguous", reason: "same_time_conflict",
    });
    expect(h.candidates.size).toBe(0);
    expect(h.watermarks.get("shop-a/checkout-1")?.state).toBe("conflicting");
  });

  it("checks PostgreSQL even with no job after MESSAGE_SENT; never schedules generation 2", async () => {
    const h = harness();
    h.recoveries.set("shop-a/checkout-1", { id: "recovery-sent", generation: 1,
      status: "MESSAGE_SENT", lastExternalActivityAt: new Date(at(0)), resumption: null, admissionEventId: null });
    expect(await h.service.handleCheckout(event("evt-after-message", 3))).toEqual({
      kind: "resumed", previousRecoveryId: "recovery-sent", nextGeneration: 2,
      candidateOutcome: "scheduled", dueAt: at(33),
    });
    expect(h.schedule).toHaveBeenCalledOnce();
    expect(h.schedule.mock.calls[0]?.[0].candidate.generation).toBe(2);
  });

  it("checks PostgreSQL with a candidate present and retires it without another first send", async () => {
    const h = harness();
    await h.service.handleCheckout(event("evt-1"));
    h.recoveries.set("shop-a/checkout-1", { id: "recovery-existing", generation: 1,
      status: "DETECTED", lastExternalActivityAt: new Date(at(0)), resumption: null, admissionEventId: null });
    expect((await h.service.handleCheckout(event("evt-2", 1))).kind).toBe("resumed");
    expect(h.candidates.get("shop-a/checkout-1")?.generation).toBe(2);
    expect(h.schedule).toHaveBeenCalledTimes(2);
  });

  it("replays a committed resumption into the same next generation and keeps later edits there", async () => {
    const h = harness();
    h.recoveries.set("shop-a/checkout-1", { id: "recovery-1", generation: 1,
      status: "ENGAGED", lastExternalActivityAt: new Date(at(0)), resumption: null, admissionEventId: null });
    const resumed = event("evt-resume", 2);
    expect((await h.service.handleCheckout(resumed)).kind).toBe("resumed");
    expect(h.closeForResumption).toHaveBeenCalledOnce();
    expect(h.candidates.get("shop-a/checkout-1")?.generation).toBe(2);
    expect((await h.service.handleCheckout(resumed)).kind).toBe("resumed");
    const later = event("evt-later", 3);
    expect(await h.service.handleCheckout(later)).toMatchObject({ kind: "rescheduled", generation: 2 });
    expect(h.closeForResumption).toHaveBeenCalledOnce();
    expect(h.candidates.get("shop-a/checkout-1")?.generation).toBe(2);
    expect(h.candidates.get("shop-a/checkout-1")?.lastEventId).toBe("evt-later");
  });

  it("cancels terminal observed placed (not necessarily paid) and ambiguous order state", async () => {
    const h = harness();
    await h.service.handleCheckout(event("evt-1"));
    h.terminal.set("shop-a/checkout-1", { kind: "order-placed", orderId: "order-1" });
    expect(await h.service.handleCheckout(event("evt-2", 1))).toEqual({ kind: "ignored-terminal", reason: "order-placed" });
    expect(h.candidates.size).toBe(0);
    h.terminal.set("shop-a/checkout-1", { kind: "ambiguous", reason: "conflicting orders" });
    expect((await h.service.handleCheckout(event("evt-3", 2))).kind).toBe("deferred-ambiguous");
    expect(h.schedule).toHaveBeenCalledOnce();
  });

  it("isolates two shops sharing checkoutKey and serializes parallel events per checkout", async () => {
    const h = harness();
    const outcomes = await Promise.all([
      h.service.handleCheckout(event("evt-a", 0)),
      h.service.handleCheckout(event("evt-b", 1)),
      h.service.handleCheckout(event("evt-c", 0, { shopId: "shop-b" })),
    ]);
    expect(outcomes.map((item) => item.kind)).toEqual(["scheduled", "rescheduled", "scheduled"]);
    expect(h.candidates.size).toBe(2);
    expect(h.candidates.get("shop-a/checkout-1")?.lastEventId).toBe("evt-b");
    expect(h.candidates.get("shop-b/checkout-1")?.lastEventId).toBe("evt-c");
    expect(h.withCheckoutLock).toHaveBeenCalledTimes(3);
  });

  it("fails closed on admission/eligibility, and propagates Redis/BullMQ errors for retry", async () => {
    const h = harness();
    vi.mocked(h.deps.shops.evaluate).mockResolvedValueOnce({ allowed: false, reason: "woo_installation_unavailable" });
    expect(await h.service.handleCheckout(event("evt-1"))).toEqual({ kind: "not-eligible", reason: "woo_installation_unavailable" });
    expect(h.schedule).not.toHaveBeenCalled();
    h.schedule.mockRejectedValueOnce(new Error("redis offline"));
    await expect(h.service.handleCheckout(event("evt-2", 1))).rejects.toThrow("redis offline");
    expect(h.watermarks.size).toBe(0); // never claim accepted before enqueue
    expect((await h.service.handleCheckout(event("evt-2", 1))).kind).toBe("scheduled");
  });

  it("repairs a successful queue write if watermark publication fails and capture retries", async () => {
    const h = harness();
    vi.mocked(h.deps.watermarks.write).mockRejectedValueOnce(new Error("watermark offline"));
    await expect(h.service.handleCheckout(event("evt-1"))).rejects.toThrow("watermark offline");
    expect(h.candidates.size).toBe(1);
    expect((await h.service.handleCheckout(event("evt-1"))).kind).toBe("rescheduled");
    expect(h.watermarks.get("shop-a/checkout-1")?.state).toBe("nonempty");
    expect(h.schedule).toHaveBeenCalledTimes(2);
  });
});
