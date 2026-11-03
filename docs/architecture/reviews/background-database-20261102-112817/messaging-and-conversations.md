# Background database review — messaging and conversations

Snapshot: moda-interact-workspace(20261102-112817).zip, 2 November 2026.
Author: messaging/conversation review subagent.
Scope: read-only static review. No database execution, integration tests, load tests, or EXPLAIN measurements were performed. All paths below are relative to moda-interact-background/. No source or architecture files were changed.

## Coverage and limits

Traced production paths: WhatsApp message-received and message-status dispatch; recovery routing; text and selected audio persistence; pending AI turns; moderation; outbound usage reservation, preparation, final permit and sent persistence; human send commands, polling and outcome reconciliation; authoritative STOP persistence; initial-outreach merchant notice finalization.

Production worker uses recovery-routing.service.ts. The separate whatsapp-conversation-routing.service.ts was inspected for context but was not used as authority for the active routing path.

Not exhaustively audited: every Commerce host/tool grant; every wrapper stored function; every template-management and translation job; all triggers and whole cross-service interleavings. Findings concern inspected code, not deployment behavior. Branch counts below are explicit ORM/raw invocations, not emitted SQL statement counts. Relation-loading expansion, stored-function internals, transaction control and database-backed configuration readers are excluded.

## Findings summary

| ID | Priority | Classification | Finding |
| --- | --- | --- | --- |
| MSG-01 | High | Static interleaving defect | Text ingress can increment inboundVersion while leaving pendingTurnStartedAt null. |
| MSG-02 | High | Static failure-path defect | Automated outbound converts moderation retry and some DB/configuration errors into terminal suppression. |
| MSG-03 | High | Static crash-recovery gap | Pending outbound reservation is treated as completed duplicate on turn replay. |
| MSG-04 | High | Static event-order gap | Early provider status is acknowledged when providerMessageId is not yet stored. |
| MSG-05 | Medium | Optimisation candidate | No-context routing applies regex to Customer.phone rather than indexed canonical-phone lookup. |
| MSG-06 | Medium | Optimisation candidate | Outbound admission materialises full automated-message ID history inside SERIALIZABLE transaction. |
| MSG-07 | Medium | Bounded-work concern | Pending moderation/history fetches are unbounded before in-memory budgets. |
| MSG-08 | Medium | Optimisation candidate | Standalone STOP reads all active null-canonical-phone candidates twice. |
| MSG-09 | Low/medium | Direct redundancy | Some IDs can be returned by existing writes or carried within one operation. |
| MSG-10 | Measurement | Intentional locking/polling cost | Final Shop locks and recurring human-command scans require measured contention/capacity evidence. |

## MSG-01 — Pending-turn initialization uses a stale snapshot

Evidence:
- src/services/conversation.service.ts:109-119 reads current conversation state before transaction.
- :138-195 creates message, conditionally initializes pendingTurnStartedAt, increments version and advances clocks.
- :158-172 decides whether initialization is needed from the pre-transaction snapshot.
- :252-264 completeTurn clears pendingTurnStartedAt.
- src/services/conversation-turn-processor.service.ts:164-176 enqueue skips conversations without pending timestamp.

Valid interleaving:
1. Version 1 has active pending turn.
2. New text reads version 1 with non-null pending timestamp.
3. Prior turn completes and clears the timestamp.
4. New transaction creates message and increments inboundVersion to 2.
5. Earlier snapshot had pending timestamp, so initialization is skipped.
6. Version 2 commits with pendingTurnStartedAt=null.
7. enqueue skips version 2.

Duplicate replay nuance: receiveMessage existing branch at :94-106 returns current version and repairs outreach engagement, but does not initialize missing pendingTurnStartedAt; enqueue still skips. Existing retry-to-enqueue behavior therefore does not repair this race.

Recommendation: decide pending state from the current locked Conversation row in the same transaction as message creation/version increment. Preserve monotonic clocks and provider-message identity. Compare existing audio completion: src/services/inbound-whatsapp-audio.service.ts:140-158 locks Conversation and sets current null pending state.

Validation: deterministic integration barriers between initial read and transaction; complete prior turn, then persist new message, assert pending timestamp and exactly one scheduled turn. No runtime reproduction was performed.

## MSG-02 — Automated moderation retry becomes terminal suppression

