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
    join(domain, "recovery-retry-funding-lineage.ts"), join(domain, "recovery-retry-claim.ts"),
    join(domain, "recovery-follow-up-retry-allowance.ts"), join(domain, "recovery-follow-up-retry-outcome.ts")], { cwd: directory, stdio: "inherit" });
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}
after(() => rmSync(directory, { recursive: true, force: true }));
const { retryFundingLineage } = await import(pathToFileURL(join(directory, "recovery-retry-funding-lineage.js")).href);
const { selectEffectiveOutreachAttempt } = await import(pathToFileURL(join(directory, "recovery-outreach-identity.js")).href);
const { planInitialRetryClaim, planScheduledFollowUpRetryClaim } = await import(pathToFileURL(join(directory, "recovery-retry-claim.js")).href);
const { proveFollowUpRetryAllowance, proveFundedFollowUpRetryAllowance, followUpRetryBlockId, isFollowUpRetryBlock, followUpRetryAttemptId } = await import(pathToFileURL(join(directory, "recovery-follow-up-retry-allowance.js")).href);
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

const followTrigger = "NO_RESPONSE_FOLLOW_UP";
function initialAccepted(id = "initial", sequence = 1, delivered = false) {
  const original = failed(id, sequence, "unused");
  original.status = "NO_RESPONSE";
  original.deliveryRetryIntent = null;
  original.outboundMessage.status = delivered ? "DELIVERED" : "SENT";
  original.outboundMessage.failedAt = null;
  original.outboundMessage.deliveredAt = delivered ? now : null;
  return original;
}
const followFailed = (id = "follow", sequence = 2, intent = "follow_intent") => failed(id, sequence, intent, followTrigger);
const followPlan = (attempts, intentId = "follow_intent") => planScheduledFollowUpRetryClaim({
  recoveryId: "recovery", conversationId: "conversation", attempts, intentId,
});
function allowance(id, ordinal, reservation, message) {
  return { id, ordinal, shopId: "shop", conversationId: "conversation", creditReservationId: reservation,
    fundingKind: ordinal === 0 ? "INITIAL" : "FOLLOW_UP", state: ordinal === 0 ? "CLOSED" : "CANCELLED",
    predecessorId: ordinal === 0 ? null : "initial-block", repairAt: null, repairLeaseToken: null,
    repairLeaseUntil: null, outboundMessageIds: [message] };
}
function allowanceFixture(repeated = false) {
  const attempts = [initialAccepted(), followFailed()];
  const blocks = [allowance("initial-block", 0, "reservation-initial", "message-initial"),
    allowance("failed-block", 1, "reservation-follow", "message-follow")];
  if (repeated) {
    attempts.push(followFailed("retry_follow_intent", 3, "second_follow"));
    blocks.push(allowance("second-failed-block", 2, "reservation-retry_follow_intent", "message-retry_follow_intent"));
  }
  const plan = followPlan(attempts, repeated ? "second_follow" : "follow_intent");
  assert.equal(plan.kind, "new");
  return { shopId: "shop", conversationId: "conversation", initialReservationId: "reservation-initial", links: plan.links, blocks };
}

