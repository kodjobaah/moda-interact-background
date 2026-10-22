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
    const notification = { notify: vi.fn(async () => "created" as const) };
    const subject = new SynchronousRecipientFailureService(evidence, correction, reachability, notification);
    await subject.afterAutomatedRejection("message-1", "447700900001");
    expect(events).toEqual(["evidence", "correction", "suppression"]);
    expect(notification.notify).toHaveBeenCalledWith({ messageId: "message-1" }, "released", "suppressed");
    expect(reachability.afterCorrection).toHaveBeenCalledWith({ messageId: "message-1" }, "released");
  });

  it("defers reachability when purchased compensation is still required", async () => {
    const reachability = { afterCorrection: vi.fn(async () => "deferred" as const) };
    const subject = new SynchronousRecipientFailureService(
      { record: vi.fn() },
      { reconcileMessage: vi.fn(async () => "purchased-compensation-required" as const) },
      reachability,
      { notify: vi.fn() },
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
      { notify: vi.fn() },
    );
    await expect(subject.afterAutomatedRejection("m", "447700900001"))
      .rejects.toThrow("database unavailable");
    expect(reachability.afterCorrection).not.toHaveBeenCalled();
  });
  it("puts the merchant notice last for a synchronous persisted rejection", async () => {
    const events: string[] = [];
    const subject = new SynchronousRecipientFailureService(
      { record: vi.fn() },
      { reconcileMessage: vi.fn(async () => { events.push("credit"); return "historical-only" as const; }) },
      { afterCorrection: vi.fn(async () => { events.push("reachability"); return "unchanged" as const; }) },
      { notify: vi.fn(async () => { events.push("notice"); return "created" as const; }) },
    );
    await subject.afterPersistedRejection("message-1");
    expect(events).toEqual(["credit", "reachability", "notice"]);
  });

  it("does not notify when suppression fails and may retry an already-corrected notice", async () => {
    const notification = { notify: vi.fn().mockRejectedValueOnce(new Error("support offline"))
      .mockResolvedValue("created") };
    const correction = { reconcileMessage: vi.fn().mockResolvedValue("already-released") };
    const reachability = { afterCorrection: vi.fn().mockResolvedValue("unchanged") };
    const subject = new SynchronousRecipientFailureService(
      { record: vi.fn() }, correction, reachability, notification,
    );
    await expect(subject.afterPersistedRejection("message-1")).rejects.toThrow("support offline");
    await expect(subject.afterPersistedRejection("message-1")).resolves.toBeUndefined();
    expect(correction.reconcileMessage).toHaveBeenCalledTimes(2);
    expect(notification.notify).toHaveBeenCalledTimes(2);
    reachability.afterCorrection.mockRejectedValueOnce(new Error("suppression offline"));
    await expect(subject.afterPersistedRejection("message-2")).rejects.toThrow("suppression offline");
    expect(notification.notify).toHaveBeenCalledTimes(2);
  });

});
