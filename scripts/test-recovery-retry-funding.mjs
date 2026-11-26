import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

// Compile only the dependency-free domain modules, outside the repository.
// No database URL, Redis, provider credentials or installed Prisma are needed.
const directory = mkdtempSync(join(tmpdir(), "moda-retry-funding-"));
const domain = fileURLToPath(new URL("../src/domain/", import.meta.url));
try {
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  // Prefer the repository dependency, even when node was invoked directly.
  const localCompiler = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));
  execFileSync(existsSync(localCompiler) ? localCompiler : "tsc", ["--strict", "--noUncheckedIndexedAccess", "--exactOptionalPropertyTypes",
    "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--outDir", directory, join(domain, "recovery-outreach-identity.ts"),
    join(domain, "recovery-retry-funding-lineage.ts"), join(domain, "recovery-retry-claim.ts")], { cwd: directory, stdio: "inherit" });
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}
after(() => rmSync(directory, { recursive: true, force: true }));
const { retryFundingLineage } = await import(pathToFileURL(join(directory, "recovery-retry-funding-lineage.js")).href);
const { selectEffectiveOutreachAttempt } = await import(pathToFileURL(join(directory, "recovery-outreach-identity.js")).href);
const { planInitialRetryClaim } = await import(pathToFileURL(join(directory, "recovery-retry-claim.js")).href);
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

const claimPlan = (attempts, intentId = "first") => planInitialRetryClaim({
  recoveryId: "recovery", conversationId: "conversation", attempts, intentId,
});
test("plans the first claim without mutating historical rows", () => {
  const attempts = [failed("original", 1, "first")];
  const before = structuredClone(attempts);
  const plan = claimPlan(attempts);
  assert.equal(plan.kind, "new");
  assert.equal(plan.attemptId, "retry_first");
  assert.equal(plan.sequence, 3);
  assert.equal(plan.links[0].intent.fundingReservationId, "reservation-original");
  assert.deepEqual(attempts, before);
});
test("replays the exact pending claim and advances only from the latest failed predecessor", () => {
  const first = failed("original", 1, "first");
  const replay = claimPlan([first, successor("retry_first", 3)]);
  assert.equal(replay.kind, "existing");
  assert.equal(replay.sequence, 3);
  const history = [first, failed("retry_first", 3, "second")];
  assert.equal(claimPlan(history).kind, "held");
  const next = claimPlan(history, "second");
  assert.equal(next.kind, "new");
  assert.equal(next.sequence, 4);
  assert.equal(next.links.length, 2);
});
test("holds cancelled, replied-to, late delivered, and non-automated predecessors", () => {
  for (const mutate of [a => { a.deliveryRetryIntent.cancelledAt = now; },
    a => { a.customerRespondedAt = now; }, a => { a.outboundMessage.deliveredAt = now; },
    a => { a.outboundMessage.senderType = "HUMAN"; }, a => { a.outboundMessage.sentAt = null; }]) {
    const original = failed("original", 1, "first");
    mutate(original);
    assert.equal(claimPlan([original]).kind, "held");
  }
});
test("holds an initial retry if the normal follow-up slot exists", () => {
  const original = failed("original", 1, "first");
  const follow = successor("follow", 2, "NO_RESPONSE_FOLLOW_UP");
  assert.deepEqual(claimPlan([original, follow]), { kind: "held", reason: "follow-up-present" });
});
test("never treats an accepted or failed successor as a fresh claim", () => {
  const original = failed("original", 1, "first");
  const admitted = successor("retry_first", 3);
  admitted.status = "WAITING_FOR_RESPONSE";
  assert.deepEqual(claimPlan([original, admitted]), { kind: "held", reason: "already-progressed" });
  assert.equal(claimPlan([original, failed("retry_first", 3, "second")]).kind, "held");
});
test("holds orphan successors, duplicate slots, wrong intent IDs and invalid ownership", () => {
  const original = failed("original", 1, "first");
  assert.equal(claimPlan([original, successor("retry_other", 3)]).kind, "held");
  assert.equal(claimPlan([original, successor("retry_first", 1)]).kind, "held");
  assert.equal(claimPlan([original], "unknown").kind, "held");
  assert.equal(claimPlan([original], "bad:id").kind, "held");
  const other = successor("retry_first", 3);
  other.recipient = "different";
  assert.equal(claimPlan([original, other]).kind, "held");
});
