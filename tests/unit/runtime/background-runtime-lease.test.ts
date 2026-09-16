import { describe, expect, it, vi } from "vitest";

import { BackgroundRuntimeLeaseService, LEASE_HEARTBEAT_MS } from "../../../src/runtime/background-runtime-lease.js";

const name = "BILLING_RECONCILIATION" as any;
const sqlDatabase = (...responses: unknown[]) => ({ $queryRaw: vi.fn().mockImplementation(async () => responses.shift() ?? []) }) as any;

describe("BackgroundRuntimeLeaseService", () => {
  it("races two instances so only one receives a handle", async () => {
    let acquired = false;
    const db = { $queryRaw: vi.fn().mockImplementation(async () => acquired ? [] : (acquired = true, [{ name, generation: 1 }])) } as any;
    const [first, second] = await Promise.all([
      new BackgroundRuntimeLeaseService(db, "host:1:first").tryAcquire(name),
      new BackgroundRuntimeLeaseService(db, "host:2:second").tryAcquire(name),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("returns takeover generations and fences old heartbeat and release", async () => {
    const db = sqlDatabase([{ name, generation: 2 }], [], []);
    const service = new BackgroundRuntimeLeaseService(db, "new-owner");
    const takeover = await service.tryAcquire(name);
    expect(takeover?.generation).toBe(2);
    expect(await service.heartbeat({ name, ownerToken: "old-owner", generation: 1 })).toBe(false);
    expect(await service.release({ name, ownerToken: "old-owner", generation: 1 })).toBe(false);
  });

  it("extends expiry with PostgreSQL time and cleans up work errors", async () => {
    const db = sqlDatabase([{ name }], [{ name }]);
    const service = new BackgroundRuntimeLeaseService(db, "owner");
    expect(await service.heartbeat({ name, ownerToken: "owner", generation: 1 })).toBe(true);
    const query = db.$queryRaw.mock.calls[0]?.[0] as { sql?: unknown; strings?: unknown };
    const fragments = String(query.sql ?? query.strings ?? "");
    expect(fragments).toContain("NOW()");
    expect(fragments).toContain("120 seconds");
    expect(fragments).toContain('"ownerToken" =');
    expect(fragments).toContain('"generation" =');
    expect(fragments).toContain('"leaseUntil" > NOW()');
    await expect(service.runWithLease(name, async () => { throw new Error("work"); })).rejects.toThrow("work");
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("marks work lease-lost after a failed heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const db = sqlDatabase([{ name, generation: 1 }], []);
      const service = new BackgroundRuntimeLeaseService(db, "owner");
      let resolveWork!: () => void;
      const resultPromise = service.runWithLease(name, () => new Promise<void>((resolve) => { resolveWork = resolve; }));
      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS);
      resolveWork();
      expect((await resultPromise)).toEqual({ kind: "completed", value: undefined, leaseLost: true });
      expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});