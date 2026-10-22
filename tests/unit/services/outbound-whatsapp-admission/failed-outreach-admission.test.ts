import { describe, expect, it, vi } from "vitest";
import { failedRecipientOutreach } from "../../../../src/services/outbound-whatsapp-admission/failed-outreach-admission.js";

const attempt = {
  checkoutRecovery: { shopId: "shop-1" },
  outboundMessage: { id: "m-1", conversationId: "conversation-1", status: "FAILED",
    sentAt: null, providerFailureCode: "131026" },
};

describe("ARCH-028-BACKGROUND-006 recovery retry fence", () => {
  it("finds a failed admission from immutable attempt when hard-limit usage was removed", async () => {
    const database = { recoveryOutreachAttempt: { findUnique: vi.fn(async () => attempt) } };
    expect(await failedRecipientOutreach(database as never, "recovery-outreach:attempt-1"))
      .toMatchObject({ shopId: "shop-1", message: { id: "m-1", status: "FAILED" } });
    expect(database.recoveryOutreachAttempt.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "attempt-1" },
    }));
  });

  it.each(["general-send", "recovery-outreach:", "recovery-outreach:A!B"])(
    "does not consult recovery attempts for unrelated identity %s", async (key) => {
      const findUnique = vi.fn();
      expect(await failedRecipientOutreach({ recoveryOutreachAttempt: { findUnique } } as never, key))
        .toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it("returns null when the recovery attempt does not exist", async () => {
    const findUnique = vi.fn(async () => null);
    expect(await failedRecipientOutreach(
      { recoveryOutreachAttempt: { findUnique } } as never,
      "recovery-outreach:missing-attempt",
    )).toBeNull();
    expect(findUnique).toHaveBeenCalledOnce();
  });

  it("only fences a failed exact 131026 message, never a pending or unrelated failure", async () => {
    const database = { recoveryOutreachAttempt: { findUnique: vi.fn() } };
    for (const [status, providerFailureCode] of [["PENDING", "131026"], ["FAILED", "131027"]]) {
      database.recoveryOutreachAttempt.findUnique.mockResolvedValueOnce({
        ...attempt, outboundMessage: { ...attempt.outboundMessage, status, providerFailureCode },
      });
      expect(await failedRecipientOutreach(database as never, "recovery-outreach:attempt-1")).toBeNull();
    }
  });
});
