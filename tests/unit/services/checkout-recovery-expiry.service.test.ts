import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  checkoutRecovery: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  checkoutRecoveryStatusHistory: {
    create: vi.fn(),
  },
  recoveryOutreachAttempt: {
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../../../src/lib/db.js", () => ({ default: prismaMock }));

import { CheckoutRecoveryExpiryService } from "../../../src/services/checkout-recovery-expiry.service.js";

const now = new Date("2026-09-16T12:00:00.000Z");
const runtime = (checkoutRecoveryLifetimeDays: number) => ({
  checkoutRecoveryLifetimeDays,
});

describe("CheckoutRecoveryExpiryService", () => {
  const service = new CheckoutRecoveryExpiryService();

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
    prismaMock.checkoutRecovery.findMany.mockResolvedValue([]);
    prismaMock.checkoutRecovery.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.checkoutRecoveryStatusHistory.create.mockResolvedValue({});
    prismaMock.recoveryOutreachAttempt.updateMany.mockResolvedValue({ count: 1 });
  });

  it("uses the 21-day default cutoff and scans only active recoveries in bounded pages", async () => {
    prismaMock.checkoutRecovery.findMany.mockResolvedValueOnce([
      { id: "recovery-1", status: "DETECTED" },
    ]);

    await expect(service.expireInactive(runtime(21), now)).resolves.toBe(1);

    const query = prismaMock.checkoutRecovery.findMany.mock.calls[0][0];
    expect(query.where.status).toEqual({
      in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"],
    });
    expect(query.where.lastExternalActivityAt.lte).toEqual(
      new Date("2026-08-26T12:00:00.000Z"),
    );
    expect(query.take).toBe(100);
    expect(query.orderBy).toEqual([
      { lastExternalActivityAt: "asc" },
      { id: "asc" },
    ]);
  });

  it("uses a changed allowed lifetime on the next scan without rewriting the row", async () => {
    await service.expireInactive(runtime(7), now);

    const query = prismaMock.checkoutRecovery.findMany.mock.calls[0][0];
    expect(query.where.lastExternalActivityAt.lte).toEqual(
      new Date("2026-09-09T12:00:00.000Z"),
    );
    expect(prismaMock.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it.each([0, 21, 180, 365])("uses the exact inclusive cutoff for %i days", async (lifetimeDays) => {
    await expect(service.expireInactive(runtime(lifetimeDays), now)).resolves.toBe(0);

    const expectedCutoff = new Date(now.getTime() - lifetimeDays * 86_400_000);
    expect(prismaMock.checkoutRecovery.findMany).toHaveBeenCalledOnce();
    expect(prismaMock.checkoutRecovery.findMany.mock.calls[0][0].where.lastExternalActivityAt).toEqual({
      lte: expectedCutoff,
    });
    expect(prismaMock.checkoutRecovery.findMany.mock.calls[0][0].where.lastExternalActivityAt.lte.getTime())
      .toBe(expectedCutoff.getTime());
  });

  it("expires activity exactly at the zero-day cutoff and keeps the conditional boundary inclusive", async () => {
    prismaMock.checkoutRecovery.findMany.mockResolvedValueOnce([
      { id: "recovery-at-cutoff", status: "DETECTED" },
    ]);

    await expect(service.expireInactive(runtime(0), now)).resolves.toBe(1);

    expect(prismaMock.checkoutRecovery.findMany.mock.calls[0][0].where.lastExternalActivityAt).toEqual({
      lte: now,
    });
    expect(prismaMock.checkoutRecovery.updateMany.mock.calls[0][0].where.lastExternalActivityAt).toEqual({
      lte: now,
    });
    expect(prismaMock.checkoutRecoveryStatusHistory.create).toHaveBeenCalledOnce();
    expect(prismaMock.recoveryOutreachAttempt.updateMany).toHaveBeenCalledOnce();
  });

  it("skips the Prisma scan when the maximum persisted lifetime is unrepresentable", async () => {
    await expect(service.expireInactive(runtime(2_147_483_647), now)).resolves.toBe(0);

    expect(prismaMock.checkoutRecovery.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("skips a PostgreSQL-out-of-range cutoff even when JavaScript Date can represent it", async () => {
    const lifetimeDays = 3_000_000;
    const cutoffMs = now.getTime() - lifetimeDays * 86_400_000;
    expect(Number.isFinite(new Date(cutoffMs).getTime())).toBe(true);

    await expect(service.expireInactive(runtime(lifetimeDays), now)).resolves.toBe(0);

    expect(prismaMock.checkoutRecovery.findMany).not.toHaveBeenCalled();
  });

  it("queries when the cutoff is exactly PostgreSQL's minimum timestamp", async () => {
    const postgresMinimumMs = -210_866_803_200_000;
    const nowAtMinimumCutoff = new Date(postgresMinimumMs + 86_400_000);

    await expect(service.expireInactive(runtime(1), nowAtMinimumCutoff)).resolves.toBe(0);

    expect(prismaMock.checkoutRecovery.findMany).toHaveBeenCalledOnce();
    expect(prismaMock.checkoutRecovery.findMany.mock.calls[0][0].where.lastExternalActivityAt).toEqual({
      lte: new Date(postgresMinimumMs),
    });
  });

  it("skips the Prisma scan when the cutoff is one millisecond below PostgreSQL's minimum", async () => {
    const postgresMinimumMs = -210_866_803_200_000;
    const nowBelowMinimumCutoff = new Date(postgresMinimumMs + 86_400_000 - 1);

    await expect(service.expireInactive(runtime(1), nowBelowMinimumCutoff)).resolves.toBe(0);

    expect(prismaMock.checkoutRecovery.findMany).not.toHaveBeenCalled();
  });

  it("expires conditionally, records history, and cancels only unsent outreach", async () => {
    prismaMock.checkoutRecovery.findMany.mockResolvedValueOnce([
      { id: "recovery-1", status: "MESSAGE_SENT" },
    ]);

    await expect(service.expireInactive(runtime(21), now)).resolves.toBe(1);

    expect(prismaMock.checkoutRecovery.updateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: "MESSAGE_SENT",
        lastExternalActivityAt: {
          lte: new Date("2026-08-26T12:00:00.000Z"),
        },
      },
      data: { status: "EXPIRED", expiredAt: now },
    });
    expect(prismaMock.checkoutRecoveryStatusHistory.create).toHaveBeenCalledWith({
      data: {
        checkoutRecoveryId: "recovery-1",
        fromStatus: "MESSAGE_SENT",
        toStatus: "EXPIRED",
        reason: "checkout-recovery-inactivity-expired",
        source: "ARCH-016",
        occurredAt: now,
      },
    });
    expect(prismaMock.recoveryOutreachAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        checkoutRecoveryId: "recovery-1",
        OR: [
          { status: "PENDING" },
          { status: "WAITING_FOR_RESPONSE", sentAt: null },
        ],
      },
      data: { status: "CANCELLED", closedAt: now },
    });
  });

  it("skips a stale expiry candidate when activity wins the race", async () => {
    prismaMock.checkoutRecovery.findMany.mockResolvedValueOnce([
      { id: "recovery-1", status: "ENGAGED" },
    ]);
    prismaMock.checkoutRecovery.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.expireInactive(runtime(21), now)).resolves.toBe(0);
    expect(prismaMock.checkoutRecoveryStatusHistory.create).not.toHaveBeenCalled();
    expect(prismaMock.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });
});
