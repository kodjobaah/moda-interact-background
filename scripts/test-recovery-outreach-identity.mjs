import assert from "node:assert/strict";
import test from "node:test";
import {
  originalOutreachTrigger,
  outreachSlot,
  retryOutreachAttemptId,
  nextRetryOutreachSequence,
  isInitialRetryId,
  selectEffectiveOutreachAttempt,
  hasConfirmedOutreachDelivery,
  isInitialOutreachIdentity,
  initialOutreachRecoveryStateAllowed,
} from "../src/domain/recovery-outreach-identity.ts";

const sentAt = new Date("2026-11-26T02:40:54Z");
const later = new Date("2026-11-27T02:40:54Z");
function attempt(id, sequence, trigger = "INITIAL", overrides = {}) {
  return {
    id,
    sequence,
    trigger,
    checkoutRecoveryId: "recovery",
    recipient: "15551234567",
    initiatedBy: "AUTOMATION",
    status: "WAITING_FOR_RESPONSE",
    sentAt,
    customerRespondedAt: null,
    outboundMessageId: `message-${id}`,
    deliveryRetryIntent: null,
    outboundMessage: {
      id: `message-${id}`,
      conversationId: "conversation",
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      status: "DELIVERED",
      providerMessageId: `wamid-${id}`,
      sentAt,
      deliveredAt: later,
      readAt: null,
      failedAt: null,
    },
    ...overrides,
  };
}
function failed(row, intentId) {
  return {
    ...row,
    status: "FAILED",
    outboundMessage: {
      ...row.outboundMessage,
      status: "FAILED",
      deliveredAt: null,
      readAt: null,
      failedAt: sentAt,
    },
    deliveryRetryIntent: {
      id: intentId,
      failedAttemptId: row.id,
      failedMessageId: row.outboundMessageId,
      cancelledAt: null,
    },
  };
}
const initial = attempt("initial", 1);
const initialFailed = failed(initial, "intent-a");
const firstRetry = attempt(retryOutreachAttemptId("intent-a"), 3);
const firstRetryFailed = failed(firstRetry, "intent-b");
const secondRetry = attempt(retryOutreachAttemptId("intent-b"), 4);
const followUp = attempt("follow-up", 2, "NO_RESPONSE_FOLLOW_UP");
const select = (attempts, slot = "INITIAL") =>
  selectEffectiveOutreachAttempt({
    recoveryId: "recovery",
    conversationId: "conversation",
    attempts,
    slot,
  });
function selected(rows, slot = "INITIAL") {
  const result = select(rows, slot);
  assert.equal(result.kind, "selected");
  return result;
}

