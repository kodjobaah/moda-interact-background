import { Queue } from "bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { readWooCouponPolicy } from "../services/platform-configuration/consumers.js";
import prisma from "../lib/db.js";
import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "../runtime/background-runtime-lease.js";
import { startDynamicLeasedScheduler } from "../runtime/dynamic-leased-scheduler.js";
import { startQueueConcurrencyController } from "../runtime/queue-concurrency-controller.js";
import { checkoutRecoveryExpiryService } from "../services/checkout-recovery-expiry.service.js";
import { WooCouponDispatcherService, WOO_COUPON_SYNC_QUEUE_NAME } from "../services/woo-coupon-dispatcher.service.js";

const wooDispatchLogger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});

void startReadyWorkerProcess({
  serviceName: "moda-recovery-worker",
  loadWorkerProcess: async () => {
    await backgroundRuntimeConfigService.start();
    const [
      { closeWorkerResources },
      { createPendingRecoveryCandidateWorker },
      { createRecoveryCapacityResumeWorker },
      { createRecoveryOutreachFollowUpWorker },
      { createShopifyDiscountSyncWorker },
      { createWooCouponSyncWorker },
      { recoveryCapacityResumeService },
      { recoveryOutreachFollowUpService },
    ] = await Promise.all([
      import("./resources.js"),
      import("../workers/pending-recovery-candidate.worker.js"),
      import("../workers/recovery-capacity-resume.worker.js"),
      import("../workers/recovery-outreach-follow-up.worker.js"),
      import("../workers/shopify-discount-sync.worker.js"),
      import("../workers/woo-coupon-sync.worker.js"),
      import("../services/recovery-capacity-resume.service.js"),
      import("../services/recovery-outreach-follow-up.service.js"),
    ]);
    const { createWooRecoveryRuntime } = await import("../services/woocommerce-recovery/woo-recovery-composition.js");
    const wooRecovery = createWooRecoveryRuntime("moda-recovery-worker");
    const pendingRecoveryCandidateWorker =
      createPendingRecoveryCandidateWorker(wooRecovery.orchestrator);
    const recoveryCapacityResumeWorker = createRecoveryCapacityResumeWorker();
    const recoveryOutreachFollowUpWorker =
      createRecoveryOutreachFollowUpWorker();
    const shopifyDiscountSyncWorker = createShopifyDiscountSyncWorker();
    const wooCouponSyncWorker = createWooCouponSyncWorker(undefined, (await readWooCouponPolicy()).workerConcurrency);
    const wooCouponSyncQueue = new Queue(WOO_COUPON_SYNC_QUEUE_NAME, { connection: connectionRedis });
    const stopQueueConcurrencyController =
      await startQueueConcurrencyController({
        config: backgroundRuntimeConfigService,
        lease: backgroundRuntimeLeaseService,
      });

    const stopRepairScheduler = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "RECOVERY_CAPACITY_REPAIR",
      intervalMs: 5 * 60 * 1000,
      runImmediately: true,
      getIntervalMs: (runtimeConfig) =>
        runtimeConfig.recoveryRepairIntervalSeconds * 1000,
      run: async (runtimeConfig) => {
        await recoveryCapacityResumeService.repair(runtimeConfig);
      },
      onError: (error) => {
        console.error("Recovery capacity repair failed", error);
      },
    });
    const stopExpiryScheduler = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "CHECKOUT_RECOVERY_EXPIRY",
      intervalMs: 60 * 60 * 1000,
      runImmediately: true,
      run: async (runtimeConfig) => {
        await checkoutRecoveryExpiryService.expireInactive(runtimeConfig);
      },
      onError: (error) => {
        console.error("Checkout recovery expiry failed", error);
      },
    });

    // All replicas attempt this tick, but only the PostgreSQL lease holder
    // discovers and dispatches due shops. Never run provider I/O under this lease.
    const stopWooCouponDispatcher = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "WOO_COUPON_SYNC_DISPATCH",
      intervalMs: 60_000,
      runImmediately: true,
      run: async () => {
        // The dispatcher is re-created with current policy on every lease cycle.
        const cycle = await readWooCouponPolicy();
        await new WooCouponDispatcherService(prisma, wooCouponSyncQueue, cycle).dispatch(cycle.dispatchBatchSize);
      },
      onError: () => {
        // Do not log arbitrary provider or database error messages.
        try { wooDispatchLogger.error("woo.coupon_sync.dispatch_failed", { reason: "dispatch_error" }); } catch { /* telemetry isolation */ }
      },
    });

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: [
        "pending-recovery-candidates",
        "recovery-capacity-resume",
        "recovery-outreach-follow-up",
        "shopify-discount-sync",
        WOO_COUPON_SYNC_QUEUE_NAME,
      ],
    });

    return {
      workers: [
        pendingRecoveryCandidateWorker,
        recoveryCapacityResumeWorker,
        recoveryOutreachFollowUpWorker,
        shopifyDiscountSyncWorker,
        wooCouponSyncWorker,
      ],
      // startWorkerProcess closes workers first. Then stop producers before
      // closing their queue, and only then disconnect shared Redis/Postgres.
      closeResources: [async () => {
        const stopFunctions = [
          stopQueueConcurrencyController,
          wooRecovery.close,
          stopRepairScheduler,
          stopExpiryScheduler,
          stopWooCouponDispatcher,
          closeWorkerObservability,
          () => backgroundRuntimeConfigService.close(),
          () => recoveryCapacityResumeService.close(),
          () => recoveryOutreachFollowUpService.close(),
          closeQueuePerformanceTelemetry,
        ];
        const stopResults = await Promise.allSettled(stopFunctions.map((stop) => stop()));
        const queueResults = await Promise.allSettled([wooCouponSyncQueue.close()]);
        const connectionResults = await Promise.allSettled(closeWorkerResources.map((close) => close()));
        const results: PromiseSettledResult<unknown>[] = [
          ...stopResults, ...queueResults, ...connectionResults,
        ];
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) throw new AggregateError(failures, "Recovery resources failed to close");
      }],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(
    error instanceof Error ? error.message : "worker readiness failed",
  );
  await closeWorkerObservability();
  process.exitCode = 1;
}
