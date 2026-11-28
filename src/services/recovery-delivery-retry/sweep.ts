import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { InitialDeliveryRetryExecutionService } from "./execution.js";
import type { ScheduledFollowUpRetryExecutionService } from "./follow-up-execution.js";
import type { ScheduledFollowUpRetryReconciliationService } from "./follow-up-reconciliation.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";

export const retryWorkerEnabled = (value: string | undefined): boolean =>
  value === "1";

type Executor = Pick<
  InitialDeliveryRetryExecutionService,
  "runDuePage" | "reconcileClaimedPage"
>;
type FollowUpReconciler = Pick<
  ScheduledFollowUpRetryReconciliationService,
  "reconcilePage"
>;
type FollowUpExecutor = Pick<
  ScheduledFollowUpRetryExecutionService,
  "runDuePage"
>;
type DueCursor = NonNullable<Parameters<Executor["runDuePage"]>[0]["after"]>;

/** PostgreSQL is the durable work list. Cursors are only fair, bounded scan
 * progress within a process. A restart begins a new sweep; the executor's
 * checkout lease, deterministic attempt and provider permit own concurrency.
 * No scheduler-wide provider retry and no overlapping cycles in a process. */
export class RecoveryDeliveryRetrySweep {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  private dueCursor: DueCursor | undefined;
  private reconcileCursor: string | undefined;
  private followUpReconcileCursor: string | undefined;
  private followUpDueCursor: DueCursor | undefined;

  constructor(
    private readonly executor: Executor,
    private readonly log: StructuredLogger,
    private readonly intervalMs = 60_000,
    private readonly pageSize = 5,
    private readonly followUpReconciler?: FollowUpReconciler,
    private readonly followUpExecutor?: FollowUpExecutor,
  ) {
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 250
    )
      throw new RangeError(
        "Invalid recovery delivery retry sweep configuration",
      );
    if (followUpExecutor && !followUpReconciler)
      throw new Error("Follow-up retry execution requires reconciliation");
  }

  start(): this {
    if (this.started || this.stopped)
      throw new Error("Recovery delivery retry sweep cannot be started twice");
    this.started = true;
    this.log.info("recovery.delivery_retry.worker_started", {
      intervalMs: this.intervalMs,
      pageSize: this.pageSize,
    });
    this.schedule(0);
    return this;
  }

  /** A single cycle is public for deterministic disposable integration tests. */
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.cycle().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        .catch((error) => {
          this.log.error("recovery.delivery_retry.sweep_failed", {
            sourceError: initialOutreachDiagnostic(error),
          });
        })
        .finally(() => this.schedule(this.intervalMs));
    }, ms);
    this.timer.unref();
  }

  private async cycle(): Promise<void> {
    const start = performance.now();
    let reconciled = 0;
    let followUpReconciled = 0;
    let due = 0;
    let followUpDue = 0;
    let errors = 0;
    try {
      const page = await this.executor.reconcileClaimedPage({
        limit: this.pageSize,
        ...(this.reconcileCursor ? { afterId: this.reconcileCursor } : {}),
      });
      this.reconcileCursor = page.next ?? undefined;
      reconciled = page.outcomes.length;
      errors += page.outcomes.filter((item) => item.kind === "error").length;
    } catch (error) {
      errors++;
      this.log.error("recovery.delivery_retry.sweep_page_failed", {
        stage: "reconcile",
        sourceError: initialOutreachDiagnostic(error),
      });
    }
    // Reconcile existing follow-up funding before either discovery page.
    // The executor also reconciles the individual block before any permit.
    if (!this.stopped && this.followUpReconciler) {
      try {
        const page = await this.followUpReconciler.reconcilePage({
          limit: this.pageSize,
          ...(this.followUpReconcileCursor
            ? { afterId: this.followUpReconcileCursor }
            : {}),
        });
        this.followUpReconcileCursor = page.next ?? undefined;
        followUpReconciled = page.outcomes.length;
        errors += page.outcomes.filter((item) => item.kind === "error").length;
      } catch (error) {
        errors++;
        this.log.error("recovery.delivery_retry.sweep_page_failed", {
          stage: "follow-up-reconcile",
          sourceError: initialOutreachDiagnostic(error),
        });
      }
    }
    if (!this.stopped) {
      try {
        const page = await this.executor.runDuePage({
          limit: this.pageSize,
          ...(this.dueCursor ? { after: this.dueCursor } : {}),
        });
        this.dueCursor = page.next ?? undefined;
        due = page.outcomes.length;
        errors += page.outcomes.filter((item) => item.kind === "error").length;
      } catch (error) {
        errors++;
        this.log.error("recovery.delivery_retry.sweep_page_failed", {
          stage: "discover",
          sourceError: initialOutreachDiagnostic(error),
        });
      }
    }
    if (!this.stopped && this.followUpExecutor) {
      try {
        const page = await this.followUpExecutor.runDuePage({
          limit: this.pageSize,
          ...(this.followUpDueCursor ? { after: this.followUpDueCursor } : {}),
        });
        this.followUpDueCursor = page.next ?? undefined;
        followUpDue = page.outcomes.length;
        errors += page.outcomes.filter((item) => item.kind === "error").length;
      } catch (error) {
        errors++;
        this.log.error("recovery.delivery_retry.sweep_page_failed", {
          stage: "follow-up-discover",
          sourceError: initialOutreachDiagnostic(error),
        });
      }
    }
    if (due || reconciled || followUpReconciled || followUpDue || errors)
      this.log.debug("recovery.delivery_retry.sweep_completed", {
        due,
        reconciled,
        ...(this.followUpReconciler ? { followUpReconciled } : {}),
        ...(this.followUpExecutor ? { followUpDue } : {}),
        errors,
        elapsedMs: Math.round(performance.now() - start),
      });
  }

  async close(): Promise<void> {
    if (this.stopped) {
      await this.running;
      return;
    }
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    this.log.info("recovery.delivery_retry.worker_stopped");
  }
}
