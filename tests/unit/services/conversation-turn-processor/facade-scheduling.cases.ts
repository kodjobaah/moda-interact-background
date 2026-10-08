import { expect, it, vi } from "vitest";
import type { ConversationTurnFacadeContext } from "../conversation-turn-processor.service.test.js";

export function registerSchedulingCases(context: ConversationTurnFacadeContext) {
  const { harness, state, first } = context;

  it("uses the current runtime quiet window when enqueueing", async () => {
    const test = harness({
      now: () => first,
      runtimeConfig: { current: () => ({ conversationQuietWindowMs: 1_000, conversationMaxSettleWindowMs: 5_000 }) },
    });
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: first, pendingTurnStartedAt: first }),
    );

    await test.processor.enqueue("conversation-1", 3);

    expect(test.queue.add.mock.calls[0]?.[2].delay).toBe(1_000);
  });

  it("uses the current runtime maximum settle window", async () => {
    const test = harness({
      now: () => first,
      runtimeConfig: { current: () => ({ conversationQuietWindowMs: 1_000, conversationMaxSettleWindowMs: 5_000 }) },
    });
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 9_000) }),
    );

    await test.processor.enqueue("conversation-1", 3);

    expect(test.queue.add.mock.calls[0]?.[2].delay).toBe(5_000);
  });

  it("fails closed when the injected maximum is below the quiet window", async () => {
    const test = harness({
      runtimeConfig: { current: () => ({ conversationQuietWindowMs: 5_000, conversationMaxSettleWindowMs: 1_000 }) },
    });

    await expect(test.processor.process({ conversationId: "conversation-1", observedVersion: 3 })).rejects.toThrow(
      "max settle window must be at least the quiet window",
    );
    expect(test.conversation.claimTurn).not.toHaveBeenCalled();
    expect(test.runAgent).not.toHaveBeenCalled();
  });

  it("applies a changed quiet window to a subsequent turn without restart", async () => {
    let config = { conversationQuietWindowMs: 3_000, conversationMaxSettleWindowMs: 10_000 };
    const test = harness({ now: () => first, runtimeConfig: { current: () => config } });
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: first, pendingTurnStartedAt: first }),
    );

    await test.processor.enqueue("conversation-1", 3);
    config = { conversationQuietWindowMs: 1_000, conversationMaxSettleWindowMs: 10_000 };
    await test.processor.enqueue("conversation-1", 4);

    expect(test.queue.add.mock.calls.map((call) => call[2].delay)).toEqual([3_000, 1_000]);
  });

  it("logs and rethrows a BullMQ scheduling failure with bounded turn identifiers", async () => {
    const test = harness({ now: () => first });
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: first, pendingTurnStartedAt: first }),
    );
    test.queue.add.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(test.processor.enqueue("conversation-1", 3)).rejects.toThrow(
      "redis unavailable",
    );

    expect(test.logger.error).toHaveBeenCalledWith(
      "whatsapp.turn.schedule_failed",
      expect.objectContaining({
        conversationId: "conversation-1",
        observedVersion: 3,
        jobId: "conversation-turn__conversation-1__3",
        errorName: "Error",
        errorMessage: "redis unavailable",
      }),
    );
  });

  it("honors the ten-second maximum despite continuous fragments", async () => {
    const test = harness();
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 9_999) }),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).toHaveBeenCalledTimes(1);
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("reuses one logical job ID for repeated early executions", async () => {
    const test = harness({
      now: () => new Date(first.getTime() + 1_000),
    });
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 1_000) }),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });
    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.queue.add).toHaveBeenCalledTimes(2);
    expect(
      new Set(test.queue.add.mock.calls.map((call: any[]) => call[2].jobId)),
    ).toEqual(new Set(["conversation-turn__conversation-1__3"]));
  });

  it("moves an active job back to delayed with its lock token", async () => {
    const test = harness({
      now: () => new Date(first.getTime() + 1_000),
    });
    const activeJob = {
      id: "conversation-turn__conversation-1__3",
      token: "worker-lock-token",
      moveToDelayed: vi.fn().mockResolvedValue(undefined),
    };

    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 1_000) }),
    );

    await expect(
      test.processor.process(
        {
          conversationId: "conversation-1",
          observedVersion: 3,
        },
        activeJob,
      ),
    ).rejects.toMatchObject({ name: "DelayedError" });

    expect(activeJob.moveToDelayed).toHaveBeenCalledWith(
      expect.any(Number),
      "worker-lock-token",
    );
    expect(test.queue.add).not.toHaveBeenCalled();
    expect(test.runAgent).not.toHaveBeenCalled();
  });

  it("uses the exact BullMQ-safe conversation/version job id", async () => {
    const test = harness({
      now: () => new Date(first.getTime() + 1_000),
    });
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 1_000) }),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    const jobId = test.queue.add.mock.calls[0]?.[2].jobId;
    expect(jobId).toBe("conversation-turn__conversation-1__3");
    expect(jobId).not.toContain(":");
  });
}
