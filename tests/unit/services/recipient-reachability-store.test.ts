import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));
import { RecipientReachabilityStore } from
  "../../../src/services/recipient-reachability-store.js";

const failureAt = new Date("2026-10-22T10:00:00.000Z");
const DAY_MS = 86_400_000;
function harness(days: number | null = null) {
  const database = {
    platformBillingPolicy: {
      findUnique: vi.fn().mockResolvedValue(days === null ? null : {
        whatsappRecipientSuppressionDays: days,
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ version: 1 }]),
  };
  return { database, store: new RecipientReachabilityStore(database as never) };
}

describe("ARCH-028 atomic Shop-scoped reachability store", () => {
  it("defaults suppression to seven days from the provider failure, not processing time", async () => {
    const h = harness();
    expect(await h.store.recordFailure("shop-1", "447700900123", failureAt, "131026"))
      .toBe("recorded");
    const query = h.database.$queryRaw.mock.calls[0]![0];
    expect(query.strings.join(" ")).toContain("ON CONFLICT");
    expect(query.strings.join(" ")).toContain('"version" + 1');
    expect(query.values).toContainEqual(new Date(failureAt.getTime() + 7 * DAY_MS));
    expect(query.values).toContain("shop-1");
    expect(query.values).toContain("447700900123");
    expect(h.database.platformBillingPolicy.findUnique).toHaveBeenCalledWith({
      where: { id: "default" }, select: { whatsappRecipientSuppressionDays: true },
    });
  });

  it("uses the current policy for new failure evidence only", async () => {
    const h = harness(3);
    await h.store.recordFailure("shop-1", "447700900123", failureAt, "131026");
    expect(h.database.$queryRaw.mock.calls[0]![0].values)
      .toContainEqual(new Date(failureAt.getTime() + 3 * DAY_MS));
    h.database.platformBillingPolicy.findUnique.mockResolvedValue({
      whatsappRecipientSuppressionDays: 8,
    });
    await h.store.recordFailure("shop-1", "447700900123", new Date(failureAt.getTime() + DAY_MS), "131026");
    expect(h.database.$queryRaw.mock.calls[1]![0].values)
      .toContainEqual(new Date(failureAt.getTime() + 9 * DAY_MS));
  });

  it("fails closed for malformed policy and does not write", async () => {
    const h = harness(0);
    await expect(h.store.recordFailure("shop-1", "447700900123", failureAt, "131026"))
      .rejects.toThrow(/suppression policy/);
    expect(h.database.$queryRaw).not.toHaveBeenCalled();
  });

  it("uses a row-atomic monotonic positive upsert, even when no failure row exists", async () => {
    const h = harness();
    expect(await h.store.recordSuccess("shop-2", "447700900123", failureAt))
      .toBe("recorded");
    const query = h.database.$queryRaw.mock.calls[0]![0];
    expect(query.strings.join(" ")).toContain("ON CONFLICT");
    expect(query.strings.join(" ")).toContain('"lastSuccessfulAt"');
    expect(query.strings.join(" ")).toContain('"lastFailureAt"');
    expect(query.values).toContain("shop-2");
    h.database.$queryRaw.mockResolvedValueOnce([]);
    expect(await h.store.recordSuccess("shop-2", "447700900123", failureAt))
      .toBe("unchanged");
  });
});
