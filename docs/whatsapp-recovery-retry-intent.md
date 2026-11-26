# Recovery delivery retries: durable decision (phase 2a)

## Release boundary

This is an additive step after the credit-protection and transaction-retry
corrections. It does **not** activate automatic resends. The new
`commerce.RecoveryOutreachRetryIntent` table records a policy decision, not a
queue job, provider permit, fresh outreach attempt or credit reservation.
The existing `(checkoutRecoveryId, sequence)` uniqueness and immutable
`outboundMessageId` remain unchanged. Deploy the database migration before
running the new Background client; older clients remain compatible with the
additive schema. No historic retry decisions are backfilled on deployment.

## One decision per failed physical attempt

The existing provider-status consumer persists definitive FAILED evidence and
closes the associated attempt. The existing compensation transaction proves
exact Shop/recovery/attempt/message/source lineage, releases or compensates
credit and removes the failed automated-message usage. It then records the
retry decision atomically, using the existing message lock and attempt read.
A failure to persist the decision fails the transaction; the existing bounded
whole-transaction retry and source error logging retain original errors.

- The original attempt, message, reservation and correction remain immutable
  audit evidence. The intent has a separate stable ID; one intent is allowed
  per failed attempt, failed message and funding reservation.
- Candidate creation requires a confirmed provider FAILED receipt with no
  positive delivery/read evidence, exact automation outreach linkage and a
  FAILED attempt (including an attempt closed by this transaction). Existing
  ENGAGED/NO_RESPONSE or otherwise terminal response history is compensated
  but not automatically recycled. HUMAN sends, ordinary conversation messages,
  continuation funding and unknown provider acceptance do not create intents.
  Synchronous HTTP failures are not made retryable by this step.
- Duplicate receipts reuse the same decision and original cooldown. A later
  code-bearing receipt may enrich an earlier code-less decision in place. A
  later authenticated DELIVERED/READ receipt cancels the plan under the same
  message lock. It does not claw back the prior credit compensation.
- The generation and last external activity snapshots are captured at
  compensation time for future revalidation, not proof of checkout validity.
  The intent is not an eligibility decision about consent, order completion,
  checkout lifetime, merchant state, funding, repair, or sender availability.

## Local retry classification (does not gate credit compensation)

| Policy | Codes | Earliest reconsideration |
| --- | --- | --- |
| AFTER_COOLDOWN | 2, 131000, 131016, 131057, 133004 | failure + configured temporary delay (default 5 min) |
| AFTER_COOLDOWN | 4, 80007, 130429, 131056 | failure + configured rate-limit delay (default 15 min) |
| PROVIDER_POLICY_HOLD | 131049 | failure + configured marketing delay (default/minimum 1440 min) AND verified provider-policy clearance |
| REPAIR_REQUIRED | listed account, parameter, template, quality or configuration codes | after verified repair; no clock alone |
| DO_NOT_RETRY | 131021, 131026, 131050 | no automatic retry of this failed action |
| REVIEW_REQUIRED | all other/absent codes | no automatic retry until classified |

The delay values are conservative Moda policy choices, not Meta guarantees.
A 24-hour floor does not establish that a marketing restriction has lifted.
Do not use sender rotation or rapid repeat requests to circumvent provider
limits. Do not change consent or recipient reachability from this decision.
Provider reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes

## Platform runtime configuration

Use the existing `public.BackgroundRuntimeConfig` singleton through Admin's
Operational / Recovery delivery retries group. These are initial database
and UI reset defaults, not execution constants:

| Field | Default | Valid values |
| --- | ---: | --- |
| `recoveryDeliveryTemporaryRetryDelayMinutes` | 5 | integer 1 to PostgreSQL Int max |
| `recoveryDeliveryRateLimitRetryDelayMinutes` | 15 | integer 1 to PostgreSQL Int max |
| `recoveryDeliveryMarketingRetryDelayMinutes` | 1440 | integer 1440 to PostgreSQL Int max |
| `recoveryDeliveryMaxRetries` | 3 | integer 0 to PostgreSQL Int max |

The compensation transaction reads the current singleton directly. Missing or
invalid retry configuration and max retries zero hold recoverable decisions
as `REVIEW_REQUIRED` with no due time; this never gates compensation. A real
SQL error still fails the atomic transaction and is retried/logged normally.
The marketing minimum is a conservative Moda safety floor, not evidence of
provider clearance. No runtime fallback intervals or new environment variables.

