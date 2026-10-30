import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { createProductionShopBrandMediaProcessor } from "../shop-brand-media/index.js";
import { MEDIA_SCAN_INTERVAL_MS } from "./contracts.js";
import { ShopBrandMediaRepository } from "./repository.js";
import { ShopBrandMediaReconciliationService } from "./service.js";

const logger = createLogger({ serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName() });

/**
 * Co-locate with the existing Recovery worker; no new Render service, DB lease enum, or
 * durable BullMQ job is required. Replicas may scan concurrently: row locks/CAS arbitrate.
 */
export async function startShopBrandMediaReconciler(): Promise<() => Promise<void>> {
  const { default: prisma } = await import("../../lib/db.js").catch((error: unknown) => {
    logger.error("shop_brand.media.start_failed", {
      reasonCode: "DATABASE_CLIENT_IMPORT_FAILURE",
      exceptionType: error instanceof Error ? "Error" : "NonErrorThrownValue",
      errorMessage: error instanceof Error ? error.message : String(error),
      error: error,
    });
    throw error;
  });
  // Do not load Cloudflare credentials at worker startup: missing optional credentials
  // cause an observable, retryable media-processing failure, not recovery-worker outage.
  let processor: ReturnType<typeof createProductionShopBrandMediaProcessor> | null = null;
  const service = new ShopBrandMediaReconciliationService({
    repository: new ShopBrandMediaRepository(prisma, logger),
    processor: {
      process: async (input) => {
        processor ??= createProductionShopBrandMediaProcessor();
        return processor.process(input);
      },
    },
    logger,
  });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const tick = (): void => {
    if (stopped || running) return;
    running = service.reconcileOnce().then(() => undefined).catch((error: unknown) => {
      logger.error("shop_brand.media.reconciliation_failed", {
        reasonCode: error instanceof AggregateError ? "PARTIAL_FAILURE" : "SWEEP_FAILED",
        exceptionType: error instanceof AggregateError ? "AggregateError" :
          error instanceof Error ? "Error" : "NonErrorThrownValue",
        failureCount: error instanceof AggregateError ? error.errors.length : 1,
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
    }).finally(() => {
      running = undefined;
      if (!stopped) schedule();
    });
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(tick, MEDIA_SCAN_INTERVAL_MS);
    timer.unref();
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
