import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/meta-template-management/service.js", () => ({
  metaTemplateManagementService: { processDueRegistrations: vi.fn() },
}));
import { startMetaTemplateDuePoller } from "../../../../src/services/meta-template-management/due-poller.js";

describe("ARCH-047 BG003 messaging-worker due reconciliation scheduler", () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it("uses bounded initial jitter, 25 due rows, 60s cadence and shutdown cleanup", async () => {
    vi.useFakeTimers();
    const processDue = vi.fn().mockResolvedValue({ inspected: 1, processed: 1 });
    const log = { info: vi.fn(), error: vi.fn() };
    const close = startMetaTemplateDuePoller({ processDue, log, jitterMs: 321 });
    await vi.advanceTimersByTimeAsync(320);
    expect(processDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(processDue).toHaveBeenCalledExactlyOnceWith(25);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processDue).toHaveBeenCalledTimes(2);
    await close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(processDue).toHaveBeenCalledTimes(2);
  });

  it("does not overlap and does not abandon scheduling after a logged error", async () => {
    vi.useFakeTimers();
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => { resolveWork = resolve; });
    const processDue = vi.fn().mockImplementationOnce(() => work)
      .mockRejectedValueOnce(new Error("provider outage"))
      .mockResolvedValue({ inspected: 0, processed: 0 });
    const log = { info: vi.fn(), error: vi.fn() };
    const close = startMetaTemplateDuePoller({ processDue, log, jitterMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(processDue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(processDue).toHaveBeenCalledTimes(1);
    resolveWork();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processDue).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith("meta.template.due.cycle_failed", expect.anything());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processDue).toHaveBeenCalledTimes(3);
    await close();
  });

  it("rejects out-of-range jitter rather than scheduling unexpectedly", () => {
    const processDue = vi.fn(); const log = { info: vi.fn(), error: vi.fn() };
    expect(() => startMetaTemplateDuePoller({ processDue, log, jitterMs: 10_001 })).toThrow(RangeError);
  });
});
