---
review_id: BGDB-20261102-01
title: Background database calls - inventory and initial architectural review
status: initial-static-review
coordinator: moda_architect
created: 2026-11-02
snapshot: moda-interact-workspace(20261102-112817).zip
---

# Background database calls: inventory and initial architectural review

## Executive assessment

The Background application has meaningful opportunities to reduce database work, but its highest-priority findings concern durable progress: completing a partially started operation after a retry, preserving conversation work during concurrent updates, keeping checkout snapshots consistent with their activity timestamp, and ensuring repair scans eventually reach later work.

This report establishes the repository-wide source inventory and a substantial first pass through the principal processing flows. It is not a claim that every branch has been exhaustively audited or that throughput has been measured. Detailed source evidence and explicit coverage limits accompany each domain review.

The recommended order is: resolve the concrete correctness gaps; remove clearly redundant same-operation reads; make scans progressive and bounded; optimise per-item write loops while retaining atomic publication; measure remaining query plans, lock duration, pool pressure and retry amplification. Do not reduce query counts by removing tenant checks, billing invariants, consent/STOP decisions or final-send revalidation.

## Source and evidence boundary

- Exact input: `moda-interact-workspace(20261102-112817).zip`.
- ZIP SHA-256: `ee42bb83ee441ba9018779e760967a5bf87edcbc429eecc58699f1419863861b`.
- Architect role: supplied `moda_architect(20261102-112835).toml`.
- Source scope: `moda-interact-background/src/**/*.ts`; schema and relevant migrations from Background's nested `database/`, compared with the canonical Database schema.
- Background lockfile resolves Prisma/client **6.19.3**, Shared **3.0.0**, and BullMQ **6.3.6**. These are snapshot dependency facts, not a statement about deployed processes.
- The two schema files are byte-identical: 130 models, 191,707 bytes, SHA-256 `45df5e44bdc1e7e29495e391a1754477f0df362c667d648f4b6893b6541f5c0d`.
- The snapshot contains no Git metadata for the parent, Background or Database. Actual branch HEADs, submodule gitlinks, remote state, worktree isolation and deployment pins were not verified. Archive/schema hashes identify the reviewed bytes instead.
- No application execution, dependency installation, live database or Redis connection, provider request, integration suite, benchmark or EXPLAIN plan was run. Existing test source was inspected where identified.
- The delivery patch adds only the six review/evidence files in this directory. It does not change implementation, schema, task status, architecture status or any `_index.md`.

### Evidence terminology

| Label | Meaning |
| --- | --- |
| Static defect | The inspected control flow admits a concrete failure/interleaving; it has not been reproduced in this session. |
| Optimisation candidate | Repeated or growing work is visible; benefit and operational priority still need measurement. |
| Cross-flow risk | A plausible interaction needs focused reproduction before being treated as a confirmed defect. |
| Measured | Reserved for actual execution evidence; no performance finding here is labelled measured. |
| Open | Not yet traced deeply enough to conclude. |

## Inventory

| Source metric | Count |
| --- | ---: |
| TypeScript source files | 481 |
| Source lines | 70,139 |
| Worker modules | 25 |
| Worker factories constructing BullMQ workers | 13 |
| Explicit worker-process entrypoints | 6 |
| Files containing direct Prisma client sites | 198 |
| ORM read sites | 433 |
| ORM write sites | 358 |
| Raw query/execute sites | 236 |
| Explicit transaction-boundary sites | 162 |
| Total direct client sites, including transaction boundaries | 1,189 |
| Separately indexed SQL-wrapper invocations | 59 |

These are syntactic source locations. They do not mean 1,189 queries per job, nor 1,189 active production queries. A location may run zero times, once, once per item or again on retry. The raw calls include database-function invocations whose internal work is not represented by the site count. Wrapper calls and their underlying raw implementations must not be added together to infer statement volume. See [runtime and inventory](runtime-and-inventory.md) and the [machine-readable index](database-call-inventory.json).

