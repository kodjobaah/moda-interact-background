# Background database review — checkout and recovery evidence

## Scope and evidence level

Read-only static review against the uploaded parent workspace, from upload `moda-interact-workspace(20261102-112817).zip`.

The domain analysis was read-only. This delivery records its findings in review documentation; application source, schema, dependencies and configuration remain unchanged. No database, Redis, load test, integration test, or live provider request was run. The observations below describe reachable code paths and potential interleavings, not reproduced incidents or measured production latency. The test files named below were inspected as coverage evidence only.

Paths below are relative to the extracted parent workspace; `BG` means `moda-interact-background/` solely to shorten this report. The database schema and migrations inspected were Background's nested `database/` copy. Actual deployment pins and live index catalogs were not available.

### Reviewed entrypoints and flow boundaries

- `BG/src/entrypoints/shopify-event.ts`: Shopify checkout/order and Woo capture composition.
- `BG/src/workers/checkout.worker.ts`, `orders.worker.ts`, `pending-recovery-candidate.worker.ts`, `recovery-capacity-resume.worker.ts` and their service routing.
- Shopify create/update/cart scheduling, pending candidate activity, checkout lock, matured materialization, initiation, order correlation, capacity resumption, scheduled follow-up, and expiry.
- Woo checkout activity, durable resumption closure, order observation/reconciliation, maturity admission, initial enqueue and dispatch, final SQL send permit.
- Shared local collaborators: recovery policy, shop execution eligibility, generation lookup, provider lookup boundary, schema/index declarations.

The full billing internals, template preparation/MCP/pricing implementations, generic messaging pipeline, customer consent reader internals, and every test body were not exhaustively audited here. The accompanying domain reviews cover parts of those areas; their coverage limits remain explicit. This is a detailed first pass over these particular processing flows, not certification of all Background paths.

## 1. Branch-specific database-call budgets

These are application-level Prisma delegate/raw calls, not SQL statement counts. Relation `include`/`select`, nested mutations, Prisma implementation, transaction controls and instrumentation can cause a different SQL count. Redis/BullMQ calls and timer-driven process configuration refreshes are excluded. Transaction counts are listed separately. Counts assume real Prisma delegates, normal successful dependency results and the exact branch described.

| Branch | Calls | Transactions | Main evidence |
| --- | ---: | ---: | --- |
| Shopify checkout-created, eligible shop, schedule/refresh candidate | 3; 4 with FIXED non-null discount | 0 | pending service 114–139; eligibility 37–55; policy 25–56 |
| Shopify checkout-updated, existing delayed candidate, newer activity | 3; 4 with FIXED non-null discount | 0 | orchestrator 111–159; activity 169–204; pending service 93–94 |
| Shopify checkout-updated, existing candidate, stale activity with no missing-context enrichment | 1 | 0 | orchestrator 111–159; activity 109–127 |
| Shopify checkout-updated, no candidate and no recovery, eligible shop, schedule candidate | 5; 6 with FIXED non-null discount | 0 | orchestrator 111–178; latest-recovery 3–7; pending service 251–284 |
| Shopify cart activity, absent candidate or unmodified stale candidate | 1 | 0 | orchestrator 295–318; eligibility 58–76; activity 82–127 |
| Shopify cart activity, newer activity on delayed candidate | 3; 4 with FIXED non-null discount | 0 | same plus activity 169–204 and policy |
| Shopify order, neither checkout nor cart correlation | 0 | 0 | order correlation 26–29 |
| Shopify order, absent/inactive shop, or successful pending-candidate cancellation | 1 | 0 | order correlation 31–77 |
| Shopify order, no candidate and absent/terminal recovery | 2 | 1 | order correlation 31–34, 90–105 |
| Shopify order, successful recovery completion | 4 | 1 | order correlation 31–34, 90–141 |
| Shopify candidate maturity, existing active recovery and no suppression-specific replay | 4 | 0 | materialization 50–62, 68–72, 98–109 |
| Woo ordinary new checkout, no durable recovery/order observation, eligible shop and scheduling | 5; 6 with FIXED non-null discount | 0 | orchestrator 43–45; composition 86–88; activity 149–154, 227–243, 413–414 |
| Woo checkout duplicate/stale against an active durable recovery, returns from watermark boundary | 2 | 0 | platform assertion + activity existing-recovery read, then activity 169–180 |
| Woo order, no durable recovery | 3 | 1 | platform assertion; order reconciliation 221–225 and 300–306 |
| Woo order, durable recovery already terminal, no recorded-order-ID conflict | 4 | 1 | same plus history lookup 227–231, terminal return 307–309 |
| Woo order, successful active recovery transition | 7 | 1 | platform + pre-read + history-read + transactional read/update/history/attempt-cancel |
| Capacity repair sweep returning S eligible/available shops | 1 + S | 0 | recovery-capacity-resume.service.ts 54–75; each eligibility uses a subscription query |
| Expiry full page of 100 successful transitions | 301 | 100 | expiry 32–76: page read plus 3 calls per successful row; next loop adds its own read |

