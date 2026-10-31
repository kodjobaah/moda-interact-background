import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
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
import { templateTranslationCoordinator } from "../services/template-translation/reconciliation.js";
import { closeTemplateTranslationWorkerResources } from "../workers/template-translation.worker.js";

const logger = createLogger({
  serviceName: "moda-merchant-communications-worker",
  environment: resolveDeploymentEnvironmentName(),
});

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
          templateTranslationCoordinator.reconcile(snapshot.translationReconciliationPageSize),
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
      onError: (error) => logger.error("background.merchant_communications.reconciliation_failed", {
        error, errorName: error instanceof Error ? error.name.slice(0, 128) : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
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
        () => templateTranslationCoordinator.close(),
        closeTemplateTranslationWorkerResources,
        closeWorkerObservability,
        closeQueuePerformanceTelemetry,
      ],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  logger.error("background.merchant_communications.readiness_failed", {
    error, errorName: error instanceof Error ? error.name.slice(0, 128) : "unknown",
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  await closeWorkerObservability();
  process.exitCode = 1;
}