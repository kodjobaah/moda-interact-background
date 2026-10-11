import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "../runtime/background-runtime-lease.js";
import { startDynamicLeasedScheduler } from "../runtime/dynamic-leased-scheduler.js";
import { translationReconciliationService } from "../services/translation-reconciliation.service.js";
import { storeCategoryTranslationReconciliationService } from "../services/store-category-translation-reconciliation.service.js";
import { merchantPricingTranslationReconciliationService } from "../services/merchant-pricing-translation-reconciliation.service.js";
import { merchantPricingTranslationPublicationService } from "../services/merchant-pricing-translation-publication.service.js";
import { storeCategoryTranslationPublicationService } from "../services/store-category-translation-publication.service.js";
import { startQueueConcurrencyController } from "../runtime/queue-concurrency-controller.js";

void startReadyWorkerProcess({
  serviceName: "moda-merchant-communications-worker",
  loadWorkerProcess: async () => {
    await backgroundRuntimeConfigService.start();
    const [{ closeWorkerResources }, { createMerchantCommunicationsWorker }] = await Promise.all([
      import("./resources.js"),
      import("../workers/merchant-communications.worker.js"),
    ]);
    const merchantCommunicationsWorker = createMerchantCommunicationsWorker();
    const stopQueueConcurrencyController = await startQueueConcurrencyController({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
    });
    const stopScheduler = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "TRANSLATION_RECONCILIATION",
      intervalMs: 0,
      runImmediately: true,
      getIntervalMs: (snapshot) => snapshot.translationReconciliationIntervalSeconds * 1000,
      run: async (snapshot) => {
        const reconciliationOutcomes = await Promise.allSettled([
          translationReconciliationService.reconcile(undefined, snapshot),
          storeCategoryTranslationReconciliationService.reconcile(snapshot),
          merchantPricingTranslationReconciliationService.reconcile(snapshot),
        ]);
        const publicationOutcomes = await Promise.allSettled([
          storeCategoryTranslationPublicationService.reconcile(
            snapshot.translationReconciliationPageSize,
          ),
          merchantPricingTranslationPublicationService.reconcile(
            snapshot.translationReconciliationPageSize,
          ),
        ]);
        const failures = [...reconciliationOutcomes, ...publicationOutcomes].filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            "translation reconciliation failed",
          );
        }
      },
      onError: (error) => console.error("translation reconciliation failed", error),
    });

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["merchant-communications"],
    });

    return {
      workers: [merchantCommunicationsWorker],
      closeResources: [
        ...closeWorkerResources,
        stopQueueConcurrencyController,
        stopScheduler,
        () => backgroundRuntimeConfigService.close(),
        () => translationReconciliationService.close(),
        () => storeCategoryTranslationReconciliationService.close(),
        () => merchantPricingTranslationReconciliationService.close(),
        closeWorkerObservability,
        closeQueuePerformanceTelemetry,
      ],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}