Evidence:
- src/services/conversation-moderation/moderation-assessment.service.ts:171-188 returns retry for checking lease/backoff.
- :196-246 persists provider retry and returns retry.
- src/services/outbound-whatsapp-admission/outbound-message-delivery.service.ts:349-355 converts result to boolean.
- :102-105 fails prepared message and returns suppression on false.
- src/services/conversation-turn-processor.service.ts:535-543 completes turn after sendPreparedText without retaining suppression/retry distinction.
- moderation-assessment.service.ts:123-139 catches allowance-recheck DB/configuration failures and returns false, causing same terminal outcome.

Impact: temporary moderation failure can discard AI response even though retryable assessment exists. Human and inbound moderation already preserve retry semantics; inbound moderation-turn-gate.ts:43-46 plus conversation-turn-processor.service.ts:288-295 explicitly reschedule.

Recommendation: propagate typed allow/block/review/retry/dependency outcomes. No send while unresolved; durably retry/reschedule without marking turn processed. Technical DB/configuration failure must not be collapsed into content refusal.

Validation: timeout; checking lease; backoff; recheck DB failure; later success must result in one send and no false processed version.

## MSG-03 — Existing reservation suppresses unfinished work

Evidence:
- src/services/outbound-whatsapp-admission/outbound-admission-reservation.service.ts:82-86 treats any existing usage-event idempotency key as duplicate.
- :145-166 transactionally creates PENDING message and UsageEvent.
- src/services/conversation-turn-processor.service.ts:402-420 reserves before agent call.
- :408-418 completes turn on any non-admitted result.
- findExistingAdmission exists, but this turn path does not use it to distinguish pending unadmitted, sent, or uncertain admitted work.

Crash window: process exits after reservation commit before provider admission. Catch cleanup never runs. Replay sees usage key, returns duplicate suppression and completes turn. This is a possible static process-failure sequence, not an observed production loss.

Recommendation: idempotent reserve/replay should expose durable lifecycle disposition. Resume unadmitted pending work with ownership; reconcile committed provider permit; repair already confirmed sends. Do not blindly resend an admitted outcome.

Related: outbound-provider-failure.service.ts:14-18 marks FAILED then deletes usage in separate autocommit operations. A crash between them leaves a failed message and stale key. Make local cleanup atomic and consider provider-permit fencing.

Validation: process loss after reservation, during model work, and between cleanup writes; same turn must converge with no loss/duplicate send.

## MSG-04 — Early provider statuses can be lost

Evidence:
- src/services/outbound-whatsapp-admission/outbound-message-delivery.service.ts:114-122 provider responds before markSent.
- :472-495 persists providerMessageId.
- src/services/whatsapp-provider-status.service.ts:80-106 finds only by persisted provider ID and returns unknown-message on miss.
- src/workers/whatsapp.worker.ts:119-121 returns normally from message-status branch.
- whatsapp-provider-status.service.ts:249-267 excludes unknown-message from compensation/reachability follow-up.

Static event-order gap: a status may be processed while sending worker has not committed ID. Status is then treated as successfully handled. A later provider replay could recover the effect, but this code does not durably ensure such replay.

Bounded repair search: rg over src for unknown-message/providerDispatchAdmittedAt/pending IDs found no unmatched-status store/reconciliation in inspected Background paths. Human reconciliation repairs known commands; it does not retain unknown provider status. Existing status unit test at tests/unit/services/whatsapp-provider-status.service.test.ts around :433 expects unknown-message. Do not claim exhaustive proof across all external ingress services or provider retry behavior.

Recommendation: persist unmatched status observations or use bounded durable reconciliation; distinguish truly unknown from temporarily unmatched. Keep provider HTTP outside DB transaction.

Validation: pause after provider response before markSent; consume status; then commit markSent; verify eventual delivery/usage/failure compensation/reachability.

## MSG-05 — Regex phone lookup misses canonical index

Evidence:
- src/services/recovery-routing.service.ts:126-153 no-context query joins Recovery/Conversation/Customer/Shop, comparing nested regexp_replace(Customer.phone).
- LIMIT 2 bounds returned candidates, not scan cost.
- database/prisma/schema.prisma:221-244 Customer has no phone index.
- :275-309 CustomerPhone has whatsappCanonicalPhone and canonical lookup indexes.
- migration 20261021170000_arch045_shared_woo_consent_privacy defines canonical indexes.

Recommendation: evaluate indexed active canonical-phone lookup as query entry point, then scoped ownership/recovery join. Preserve cross-shop ambiguity, newest Woo lineage, and merchant-scoped phone identity.

