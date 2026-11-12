import { createLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { ShopifyBrandSourceRepository } from "./repository.js";
import { SHOPIFY_BRAND_SYNC_SCAN_INTERVAL_MS } from "./contracts.js";
import { ShopifyPublicBrandReader } from "./reader.js";
import { ShopifyBrandSourceSyncService } from "./service.js";

const logger = createLogger({ serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName() });

export async function startShopifyBrandSourceSync(override?: Pick<ShopifyBrandSourceSyncService, "reconcileOnce">): Promise<() => Promise<void>> {
  const service = override ?? new ShopifyBrandSourceSyncService({
    repository: new ShopifyBrandSourceRepository(prisma),
    reader: new ShopifyPublicBrandReader(),
    logger,
  });
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = service.reconcileOnce().then(() => undefined).catch((error: unknown) => {
      logger.error("shop_brand.shopify.schedule_failed", {
        reasonCode: error instanceof AggregateError ? "PARTIAL_FAILURE" : "SWEEP_FAILED",
        exceptionType: error instanceof Error ? "Error" : "NonErrorThrownValue",
        failureCount: error instanceof AggregateError ? error.errors.length : 1,
      });
    }).finally(() => {
      running = undefined;
      if (!stopped) schedule();
    });
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, SHOPIFY_BRAND_SYNC_SCAN_INTERVAL_MS);
    timer.unref();
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