test("preserves original sequence and distinguishes all three business triggers", () => {
  assert.equal(originalOutreachTrigger(1), "INITIAL");
  assert.equal(originalOutreachTrigger(2), "NO_RESPONSE_FOLLOW_UP");
  assert.throws(() => originalOutreachTrigger(3));
  assert.equal(outreachSlot("POST_WINDOW_FOLLOW_UP"), "FOLLOW_UP");
  assert.equal(outreachSlot("NO_RESPONSE_FOLLOW_UP"), "FOLLOW_UP");
  assert.equal(outreachSlot("UNKNOWN"), null);
});
test("stable retry identity and physical sequence allocation reserve original slots", () => {
  assert.equal(
    retryOutreachAttemptId("cmwwy40760145ku16k6l4jfp2"),
    "retry_cmwwy40760145ku16k6l4jfp2",
  );
  assert.equal(nextRetryOutreachSequence([]), 3);
  assert.equal(nextRetryOutreachSequence([initial]), 3);
  assert.equal(nextRetryOutreachSequence([secondRetry, initial, followUp]), 5);
  for (const invalid of ["", "contains:colon", " a", "a".repeat(101)])
    assert.throws(() => retryOutreachAttemptId(invalid));
  for (const rows of [
    [initial, initial],
    [{ sequence: 0 }],
    [{ sequence: 1.5 }],
    [{ sequence: 2_147_483_647 }],
  ]) {
    assert.throws(() => nextRetryOutreachSequence(rows));
  }
});
test("retry identity recognition does not grant authority to malformed IDs", () => {
  assert.equal(isInitialRetryId(retryOutreachAttemptId("intent-a")), true);
  for (const id of [
    "",
    "retry_",
    "initial",
    "retry_:",
    "retry_" + "a".repeat(101),
    "retry_a b",
  ])
    assert.equal(isInitialRetryId(id), false);
});
test("selects ordinary initial and follow-up independently", () => {
  assert.equal(selected([followUp, initial]).current.id, initial.id);
  assert.equal(
    selected([initial, followUp], "FOLLOW_UP").current.id,
    followUp.id,
  );
  assert.equal(select([], "INITIAL").kind, "missing");
});
test("an inert intent is not a physical retry", () => {
  const result = selected([initialFailed]);
  assert.equal(result.retryCount, 0);
  assert.equal(result.current.id, initial.id);
  assert.equal(
    hasConfirmedOutreachDelivery(result.current, "conversation"),
    false,
  );
});
test("walks exact persisted intent lineage, independent of row order and follow-up sequence", () => {
  const result = selected([
    secondRetry,
    followUp,
    firstRetryFailed,
    initialFailed,
  ]);
  assert.equal(result.current.id, secondRetry.id);
  assert.equal(result.retryCount, 2);
  assert.deepEqual(
    result.chain.map((row) => row.sequence),
    [1, 3, 4],
  );
  assert.equal(
    hasConfirmedOutreachDelivery(result.current, "conversation"),
    true,
  );
  assert.equal(
    selected(
      [secondRetry, followUp, firstRetryFailed, initialFailed],
      "FOLLOW_UP",
    ).current.id,
    followUp.id,
  );
});
test("a follow-up retry keeps its original post-window trigger and independent initial slot", () => {
  const original = failed(
    attempt("post-window", 2, "POST_WINDOW_FOLLOW_UP"),
    "intent-post",
  );
  const retry = attempt(
    retryOutreachAttemptId("intent-post"),
    3,
    "POST_WINDOW_FOLLOW_UP",
  );
  assert.equal(
    selected([initial, original, retry], "FOLLOW_UP").current.id,
    retry.id,
  );
  assert.equal(selected([initial, original, retry]).current.id, initial.id);
});
test("holds a pending or merely accepted retry rather than choosing an older attempt", () => {
  const pending = {
    ...firstRetry,
    status: "PENDING",
    sentAt: null,
    outboundMessageId: null,
    outboundMessage: null,
  };
  assert.equal(selected([initialFailed, pending]).current.id, pending.id);
  assert.equal(hasConfirmedOutreachDelivery(pending, "conversation"), false);
  const accepted = {
    ...firstRetry,
    outboundMessage: {
      ...firstRetry.outboundMessage,
      status: "SENT",
      deliveredAt: null,
    },
  };
  assert.equal(
    hasConfirmedOutreachDelivery(
      selected([initialFailed, accepted]).current,
      "conversation",
    ),
    false,
  );
});
test("late positive receipt or cancellation holds automatic decisions", () => {
  for (const parent of [
    {
      ...initialFailed,
      deliveryRetryIntent: {
        ...initialFailed.deliveryRetryIntent,
        cancelledAt: later,
      },
    },
    {
      ...initialFailed,
      outboundMessage: {
        ...initialFailed.outboundMessage,
        status: "DELIVERED",
        deliveredAt: later,
      },
    },
    {
      ...initialFailed,
      outboundMessage: { ...initialFailed.outboundMessage, readAt: later },
    },
  ])
    assert.equal(select([parent, firstRetry]).kind, "conflict");
});
test("rejects orphan and conflicting identities without guessing from highest sequence", () => {
  for (const rows of [
    [firstRetry],
    [initialFailed, secondRetry],
    [initialFailed, firstRetry, secondRetry],
    [initialFailed, { ...firstRetry, id: "unrelated" }],
    [initialFailed, { ...firstRetry, sequence: 1 }],
    [initialFailed, { ...firstRetry, checkoutRecoveryId: "other-recovery" }],
    [initialFailed, { ...firstRetry, trigger: "NO_RESPONSE_FOLLOW_UP" }],
    [initialFailed, { ...firstRetry, recipient: "different" }],
    [initialFailed, { ...firstRetry, initiatedBy: "HUMAN" }],
    [
      initialFailed,
      {
        ...firstRetry,
        outboundMessage: {
          ...firstRetry.outboundMessage,
          conversationId: "other",
        },
      },
    ],
    [
      initialFailed,
      {
        ...firstRetry,
        outboundMessage: { ...firstRetry.outboundMessage, senderType: "HUMAN" },
      },
    ],
  ])
    assert.equal(select(rows).kind, "conflict");
});
test("requires a definitive automated failed predecessor with exact attempt and message IDs", () => {
  for (const parent of [
    { ...initialFailed, status: "ENGAGED" },
    { ...initialFailed, customerRespondedAt: later },
    { ...initialFailed, initiatedBy: "HUMAN" },
    {
      ...initialFailed,
      outboundMessage: {
        ...initialFailed.outboundMessage,
        senderType: "HUMAN",
      },
    },
    {
      ...initialFailed,
      outboundMessage: { ...initialFailed.outboundMessage, failedAt: null },
    },
    {
      ...initialFailed,
      outboundMessage: {
        ...initialFailed.outboundMessage,
        providerMessageId: null,
      },
    },
    {
      ...initialFailed,
      deliveryRetryIntent: {
        ...initialFailed.deliveryRetryIntent,
        failedAttemptId: "other",
      },
    },
    {
      ...initialFailed,
      deliveryRetryIntent: {
        ...initialFailed.deliveryRetryIntent,
        failedMessageId: "other",
      },
    },
  ])
    assert.equal(select([parent, firstRetry]).kind, "conflict");
});
test("READ is positive evidence even when historical failure time remains", () => {
  const read = {
    ...firstRetry,
    outboundMessage: {
      ...firstRetry.outboundMessage,
      status: "READ",
      deliveredAt: null,
      readAt: later,
      failedAt: sentAt,
    },
  };
  assert.equal(hasConfirmedOutreachDelivery(read, "conversation"), true);
  assert.equal(hasConfirmedOutreachDelivery(read, "wrong-conversation"), false);
  assert.equal(
    hasConfirmedOutreachDelivery(
      { ...read, outboundMessageId: "wrong" },
      "conversation",
    ),
    false,
  );
});

test("initial preparation distinguishes a physical retry from original and follow-up slots", () => {
  assert.equal(isInitialOutreachIdentity(initial), true);
  assert.equal(isInitialOutreachIdentity(firstRetry), true);
  assert.equal(
    isInitialOutreachIdentity({ ...firstRetry, sequence: 1 }),
    false,
  );
  assert.equal(
    isInitialOutreachIdentity({
      ...firstRetry,
      trigger: "NO_RESPONSE_FOLLOW_UP",
    }),
    false,
  );
  assert.equal(
    isInitialOutreachIdentity({ ...firstRetry, id: "unrelated" }),
    false,
  );
  assert.equal(
    initialOutreachRecoveryStateAllowed(initial.id, "MESSAGE_SENT"),
    false,
  );
  assert.equal(
    initialOutreachRecoveryStateAllowed(firstRetry.id, "MESSAGE_SENT"),
    true,
  );
  for (const status of ["ENGAGED", "COMPLETED", "CANCELLED", "EXPIRED"])
    assert.equal(
      initialOutreachRecoveryStateAllowed(firstRetry.id, status),
      false,
    );
});