For expiry, a failed compare-and-set makes only its update call inside the transaction, so 301 is specifically the all-success full page. For policy counts, the extra platform lookup is conditional on `configuredOfferMode === "FIXED" && discount !== null`; the common three-call and five-call totals are not universal constants.

## 2. Findings requiring correctness work before query reductions

### C1 — Shopify checkout exclusion expires while protected work is still running

**Classification:** confirmed static coordination gap; high priority; no race executed.

Evidence:

- `BG/src/services/pending-recovery-candidate/checkout-order-guard.service.ts:8–10,26–40` obtains a ten-second Redis lease, retries for approximately three seconds, then executes an arbitrary callback with no renewal.
- The same file `49–52` releases through separate GET and DEL commands. Ownership may change after GET and before DEL.
- `BG/src/services/checkout-recovery/recovery-materialization.service.ts:64–170` holds this lease through the second eligibility check, latest generation lookup, remote abandoned-checkout lookup (`131–133`) and full initiation (`160`).
- Initiation calls template preparation (`recovery-initiation.service.ts:260–264`), external offer validation with a 15-second timeout (`341–343`) and outbound provider dispatch (`352–361`). A permitted timeout alone exceeds the lease lifetime; there is no guarantee the callback finishes within ten seconds.
- Scheduled follow-up likewise holds this guard around template preparation and provider dispatch (`recovery-outreach-follow-up-processor.service.ts:40–43,117–121,174–184`).
- The Woo guard in the same module (`100–181`) already uses a renewable lease and atomic ownership-aware Redis scripts. This is implementation asymmetry, not an absent platform capability.

Possible interleavings: a second checkout/order worker acquires the expired lease while the first still reads or writes recovery state; or the first worker reads its owner value, its lease expires, a successor acquires the key, and the old worker deletes the successor's lock. PostgreSQL generation uniqueness protects duplicate generation rows but does not by itself serialize the full order/update/send workflow.

Recommendation: unify the owned checkout coordination mechanism with renewal and atomic release, and explicitly define how loss of ownership prevents subsequent effects. Retain PostgreSQL compare-and-set and final SQL send fences; a renewable Redis lease alone cannot guarantee safe effects after process pauses. Keep remote I/O outside database transactions. Validate a >10-second provider/preparation delay, lease expiry during an event-loop pause, successor acquisition, and cleanup racing successor ownership.

### C2 — Shopify recovery snapshot can regress behind its activity watermark

**Classification:** confirmed static missing write fence; high priority; no reproduced incident.

Evidence: `BG/src/services/checkout-recovery/checkout-event-orchestrator.service.ts:83–105,215–259`.

`recordExternalActivity` conditionally advances `lastExternalActivityAt` under the checkout lock. `handleCheckoutUpdatedContract` ignores its returned count, releases the lock before awaiting current Shopify data, then updates currency/price/URL/items with only `id` and active-status predicates. The payload write has no expected activity timestamp or source version predicate and does not reacquire the checkout lock.

Interleaving: event A starts an earlier Shopify read; event B advances the watermark and writes its later snapshot; A's earlier response finishes last and overwrites the payload while B's timestamp remains. Even a stale activity event whose timestamp update affects zero rows still performs the remote lookup and may write the snapshot.

Recommendation: define an accepted source revision/activity fence and apply the payload plus matching watermark coherently. A stale refresh must not overwrite a newer accepted snapshot. Preserve the provider-backed current-state requirement; do not substitute untrusted webhook payloads. Validate reversed response completion order and status transitions during the lookup.

### C3 — Generic Shopify maturity retry can acknowledge a partially initialized recovery

**Classification:** confirmed static retry-path gap; high priority, stage-specific replay design needed.

Evidence:

