# Runtime, database access and inventory

## Scope

This is the runtime/inventory section of BGDB-20261102-01. Paths are relative to `moda-interact-background/` unless explicitly stated. Static evidence is distinguished from runtime measurement throughout. No application or database test was run.

## Six process entrypoints and 25 worker modules

The six entrypoints are definitions in source, not evidence that all six are currently deployed. `src/index.ts` is the combined development entrypoint. The three other files in `src/entrypoints/` provide resources.

| Process entrypoint | Worker modules / handlers | Additional recurring work |
| --- | --- | --- |
| `src/entrypoints/shopify-event.ts` | `checkout.worker.ts`, `orders.worker.ts`, `woo-checkout-capture.worker.ts`, `woo-order-capture.worker.ts` | Runtime-config refresh; queue-concurrency reconciliation. |
| `src/entrypoints/recovery.ts` | `pending-recovery-candidate.worker.ts`, `recovery-capacity-resume.worker.ts`, `recovery-outreach-follow-up.worker.ts`, `shopify-discount-sync.worker.ts`, `woo-coupon-sync.worker.ts` | Capacity repair, expiry, Woo coupon dispatch, brand-media reconciliation, runtime/config controls. |
| `src/entrypoints/messaging.ts` | `whatsapp.worker.ts` | Human-command dispatch/reconciliation, Meta template due poller, runtime/config controls. |
| `src/entrypoints/billing.ts` | `billing-subscription-reconciliation.worker.ts` | Billing/receipt/usage reconciliation and subscription-queue reconstruction, runtime/config controls. |
| `src/entrypoints/merchant-knowledge.ts` | `merchant-knowledge.worker.ts` | Pending repair, entitlement reconciliation, upload cleanup and runtime configuration. |
| `src/entrypoints/merchant-communications.ts` | `merchant-communications.worker.ts` plus the 12 subordinate handler modules below | Translation reconciliation/publication and runtime/config controls. |

The 12 subordinate merchant-communications modules are: `translation-dispatch.worker.ts`, `translation-reconcile.worker.ts`, `translation-batch-submit.worker.ts`, `translation-batch-poll.worker.ts`, `translation-batch-results.worker.ts`, `store-category-translation-batch-submit.worker.ts`, `store-category-translation-batch-poll.worker.ts`, `store-category-translation-batch-results.worker.ts`, `merchant-pricing-translation-batch-submit.worker.ts`, `merchant-pricing-translation-batch-poll.worker.ts`, `merchant-pricing-translation-batch-results.worker.ts`, and `template-translation.worker.ts`. They are dispatched through the merchant-communications worker; 25 modules do not mean 25 independent queues.

## Database clients and connection footprint

`src/lib/db.ts:3` constructs one application Prisma client for the module instance. It retains that client on globalThis in nonproduction. The separate readiness probe at `src/runtime/readiness.ts:110` constructs a short-lived client, runs SELECT 1, and disconnects. Readiness is not an additional per-event business lookup.

Each separate process/replica has its own client/pool. The source alone does not establish effective connection_limit, pooler topology, deployed replica count, or shared PostgreSQL headroom. No exact connection-capacity number is claimed. Estimate fleet pressure only after collecting those settings and concurrent transaction occupancy. Raising worker concurrency without that evidence is not an optimisation conclusion.

## R1 — Runtime lease ownership is not propagated into work cancellation/fencing

**Classification: static error-handling and coordination gap; high priority.**

`src/runtime/background-runtime-lease.ts:18` acquires through one SQL statement with expiry/cadence predicates. Heartbeat and release predicate owner token and generation; this correctly prevents an old handle from modifying a successor's lease row. Heartbeat also rejects renewal after expiry.

The wrapper at line 80 has a separate gap. Its timer assigns `heartbeat(...).then(success).finally(cleanup)` at line 91 without a rejection handler. Only a resolved false marks `leaseLost`. A rejected renewal can settle after its retained promise is cleared, leaving final cleanup unable to observe that earlier rejection. If work happens to end while renewal is still pending, the final await can observe it; that timing does not make the general path safe. Process termination on an unhandled rejection is environment-dependent and was not tested.

A resolved ownership loss stops future heartbeat scheduling but does not stop the work callback. `startDynamicLeasedScheduler` at `src/runtime/dynamic-leased-scheduler.ts:33` checks only the skipped result and ignores completed `leaseLost`. Queue-concurrency reconciliation also discards the result. Sample callbacks in `src/entrypoints/recovery.ts:72` and `merchant-communications.ts:44` ignore the passed handle.

If an old callback remains active after expiry and a new owner acquires, both callbacks may perform work. This is a permitted scheduler-level overlap, not proof of duplicate messages or accounting: domain CAS, durable claims, queue identities and provider fences can still protect effects.

**Direction:** handle renewal errors immediately; define uncertainty versus confirmed ownership loss; expose an explicit cancellation/fencing state to the callback; check it before subsequent effects; observe/report loss in callers. Independently audit each callback's durable guards. Do not assume cancellation can retract a committed write.