test("scheduled follow-up retry preserves sequence two and derives a distinct physical claim", () => {
  const attempts = [initialAccepted(), followFailed()];
  const before = structuredClone(attempts);
  const plan = followPlan(attempts);
  assert.equal(plan.kind, "new");
  assert.equal(plan.attemptId, "retry_follow_intent");
  assert.equal(plan.sequence, 3);
  assert.equal(plan.initialAttemptId, "initial");
  assert.deepEqual(plan.links.map(link => link.predecessor.id), ["follow"]);
  assert.deepEqual(attempts, before);
});
test("scheduled follow-up retry replays only the exact clean pending claim", () => {
  const pending = successor("retry_follow_intent", 3, followTrigger);
  const attempts = [initialAccepted(), followFailed(), pending];
  const plan = followPlan(attempts);
  assert.equal(plan.kind, "existing");
  assert.equal(plan.attemptId, pending.id);
  assert.equal(plan.sequence, 3);
  pending.status = "WAITING_FOR_RESPONSE";
  assert.equal(followPlan(attempts).kind, "held");
});
test("a retry of the follow-up uses the latest failed follow-up rather than the initial slot", () => {
  const attempts = [initialAccepted(), followFailed(), followFailed("retry_follow_intent", 3, "second_follow")];
  assert.equal(followPlan(attempts).kind, "held");
  const plan = followPlan(attempts, "second_follow");
  assert.equal(plan.kind, "new");
  assert.equal(plan.sequence, 4);
  assert.deepEqual(plan.links.map(link => link.intent.fundingReservationId), ["reservation-follow", "reservation-retry_follow_intent"]);
});
test("an initial retry must be positively delivered before a follow-up retry can be planned", () => {
  const attempts = [failed("original", 1, "initial_intent"), followFailed(), initialAccepted("retry_initial_intent", 3)];
  assert.equal(followPlan(attempts).kind, "held");
  attempts[2] = initialAccepted("retry_initial_intent", 3, true);
  const plan = followPlan(attempts);
  assert.equal(plan.kind, "new");
  assert.equal(plan.sequence, 4);
  assert.equal(plan.initialAttemptId, "retry_initial_intent");
});
test("holds initial delivery conflicts and unproven initial identity", () => {
  for (const mutate of [a => { a.status = "FAILED"; }, a => { a.customerRespondedAt = now; },
    a => { a.outboundMessage.providerMessageId = null; }, a => { a.outboundMessage.failedAt = now; },
    a => { a.outboundMessage.conversationId = "foreign"; }, a => { a.outboundMessage.sentAt = new Date(0); }]) {
    const initial = initialAccepted(); mutate(initial);
    assert.equal(followPlan([initial, followFailed()]).kind, "held");
  }
});
test("holds merchant initiated, non-automation and mismatched recipient follow-ups", () => {
  for (const mutate of [a => { a.trigger = "POST_WINDOW_FOLLOW_UP"; }, a => { a.initiatedBy = "HUMAN"; },
    a => { a.initiatedBy = "AGENT"; }, a => { a.initiatedBy = null; }, a => { a.recipient = "other"; }]) {
    const follow = followFailed(); mutate(follow);
    assert.equal(followPlan([initialAccepted(), follow]).kind, "held");
  }
});
test("holds cancelled, answered, late positive and unconfirmed failed follow-ups", () => {
  for (const mutate of [a => { a.deliveryRetryIntent.cancelledAt = now; }, a => { a.customerRespondedAt = now; },
    a => { a.outboundMessage.deliveredAt = now; }, a => { a.outboundMessage.readAt = now; },
    a => { a.outboundMessage.senderType = "HUMAN"; }, a => { a.outboundMessage.providerMessageId = null; },
    a => { a.sentAt = null; }, a => { a.outboundMessage.sentAt = new Date(0); }]) {
    const follow = followFailed(); mutate(follow);
    assert.equal(followPlan([initialAccepted(), follow]).kind, "held");
  }
});
test("rejects orphan and cross-slot follow-up retry identities", () => {
  assert.equal(followPlan([initialAccepted(), followFailed(), successor("retry_wrong", 3, followTrigger)]).kind, "held");
  assert.equal(followPlan([initialAccepted(), followFailed(), successor("retry_follow_intent", 3)]).kind, "held");
  assert.equal(followPlan([initialAccepted(), followFailed()], "foreign").kind, "held");
});
test("proves the exact cancelled follow-up allowance without mutating its predecessor", () => {
  const fixture = allowanceFixture();
  const before = structuredClone(fixture);
  assert.deepEqual(proveFollowUpRetryAllowance(fixture), { kind: "proven", initialBlockId: "initial-block", failedBlockId: "failed-block" });
  assert.deepEqual(fixture, before);
});
test("each compensated physical follow-up keeps its own cancelled allowance and credit", () => {
  const fixture = allowanceFixture(true);
  assert.deepEqual(proveFollowUpRetryAllowance(fixture), { kind: "proven", initialBlockId: "initial-block", failedBlockId: "second-failed-block" });
  fixture.blocks[2].creditReservationId = fixture.blocks[1].creditReservationId;
  assert.equal(proveFollowUpRetryAllowance(fixture).kind, "held");
});
test("holds a different owner, wrong initial credit or invalid allowance identity", () => {
  for (const mutate of [f => { f.blocks[1].shopId = "foreign"; }, f => { f.blocks[1].conversationId = "foreign"; },
    f => { f.blocks[1].id = f.blocks[0].id; }, f => { f.blocks[1].ordinal = 0; },
    f => { f.initialReservationId = "foreign"; }, f => { f.blocks[0].state = "CANCELLED"; }]) {
    const fixture = allowanceFixture(); mutate(fixture);
    assert.equal(proveFollowUpRetryAllowance(fixture).kind, "held");
  }
});
test("holds unreconciled allowance consumption, pending work and different funding evidence", () => {
  for (const mutate of [f => { f.blocks[1].state = "ACTIVE"; }, f => { f.blocks[1].state = "PENDING"; },
    f => { f.blocks[1].outboundMessageIds.push("later-message"); }, f => { f.blocks[1].outboundMessageIds = ["foreign"]; },
    f => { f.blocks[1].predecessorId = "foreign"; }, f => { f.blocks[1].fundingKind = "CONTINUATION"; },
    f => { f.blocks[1].repairLeaseToken = "lease"; }, f => { f.blocks[1].creditReservationId = null; },
    f => { f.blocks.push(allowance("unrelated", 2, "unrelated-reservation", "unrelated-message")); }]) {
    const fixture = allowanceFixture(); mutate(fixture);
    assert.equal(proveFollowUpRetryAllowance(fixture).kind, "held");
  }
});