- `recovery-initiation.service.ts:73–98` creates a DETECTED recovery; `146–265` resolves consent and invokes that insert at `195`, then attaches customer/policy/attempt and prepares a template. Later sends/finalization remain fallible.
- `pending-recovery-candidate.worker.ts:157–162` enables `retrySuppressionAdmission` only for two special failure markers. Marker classification is `237–243`.
- `recovery-materialization.service.ts:98–110` returns `no-op-existing` for DETECTED, MESSAGE_SENT and ENGAGED except that suppression-specific DETECTED replay.
- The worker removes candidate indexes after materialization even on a failed attempt (`174–183`) and propagates the error (`189–203`). A subsequent ordinary retry finds the durable DETECTED row, returns success without re-entering initiation, and can complete the BullMQ job.
- `RecoveryCapacityResumeService.repair` only scans DETECTED rows with `RECOVERY_CAPACITY_EXHAUSTED` (`54–64`), not generic partially initialized rows.

Concrete reachable example: an exception after the insert but before provider dispatch, such as template preparation, leaves DETECTED and is not one of the two suppression markers. The next maturity attempt takes the no-op branch. A later customer checkout update can schedule a targeted recovery wakeup, but that is not autonomous repair of the failed attempt. A provider success followed by failed durable finalization also needs careful stage-aware reconciliation, not another send.

Recommendation: separate idempotent recovery creation from idempotent initial-dispatch repair and persist enough stage/provenance to resume the same attempt. Reconcile confirmed and ambiguous provider outcomes before any retry. Woo's `already-exists + repairInitial` path is a useful local reference (`woo-recovery-admission.service.ts:510–523`, `woo-recovery-orchestrator.service.ts:77–92`). Do not merely remove the existing-generation guard, because it currently prevents duplicate messaging.

### C4 — Capacity repair has no fair progress beyond the first shop page

**Classification:** confirmed selection shape; conditional starvation risk; medium/high priority.

Evidence: `BG/src/services/recovery-capacity-resume.service.ts:47–81`.

Every sweep selects the first N distinct shop IDs ordered by shop ID and reads each shop's eligibility separately. There is no keyset cursor, continuation, rotating frontier, or durable next-attempt time in this selector. If the first N active shops remain capacity exhausted, they remain selected on each run; later shops may never receive this repair wakeup. Other explicit billing/purchase events can schedule a wakeup, so the finding is about repair coverage, not proof that all later shops can never resume by any mechanism.

The worker's per-shop continuation name contains the last recovery ID, but `findBlockedRecoveries` (`recovery-capacity-resume.worker.ts:92–102`) always starts at the first page. This merits a second progress check when leading recoveries remain blocked for reasons other than an immediate capacity-exhausted return; its continuation does not represent a database cursor.

Recommendation: use bounded, fair, durable keyset/progress semantics for the repair sweep and per-shop batches; keep the one-credit admission ordering. Test more than N persistently blocked shops with a later eligible shop. The Prisma `distinct` + `take` SQL shape and rows scanned require capture/EXPLAIN; do not claim the return limit bounds physical database work.

### C5 — Shopify order completion can record a stale previous status

**Classification:** secondary static audit-history race; state completion itself remains guarded.

`order-recovery-correlation.service.ts:90–141` reads a recovery status, then updates any of DETECTED/MESSAGE_SENT/ENGAGED, and writes history.fromStatus from the initial read. A concurrent writer can change one active status into another before this update. The update still succeeds, while history records the earlier state. The checkout lease usually narrows the race, but C1 defeats that protection under slow work; capacity-resume initiation also runs outside that lock after a short gate. Woo order transition instead compares `status: recovery.status` and throws on a lost CAS (`woo-order-reconciliation.service.ts:312–330`).

Recommendation: use the actual transitioned prior status via a consistent lock or exact-status CAS/retry. Preserve the transaction around state and history.

## 3. Query and write-cost improvements

### O1 — Resolve only scheduling policy on the high-volume candidate path

`BG/src/services/recovery-policy.service.ts:25–56` loads full ShopSettings and ShopRecoveryPolicyOverride, including their fixed Shopify discounts and full catalogue relations. It may additionally look up Shop.platform. These payloads serve offer rendering (`83–94`) but create/update/cart candidate scheduling only consumes `recoveryDelayMinutes`.

Call sites: `pending-recovery-candidate.service.ts:93–94,138–139,270–271`; Woo `woo-checkout-activity.service.ts:413–414`.

Further duplication: Shopify `resolveShopByDomain` already retrieves settings.recoveryDelayMinutes (`shop-execution-eligibility.service.ts:53`), then scheduling fetches settings again. The latter cannot simply be removed because the administrator override and expiry semantics matter. Checkout-update fallback also resolves the same shop twice (orchestrator `111`; pending service `252`).

