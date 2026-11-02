import { describe, expect, it, vi } from "vitest";

import { recordProcessableInbound } from "../../../../src/services/conversation-ai-delay/pending-turn-repository.js";

const pendingStartedAt = new Date("2026-10-31T12:00:00.000Z");

function makeTransaction(overrides: Record<string, unknown> = {}) {
  const state = {
    id: "conversation-1",
    type: "RECOVERY",
    checkoutRecoveryId: "recovery-1",
    controlMode: "AI",
    controlRevision: 7,
    inboundVersion: 4,
    lastProcessedVersion: 4,
    pendingTurnStartedAt: null,
    recoveryId: "recovery-1",
    recoveryShopId: "recovery-shop-authority",
    ...overrides,
  };
  const update = vi.fn().mockResolvedValue({ inboundVersion: state.inboundVersion + 1 });
  const findUnique = vi.fn().mockResolvedValue({ aiResponseDelayMinutes: 7 });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([state]),
    conversation: { update },
    shopSettings: { findUnique },
  };
  return { tx, state, update, findUnique };
}

describe("recordProcessableInbound", () => {
  it("captures the recovery-shop delay and control revision only when opening an AI turn", async () => {
    const { tx, update, findUnique } = makeTransaction();

    await expect(recordProcessableInbound(tx as never, "conversation-1", pendingStartedAt))
      .resolves.toEqual({ version: 5, scheduleAi: true });

    expect(findUnique).toHaveBeenCalledWith({
      where: { shopId: "recovery-shop-authority" },
      select: { aiResponseDelayMinutes: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        inboundVersion: { increment: 1 },
        pendingTurnStartedAt: pendingStartedAt,
        pendingAiNotBeforeAt: new Date(pendingStartedAt.getTime() + 7 * 60_000),
        pendingAiDelayMinutes: 7,
        pendingAiControlRevision: 7,
      },
      select: { inboundVersion: true },
    });
  });

  it("uses zero when a valid recovery shop has no settings row", async () => {
    const { tx, update, findUnique } = makeTransaction();
    findUnique.mockResolvedValue(null);

    await recordProcessableInbound(tx as never, "conversation-1", pendingStartedAt);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pendingAiNotBeforeAt: pendingStartedAt,
        pendingAiDelayMinutes: 0,
        pendingAiControlRevision: 7,
      }),
    }));
  });

  it.each([-1, 31, 1.5, "7", null])("rejects corrupt persisted delay %s", async (delayMinutes) => {
    const { tx, update, findUnique } = makeTransaction();
    findUnique.mockResolvedValue({ aiResponseDelayMinutes: delayMinutes });

    await expect(recordProcessableInbound(tx as never, "conversation-1", pendingStartedAt))
      .rejects.toThrow(RangeError);
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves the first pending snapshot unchanged for later inbound fragments", async () => {
    const originalStart = new Date("2026-10-31T11:58:00.000Z");
    const { tx, update, findUnique } = makeTransaction({
      inboundVersion: 5,
      lastProcessedVersion: 4,
      pendingTurnStartedAt: originalStart,
    });

    await recordProcessableInbound(tx as never, "conversation-1", pendingStartedAt);

    expect(findUnique).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { inboundVersion: { increment: 1 } },
      select: { inboundVersion: true },
    });
  });

  it("advances the processed watermark and creates no AI deadline in HUMAN mode", async () => {
    const { tx, update, findUnique } = makeTransaction({ controlMode: "HUMAN" });

    await expect(recordProcessableInbound(tx as never, "conversation-1", pendingStartedAt))
      .resolves.toEqual({ version: 5, scheduleAi: false });

    expect(findUnique).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        inboundVersion: { increment: 1 },
        lastProcessedVersion: 5,
        pendingTurnStartedAt: null,
        pendingAiNotBeforeAt: null,
        pendingAiDelayMinutes: null,
        pendingAiControlRevision: null,
        processingInboundVersion: null,
        processingStartedAt: null,
      },
      select: { inboundVersion: true },
    });
  });

  it("preserves standalone turn behavior without consulting merchant settings", async () => {
    const { tx, update, findUnique } = makeTransaction({
      type: "PRODUCT_SUPPORT",
      checkoutRecoveryId: null,
      recoveryId: null,
      recoveryShopId: null,
    });

    await recordProcessableInbound(tx as never, "conversation-1", pendingStartedAt);

    expect(findUnique).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pendingTurnStartedAt: pendingStartedAt,
        inboundVersion: { increment: 1 },
      }),
    }));
    expect(update.mock.calls[0]?.[0].data).not.toHaveProperty("pendingAiNotBeforeAt");
  });
});