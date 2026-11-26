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

The supplied archive contains Background and its database submodule, not the
Shopify, API or Admin repositories. Do not remove the old unique sequence key
or start a retry dispatcher until all readers/writers of that key have been
migrated together. In particular, use the stable retry intent ID (or a durable
one-to-one successor mapping) for a *new* physical attempt ID. Never reopen the
failed attempt, delete its receipt, use the old `recovery-outreach:<attemptId>`
funding key, or count an initial retry as sequence two.

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
  a new funding block for a new physical send; cancelled/compensated blocks
  must never authorize a provider permit or count as successful initial funding.
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

Persist a lease and bounded retry budget at the logical slot (recommend one
additional physical send per slot initially). Reconstruct delayed work from
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