Replay keeps an existing decision and due time; code-less enrichment evaluates
the current settings against original failure time. The future dispatcher must
read current settings (not a stale cache), enforce current max additional
attempts and checkout lifetime, and never shorten a persisted cooldown on
configuration changes. A disabled/review-held decision must not silently
become sendable on re-enable. This patch does not implement dispatch, repair
release, retry counters, or automatic reconsideration of historical intents.

## Inspect the decision (read only)

```sql
SELECT i."id", a."checkoutRecoveryId", a."sequence", a."status",
       i."failedAttemptId", i."failedMessageId", i."providerFailureCode",
       i."policy", i."notBeforeAt", i."cancelledAt", u."status" AS "creditStatus",
       u."compensationDisposition", u."compensationUsageEventId"
FROM commerce."RecoveryOutreachRetryIntent" i
JOIN commerce."RecoveryOutreachAttempt" a ON a."id" = i."failedAttemptId"
JOIN billing."UsageReservation" u ON u."id" = i."fundingReservationId"
ORDER BY i."createdAt" DESC;
```

## Remaining activation boundary (phase 2b — not in this patch)

### Phase 2b patch 1 — code-only outreach identity and selection

Retain the existing `(checkoutRecoveryId, sequence)` unique key and the
original database schema. The trigger identifies the logical outreach slot:
`INITIAL`, or follow-up (`NO_RESPONSE_FOLLOW_UP`, `POST_WINDOW_FOLLOW_UP`).
Original attempts retain sequences 1 and 2 respectively. New physical delivery
retries reserve sequences 3 and above, regardless of the trigger. The retry
attempt's primary key is `retry_<intent.id>`; never repurpose `initiationKey`.
The same intent must resolve the same attempt under the existing recovery /
checkout lock and transaction. Allocate max(sequence, 2) + 1 only for a new
retry after re-reading under that lock; sequence allocation is not a send permit.

`domain/recovery-outreach-identity.ts` validates the chain from the original
slot through each exact predecessor intent, failed message and successor ID.
`services/recovery-delivery-retry/outreach-selection.ts` is its reusable Prisma
projection. Do not substitute the highest sequence, a failed original or a
historical successful row for the current physical attempt. Orphan, cross-
recovery, wrong recipient/trigger, non-automated retry, late positive receipt
and cancelled predecessor conflicts hold automated selection. An intent without
a successor is still only a decision. These checks are identity checks, not
proof of retry eligibility, allowance ownership, funding or a provider permit.

The automated follow-up template reader uses this selector for prior promises.
It keeps legacy SENT behaviour for original outreach; for a physical retry it
requires DELIVERED/READ evidence before reusing the actual persisted promise.

No retry row is created, no queue is registered, and no additional provider
send or credit charge is permitted by patch 1. Do not deploy retry writers
until every affected consumer has been migrated together. Never reopen the
failed attempt, delete its receipt, use the old `recovery-outreach:<attemptId>`
funding key, or count an initial retry as sequence two. The initial allowance
can adopt the successful retry only if no incompatible allowance block already
exists; existing immutable allowance funding must be explicitly handled or held.

Patch 1 validation: run `node --experimental-strip-types --test scripts/test-recovery-outreach-identity.mjs`, the automated template and original
outreach unit suites, `npx tsc --noEmit`, the full unit suite and build. The
selector tests are dependency-free; database concurrency and provider admission
are not validated by these tests.

### Code-only patch 2: delivery-aware agent history

Both recovery `loadCommerceHistory` and the legacy standalone agent snapshot
now use the same delivery-aware selection and projection. The moderation gate
uses the same prior-20 SQL window as the recovery history loader. FAILED and
PENDING outbound rows are excluded before that window is applied, even when
`sentAt` was set by provider acceptance. All persisted history is retained.

- `DELIVERED`/`READ` with the corresponding timestamp is positive evidence;
  a retained failure timestamp does not erase a later positive receipt.
- A persisted `SENT` message is not proof of delivery. Its automated template
  parameters and offer promise are withheld (only a host-owned uncertainty
  marker remains). Ordinary AI/HUMAN text remains attributed and explicitly
  marked as unconfirmed; merchant text is still untrusted history.
- An exact persisted same-conversation CUSTOMER quote of the outbound provider
  message ID in the existing bounded read can establish receipt of a SENT
  message. The inbound must have its own provider identity and positive status
  and must not predate the outbound acceptance. Quotes from other conversations
  or projected text alone are not evidence; no quote overrides FAILED/PENDING.
