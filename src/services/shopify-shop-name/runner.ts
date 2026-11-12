import { createLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { ShopNameRepository } from "./repository.js";
import { NAME_SCAN_MS } from "./contracts.js";
import { ShopifyAdminNameReader } from "./reader.js";
import { ShopNameSyncService } from "./service.js";

const logger = createLogger({ serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName() });

export async function startShopifyShopNameSync(override?: Pick<ShopNameSyncService, "reconcileOnce">): Promise<() => Promise<void>> {
  const service = override ?? new ShopNameSyncService({
    repository: new ShopNameRepository(prisma),
    reader: new ShopifyAdminNameReader(),
    logger,
  });
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = service.reconcileOnce().then(() => undefined).catch((error: unknown) => {
      logger.error("shop_brand.name.schedule_failed", {
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
    timer = setTimeout(tick, NAME_SCAN_MS);
    timer.unref();
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