Recommendation: a narrow scheduling-policy projection/resolver preserving override expiry; resolve shop identity/eligibility once at the intended consistency boundary; keep full offer policy for actionable outreach. Treat cross-job caching as a separate consistency decision, not an assumed safe optimization. This saves row width and joins even if a two-query override implementation is retained. Measure actual SQL count and payload bytes before setting savings targets.

### O2 — Remove a one-statement interactive transaction after fixing its write fence

`checkout-event-orchestrator.service.ts:246–259` wraps one `checkoutRecovery.updateMany` in `$transaction`. No second read/write or row lock participates. It contributes transaction lifecycle work without making the separate earlier watermark update and provider fetch atomic.

Recommendation: once C2's compare-and-set contract is defined, issue the single atomic conditional update directly, unless the implementation introduces a genuinely coupled multi-statement operation. Do not extend the transaction across Shopify HTTP work.

### O3 — Narrow latest-recovery reads used only for control flow

`checkout-recovery/latest-recovery.ts:3–7` has no `select`, so it fetches JSON basket/restoration payloads and URL fields even where maturity only needs status/generation/identity. This helper is shared with initiation and refresh paths that use more fields, so replacing it globally with a tiny projection would break consumers. Provide purpose-specific projections or typed options. The unique `(shopId, checkoutToken, generation)` supports latest-generation identity; do not add a new index solely because the query orders descending.

### O4 — Consolidate Woo preflight reads without deleting final guards

Woo maturity performs separate Shop, installation, and subscription-with-Shop calls in parallel (`woo-recovery-admission.service.ts:261–271`), after the composition's platform-only Shop assertion (`woo-recovery-composition.ts:86–88`). They overlap in shop fields and occur before final SQL checks. Woo order reads latest recovery once to find durable order provenance (`221–235`) and again in its transition transaction (`300–309`), including when no recovery exists.

These are candidates for one authoritative scoped projection at a defined boundary, not automatic redundant-read deletions. The second transactional read protects transitions against other writers; preserve that safety. Preserve merchant/installation eligibility, provenance conflict detection, STOP, credit, and final template checks. Combine the platform assertion with a sufficient business-scope read where the ownership contract permits.

### O5 — Exact duplicate generation index appears in schema and migration

`BG/database/prisma/schema.prisma:390–391` declares both `@@unique([shopId, checkoutToken, generation])` and a nonunique index with identical columns. Migration `20260916150000_arch016_recovery_policy_discounts_outreach_generations/migration.sql:184–187` creates both physical indexes. The unique index supplies integrity and ordinary lookup support; the extra identical nonunique index is a strong removal candidate. Verify the deployed catalog and complete dependency/usage context, and have Database own the migration. Do not remove the unique constraint.

Other useful existing indexes: recovery `status,lastExternalActivityAt` (`392`), `shopId,admissionBlockReason,status,detectedAt` (`394`), status history `checkoutRecoveryId,occurredAt` (`346`), attempt unique recovery+sequence (`460`). Expiry's multistatus/global activity ordering and the global capacity repair selector are EXPLAIN candidates, not proven missing-index defects.

### O6 — Expiry is bounded but transaction-heavy

`checkout-recovery-expiry.service.ts:31–80` reads pages of 100, up to 1,000 pages, and performs one three-operation transaction for each successful expiry: CAS recovery update, history insert, cancel unsent attempts. All three writes are necessary outcomes. A full page yields 301 delegate calls and 100 transaction callbacks; the maximum loop can inspect 100,000 selected rows before returning, subject to actual progress.

Recommendation: measure scheduler duration, lock waits, rows changed, and connection occupancy first. Consider a bounded set-based transaction using exact returned transition rows to create history and cancel attempts if throughput warrants it. Retain status/activity CAS and all history/attempt side effects; an unconditional bulk status update would be incorrect. Separate query-count improvement from correctness. No existing index is called inadequate without a plan.

## 4. Guardrails and positive findings