Measure known/unknown sender, many-shop sender, large recovery history. No plan or throughput claim.

## MSG-06 — Outbound admission scales with stored message history

Evidence:
- outbound-admission-reservation.service.ts:114-131 fetches all automated outbound message IDs then UsageEvent.groupBy with expanding sourceId IN list.
- :71-74 serializable transaction.
- schema.prisma:1590-1637 indexes UsageEvent by shop/metric/time etc.; no sourceId-leading index found in inspected schema/migrations.

Message-success limits do not prevent failed/prepared historical message rows accumulating.

Recommendation: DB-side join/aggregate instead of application ID materialization. Inspect emitted SQL and EXPLAIN before adding index. Durable counter would be broader change requiring consistency with terminal-message counting, cleanup and compensation.

Measure transaction duration, returned IDs, SQL statements, serialization conflict/retry amplification as history grows.

## MSG-07 — Pending moderation/history not bounded at database boundary

Evidence:
- moderation-turn-gate.ts:20-45 fetches all candidates then sequentially assesses.
- src/commerce/history.ts:69-86 current query has no take.
- :26-48 checks 32k character budget after retrieval and filtering.
- workers/whatsapp.worker.ts:221-231 loads all pending reply-context fields but :270-272 uses only some(...).
- turn processor invokes settled-turn abuse admission after moderation/context (:288-305,332-340). Raw limiter precedes routing, so this is not unlimited ingress.

Recommendation: bounded retrieval/progression and existence query for reply-context. Never truncate pending content silently and mark all versions processed.

Moderation direct call budget for N eligible messages:
- setup: 2 (Conversation, candidates).
- cached terminal assessment: 3 per item (canonical source, create-or-reuse SQL function, assessment read).
- fresh assessment: 5 per item (above + claim + complete SQL function).
Excludes readModerationOperation and function-internal SQL. Reuse path still invokes create-or-reuse; optimise only preserving canonical content/model/version identity.

## MSG-08 — Null canonical STOP fallback

Evidence: whatsapp-contact-opt-out/stop-writer.ts:32-82 matches active canonical recipient OR canonical null; reads candidates twice and filters in memory; sorted Shop locks; per-phone guarded update. Standalone STOP may retrieve all active unresolved canonical rows across tenants twice.

Recommendation: measure unresolved-phone population; normalise in owning path and narrow fallback while preserving STOP scope, stable lock ordering, post-lock reread and recipient serialization. Notice writes after STOP commit must remain separate so notice failure cannot undo STOP.

## MSG-09 — Direct redundant lookup opportunities

1. outbound-message-delivery.service.ts:476-494 updates message, rereads conversationId, updates conversation. Return conversationId from first update: 3 -> 2 direct calls.
2. conversation.service.ts:109-118 already loads recovery ID; recovery-outreach-attempt.service.ts:183-188 rereads it in markEngagedForConversation. Carry validated identity within operation.
3. human-command-evaluation.service.ts:20 loads claimed command/context; human-command-dispatcher.service.ts:210 loads again; :216 rereads recovery context. Return validated evaluation context for next preparation phase where safe, preserving final locked revalidation.
4. merchant-send-command.service.ts:32-48 claims with 1 SELECT + N UPDATE calls, despite one-SQL-statement comment. Production limit <=4 available slots; not unbounded urgency.

## Exact local branch budgets

| Named branch | Explicit ORM/raw invocations |
| --- | ---: |
| receiveMessage, fresh quiescent text and matching outreach attempt | 9 |
| receiveMessage, fresh text with pending turn and matching attempt | 8 |
| receiveMessage, duplicate and matching attempt | 4 |
| Initial-outreach finalizer with notice disabled | 5 |
| Initial-outreach finalizer with notice created | 9 |
| Initial-outreach finalizer replay | 3 |
| Human command claim batch | 1 + N |

Fresh text includes markEngagedForConversation but not upstream routing, activity, reachability or scheduling. Quiescent fresh calls: duplicate read, conversation read, message create, pending-state update, version update, clock raw update, recovery-ID read, attempt read, attempt update. Pending path omits pending-state update. Duplicate path: duplicate read, recovery-ID read, attempt read, attempt update. Conditional no-attempt/no-update outcomes reduce count.

Notice finalizer: lock attempt; read attempt lineage; read outbound message; transition attempt; settings; if enabled create thread, read thread, create notice, advance thread clock. Replay exits after first 3.