function fundedAllowanceFixture(repeated = false) {
  const fixture = allowanceFixture(repeated);
  const attemptId = repeated ? "retry_second_follow" : "retry_follow_intent";
  const pending = { ...allowance(followUpRetryBlockId(attemptId), repeated ? 3 : 2, "fresh-reservation", "unused"),
    state: "PENDING", outboundMessageIds: [], repairAt: now, repairDeadlineAt: new Date(now.getTime() + 60_000) };
  return { ...fixture, attemptId, reservationId: "fresh-reservation", now,
    blocks: [...fixture.blocks.map(b => ({ ...b, repairDeadlineAt: null })), pending] };
}
test("funded replay proves the new block without reopening or rewriting a historical block", () => {
  for (const repeated of [false, true]) {
    const fixture = fundedAllowanceFixture(repeated);
    const before = structuredClone(fixture);
    assert.deepEqual(proveFundedFollowUpRetryAllowance(fixture), { kind: "proven", initialBlockId: "initial-block",
      failedBlockId: repeated ? "second-failed-block" : "failed-block", blockId: followUpRetryBlockId(fixture.attemptId) });
    assert.equal(proveFollowUpRetryAllowance(fixture).kind, "held");
    assert.deepEqual(fixture, before);
  }
});
test("funded replay holds unrelated, missing, duplicate or misowned allowance blocks", () => {
  for (const mutate of [f => { f.blocks.pop(); }, f => { f.blocks.at(-1).id = "different"; },
    f => { f.blocks.push({ ...f.blocks.at(-1) }); }, f => { f.blocks.at(-1).shopId = "foreign"; },
    f => { f.blocks.at(-1).conversationId = "foreign"; }, f => { f.blocks.at(-1).ordinal = 1; },
    f => { f.blocks.at(-1).predecessorId = "failed-block"; }, f => { f.blocks.at(-1).fundingKind = "CONTINUATION"; },
    f => { f.blocks.push({ ...allowance("unrelated", 5, "other-reservation", "other-message"), repairDeadlineAt: null }); }]) {
    const f = fundedAllowanceFixture(); mutate(f);
    assert.equal(proveFundedFollowUpRetryAllowance(f).kind, "held");
  }
});
test("funded replay cannot reuse a compensated credit or another retry's reservation", () => {
  for (const mutate of [f => { f.reservationId = "reservation-follow"; f.blocks.at(-1).creditReservationId = f.reservationId; },
    f => { f.blocks.at(-1).creditReservationId = null; }, f => { f.reservationId = "different"; },
    f => { f.blocks[0].creditReservationId = f.reservationId; }]) {
    const f = fundedAllowanceFixture(); mutate(f);
    assert.equal(proveFundedFollowUpRetryAllowance(f).kind, "held");
  }
});
test("funded replay holds expired, progressed, cancelled or leased work", () => {
  for (const mutate of [f => { f.blocks.at(-1).repairDeadlineAt = now; }, f => { f.blocks.at(-1).repairAt = null; },
    f => { f.blocks.at(-1).repairAt = new Date(now.getTime() + 120_000); }, f => { f.blocks.at(-1).repairLeaseToken = "lease"; },
    f => { f.blocks.at(-1).repairLeaseUntil = new Date(now.getTime() + 1000); }, f => { f.blocks.at(-1).outboundMessageIds = ["prepared"]; },
    f => { f.blocks.at(-1).state = "ACTIVE"; }, f => { f.blocks.at(-1).state = "CANCELLED"; }]) {
    const f = fundedAllowanceFixture(); mutate(f);
    assert.equal(proveFundedFollowUpRetryAllowance(f).kind, "held");
  }
});


