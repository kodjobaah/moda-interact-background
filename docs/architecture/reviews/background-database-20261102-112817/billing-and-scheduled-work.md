# Background database review — billing and scheduled work

Source: `review-source/moda-interact-workspace`, uploaded snapshot `moda-interact-workspace(20261102-112817).zip`.

This is a read-only static review. The domain analysis was read-only; this delivery adds review documentation without changing implementation. No tests, database traces, EXPLAIN plans, PostgreSQL or Redis connections were run. All counts below are explicit Prisma/raw-query client invocations on named branches; relation includes may emit more than one SQL statement. These counts exclude transaction BEGIN/COMMIT, Prisma internals, Redis, and retries.

## Highest-confidence findings

### BS-01 — Pending merchant-knowledge repair can starve later eligible revisions

Classification: statically demonstrated liveness gap; high priority.

`moda-interact-background/src/services/merchant-knowledge-reconciliation.service.ts:45–57` always selects the oldest `PENDING` revisions by `(requestedAt,id)`, `take: pageSize`, without a cursor. Lines 63–75 skip stale-generation or dormant/ineligible revisions without changing their status or position. The next invocation repeats the same prefix. The production wiring fixes `pageSize:100`, once per minute (`src/entrypoints/merchant-knowledge.ts:64–74`). A prefix of 100 dormant pending revisions prevents the reconciler reaching revision 101 even if that later revision is eligible and its original enqueue was lost.

This is not resolved by the processing worker: it deliberately calls `resetPending` on dormant eligibility (`src/services/merchant-knowledge-processing.service.ts:160–173`, `379–399`), retaining the durable intent. The entitlement reconciler also skips dormant entries (`merchant-knowledge-entitlement-reconciliation.service.ts:149–160`). That is a useful retention policy, but the repair scan must progress around retained dormant work.

Recommendation: bounded fair keyset/cursor traversal or eligibility-aware selection with an explicit dormant revisit mechanism. Preserve pending intent, and preserve final worker eligibility rechecks. Do not simply mark dormant work permanently failed. Regression: oldest full page dormant/stale plus one eligible lost-enqueue revision; the eligible revision must eventually be enqueued while the prefix remains dormant. Index already present at nested database `prisma/schema.prisma:4260–4263` includes `(status,requestedAt)`; adding an index alone cannot repair non-progressing selection.

### BS-02 — Upload cleanup reprocesses every successfully deleted tombstone forever

Classification: confirmed repeated work and unbounded whole-cycle size; scale impact requires measurement.

`src/services/merchant-knowledge-upload-cleanup.service.ts:40–49` includes all `status:DELETED` assets. Lines 60–157 page 100 rows at a time but continue until exhaustion, so only the individual page is bounded. Each historical deleted candidate is row-locked, checked for revision references, and reread for its object key (84–105), then R2 deletion runs (146–150). A successful R2 deletion does not modify/delete the tombstone or record an object-deletion acknowledgement. Every subsequent hourly cycle repeats this work (`src/entrypoints/merchant-knowledge.ts:96–104`). The asset schema has no object-deletion acknowledgement field (`database/prisma/schema.prisma:4186–4206`).

For D unreferenced DELETED tombstones with successful R2 deletion, a full sweep executes D transactions containing three explicit DB operations each (lock, count references, read object key), plus ceil(D/100)+1 page reads, and D R2 deletes. This branch excludes newly expired/available assets, races, failures, lease operations and configuration reads.

Recommendation: distinguish a tombstone awaiting external deletion from one whose external deletion is confirmed; retain audit data without selecting acknowledged tombstones forever. Bound total work/time per scheduler cycle and retain progress. Keep the existing DB-tombstone-before-R2 ordering and recheck references under the row lock. The current `catch { deleteFailed += 1 }` at 149–150 also drops the original R2 error; similarly entitlement reconciliation silently counts enqueue failure at 176–178. Recoverable failures should retain the original error in shared structured logs rather than only a counter.

### BS-03 — Merchant-knowledge eligibility loops repeatedly reread the same shop-wide state

Classification: confirmed N+1/query amplification, optimisation candidate.

`src/services/merchant-knowledge-entitlement-reconciliation.service.ts:138–148` loads every source for one shop and calls `resolveSourceEligibility` separately per source. That function reads the source (`merchant-knowledge-entitlement.service.ts:124–133`), reloads the same subscription/feature/preference graph (`147`, implementation `51–79`), then fetches every matching source ID for the shop to calculate rank (`167–180`). For S otherwise eligible sources, this transfers an S-row candidate list S times: O(S²) source-ID rows before considering the second eligibility pass in `createReplacementIfRequired` at reconciliation lines 197–249. That second pass runs inside a source-row lock and repeats the source read already performed at 207–215.

