import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

// Compile only the two dependency-free domain modules, outside the repository.
// No database URL, Redis, provider credentials or installed Prisma are needed.
const directory = mkdtempSync(join(tmpdir(), "moda-retry-funding-"));
const domain = fileURLToPath(new URL("../src/domain/", import.meta.url));
try {
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  execFileSync("tsc", ["--strict", "--noUncheckedIndexedAccess", "--exactOptionalPropertyTypes",
    "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--outDir", directory, join(domain, "recovery-outreach-identity.ts"),
    join(domain, "recovery-retry-funding-lineage.ts")], { cwd: directory, stdio: "inherit" });
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}
after(() => rmSync(directory, { recursive: true, force: true }));
const { retryFundingLineage } = await import(pathToFileURL(join(directory, "recovery-retry-funding-lineage.js")).href);
const { selectEffectiveOutreachAttempt } = await import(pathToFileURL(join(directory, "recovery-outreach-identity.js")).href);
const now = new Date("2026-11-26T01:00:00Z");
function failed(id, sequence, intentId, trigger = "INITIAL") {
  return {
    id, checkoutRecoveryId: "recovery", sequence, trigger, recipient: "447700900001",
    initiatedBy: "AUTOMATION", status: "FAILED", sentAt: now, customerRespondedAt: null,
    outboundMessageId: `message-${id}`,
    outboundMessage: { id: `message-${id}`, conversationId: "conversation", direction: "OUTBOUND",
      senderType: "AUTOMATION", status: "FAILED", providerMessageId: `wamid-${id}`,
      sentAt: now, failedAt: now, deliveredAt: null, readAt: null },
    deliveryRetryIntent: { id: intentId, failedAttemptId: id, failedMessageId: `message-${id}`,
      fundingReservationId: `reservation-${id}`, cancelledAt: null },
  };
}
function successor(id, sequence, trigger = "INITIAL") {
  return { ...failed(id, sequence, "unused", trigger), status: "PENDING", sentAt: null,
    outboundMessage: null, outboundMessageId: null, deliveryRetryIntent: null };
}
function chain() {
  return [failed("original", 1, "first"), failed("retry_first", 3, "second"), successor("retry_second", 4)];
}
const lineage = (attempts, attemptId = "retry_second") => retryFundingLineage({
  recoveryId: "recovery", conversationId: "conversation", attempts, attemptId,
});
const current = attempts => selectEffectiveOutreachAttempt({
  recoveryId: "recovery", conversationId: "conversation", slot: "INITIAL", attempts,
});

test("each physical attempt has a distinct predecessor reservation", () => {
  const attempts = chain();
  assert.deepEqual(lineage(attempts)?.map(link => link.intent.fundingReservationId),
    ["reservation-original", "reservation-retry_first"]);
  assert.equal(current(attempts).kind, "selected");
});
test("cancelled intent or late positive receipt blocks new funding but preserves historical lineage", () => {
  const attempts = chain();
  attempts[0].deliveryRetryIntent.cancelledAt = now;
  attempts[0].outboundMessage.status = "DELIVERED";
  attempts[0].outboundMessage.deliveredAt = now;
  assert.equal(lineage(attempts)?.length, 2);
  assert.equal(current(attempts).kind, "conflict");
});
test("rejects missing predecessor or wrong successor identity", () => {
  assert.equal(lineage(chain().slice(1)), null);
  const attempts = chain();
  attempts[2].id = "retry_wrong";
  assert.equal(lineage(attempts, "retry_wrong"), null);
});
test("rejects duplicate or reversed physical sequences", () => {
  const attempts = chain();
  attempts[2].sequence = 3;
  assert.equal(lineage(attempts), null);
  attempts[2].sequence = 2;
  assert.equal(lineage(attempts), null);
});
test("rejects cross-recovery, cross-conversation and changed-recipient evidence", () => {
  for (const change of [a => { a[1].checkoutRecoveryId = "other"; },
    a => { a[1].outboundMessage.conversationId = "other"; },
    a => { a[2].recipient = "other"; }]) {
    const attempts = chain(); change(attempts);
    assert.equal(lineage(attempts), null);
  }
});
test("requires persisted failure and exact message and funding references", () => {
  for (const change of [a => { a[1].outboundMessage.failedAt = null; },
    a => { a[1].outboundMessage.providerMessageId = null; },
    a => { a[1].deliveryRetryIntent.failedMessageId = "other"; },
    a => { a[1].deliveryRetryIntent.fundingReservationId = ""; }]) {
    const attempts = chain(); change(attempts);
    assert.equal(lineage(attempts), null);
  }
});
test("human sends and trigger changes cannot become automated retry lineage", () => {
  const attempts = chain();
  attempts[1].initiatedBy = "HUMAN";
  assert.equal(lineage(attempts), null);
  attempts[1].initiatedBy = "AUTOMATION";
  attempts[2].trigger = "NO_RESPONSE_FOLLOW_UP";
  assert.equal(lineage(attempts), null);
});
test("supports historical automated follow-up funding without admitting a follow-up", () => {
  const attempts = [failed("follow-up", 2, "follow", "NO_RESPONSE_FOLLOW_UP"),
    successor("retry_follow", 5, "NO_RESPONSE_FOLLOW_UP")];
  assert.equal(lineage(attempts, "retry_follow")?.[0].predecessor.id, "follow-up");
  assert.equal(lineage(attempts, "follow-up"), null);
});