test("retry allowance namespace can never be confused with a legacy allowance", () => {
  assert.equal(isFollowUpRetryBlock("normal-allowance"), false);
  assert.equal(followUpRetryAttemptId("normal-allowance"), null);
  for (const id of ["retry_follow_intent", "retry_" + "a".repeat(100)]) {
    const blockId = followUpRetryBlockId(id);
    assert.equal(isFollowUpRetryBlock(blockId), true);
    assert.equal(followUpRetryAttemptId(blockId), id);
  }
  // Even corrupt identities in the reserved namespace cannot enter legacy repair.
  for (const id of ["allowance_retry_", "allowance_retry_bad/id", "allowance_retry_" + "a".repeat(101)]) {
    assert.equal(isFollowUpRetryBlock(id), true);
    assert.equal(followUpRetryAttemptId(id), null);
  }
});

test("only the exact prepared opener permits a funded retry readiness proof", () => {
  const fixture = fundedAllowanceFixture();
  assert.equal(proveFundedFollowUpRetryAllowance({ ...fixture, preparedMessageId: "opener" }).kind, "held");
  fixture.blocks.at(-1).outboundMessageIds = ["opener"];
  assert.equal(proveFundedFollowUpRetryAllowance(fixture).kind, "held"); // unchanged funding replay contract
  assert.equal(proveFundedFollowUpRetryAllowance({ ...fixture, preparedMessageId: "opener" }).kind, "proven");
  for (const preparedMessageId of ["", "foreign"]) {
    assert.equal(proveFundedFollowUpRetryAllowance({ ...fixture, preparedMessageId }).kind, "held");
  }
  fixture.blocks.at(-1).outboundMessageIds.push("another");
  assert.equal(proveFundedFollowUpRetryAllowance({ ...fixture, preparedMessageId: "opener" }).kind, "held");
});

test("prepared opener cannot bypass the current credit and block lineage checks", () => {
  for (const mutate of [f => { f.blocks.at(-1).state = "ACTIVE"; }, f => { f.blocks.at(-1).repairDeadlineAt = now; },
    f => { f.blocks.at(-1).repairLeaseToken = "lease"; }, f => { f.blocks.at(-1).creditReservationId = "foreign"; },
    f => { f.blocks[1].outboundMessageIds.push("other-consumption"); }]) {
    const fixture = fundedAllowanceFixture(true);
    fixture.blocks.at(-1).outboundMessageIds = ["opener"];
    mutate(fixture);
    assert.equal(proveFundedFollowUpRetryAllowance({ ...fixture, preparedMessageId: "opener" }).kind, "held");
  }
});