The pending reconciler adds up to three eligibility client operations per non-stale source (one source lookup, one subscription lookup, and one source-list lookup), in addition to its initial page query. A page of 100 current and otherwise eligible revisions therefore can execute up to 301 explicit reads before Redis enqueue, even if many are for the same shop.

Recommendation: shop-scoped batch context for one reconciliation pass, compute source positions once, use narrow transaction-local revalidation only where writing a replacement. Reduce the source-rank query to the configured prefix or a bounded rank predicate when only allowance membership is required. Preserve transactional eligibility where it governs a durable generation change, and late revalidation after acquisition/embedding. Measure source cardinality and transferred rows; do not cache mutable entitlement indefinitely.

### BS-04 — Exact duplicate paid-usage plan lookup inside the same transaction

Classification: confirmed redundancy; low-risk optimisation candidate.

`src/services/paid-included-recovery-reservation.service.ts:307–310` reads `subscription.plan.kind` and `subscription.plan.shopifyUsageEventHandle`, validating them at 311–316. When creating a Shopify usage event, line 348 calls `readPaidUsageEventHandle`, which repeats the identical lookup and validation at 509–517. These occur inside the same Serializable transaction, with no intervening modification to subscription/plan. Reusing the validated handle removes one explicit DB operation while preserving the guard.

Fresh RESERVED -> COMMITTED paid-included path counts: Shopify 9 client calls, WooCommerce 8. Components: reservation read; subscription period read; counter+period read; shop provider read; plan read; counter CAS update; an additional Shopify-only plan read; usage-event insert; reservation update. An already-committed replay is one reservation read. Further consolidation could select plan/provider along with the transaction-local subscription read; it must retain exact current-period, source ownership, version and capacity checks.

The fresh paid reservation path contains 11 explicit client calls inside its Serializable transaction: six in `EffectiveBillingPolicyResolver.resolve` (one subscription include, four policy/counter/preference reads, one paid counter read), a second subscription/current-period read, existing-reservation read, period-counter read, counter CAS, and reservation insert. This highlights consolidation potential, but the outer pre-admission policy read and later pre-provider policy read represent separate decision times and must not simply be deleted.

### BS-05 — Compensation reservation lookup is broad and can confuse historical reservations

Classification: confirmed query shape, strongly supported cross-flow correctness risk; requires regression reproduction.

`src/services/recovery-delivery-compensation/lineage.ts:85–96` searches all reservations using exact logical source OR `startsWith:paid-included:` plus `endsWith:<logical source>`, takes two, and requires exactly one. It has no shop predicate and does not exclude RELEASED historical reservations. It then verifies shop ownership in application code. This is not evidence of disclosure: the ownership check is present. The broad suffix query is a plan/scan risk; `take:2` bounds returned rows, not examined rows. `UsageReservation.sourceKey` has a unique ordinary index and `(shopId,status)` exists (`database/prisma/schema.prisma:1760,1778–1783`); actual plan must be measured.

Cross-flow scenario supported by current code: a paid initial attempt reserves in period A; billing period advances before send; `recovery-billing.service.ts:255–271` releases the old source then admits the SAME outreach attempt under current policy. `paid-included-recovery-reservation.service.ts:194–198` embeds period in sourceKey, and release at 367–386 preserves the old reservation row as RELEASED. The new period's row can subsequently become COMMITTED. Both old A and new B source keys match the compensation suffix lookup, making the exactly-one assertion fail for a terminal failed provider message. The unit suite explicitly expects release/readmit on period change (`tests/unit/services/recovery-billing/recovery-billing-revalidation.test.ts:130–151`). A similar collision may arise when paid capacity is released and a durable fallback is admitted.

Recommendation: resolve the precise reservation consumed by the outbound attempt through immutable source/reservation linkage, not a wildcard across historical funding records. At minimum constrain the query by known shop, but shop scoping alone does not resolve historical ambiguity. Preserve exact-source accounting; never choose an arbitrary matching reservation merely to make compensation succeed. Required regression: period A RELEASED + period B COMMITTED for one attempt, terminal recipient failure, exactly the consumed source compensated once; historical A remains unchanged.

### BS-06 — Billing subscription reconstruction is an unbounded global read every billing cycle

Classification: confirmed unbounded scan/result set; scalability candidate.

`src/services/billing-subscription-reconciliation/reconciliation-queue.service.ts:45–101` loads all eligible shops/subscriptions with no `take`, cursor, order, or due horizon; the selection admits non-null future `nextReconcileAt` values. Lines 106–119 enqueue them individually. `src/entrypoints/billing.ts:241–245` calls reconstruction every billing reconciliation cycle, not only startup. This is separate from `BillingReconciliationService.selectRotatingShopPage` (`billing-reconciliation.service.ts:150–177`), which is bounded and rotating.

Recommendation: bounded keyset reconciliation with explicit sweep progress/fairness, a near-term horizon plus a mechanism to advance future schedules when due, and retain deterministic job IDs + durable nextReconcileAt recovery. Do not remove reconstruction entirely: it repairs DB-commit/Redis-publication gaps. Capture selected rows, DB duration, queue publications and cycle duration at realistic merchant counts.