- Confirmed automated records retain their exact moderated content, labeled as
  historical template parameters rather than verbatim rendered copy. The
  Commerce Agent is instructed not to assert past receipt for unconfirmed
  messages, and to revalidate current offer terms using authorized tools.
- Current-model, exact-content moderation is still required before projection.
  Existing routing decisions, current customer objective, audio chronology,
  20-history-message and 32,000-character recovery limits are unchanged.
  No cross-recovery history is merged, no summary is fabricated, and no extra
  query is made to look for quotes or offers outside the bounded read.

This patch operates on the persisted root message; it does not reconstruct
partially delivered multipart bodies or revalidate a historical receipt during
an in-flight agent call. Those conservative omissions must not become proof
of a new customer promise. The standalone snapshot keeps its existing current
window API rather than changing routing or agent ownership. Automatic retry
execution, funding and provider admission remain disabled by this patch.

Patch 2 validation: run `node --experimental-strip-types --test scripts/test-recovery-history-delivery.mjs`, the commerce history/current-window,
conversation snapshot and moderation handback tests; run the disposable
conversation-moderation and common-layout integration suites, `npx tsc --noEmit`,
full units and build.

### Patch 3: funding and allowance lineage (no activation)

- Physical retries derive their identity from the predecessor's existing retry
  intent. Financial reconciliation uses the historical chain, not the mutable
  current-attempt selector: a later cancellation or positive receipt cannot
  erase already admitted financial history.
- Initial retry admission requires the exact current intent, a definitive
  temporary/rate-limit failure, both persisted and current cooldowns, the
  configured budget, unchanged checkout generation/activity, no customer
  inbound or local opt-out, and no existing conversation allowance. Provider
  policy holds (including 131049), repair and review decisions remain inert.
- Prove each predecessor's exact reservation and its release or compensation.
  A correction is not necessarily spendable capacity. Apply the existing
  billing policy and free, paid-included, purchased and promotional owners
  in one serializable Shop -> Conversation transaction. Lookup is across
  paid-period keys; replay cannot charge a second source for the same retry.
- Existing initial-send settlement accepts the retry's exact linked message and
  reservation. Compensation resolves the exact physical attempt, not the
  original sequence. The old positive/correction event pair is never rewritten.
- Adopt an initial retry allowance only after positive delivery and exact
  uncorrected commitment. Keep the block attached to its immutable funding
  reservation; block source lookup can resolve historical retry identities.
  An existing initial allowance is not reassigned. New follow-up retry
  funding is deliberately held until the successor-allowance path is coordinated.
- The new entrypoint does not create an attempt, schedule work, send to Meta,
  or issue a provider permit. Checkout lifetime, current consent, sender,
  offer and final admission still belong to the activation patch. Do not
  activate retries in production from Patch 3 alone.

Validate with `node --test scripts/test-recovery-retry-funding.mjs` and the
new disposable `recovery-retry-funding.integration.test.ts`, plus existing
initial-outreach settlement, recovery allowance and compensation suites.

### Patch 4a: durable discovery and initial retry claim (not activated)

- Scan due `AFTER_COOLDOWN` initial retry intents in bounded, ordered keyset
  pages. PostgreSQL remains the durable source; each later sweep begins again
  at the oldest due key. Already claimed intents are not excluded from recovery
  after restart. Policy-held, cancelled and follow-up intents are not dispatched.
- Under the existing serializable Shop -> Conversation owner transaction,
  validate the current exact failed predecessor, all historical reservations,
  the persisted and current cooldown/budget, unchanged activity/generation,
  current checkout lifetime, merchant status, absence of customer inbound,
  local STOP, existing allowance and follow-up slot. Reject stale generations.
  Require the existing open sender assignment and matching failed message's
  persisted account and phone stamps. Never allocate another sender.
- The read-only `inspect` method returns an eligible *claim*, not a send
  authorization. `claim` creates the deterministic sequence >=3 PENDING row
  once, using a caller-resolved offer policy, or returns the existing clean
  claim. Conflicting, progressed, or unlinked evidence remains held. A prior
  outbound usage event prevents this path from treating the attempt as fresh.
  A claim does not reserve credits, produce a message, or obtain a permit.