const { classifyFollowUpRetryOpening } = await import(pathToFileURL(join(directory, "recovery-follow-up-retry-outcome.js")).href);
const preparedOpening = { status: "PENDING", providerDispatchKey: null, providerDispatchAdmittedAt: null,
  providerDispatchControlRevision: null, dispatchProviderAccountId: null, dispatchProviderPhoneNumberId: null,
  providerMessageId: null, sentAt: null, deliveredAt: null, readAt: null, failedAt: null, providerFailureCode: null };
const admittedOpening = { ...preparedOpening, providerDispatchKey: "retry-permit", providerDispatchAdmittedAt: now,
  providerDispatchControlRevision: 0, dispatchProviderAccountId: "account", dispatchProviderPhoneNumberId: "phone" };
const classifyOpening = (message, code) => classifyFollowUpRetryOpening(message, "retry-permit", code);

test("follow-up reconciliation distinguishes unprepared, prepared and pre-provider refused work", () => {
  assert.equal(classifyOpening(null), "unprepared");
  assert.equal(classifyOpening(preparedOpening), "prepared");
  assert.equal(classifyOpening({ ...preparedOpening, status: "FAILED" }), "refused");
  assert.equal(classifyOpening({ ...preparedOpening, sentAt: now }), "conflict");
  assert.equal(classifyOpening({ ...preparedOpening, dispatchProviderAccountId: "account" }), "conflict");
});
test("a retry permit or FAILED without definitive rejection evidence stays unknown", () => {
  assert.equal(classifyOpening(admittedOpening), "unknown");
  assert.equal(classifyOpening({ ...admittedOpening, status: "FAILED", failedAt: now }), "unknown");
  assert.equal(classifyOpening({ ...admittedOpening, status: "FAILED", failedAt: now }, "PROVIDER_REJECTED"), "rejected");
  assert.equal(classifyOpening({ ...admittedOpening, providerDispatchKey: "foreign" }), "conflict");
  assert.equal(classifyOpening({ ...admittedOpening, providerDispatchControlRevision: -1 }), "conflict");
});
test("provider acceptance requires exact permit and durable message identity", () => {
  assert.equal(classifyOpening({ ...admittedOpening, status: "SENT", sentAt: now }), "conflict");
  assert.equal(classifyOpening({ ...admittedOpening, status: "SENT", providerMessageId: "wamid", sentAt: now }), "accepted");
  assert.equal(classifyOpening({ ...admittedOpening, status: "SENT", providerMessageId: "wamid", sentAt: now, providerFailureCode: "131026" }), "unknown");
  assert.equal(classifyOpening({ ...preparedOpening, status: "SENT", providerMessageId: "wamid", sentAt: now }), "conflict");
});
test("negative provider receipts and later positive receipts are not confused", () => {
  const failed = { ...admittedOpening, status: "FAILED", providerMessageId: "wamid", sentAt: now, failedAt: now };
  assert.equal(classifyOpening(failed), "non-delivery");
  assert.equal(classifyOpening({ ...failed, status: "DELIVERED", deliveredAt: now }), "accepted");
  assert.equal(classifyOpening({ ...failed, status: "READ", readAt: now }), "accepted");
  assert.equal(classifyOpening({ ...failed, readAt: now }), "unknown");
});


test("synchronous recipient failure requires exact persisted 131026 evidence and a permit", () => {
  const failure = { ...admittedOpening, status: "FAILED", failedAt: now, providerFailureCode: "131026" };
  assert.equal(classifyOpening(failure, "WHATSAPP_RECIPIENT_UNDELIVERABLE"), "non-delivery");
  assert.equal(classifyOpening(failure), "unknown");
  assert.equal(classifyOpening({ ...failure, providerFailureCode: "131016" }, "WHATSAPP_RECIPIENT_UNDELIVERABLE"), "unknown");
  assert.equal(classifyOpening({ ...preparedOpening, status: "FAILED", failedAt: now, providerFailureCode: "131026" }, "WHATSAPP_RECIPIENT_UNDELIVERABLE"), "conflict");
});
