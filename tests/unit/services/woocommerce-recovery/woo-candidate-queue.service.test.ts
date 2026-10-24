import { describe, expect, it, vi } from "vitest";

// Service modules import production adapters, but injected unit harnesses do
// not connect to Redis/PostgreSQL or require local integration credentials.
vi.mock("../../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));

import type { WooPendingCandidate } from "../../../../src/services/woocommerce-recovery/contracts.js";
import {
  WooCandidateMutationBlocked,
  WooPendingCandidateQueueService,
  wooCandidateJobId,
} from "../../../../src/services/woocommerce-recovery/woo-candidate-queue.service.js";
import {
  EVALUATE_PENDING_RECOVERY_JOB,
  pendingCandidateCheckoutIndexKey,
} from "../../../../src/domain/pending-recovery-candidate.js";

const NOW = Date.parse("2026-10-24T10:00:00.000Z");
const candidate = (shopId = "woo-shop", checkoutToken = "same-token", eventId = "first"): WooPendingCandidate => ({
  source: "woocommerce", shopId, checkoutToken, lastEventId: eventId,
  lastActivityAt: "2026-10-24T10:00:00.000Z",
  basket: { kind: "nonempty", checkout: {
    currency: "GBP", total: "12.00", items: [{ quantity: 1, total: "12.00" }],
  } },
});

function harness() {
  const jobs = new Map<string, {
    data: WooPendingCandidate;
    state: string;
    updateData: (candidate: WooPendingCandidate) => Promise<void>;
    changeDelay: (delayMs: number) => Promise<void>;
    remove: () => Promise<void>;
    getState: () => Promise<string>;
  }>();
  const indexes = new Map<string, string>();
  const shopIndex = new Map<string, number>();
  const add = vi.fn(async (_name: string, value: WooPendingCandidate, opts: { jobId: string; delay: number }) => {
    if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, fakeJob(value));
  });
  const upsert = vi.fn(async (input: {
    candidate: { shopId: string; checkoutToken: string };
    jobId: string; dueAtMs: number; retentionMs?: number;
  }) => {
    indexes.set(pendingCandidateCheckoutIndexKey(input.candidate), input.jobId);
    shopIndex.set(input.jobId, input.dueAtMs);
  });
  const remove = vi.fn(async (ref: { shopId: string; checkoutToken: string }, jobId?: string) => {
    indexes.delete(pendingCandidateCheckoutIndexKey(ref));
    if (jobId) shopIndex.delete(jobId);
  });
  const queue = { add, getJob: vi.fn(async (jobId: string) => jobs.get(jobId) ?? null) };
  const index = { upsert, remove, findByCheckout: vi.fn(async (ref: {
    shopId: string; checkoutToken: string;
  }) => indexes.get(pendingCandidateCheckoutIndexKey(ref)) ?? null) };
  const service = new WooPendingCandidateQueueService(queue, index as never, () => NOW);
  return { service, add, upsert, remove, queue, indexes, jobs, shopIndex };

  function fakeJob(value: WooPendingCandidate) {
    const job = {
      data: value,
      state: "delayed",
      getState: async () => job.state,
      updateData: vi.fn(async (changed: WooPendingCandidate) => { job.data = changed; }),
      changeDelay: vi.fn(async () => {}),
      remove: vi.fn(async () => {
        for (const [id, stored] of jobs) if (stored === job) jobs.delete(id);
      }),
    };
    return job;
  }
}