- Neither method is wired to a production worker, CLI or queue. This is an
  internal seam for the activation patch; the current legacy sequence-one
  readers cannot safely consume an automatically created retry. The eventual
  dispatcher must refresh Shopify checkout authority / Woo persisted state,
  current verified consent, effective policy, sender configuration and offer
  eligibility, and enforce the exact claim at the final provider fence. Do
  not invoke `claim` from production before these changes and validation.
- Initial claims only; follow-up retry funding and dispatch remain held.
- Fix the focused funding test runner to prefer the repository TypeScript
  compiler; retain PATH fallback for dependency-free development environments.

Validate the focused claim/funding domain tests, `recovery-retry-claim.integration.test.ts`
with disposable PostgreSQL/Redis and the Patch 3 funding/settlement suites.

### Remaining activation work

Background touchpoints requiring coordinated changes:

- `recovery-outreach-attempt.service.ts` and `recovery-recipient-ownership.ts`:
  one current physical attempt per logical slot, preserved full history.
- `checkout-recovery/recovery-initiation.service.ts`,
  `checkout-recovery/recovery-outreach-finalization.service.ts`,
  `checkout-recovery/recovery-initial-outreach-support-notice.service.ts`,
  `woocommerce-recovery/woo-recovery-outreach.adapters.ts` and
  `woocommerce-recovery/woo-resumed-outreach-settlement.adapter.ts`:
  initiate and settle the exact new attempt through the normal path, not the
  historical sequence-one receipt. Preserve platform-specific authority.
- `recovery-allowance/storage.ts`, `recovery-allowance/renewal.service.ts`:
  finish follow-up successor allowance and provider admission; initial retry
  adoption and historical funding lookup are addressed by Patch 3.
- `outbound-whatsapp-admission/outbound-admission-reservation.service.ts`,
  `outbound-whatsapp-admission/outbound-provider-failure.service.ts`,
  `recovery-sender-pool/sender-pool.service.ts`:
  exact fresh attempt admission and durable sender identity. A retry must not
  select a different sender as a workaround for a provider restriction.
- `checkout-recovery/recovery-outreach-follow-up-processor.service.ts`,
  `domain/recovery-outreach-follow-up.ts`, and
  `recovery-template-integration/automated-recovery-template.service.ts`:
  retain the logical initial/follow-up distinction; require current verified
  initial success before opening the follow-up slot.
- Order/checkout updates, inbound replies, expiry and late positive receipt
  consumers must fence the same durable claim before any retry send. Use
  `checkoutRecoveryLifetimeDays` and exact Shopify abandoned-checkout or
  persisted Woo checkout authority; refresh price/offer/template and consent.
- Coordinate Admin, Shopify and API sequence queries and displays; external
  clients must not treat historical failed sends as the active slot.

Prove a durable claim and bounded retry budget using the existing records
and current runtime configuration; do not introduce new persistence without
first establishing a concrete constraint. Reconstruct delayed work from
PostgreSQL, require a fresh permit, and reserve fresh funding only after all
final eligibility checks. Explicitly handle configuration repair, policy holds,
ambiguous acceptance, crash recovery, and exhausted budgets. Validate real
PostgreSQL concurrency, late positive receipts and duplicate provider jobs on
both platforms and all four funding sources. Do not activate resend behaviour
until these gates are met. No new queue or retry dispatcher is started by 2a.

## Validation commands

In Database: `npm run prisma:validate`, then
`node scripts/test-recovery-outreach-retry-intent-postgres.mjs --mode fresh`
and `--mode upgrade`. Both runs use their own disposable pg17/pgvector
container, with no production connection.

In Background, pin the new Database commit and run `npm run prisma:generate`,
`npx tsc --noEmit`, the new `recovery-outreach-retry-policy.test.ts`, existing
provider-status and compensation unit tests, and the compensation,
reachability and notification integration suites with `--testTimeout=60000`.
Run all unit tests, lint, build and `git diff --check` before commit. Verify
that compensation still occurs for code-less and unknown failures and that
no resend/fresh charge is made by 2a.

### Retry observability before worker activation

Use the existing Shared structured logger, not an additional telemetry sink.
Correlate the original failed message/attempt, persisted retry intent, physical
successor, recovery, shop, conversation and exact credit reservation where known.
No recipient phone, token, checkout token, template content or basket payload is
added to the retry events. Exception diagnostics use the existing bounded,
redacted initial-outreach projection and preserve the original thrown error.