1. Shopify no-correlation order events do zero database work; pending candidate correlation uses Redis indexes rather than queue scans (`order-recovery-correlation.service.ts:26–29`, pending service `323–329`).
2. Woo processing keeps observed order evidence in Redis (`woo-order-reconciliation.service.ts:15–21,78–100`). Its TTL is maximum policy delay plus 48 hours. This is explicitly bounded observation, not a permanent order ledger. Do not count these operations as PostgreSQL reads or imply that absent Redis evidence proves no live Woo order exists.
3. Woo resumption closure couples guarded status mutation and history in one transaction (`woo-checkout-activity.adapters.ts:75–104`); queue publication is outside it, and replay uses durable resumption metadata. Keep that coupling.
4. Woo maturity keeps Redis and provider work outside its transaction (`woo-recovery-admission.service.ts:374–472`). It locks/rechecks the prior generation, confirms current consent under row locks, inserts recovery and provenance history, and handles only the expected generation unique conflict (`474–482`). The preflight rechecks are not all redundant: they protect long work and compare accepted candidate and consent versions.
5. Woo final SQL permit (`woo-initial-send-fence.service.ts:102–271`) checks shop, conversation ownership, recovery, order history, attempt, consent/STOP, recipient ambiguity, reserved credit, outbound usage/message identity, runtime lifetime policy and template registration, then records the provider permit. Its many queries serve distinct invariants; reducing count by removing them is unsafe. Shop-first locking serializes this critical section per merchant and should be measured under hot-tenant load; no external provider call occurs inside this transaction.
6. Woo supports repair after a successful insert and failed initial enqueue: already-existing recovery requires exact admission provenance, same generation and DETECTED state (`woo-recovery-admission.service.ts:510–523`, orchestrator `77–92`). This should guide, not be copied blindly into, Shopify C3.

## 5. Snapshot reachability and diagnostic caveats

### Woo initial sending is deliberately gated in this snapshot

`WooRecoveryOutreachService.enabled()` (`woo-recovery-outreach.service.ts:501–503`) returns true only with `NODE_ENV === "test"` and an injected `enableTestOutbound()` returning true. Normal `createWooRecoveryRuntime` (`woo-recovery-composition.ts:71–74`) passes no such override. Thus the full Woo send path above is implemented but cannot execute through this normal factory; tests inject it. Do not multiply full Woo send costs into the actual normal candidate workload or imply production activation was verified. Reconciliation of already confirmed messages occurs before this gate, so not all read/finalization paths are disabled.

### One SQL fence error log replaces original evidence

`woo-initial-send-fence.service.ts:272–285` claims in a comment to preserve the original dependency error but emits `error: new Error("PERSISTENCE_FAILURE")` at 283. It rethrows the original error at 285, so outer worker logging may still record it; this particular diagnostic event does not preserve the original Prisma/provider message or metadata. Correct the field to the real error and rely on the shared logger's redaction/bounds. `woo-recovery-admission.service.ts:233–239` likewise logs only a type category before rethrow. This is diagnostic quality, not evidence that the exception is swallowed.

## 6. Test coverage examined and concrete next validation

Test files and relevant cases inspected by source/title:

- `tests/unit/services/checkout-recovery/recovery-materialization.service.test.ts`: ordering, eligibility inside lock, order tombstone, provider failure before initiation, completed current Shopify checkout, expired generation. Provider failure test at 275 covers failure before insert, not C3's post-insert replay.
- `tests/unit/services/pending-recovery-candidate/checkout-order-guard.service.test.ts`: callback/release, changed owner before release, callback plus cleanup failure. The changed-owner test at 67 does not prove atomicity across the GET/DEL gap or renewal beyond ten seconds.
- `tests/unit/services/recovery-capacity-resume.service.test.ts`: configured batch size, invalid size, one schedule failure, targeted resume. No fair multi-page repair assertion was established by these cases.
- `tests/integration/woo-recovery-worker-faults.integration.test.ts`: real failed jobs and recovery insert→enqueue repair at 149; useful existing integration pattern.
- `tests/integration/woo-recovery-admission-races.integration.test.ts`: stale candidates/watermarks, cancellation, missing queue data with existing sent recovery, expired lease competing generation admission at 279.

Recommended evidence for first implementation round:

1. SQL traces per named branch, including relation-generated queries and transaction controls; rows/bytes returned, pool wait, transaction duration, retries and queue lag. Keep non-actionable events distinct from materialized recoveries.
2. PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` on a disposable representative fixture for latest recovery, capacity repair/distinct selection, per-shop blocked recoveries, and expiry, including skewed hot merchants and larger history.
3. Fault injection after recovery insert, after attempt insert, after provider confirmation and during support/finalization; replay must repair exactly once and must never resend an ambiguous or confirmed attempt.
4. Deliberately reversed Shopify refresh responses and interleaved order completion; assert timestamp and basket version coherence and exact status history.
5. Checkout lease expiry/loss tests with two worker replicas and slow provider/preparation work; assert no successor lock deletion and no protected effects after ownership loss.
6. More shops than repair batch size, first page persistently blocked, later page newly eligible; demonstrate bounded eventual repair.

This file is internal review evidence. It does not claim task acceptance, benchmark results, or implementation completion.
