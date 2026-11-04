import { describe, expect, it } from "vitest";
import {
  assertNoInitialMessageEvidence,
  readInitialAttempt,
  validateInitialMessageIdentity,
} from "../../../../src/services/recovery-billing/initial-outreach-credit-evidence.js";
import {
  attemptEvidence,
  input,
  transactionForAttempt,
} from "./initial-outreach-credit.test-support.js";

describe("initial outreach credit evidence", () => {
  it("accepts only the stored sequence-one INITIAL identity for the supplied Shop and recovery", async () => {
    const tx = transactionForAttempt();
    await expect(readInitialAttempt(tx as never, input)).resolves.toMatchObject({
      id: input.outreachAttemptId,
      checkoutRecoveryId: input.recoveryId,
      sequence: 1,
      trigger: "INITIAL",
      checkoutRecovery: { shopId: input.shopId },
    });
  });

  it("rejects contradictory Shop identity rather than inferring a replacement", async () => {
    const tx = transactionForAttempt({
      recoveryOutreachAttempt: {
        findUnique: async () => ({
          ...attemptEvidence(),
          checkoutRecovery: { ...attemptEvidence().checkoutRecovery, shopId: "another-shop" },
        }),
      },
    });
    await expect(readInitialAttempt(tx as never, input)).rejects.toThrow("lineage");
  });

  it("rejects a linked automated message on a different conversation of the same recovery", async () => {
    const tx = transactionForAttempt({
      merchantConversationSendCommand: { findFirst: async () => null },
      recoveryOutreachAttempt: { findUnique: async () => null },
      usageEvent: {
        findMany: async () => [],
        findUnique: async () => null,
      },
    });
    const attempt = { ...attemptEvidence(), outboundMessageId: "message-1" };
    const message = {
      id: "message-1",
      conversationId: "other-conversation",
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      recoveryOutreachAttempt: { id: attempt.id },
      merchantSendCommand: null,
      conversation: {
        id: "other-conversation",
        shopId: input.shopId,
        checkoutRecovery: { id: input.recoveryId, shopId: input.shopId },
      },
    };

    await expect(validateInitialMessageIdentity(
      tx as never,
      input,
      attempt,
      message as never,
      false,
    )).rejects.toThrow("lineage");
  });

  it("requires a null-message attempt to have no sent, failure, link, message or usage evidence", async () => {
    const tx = transactionForAttempt({
      conversationMessage: { findUnique: async () => null, findFirst: async () => null },
      usageEvent: { findUnique: async () => null, findMany: async () => [] },
    });
    await expect(assertNoInitialMessageEvidence(tx as never, {
      ...input,
      outboundMessageId: null,
    }, attemptEvidence())).resolves.toBeUndefined();

    const sentAttempt = { ...attemptEvidence(), sentAt: new Date() };
    await expect(assertNoInitialMessageEvidence(tx as never, {
      ...input,
      outboundMessageId: null,
    }, sentAttempt)).rejects.toThrow("lineage");
  });
});