A Prisma call using relations may result in more than one SQL statement, depending on the relation-loading strategy. Consequently every budget below counts explicit client calls, excluding transaction-control statements and relation expansion. The distinction is supported by the [Prisma v6 relation-query documentation](https://www.prisma.io/docs/orm/v6/prisma-client/queries/relation-queries).

## Workload and review coverage

The architect's reference workload is approximately **20,000 Shopify ingress events per minute**. This is a design assumption, not measured capacity. The actionable recovery fraction, duplicate/stale fraction, merchant distribution and provider-send volume are unknown. Do not apply that ingress rate directly to recovery, conversation or AI costs.

| Area | Principal source boundary | Depth in this pass |
| --- | --- | --- |
| Runtime, configuration, leases, pooling and instrumentation | `src/runtime/`, `src/lib/db.ts`, `observability/` | Detailed static review of shared mechanics; actual process counts and pool settings unknown. |
| Shopify checkout/order filtering and maturity | Checkout/order workers; candidate services; recovery materialisation/initiation | Detailed static branch tracing. |
| Woo checkout/order capture, maturity and resumption | Woo workers; `services/woocommerce-recovery/` | Detailed main-path tracing; send reachability explicitly qualified below. |
| Capacity resumption, follow-up and expiry | Recovery workers and repair/expiry services | Detailed selector/transaction/replay review; not every downstream offer branch. |
| Inbound, turns, moderation, admission and provider statuses | WhatsApp worker; conversation, moderation and admission services | Detailed static production-path tracing. |
| Human commands and initial-outreach notice | `services/recovery-conversation/`; initial-notice service | Detailed main persistence and replay review. |
| Billing reservations and compensation | Billing orchestration; free/paid reservation; compensation lineage | Detailed free/paid and entrypoint tracing; purchased/promotional and refund variants selective. |
| Translation | Merchant communications router; support/template assembly | Detailed assembly and selected reconciliation; all category/pricing publication and provider-result branches remain open. |
| Merchant knowledge | Pending/entitlement reconciliation, processing/promotion, upload cleanup | Substantial static tracing; provider transport internals outside database focus. |
| Discount/coupon catalogue publication | Shopify/Woo catalogue services; Woo dispatcher | Detailed publication/claim shape, not every provider-result case. |
| Brand media and Meta template management | Brand repository; template due poller/reconciler | Selected claim/pagination/publication boundaries. |
| Commerce grants/tools, price evidence and every embedded SQL routine | `src/commerce/`, selected outreach collaborators, Database functions | Indexed or selectively inspected; full branch proof remains open. |

### Important reachability qualification

`WooRecoveryOutreachService.enabled()` in `src/services/woocommerce-recovery/woo-recovery-outreach.service.ts:501` requires `NODE_ENV === "test"` and an injected `enableTestOutbound()` returning true. The normal runtime factory at `woo-recovery-composition.ts:71` supplies no override. The complete Woo initial-send path is therefore implemented and testable but is not enabled through this normal composition in this snapshot. Some reconciliation/finalisation reads run before that gate. This review does not alter it or treat its full send cost as ordinary active workload.

## Findings to address before broad query reduction

The references identify evidence sections, not newly created implementation tasks. Priority reflects possible effect, not observed incident frequency.

| Reference | Finding | Classification / consequence |
| --- | --- | --- |
| R1 | Runtime lease heartbeat rejection is detached; detected loss does not stop the callback, and schedulers ignore the loss result. | Static error-handling/coordination gap; overlapping scheduler work is possible after takeover. Duplicate business effects are not proven. |
| C1 | Shopify checkout exclusion lasts ten seconds without renewal and uses GET followed by DEL for release. | Static coordination gap across provider/preparation work that may outlast the lease. |
| C2 | Checkout refresh advances activity before provider lookup, then writes basket fields without an expected-version predicate. | Static race: a slower earlier refresh can overwrite the newer basket while retaining its newer activity timestamp. |
| C3 | A generic maturity retry treats an inserted DETECTED recovery as already handled. | Static replay gap after partial initialisation; only suppression-specific markers allow reentry. |
| C4 | Capacity repair repeatedly selects the first configured number of shop IDs. | Static liveness gap: persistently blocked shops can prevent later shops being repaired. |
| C5 | Order history can record an earlier status as its transition source after a concurrent status change. | Static history-consistency risk; retain state/history atomicity and fence the expected source status. |
| MSG-01 | Text ingress decides whether to initialise pending-turn state from an earlier, unlocked read. | Static race: a new inbound version can commit without a pending timestamp and then be skipped by scheduling. |
| MSG-02 | Automated moderation turns typed retry outcomes into terminal suppression. | Static failure-path gap: a temporary dependency/assessment condition can consume the turn. |
| MSG-03 | Any existing outbound usage idempotency row is treated as duplicate-complete. | Static crash-recovery gap after reservation but before dispatch; pending and completed lifecycle states need distinct replay treatment. |
| MSG-04 | An early provider status without a currently persisted provider message ID returns success as unknown. | Static event-order gap: that observation has no durable repair path in the inspected Background code; a later external replay may still repair it. |
| BS-01 | Knowledge pending repair repeatedly selects an oldest page, then skips dormant/stale items without scan progress. | Static liveness gap: retained pending rows can hide later eligible lost-enqueue work. |

Details, interleavings, necessary invariants and targeted validation are in [runtime](runtime-and-inventory.md), [checkout/recovery](checkout-and-recovery.md), [messaging](messaging-and-conversations.md), and [billing/scheduled work](billing-and-scheduled-work.md).

The compensation-period interaction BS-05 is intentionally a **cross-flow risk requiring reproduction**: historical RELEASED and later COMMITTED reservations can share an attempt suffix, while compensation expects exactly one match. It must not be described as a reproduced accounting failure.

## Clear opportunities to reduce work

| Reference | Current work | Smallest useful direction |
| --- | --- | --- |
| Checkout O1 | Candidate scheduling loads complete settings/override discount/catalogue graphs to obtain delay. | Narrow scheduling projection while preserving override precedence and expiry; reuse already-resolved identity within one operation. |
| BS-04 | Paid Shopify commit reads the same plan/usage handle twice in one Serializable transaction. | Reuse the validated transaction-local handle; one client call saved on this branch. |
| MSG-09 | Confirmed outbound update rereads its conversation ID before updating the conversation. | Return the ID from the update: three local calls become two. |
| BS-03 | Knowledge eligibility loads shop-wide entitlement/source IDs separately for each source. | Compute one bounded shop context/rank set per pass, retain transaction-local revalidation for mutation. |
| BS-02 | Every successful upload tombstone deletion is retried in every future whole-history cleanup sweep. | Record external deletion acknowledgement and bound total per-cycle work. |
| BS-06 | Billing queue reconstruction loads all eligible shops, including future scheduled work, each cycle. | Progressive bounded reconstruction with a defined scheduling horizon and future revisit mechanism. |
| BS-07 / TEMPLATE-01 | Translation batch assembly inserts/assigns items one by one under locks. | Bulk insertion/assignment preserving all-or-nothing claims and stable identities. |
| MSG-05 / MSG-08 | No-context routing normalises phone text in a predicate; STOP fallback scans canonical-null records. | Evaluate canonical indexed access and narrow unresolved-phone fallback without changing merchant scope or ambiguity rules. |
| MSG-06 / MSG-07 | Admission materialises message IDs; history/moderation fetch before applying processing bounds. | Database-side aggregation/existence and explicit bounded progress; never mark unprocessed content completed. |
| Checkout O5 | Identical unique and nonunique recovery-generation indexes are both declared and migrated. | Verify the deployed catalogue and usage, then remove only the redundant nonunique index through Database ownership. |
| R2 / TEMPLATE-02 | Replicas can repeat queue configuration reconciliation and template GET discovery. | Measure duplicate control work first; keep state fencing and provider calls outside transactions. |

This is not a recommendation to put all reads behind a process cache. Runtime configuration already has a versioned snapshot; credentials and sensitive platform policy have intentional operation-time reads. Mutable eligibility, consent, ownership, moderation and billing must be assessed at the appropriate decision boundary.

## Named branch budgets

The detailed appendices contain assumptions and source references. Counts exclude Redis/BullMQ, process polling, provider calls, transaction controls, relation expansion and retry multiplication unless stated.

| Named execution branch | Explicit database client calls |
| --- | ---: |
| Shopify order with neither checkout nor cart correlation | 0 |
| Eligible Shopify checkout create, scheduling candidate | 3; 4 for a FIXED non-null discount |
| Shopify checkout update, no candidate and no recovery, then schedule | 5; 6 for a FIXED non-null discount |
| Shopify order completes an active recovery | 4 in total, including 3 inside its transaction |
| Woo ordinary new checkout scheduling | 5; 6 for a FIXED non-null discount |
| Fresh text receive from a quiescent conversation with a matching outreach attempt | 9; excludes upstream routing and downstream scheduling |
| Fresh paid-included credit commit | Shopify 9; Woo 8 |
| Human-command claim of N records | 1 + N, with normal production capacity at most four available slots |
| Knowledge pending page of 100 current, otherwise eligible revisions | Up to 301 reads before enqueue |
| Successful expiry page of 100 transitions | 301 calls and 100 transaction callbacks |
| Support translation assembly of N claimed items | 2 + 2N inside its transaction |
| Template translation assembly of N claimed items | 5 + 2N inside its transaction; N capped at 100 |

A three-call branch at 20,000 events/minute would imply 60,000 client-call executions/minute only if every event took that branch. That is conditional arithmetic, not a workload forecast: actual event mix and the actionable fraction remain unknown. Removing one call on every event that actually takes a hot branch saves that branch's observed event rate, not the platform's entire downstream workload.

## Invariants to preserve

- Tenant/shop lineage and shop-scoped phone identity; the same phone may legitimately exist at several merchants.
- Recovery generation uniqueness, history and attempt coupling, current activity/version comparison, and superseded-job rejection.
- Exact-source credit reservation, commit, release and compensation; counter version predicates and whole-transaction retries.
- Consent/STOP, recipient reachability, human takeover/control revision, approved template and final-send checks after asynchronous preparation.
- Durable provider-admission disposition; retry a safe pre-admission operation differently from an admitted send whose provider outcome is uncertain.
- Provider HTTP, Redis publication, image acquisition and embedding outside database transactions.
- Atomic batch/catalogue publication and ownership; multiple smaller visible commits require a deliberate generation/publication design.
- Original database/provider errors retained in shared structured diagnostics with appropriate redaction. A generic reason code can supplement, not replace, the underlying error.

The official [Prisma v6 transaction guidance](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions) recommends short interactive transactions and avoiding network work inside them. Its serialization-conflict guidance requires retry handling. [PostgreSQL 17 SELECT](https://www.postgresql.org/docs/17/sql-select.html) documents SKIP LOCKED as appropriate for queue-like consumers, not a general consistency substitute. These references support the review method; they do not establish measurements for this application.

## Remaining deep-dive sequence

These are review batches, not implementation tasks or newly assigned architecture IDs.

1. **Checkout and order pipeline:** finish every stale/duplicate/terminal/maturity/reentry branch; settle C1-C5; trace exact recovery initialisation and source refresh outcomes.
2. **Outreach and conversation lifecycle:** finish offer/price/template composition, durable pending-send replay and all SQL send-fence routines; complete MSG findings against adversarial tests.
3. **Billing and accounting:** extend free/paid tracing through purchased/promotional/refund/cross-period cases and prove BS-05's precise lineage requirements.
4. **Scheduled and bulk work:** complete translation category/pricing publication/results, catalogue/knowledge maximum batches and all fairness/cleanup scans.
5. **Measured database review:** collect emitted SQL and plans from disposable representative fixtures; exercise hot merchants, queue reconstruction and concurrency faults; update estimates with measured results.
6. **Consolidation:** combine findings around functional areas or shared touch points before defining the smallest coherent implementation task set.

## Validation and acceptance boundary

This delivery is a documentation/analysis patch, not architect acceptance of an implementation attempt. No existing task becomes Complete, Ready or Changes Requested as a side effect of this review.

The delivery validation checks patch applicability against a fresh extraction of the exact uploaded archive; whitespace; changed-path scope; matching patched document bytes; and byte equality between the standalone patch and the patch inside the ZIP. Those checks establish artifact integrity only. They do not establish runtime correctness, SQL-plan quality or production capacity.

For runtime validation, start with the repository's declared scripts and targeted test files identified in the domain reports. Use disposable PostgreSQL with the required extensions and Redis, verify migration state, and record container cleanup. Capture per branch: executed statements, rows/bytes returned, transaction duration, lock and pool wait, retry count, and p50/p95/p99 job latency. Retain queue lag, event mix and merchant skew alongside database metrics. Reuse the existing shared Prisma/BullMQ instrumentation before proposing new telemetry.