describe("ARCH-048-BACKGROUND-001 Woo candidate queue/index adapter", () => {
  it("enqueues and reschedules exactly one explicit-source job through existing index", async () => {
    const h = harness();
    const initial = candidate();
    const input = { candidate: initial, delayMinutes: 30, dueAtMs: NOW + 30 * 60_000,
      retentionMs: 24 * 60 * 60_000 + 30 * 60_000 };
    expect(await h.service.schedulePending(input)).toBe("scheduled");
    const jobId = wooCandidateJobId(initial);
    expect(h.add).toHaveBeenCalledWith(EVALUATE_PENDING_RECOVERY_JOB, initial, { jobId, delay: 30 * 60_000 });
    expect(await h.service.getPending(initial)).toEqual(initial);
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({
      jobId, shouldIndexShop: true, retentionMs: input.retentionMs,
    }));
    const changed = candidate("woo-shop", "same-token", "second");
    expect(await h.service.schedulePending({ ...input, candidate: changed })).toBe("rescheduled");
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.jobs.get(jobId)?.updateData).toHaveBeenCalledWith(changed);
    expect(h.jobs.get(jobId)?.changeDelay).toHaveBeenCalledWith(30 * 60_000);
    expect(h.indexes.get(pendingCandidateCheckoutIndexKey(initial))).toBe(jobId);
    expect(await h.service.cancelPending(initial)).toBe("cancelled");
    expect(h.indexes.size).toBe(0);
    expect(h.shopIndex.size).toBe(0);
    expect(await h.service.getPending(initial)).toBeNull();
  });

  it("keeps two tenant lineages with identical checkout keys isolated", async () => {
    const h = harness();
    for (const shopId of ["woo-a", "woo-b"]) {
      await h.service.schedulePending({ candidate: candidate(shopId), delayMinutes: 30,
        dueAtMs: NOW + 1_800_000, retentionMs: 90_000_000 });
    }
    expect(h.jobs.size).toBe(2);
    expect(wooCandidateJobId(candidate("woo-a"))).not.toBe(wooCandidateJobId(candidate("woo-b")));
    await h.service.cancelPending(candidate("woo-a"));
    expect(await h.service.getPending(candidate("woo-b"))).toMatchObject({ shopId: "woo-b" });
  });

  it("refuses an unmarked Shopify candidate or a forged source instead of migrating it", async () => {
    const h = harness();
    const woo = candidate();
    const indexKey = pendingCandidateCheckoutIndexKey(woo);
    const legacyJobId = "shopify-existing-candidate";
    h.indexes.set(indexKey, legacyJobId);
    h.jobs.set(legacyJobId, {
      data: { shopId: woo.shopId, checkoutToken: woo.checkoutToken } as WooPendingCandidate,
      state: "delayed", getState: async () => "delayed",
      updateData: vi.fn(), changeDelay: vi.fn(), remove: vi.fn(),
    });
    await expect(h.service.cancelPending(woo)).rejects.toBeInstanceOf(WooCandidateMutationBlocked);
    await expect(h.service.schedulePending({ candidate: woo, delayMinutes: 30,
      dueAtMs: NOW + 1_800_000, retentionMs: 90_000_000 })).rejects.toThrow("unexpected_source");
    expect(h.jobs.has(legacyJobId)).toBe(true);
    expect(h.indexes.get(indexKey)).toBe(legacyJobId);
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each(["waiting", "active", "failed"])("never silently overwrites a %s job", async (state) => {
    const h = harness();
    const woo = candidate();
    const input = { candidate: woo, delayMinutes: 30, dueAtMs: NOW + 1_800_000,
      retentionMs: 90_000_000 };
    await h.service.schedulePending(input);
    const job = h.jobs.get(wooCandidateJobId(woo))!;
    job.state = state;
    await expect(h.service.schedulePending(input)).rejects.toThrow("job_not_mutable");
    expect(h.add).toHaveBeenCalledOnce();
    expect(job.updateData).not.toHaveBeenCalled();
  });

  it("cleans dangling Woo indexes when a completed job has been removed", async () => {
    const h = harness();
    const woo = candidate();
    h.indexes.set(pendingCandidateCheckoutIndexKey(woo), wooCandidateJobId(woo));
    expect(await h.service.cancelPending(woo)).toBe("absent");
    expect(h.indexes.size).toBe(0);
    expect(h.remove).toHaveBeenCalledOnce();
  });
});
