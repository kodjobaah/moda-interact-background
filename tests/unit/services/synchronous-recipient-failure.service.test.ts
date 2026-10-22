import { describe, expect, it, vi } from "vitest";
import { SynchronousRecipientFailureService } from "../../../src/services/synchronous-recipient-failure.service.js";

describe("ARCH-028-BACKGROUND-006 synchronous correction ordering", () => {
  it("persists message/attempt before the credit owner reads usage and clears usage before suppression", async () => {
    const events: string[] = [];
    let usageExists = true;
    const evidence = { record: vi.fn(async (id: string, recipient: string) => {
      expect(id).toBe("message-1");
      expect(recipient).toBe("447700900001");
      events.push("evidence");
    }) };
    const correction = { reconcileMessage: vi.fn(async () => {
      expect(events).toEqual(["evidence"]);
      expect(usageExists).toBe(true); // identity needed by resolveExactRecoverySource
      usageExists = false; // owning correction deletes hard-limit usage
      events.push("correction");
      return "released" as const;
    }) };
    const reachability = { afterCorrection: vi.fn(async (_identity: unknown, outcome: string) => {
      expect(events).toEqual(["evidence", "correction"]);
      expect(usageExists).toBe(false);
      expect(outcome).toBe("released");
      events.push("suppression");
      return "suppressed" as const;
    }) };
    const subject = new SynchronousRecipientFailureService(evidence, correction, reachability);
    await subject.afterAutomatedRejection("message-1", "447700900001");
    expect(events).toEqual(["evidence", "correction", "suppression"]);
    expect(reachability.afterCorrection).toHaveBeenCalledWith({ messageId: "message-1" }, "released");
  });

  it("defers reachability when purchased compensation is still required", async () => {
    const reachability = { afterCorrection: vi.fn(async () => "deferred" as const) };
    const subject = new SynchronousRecipientFailureService(
      { record: vi.fn() },
      { reconcileMessage: vi.fn(async () => "purchased-compensation-required" as const) },
      reachability,
    );
    await subject.afterPersistedRejection("message-2");
    expect(reachability.afterCorrection).toHaveBeenCalledWith(
      { messageId: "message-2" }, "purchased-compensation-required",
    );
  });

  it("does not ask the reachability writer to run when compensation throws", async () => {
    const reachability = { afterCorrection: vi.fn() };
    const subject = new SynchronousRecipientFailureService(
      { record: vi.fn() },
      { reconcileMessage: vi.fn(async () => { throw new Error("database unavailable"); }) },
      reachability,
    );
    await expect(subject.afterAutomatedRejection("m", "447700900001"))
      .rejects.toThrow("database unavailable");
    expect(reachability.afterCorrection).not.toHaveBeenCalled();
  });
});
