import { describe, expect, it, vi } from "vitest";
import {
  PENDING_TURN_REPAIR_MAX_PER_PASS,
  PENDING_TURN_REPAIR_PAGE_SIZE,
  PendingTurnRepairService,
} from "../../../../src/services/conversation-ai-delay/pending-turn-repair.js";

type Candidate = {
  id: string;
  inboundVersion: number;
  pendingAiNotBeforeAt: Date;
  pendingTurnStartedAt: Date;
  lastInboundAt: Date;
};

function candidate(id: string): Candidate {
  const pendingTurnStartedAt = new Date("2026-11-02T12:00:00.000Z");
  return {
    id,
    inboundVersion: 4,
    pendingAiNotBeforeAt: new Date(pendingTurnStartedAt.getTime() + 60_000),
    pendingTurnStartedAt,
    lastInboundAt: pendingTurnStartedAt,
  };
}

function harness(initialCandidates: Candidate[], now = new Date("2026-11-02T12:02:00.000Z")) {
  const candidates = initialCandidates;
  const query = vi.fn(async (_sql: string, cursorDate: Date | null, cursorId: string | null,
    _staleBefore: Date, limit: number) => candidates
    .filter((row) => cursorDate === null || row.pendingAiNotBeforeAt > cursorDate ||
      (row.pendingAiNotBeforeAt.getTime() === cursorDate.getTime() && row.id > cursorId!))
    .sort((left, right) => left.pendingAiNotBeforeAt.getTime() - right.pendingAiNotBeforeAt.getTime() ||
      left.id.localeCompare(right.id))
    .slice(0, limit));
  const add = vi.fn(async (_name: string, _data: unknown, _options: unknown) => undefined);
  const getJob = vi.fn(async (_jobId: string) => null);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new PendingTurnRepairService(
    { $queryRawUnsafe: query } as never,
    { add, getJob } as never,
    { current: () => ({ conversationQuietWindowMs: 250, conversationMaxSettleWindowMs: 30_000 }) } as never,
    () => now,
    log,
  );
  return { candidates, query, add, getJob, log, service };
}

describe("PendingTurnRepairService", () => {
  it("advances its indexed keyset cursor across bounded passes despite a continuing older-row flood", async () => {
    const rows = Array.from({ length: 2_250 }, (_, index) => candidate(`a${String(index).padStart(5, "0")}`));
    const test = harness(rows);

    const first = await test.service.runPass();
    expect(first.scanned).toBe(PENDING_TURN_REPAIR_MAX_PER_PASS);
    expect(first.requeued).toBe(PENDING_TURN_REPAIR_MAX_PER_PASS);
    expect(test.add.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      jobId: "conversation-turn__a00000__4",
      delay: 0,
      removeOnComplete: true,
    }));

    rows.unshift(...Array.from({ length: 500 }, (_, index) => candidate(`00000-${String(index).padStart(5, "0")}`)));
    const beforeSecondPass = test.add.mock.calls.length;
    const second = await test.service.runPass();
    expect(second.scanned).toBe(PENDING_TURN_REPAIR_MAX_PER_PASS);
    expect(test.add.mock.calls[beforeSecondPass]?.[1]).toEqual({
      conversationId: "a01000",
      observedVersion: 4,
    });

    const third = await test.service.runPass();
    expect(third.scanned).toBe(250);
    expect(test.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY "pendingAiNotBeforeAt", "id"'),
      expect.any(Date), expect.any(String), expect.any(Date), PENDING_TURN_REPAIR_PAGE_SIZE);
    expect(test.log.info).toHaveBeenLastCalledWith("whatsapp.turn.repair.pass_completed", expect.objectContaining({
      scanned: 250,
      requeued: 250,
      skipped: 0,
      failed: 0,
      oldestDueLagMs: 60_000,
    }));

    const fourthPass = await test.service.runPass();
    expect(fourthPass.scanned).toBe(PENDING_TURN_REPAIR_MAX_PER_PASS);
    expect(test.add.mock.calls.at(-PENDING_TURN_REPAIR_MAX_PER_PASS)?.[1]).toEqual({
      conversationId: "00000-00000",
      observedVersion: 4,
    });
  });

  it("retains the failed candidate as the next pass cursor and rethrows the original queue error", async () => {
    const error = new Error("redis unavailable");
    const test = harness([candidate("conversation-a"), candidate("conversation-b")]);
    test.add.mockRejectedValueOnce(error);

    await expect(test.service.runPass()).rejects.toBe(error);
    expect(test.log.error).toHaveBeenCalledWith("whatsapp.turn.repair.job_recovery_failed", expect.objectContaining({
      conversationId: "conversation-a",
      jobId: "conversation-turn__conversation-a__4",
      error,
    }));

    test.add.mockResolvedValue(undefined);
    await test.service.runPass();
    expect(test.add.mock.calls.at(-2)?.[1]).toEqual({
      conversationId: "conversation-a",
      observedVersion: 4,
    });
  });

  it("retries a retained failed job only after its frozen eligibility deadline and resets exhausted attempts", async () => {
    const test = harness([candidate("conversation-a")]);
    let state = "failed";
    const failedJob = {
      getState: vi.fn(async () => state),
      retry: vi.fn(async () => { state = "waiting"; }),
    };
    test.getJob.mockResolvedValue(failedJob as never);

    const due = await test.service.runPass();
    expect(due.requeued).toBe(1);
    expect(due.skipped).toBe(0);
    expect(failedJob.retry).toHaveBeenCalledWith("failed", {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(test.add).not.toHaveBeenCalled();

    state = "failed";
    failedJob.retry.mockClear();
    const futureTest = harness([candidate("conversation-a")], new Date("2026-11-02T12:00:30.000Z"));
    futureTest.getJob.mockResolvedValue(failedJob as never);
    const notDue = await futureTest.service.runPass();
    expect(notDue.skipped).toBe(1);
    expect(failedJob.retry).not.toHaveBeenCalled();
  });

  it("treats a competing replica's successful retry as a skip without touching a now-active job", async () => {
    const test = harness([candidate("conversation-a")]);
    const retryError = new Error("job is no longer failed");
    const failedJob = {
      getState: vi.fn().mockResolvedValueOnce("failed").mockResolvedValueOnce("active"),
      retry: vi.fn().mockRejectedValue(retryError),
    };
    test.getJob.mockResolvedValue(failedJob as never);

    const result = await test.service.runPass();
    expect(result.requeued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(failedJob.retry).toHaveBeenCalledOnce();
  });
});