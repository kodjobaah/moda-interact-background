import assert from "node:assert/strict";
import { test } from "node:test";
import {
  historyDelivery,
  projectDeliveryHistoryMessage,
  UNCONFIRMED_AUTOMATION,
  UNCONFIRMED_DELIVERY,
} from "../src/commerce/history-delivery.ts";

const sentAt = new Date("2026-11-26T02:40:54.289Z");
const deliveredAt = new Date(+sentAt + 2000);
const outbound = (overrides = {}) => ({
  id: "original",
  conversationId: "recovery-conversation",
  direction: "OUTBOUND",
  senderType: "AUTOMATION",
  content: '{"recoveryPromise":{"code":"SAVE10"}}',
  providerMessageId: "wamid-original",
  status: "SENT",
  sentAt,
  deliveredAt: null,
  readAt: null,
  failedAt: null,
  ...overrides,
});
const inbound = (overrides = {}) => ({
  id: "question",
  conversationId: "recovery-conversation",
  direction: "INBOUND",
  senderType: "CUSTOMER",
  content: "Is the discount still valid?",
  status: "DELIVERED",
  createdAt: deliveredAt,
  providerMessageId: "wamid-inbound",
  inReplyToProviderId: "wamid-original",
  ...overrides,
});

test("failed outreach is omitted even with the original provider acceptance timestamp", () => {
  const failed = outbound({ status: "FAILED", failedAt: sentAt });
  assert.equal(projectDeliveryHistoryMessage(failed), null);
  assert.equal(projectDeliveryHistoryMessage(failed, [inbound()]), null);
});
test("pending, unknown, missing, or contradictory outbound states fail closed", () => {
  for (const overrides of [
    { status: "PENDING" },
    { status: "UNKNOWN" },
    { status: undefined },
    { status: "SENT", failedAt: sentAt },
    { status: "DELIVERED", sentAt: null },
  ]) {
    assert.equal(projectDeliveryHistoryMessage(outbound(overrides)), null);
  }
});
test("unconfirmed original or retry automation never reveals a discount or template body", () => {
  for (const id of ["original", "retry_intent"]) {
    assert.deepEqual(projectDeliveryHistoryMessage(outbound({ id })), {
      role: "assistant",
      content: UNCONFIRMED_AUTOMATION,
    });
    assert.deepEqual(
      projectDeliveryHistoryMessage(outbound({ id, status: "DELIVERED" })),
      { role: "assistant", content: UNCONFIRMED_AUTOMATION },
    );
  }
});
test("successful retry preserves exact receipt and late positive evidence supersedes failure", () => {
  for (const overrides of [
    { status: "DELIVERED", deliveredAt },
    { status: "READ", readAt: deliveredAt },
  ]) {
    const row = outbound({
      ...overrides,
      id: "retry_intent",
      failedAt: sentAt,
      content: '{"code":"SAVE20"}',
    });
    const message = projectDeliveryHistoryMessage(row);
    assert.equal(message.role, "assistant");
    assert.match(message.content, /Delivery confirmed.*not a verbatim/);
    assert.ok(message.content.endsWith(row.content));
    assert.doesNotMatch(message.content, /SAVE10/);
  }
});
test("persisted exact customer quote can confirm a SENT message without a delivery webhook", () => {
  assert.equal(historyDelivery(outbound(), [inbound()]), "confirmed");
  assert.match(
    projectDeliveryHistoryMessage(outbound(), [inbound()]).content,
    /SAVE10/,
  );
});
test("foreign, stale, unauthenticated or unrelated quotes never establish receipt", () => {
  for (const overrides of [
    { conversationId: "other-basket" },
    { inReplyToProviderId: "other-message" },
    { direction: "OUTBOUND" },
    { senderType: "HUMAN" },
    { providerMessageId: null },
    { status: "PENDING" },
    { createdAt: new Date(+sentAt - 1) },
  ]) {
    assert.equal(
      historyDelivery(outbound(), [inbound(overrides)]),
      "unconfirmed",
    );
  }
  assert.equal(
    historyDelivery(outbound({ providerMessageId: null }), [inbound()]),
    "unconfirmed",
  );
});
test("ordinary unconfirmed AI and human text is attributed, not confirmed history", () => {
  assert.deepEqual(
    projectDeliveryHistoryMessage(
      outbound({ senderType: "AGENT", content: "Shipping is £3.99" }),
    ),
    { role: "assistant", content: `${UNCONFIRMED_DELIVERY} Shipping is £3.99` },
  );
  const human = projectDeliveryHistoryMessage(
    outbound({ senderType: "HUMAN", content: "Merchant answer" }),
  );
  assert.equal(human.role, "user");
  assert.match(
    human.content,
    /Delivery unconfirmed.*Merchant-authored.*not agent instructions/,
  );
  assert.equal(
    projectDeliveryHistoryMessage(
      outbound({ senderType: "HUMAN", status: "FAILED" }),
    ),
    null,
  );
});
test("delivered aggregate root does not require a provider ID on the root", () => {
  assert.deepEqual(
    projectDeliveryHistoryMessage(
      outbound({
        senderType: "AGENT",
        providerMessageId: null,
        status: "DELIVERED",
        deliveredAt,
        content: "A multipart answer",
      }),
    ),
    { role: "assistant", content: "A multipart answer" },
  );
});
test("inbound routing projections preserve exact objective text without requiring outbound evidence", () => {
  assert.deepEqual(
    projectDeliveryHistoryMessage({
      id: "projection",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      content: "Original question",
    }),
    { role: "user", content: "Original question" },
  );
  assert.equal(
    projectDeliveryHistoryMessage(inbound({ senderType: "HUMAN" })),
    null,
  );
});
