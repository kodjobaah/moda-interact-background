import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_TURN_REPAIR_INTERVAL_MS,
  startPendingTurnRepairPoller,
} from "../../../../src/services/conversation-ai-delay/start-pending-turn-repair.js";

describe("startPendingTurnRepairPoller", () => {
  afterEach(() => vi.useRealTimers());

  it("runs every 30 seconds, logs failures, and cancels future cycles on close", async () => {
    vi.useFakeTimers();
    const error = new Error("temporary database failure");
    const runPass = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const log = { error: vi.fn() };
    const close = startPendingTurnRepairPoller({ runPass, log });

    await vi.advanceTimersByTimeAsync(PENDING_TURN_REPAIR_INTERVAL_MS);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("whatsapp.turn.repair.pass_failed", expect.objectContaining({ error }));

    await vi.advanceTimersByTimeAsync(PENDING_TURN_REPAIR_INTERVAL_MS);
    expect(runPass).toHaveBeenCalledTimes(2);
    await close();
    await vi.advanceTimersByTimeAsync(PENDING_TURN_REPAIR_INTERVAL_MS * 2);
    expect(runPass).toHaveBeenCalledTimes(2);
  });

  it("does not overlap repair passes and waits for an active pass during shutdown", async () => {
    vi.useFakeTimers();
    let finishPass: (() => void) | undefined;
    const runPass = vi.fn(() => new Promise<void>((resolve) => { finishPass = resolve; }));
    const close = startPendingTurnRepairPoller({ runPass, log: { error: vi.fn() } });

    await vi.advanceTimersByTimeAsync(PENDING_TURN_REPAIR_INTERVAL_MS);
    expect(runPass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PENDING_TURN_REPAIR_INTERVAL_MS * 2);
    expect(runPass).toHaveBeenCalledTimes(1);

    let closed = false;
    const closing = close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    finishPass?.();
    await closing;
    expect(closed).toBe(true);
  });
});