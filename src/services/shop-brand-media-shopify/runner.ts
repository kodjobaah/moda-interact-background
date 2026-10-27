import { createLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { ShopBrandMediaRepository } from "../shop-brand-media-orchestration/repository.js";
import { SHOPIFY_BRAND_SYNC_SCAN_INTERVAL_MS } from "./contracts.js";
import { ShopifyAdminBrandReader } from "./reader.js";
import { ShopifyBrandSourceSyncService, type ShopifyGrant } from "./service.js";

const logger = createLogger({ serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName() });

export async function startShopifyBrandSourceSync(): Promise<() => Promise<void>> {
  const service = new ShopifyBrandSourceSyncService({
    repository: new ShopBrandMediaRepository(prisma, logger),
    reader: new ShopifyAdminBrandReader(),
    grantForShop: async (domain): Promise<ShopifyGrant> => {
      // The existing token service handles expiring offline-token refresh after this scope check.
      const session = await prisma.session.findFirst({
        where: { shop: domain, isOnline: false },
        select: { scope: true }, orderBy: { expires: "desc" },
      });
      if (!session) return "NO_OFFLINE_SESSION";
      return session.scope?.split(",").some((scope) => scope.trim() === "read_brand")
        ? "GRANTED" : "MISSING_READ_BRAND_SCOPE";
    },
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