### BS-07 — Serial per-item writes while holding batch/catalogue locks

Classification: confirmed O(N) transaction round trips; optimisation candidate, no measured timeout claimed.

Support translation batch assembly locks selected pending translations at `translation-batch-assembly.service.ts:80–95`, creates one batch, then does one batch-item insert and one translation update per item (122–147). For N>0 items, the transaction has 2+2N explicit raw DB calls: selection + batch insert + N item inserts + N assignment updates. The model lookup occurs before the transaction (48–54,78). Replace per-item writes with bounded set-based writes while preserving row locks, one batch per claimed item, stable providerCustomIds and atomic association.

Shopify discount reconciliation writes one upsert per observed discount while holding the catalogue row lock (`shopify-discount-catalogue.service.ts:100–126`). Woo mirrors that per coupon (`woo-coupon-catalogue.service.ts:72–121,211–229`, explicit transaction timeout). Provider fetches are correctly outside write transactions, and final token/generation/eligibility checks are necessary. Larger catalogues increase transaction duration and pool occupancy; favour bounded bulk staging/publication preserving merchant availability choices, immutable references and complete-scan semantics. Splitting into independent visible commits without a publication generation is unsafe.

Merchant knowledge promotion also inserts one vector chunk per iteration inside the promotion transaction (`merchant-knowledge-processing.service.ts:414–495`). It computes embeddings outside the transaction, which is correct. This should be measured by chunks/revision and lock duration before prioritising a batched insert change.

## Correctness mechanisms to retain

- Reservation operations use Serializable transactions with version CAS on counters, deterministic sourceKey uniqueness, same-shop assertions, and bounded retries for P2002/P2034/concurrency conflicts. See `free-recovery-reservation.service.ts:73–134,144–222,225–315`, `paid-included-recovery-reservation.service.ts:108–168,194–251`, and `recovery-reservation/reservation-lifecycle.ts:95–119`. The retries repeat the entire transaction; no delay/jitter appears, so hot-shop retry amplification is a measurement target, not a reason to remove CAS or isolation.
- Terminal compensation locks the provider message, rechecks terminal status, validates immutable lineage, and updates source-owned accounting in the same transaction (`recovery-delivery-compensation/reconcile.service.ts:33–104`). Message-status transaction and compensation are separate; the messaging reviewer confirms failed status replays retry compensation. Preserve this replayability.
- Shopify order completion performs status transition and history insertion atomically (`checkout-recovery/order-recovery-correlation.service.ts:90–148`). Named branch counts: missing correlation 0 DB calls; missing/inactive shop 1; with checkout token, no pending Redis candidate and absent/terminal recovery 2; successful transition 4 (shop, recovery, update, history). Redis candidate lookup/lock/tombstone calls are additional and not database calls. Updating status with an IN-list while history uses the earlier status leaves a stale-fromStatus race; checkout reviewer confirms capacity-resume can write outside the checkout lock. Do not drop history to save a write.
- Woo coupon dispatcher uses bounded atomic `FOR UPDATE SKIP LOCKED` reservation (`woo-coupon-dispatcher.service.ts:67–118`) and publishes Redis after commit (120–134), with cooldown-based recovery. A backlog aggregate adds a separate DB query each cycle (148–164); its cost should be measured independently from bounded dispatch.
- Brand media does keyset reads of at most 100 shops and locks only the affected brand/shop rows for state mutation, keeping fetch/R2 work outside the transaction (`shop-brand-media-orchestration/repository.ts:59–98`). Do not replace this with a fleet-wide mutex.

## Coverage / limits

Deep or substantial static tracing: recovery billing orchestration and policy resolver; free and paid reservations; compensation entrypoint and lineage; billing reconciliation + subscription reconstruction; Shopify order correlation; merchant-knowledge pending/entitlement reconciliation, eligibility, processing/promotion and cleanup; support translation assembly + reconciliation; Woo coupon dispatch/catalogue and Shopify catalogue; brand media repository. Purchased/promotional reservation paths and several billing reconciliation subservices were inspected selectively, not exhaustively. Translation provider submission/poll/results, all refund correction branches, every purchase/refund operation, merchant pricing/category translation publication, and all provider-call error paths have NOT had an end-to-end proof in this agent's pass. Existing unit/integration test filenames were inspected but no test outcome is claimed.

Recommended next validation uses disposable PostgreSQL + Redis and source-defined test commands: concurrent final-credit reservations; counter invariants on replay/retry; compensation after period readmission; dormant-prefix repair progress; successful tombstone cleanup across repeated cycles; maximum translation/discount/chunk batch transaction duration; reconstruction across more than one page and interrupted publication. Capture statement counts, transferred rows, lock/pool wait, retries and p50/p95/p99 duration separately.