`recovery.delivery_retry.intent_recorded` (info) records the persisted decision
and compensation outcome after the compensation transaction commits. Replays
report the stored decision, not a new calculated cooldown. A late positive
receipt emits `recovery.delivery_retry.cancelled` only when a row was actually
cancelled and the status transaction committed. The existing
`whatsapp.provider_status.applied` includes the provider message and failure IDs.

`discovered`, `evaluation_started`, `eligible`, `eligibility_held`, `claim_held`,
`claim_replayed`, `funding_replayed`, and normal funding holds are debug-level
observations under the existing retry event namespace (`recovery.retry_credit`
for existing credit holds). Discovery logs a bounded nonempty page, never every
idle poll. `claimed` and `funding_reserved` are info only after commit.
Conflicts are warnings and unexpected exceptions are errors with stage and
source diagnostic; original exceptions propagate. An allowance adoption is
logged as `allowance_adoption_prepared` with `transactionState: uncommitted`,
because its enclosing owner transaction may still roll back; reuse and held
allowance checks are diagnostic events. These logs are not financial authority.

There is no retry polling worker or provider send in this patch. When activating
polling, coalesce repeated unchanged holds across polling cycles; the present
patch does not provide cross-process log deduplication or a worker-level summary.
Log offer preparation, outbound admission, provider acceptance and final
settlement at their actual boundaries when the dispatcher is implemented.


### Patch 4b.1 — last-mile admission (not worker activation)

The existing Shopify and Woo initial send fences now distinguish a physical
initial retry by its deterministic ID, sequence >= 3, INITIAL trigger and exact
persisted predecessor chain. They continue to require their original consent,
STOP, template, moderation (where applicable), sender, usage and fresh-credit
proof. The shared SQL-only retry check additionally rechecks current recovery
ownership, generation/activity/lifetime, retry policy/budget, all predecessor
funding corrections, customer response, allowance and original sender. A retry
permit is attempt-keyed and never authorizes a second provider call for a
previously admitted attempt. Admission inspection and pre-provider rejection
use historical lineage rather than current retry eligibility for reconciliation.
The legacy sequence-one flow retains its original behavior.

The prepared/held, dispatch-admitted, provider-accepted and dispatch-failed
observations use the existing structured logger and redacted diagnostics.
Acceptance means the provider receipt was persisted; it does not establish
customer delivery. No credentials, recipient, basket or offer content is logged.

No retry worker, provider execution entrypoint, queue, or production Woo
outbound enablement is added here. The remaining cutover must implement
platform checkout authority and preparation, retry receipt finalization and
reservation release/restart reconciliation, and update inbound ownership and
follow-up scheduling/reporting before activating dispatch. A `131049` hold
remains inert. This patch is not an instruction to manually dispatch retries.

### Patch 4b.2 — initial retry execution and receipt reconciliation

`InitialDeliveryRetryExecutionService` is a callable executor for the existing
initial outreach pipeline, not a second offer or billing system. It acquires the
checkout lease, inspects durable provider progress before any fresh send,
revalidates stored checkout/customer/consent/suppression and merchant policy,
prepares the current offer through the existing services, and uses the existing
platform-specific billing, admission and provider send owners. The original
attempt, message, compensation, recovery, conversation and sender identities
are retained. An exact accepted receipt is reconciled against the retry's own
attempt; a committed permit without a definitive outcome is held, never sent
again. Definitive terminal failures release only an exact unused reservation.

Preparation recognizes the retry's physical identity without granting dispatch
authority. Finalization accepts the retry's exact historical predecessor chain,
retains the original recovery timestamp, and uses positively delivered initial
outreach for follow-up selection. Inbound authority and recovery-window queries
recognize a retry only through exact historical lineage and its dispatch permit.
Execution and finalization use structured, redacted diagnostics.

`runDuePage` and `reconcileClaimedPage` expose bounded, cursor-based discovery
and receipt reconciliation. Neither is registered with a production worker in
this patch. Do not manually invoke the executor against production. The existing
Woo outbound test-only gate is unchanged; `131049` policy holds are unchanged.
Follow-up retries and incompatible allowance blocks remain held. Before worker
activation, validate actual fresh provider dispatch and restart recovery in the
local emulator, production checkout authority and consent races, recovery of
reservations stranded before permit acquisition, and unchanged-hold log
coalescing. Unknown provider outcomes must remain held for reconciliation.
API/dashboard projections and full end-to-end validation remain outstanding.
No schema changes are introduced.