**Validation:** rejected heartbeat while callback is blocked; false heartbeat mid-batch; expiry/takeover with two owners; stale owner's next effect; simultaneous work/cleanup errors preserving the original error. Existing `tests/unit/runtime/background-runtime-lease.test.ts:43` tests resolved false, then deliberately lets work finish. It does not establish rejected-renewal handling or callback stopping.

## R2 — Runtime control reads exist even when queues are empty

**Classification: evidenced recurring footprint, measurement candidate.**

`background-runtime-config.ts:15` refreshes every 5,000 ms. `current()` at line 148 is a process-local read; `getFresh()` at line 153 performs a refresh. Concurrent refreshes within a process coalesce through `refreshInFlight`, and only increasing versions replace the immutable snapshot. Refresh failure is logged and the last valid snapshot is retained after successful startup.

Ignoring query duration, P long-running worker processes produce approximately `12 * P` periodic configuration reads per minute, plus explicit getFresh calls. This is cadence arithmetic, not a measured rate. It should not be counted as a new lookup on every business event.

`queue-concurrency-controller.ts:15` reconciles every 30 seconds and starts in five process types. An uncontended successful cycle uses one lease-acquire query, one fresh-config read and one release query, plus renewals if long-running. A skipped cycle uses the acquisition attempt. It also writes and reads eight queue concurrency values in Redis; those are not PostgreSQL calls.

The lease cadence mapping for QUEUE_CONCURRENCY_RECONCILIATION is zero (`background-runtime-lease.ts:26`), so the lease prevents simultaneous execution but does not prevent staggered replicas from repeating the same reconciliation. Measure whether this modest control footprint matters before centralising it. Preserve eventual repair of queue configuration drift.

Human-command polling adds four discovery/repair paths roughly every three seconds per messaging process even while idle; details appear under MSG-10. Meta polling is bounded but may repeat across replicas; see TEMPLATE-02 in the messaging report.

## R3 — Operation-time platform configuration is different from runtime polling

`services/platform-configuration/repository.ts:11` uses a narrow environment/key lookup. `readBundle` consolidates related keys into one client call; moderation already requests policy and credentials together. This repository intentionally has no process cache. Do not apply a general cache to revocable credentials or moderation policy without defining its freshness contract.

Diagnostics deserve correction separately: `services/platform-configuration/service.ts:130` replaces a caught database error with DB_UNAVAILABLE without retaining its cause. `src/runtime/readiness.ts:54` similarly replaces probe failures. The Woo SQL fence at `services/woocommerce-recovery/woo-initial-send-fence.service.ts:283` logs a synthetic PERSISTENCE_FAILURE error but rethrows the original. The latter does not swallow the exception, but that diagnostic event loses its actual evidence. Preserve the original error through the shared logger/error cause, with secret and sensitive-data redaction; an internal code can remain as an additional field.

## Existing instrumentation

All six `observability/*.mjs` entrypoints invoke the shared `initNodeObservability` with Prisma instrumentation enabled. `package.json` production start scripts preload them. Source configuration does not prove export, sampling, query attribution or deployed coverage, but it means a new generic Prisma telemetry layer should not be proposed without checking the existing capability. The combined development startup differs and must be identified separately during measurement.

## Syntactic inventory method

`database-call-inventory.json` indexes direct Prisma CRUD, raw SQL and transaction-boundary sites, plus separate calls to the local first/rows/changed SQL wrappers. It scans only `src/**/*.ts`. Tests, scripts, generated clients, Shared package implementation and SQL-function internals are excluded.

The scanner uses a bounded lexer to mask comments, strings and regular-expression literals, then recognises method calls and generic type arguments. This is not a complete TypeScript parser or a reachability analysis. ORM receivers must match schema delegates or inspected aliases; generic provider clients are not assumed to be Prisma. The excluded set was independently reviewed and contains hashing, Maps/Sets, Redis candidate stores and provider SDK calls. An independent pass corrected four provider false positives and four previously masked database sites before the final totals were recorded.

Final totals: **433 ORM reads; 358 ORM writes; 236 raw sites; 162 transaction sites = 1,189 direct sites across 198 files**. There are **59 wrapper invocations across 13 files**, and **109 excluded non-database candidates**. Of the direct sites, 1,027 are non-transaction method invocations; this still is not an execution or SQL-statement count.

Examples of why source counts differ from runtime cost: one translation-loop site executes once per item; one raw call may invoke a stored function with several internal statements; a nested Prisma include may expand; an idempotent branch can skip almost all sites; retries repeat work. Use the index as a completeness checklist for subsequent workflow reviews, not a performance ranking.

## Measurement plan for shared mechanics

1. Record actual entrypoint, replica counts, database/client version, pool settings, PostgreSQL limits and any pooler.
2. Reuse approved tracing to capture named jobs through their actual DB statements and relation expansion; keep customer content and credential values out of diagnostics.
3. Separate idle polling, readiness, non-actionable events, actionable recovery, conversation turns and batch work.
4. Record transaction/lock/pool wait, retries and queue age under merchant skew and horizontal concurrency.
5. Run crash/lease-loss/replay experiments on disposable infrastructure and report cleanup evidence. No production experiment is implied by this review.