## MSG-10 — Locking/polling costs requiring measurements

recovery-conversation/recovery-conversation.sql.ts:50-66 locks Shop -> Conversation and rereads identity. Final-send fence then checks mutable control revision, STOP, reachability, window evidence, template registration and durable policy. These are not safely removable duplicate reads. Shop lock serializes same-shop final permits; measure hot-shop lock wait/held duration.

human-command-dispatcher.service.ts:122-129 runs expired-permit, confirmed-follow-up and cancelled-claim repair discovery plus claim discovery every 3 seconds per messaging process, even idle. Production in-flight maximum is 4. Include these in baseline polling load.

## Safeguards that should remain

- Provider HTTP occurs after final permit transaction commits.
- CAS/version and unique provider IDs enforce duplicate/state discipline.
- Revalidation after model/moderation/provider preparation protects changing state.
- Provider-status compensation outside status transaction is intentionally replayed.
- Initial-outreach notice finalization transaction is atomic and lineage-checked.
- Human commands have durable claims and uncertain-permit reconciliation.
- STOP persistence commits before merchant notices.
- Raw abuse limiter uses Redis/current in-memory runtime config, not a DB lookup per request by this service.

## Test evidence and gaps

Tests read, not run:
- tests/integration/conversation-turn-scheduling.integration.test.ts:252-299 repairs missing enqueue when original inbound is delivered again. Does not cover MSG-01 null timestamp or MSG-03 reservation crash.
- tests/unit/services/whatsapp-provider-status.service.test.ts covers status duplicates/compensation replay and expects unknown-message; early-status repair not established.
- Existing moderation and final-fence tests exist; coverage of automated typed retry preservation not established.
- Existing fixtures frequently inject simplified turn persistence; integration tests must exercise production ConversationService for MSG-01.

No latency, SQL counts, sustainable throughput, pool pressure, lock wait, or failure rate has been measured.

## Coordination note

Billing reviewer identified possible compensation ambiguity between historical RELEASED and later COMMITTED reservation rows after billing-period rollover. Status handler invokes compensation outside transaction on FAILED replay and propagates error; this does not resolve that ambiguity. No countervailing lineage handling found in messaging path; root should validate billing agent evidence.


## TEMPLATE-01 — Assembly uses 5 + 2N raw calls inside one run transaction

Evidence: src/services/template-translation/repository.ts:73-121, loadRunForTransaction :124 onward.

For nonempty successful assembly:
1. Lock run.
2. Load run/snapshot.
3. Update run.
4. Select candidate items (FOR UPDATE SKIP LOCKED; limit clamps to 1..100).
5. Insert batch.
6. For each N item: insert batch item, update translation item assignment.

Thus 5 + 2N explicit raw invocations in one transaction, excluding stored triggers. At max100 this is205 calls. This is bounded, not an unbounded query, but holds run/item locks while performing many network round trips. No provider HTTP occurs in this transaction.

Candidate improvement: bulk insert/assignment under same run lock, preserve deterministic provider custom IDs, all-or-nothing ownership and guarded status checks. Measure transaction duration and lock waits at actual batch sizes; do not assert a timeout without measurement.

## TEMPLATE-02 — Meta poller is bounded, but replica CAS does not prevent duplicate GETs

Evidence:
- meta-template-management/due-poller.ts:38 processes25; :51 schedules60s after completion; :18-20 promises at most1 cycle perprocess.
- repository.ts:23-40 listDue clamps result to1..50, production25.
- service.ts:221-246 loops per due item, collects errors and continues.
- service.ts:155-182 reconcileRegistration loads record, then provider verify/find, then records reconciliation.
- There is no durable claim before the GET in that reconcile branch. Replicas can discover the same due row before either writes it.
- Repository write CAS protects state from stale overwrite, and submission claim protects creates; this observation does NOT establish duplicate POSTs.

Candidate improvement only if measured cost warrants: durable reconciliation claims or a leased dispatcher to reduce repeated read/provider work. Do not hold SQL transaction across external I/O or weaken existing status fencing. Preserve bounded due discovery and error propagation.

Positive boundedness:
TemplateTranslationCoordinator.reconcile clamps pageSize1..500 (reconciliation.ts:76-77), each discovery query has LIMIT. Template assembly clamps100. No new unbounded-scan correctness claim raised for these paths. Plans/index adequacy still need measurements.
