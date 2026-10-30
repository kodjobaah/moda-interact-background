import { createLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../../lib/db.js";
import { connectionRedis } from "../../lib/redis.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { PendingRecoveryCandidateIndexStore } from "../pending-recovery-candidate/candidate-index.store.js";
import { WooCheckoutLeaseGuard } from "../pending-recovery-candidate/checkout-order-guard.service.js";
import { recoveryConsentMerchantNoticeService } from "../checkout-recovery/recovery-consent-merchant-notice.service.js";
import { WooCheckoutCoordinatorService, WooOrderReconciliationService, WooOrderTerminalEvidenceStore } from "./woo-order-reconciliation.service.js";
import {
  WooPendingCandidateQueueService, getWooCandidateQueue, wooCandidateJobId,
  type WooCandidateQueuePort, type WooCandidateIndexPort,
} from "./woo-candidate-queue.service.js";
import { createWooCheckoutActivityService } from "./woo-checkout-activity.service.js";
import { WooRecoveryAdmissionService } from "./woo-recovery-admission.service.js";
import { createWooRecoveryConsentDeniedAdmissionNotifier } from "./woo-recovery-consent-notice.adapter.js";
import { createWooGuardedInitialSender } from "./woo-guarded-initial-sender.service.js";
import { createWooRecoveryOutreachService } from "./woo-recovery-outreach.adapters.js";
import { WooInitialDispatchQueue } from "./woo-initial-dispatch.queue.js";
import { WooRecoveryOrchestratorService } from "./woo-recovery-orchestrator.service.js";
import type { WooPendingCandidate } from "./contracts.js";
import type { WooCheckoutCoordinator } from "./contracts.js";

export async function clearMaturedWooCandidate(
  dependencies: {
    coordinator: Pick<WooCheckoutCoordinator, "withCheckoutLock">;
    index: Pick<WooCandidateIndexPort, "findByCheckout" | "compareAndRemoveCheckout">;
    queue: Pick<WooCandidateQueuePort, "getJob">;
  },
  candidate: WooPendingCandidate,
  jobId: string,
): Promise<void> {
  const ref = { shopId: candidate.shopId, checkoutToken: candidate.checkoutToken };
  await dependencies.coordinator.withCheckoutLock(ref, async () => {
    if (await dependencies.index.findByCheckout(ref) !== jobId) return;
    if (wooCandidateJobId(ref, candidate.generation) !== jobId) {
      throw new Error("WOO_MATURED_JOB_GENERATION_MISMATCH");
    }
    const job = await dependencies.queue.getJob(jobId);
    if (!job || job.data.source !== "woocommerce" ||
      job.data.shopId !== candidate.shopId || job.data.checkoutToken !== candidate.checkoutToken ||
      job.data.generation !== candidate.generation ||
      job.data.lastEventId !== candidate.lastEventId ||
      job.data.lastActivityAt !== candidate.lastActivityAt) {
      throw new Error("WOO_MATURED_INDEX_OWNERSHIP_CHANGED");
    }
    // The checkout pointer can now belong to the successor generation.
    // Compare-and-delete preserves that successor under a stale job race.
    await dependencies.index.compareAndRemoveCheckout(ref, jobId);
  });
}

/** One coordinator + candidate store per process, backed by the same Redis
 * checkout lease. All provider, consent and billing behaviour belongs to the
 * accepted services, not this composition root. */
export function createWooRecoveryRuntime(serviceName: "moda-shopify-event-worker" | "moda-recovery-worker") {
  const logger = createLogger({ serviceName, environment: resolveDeploymentEnvironmentName() });
  const coordinator = new WooCheckoutCoordinatorService(new WooCheckoutLeaseGuard());
  const observedOrders = new WooOrderTerminalEvidenceStore(connectionRedis);
  const candidateQueue = getWooCandidateQueue();
  const index = new PendingRecoveryCandidateIndexStore();
  const candidates = new WooPendingCandidateQueueService(candidateQueue, index);
  const initialQueue = new WooInitialDispatchQueue();
  const guardedSender = createWooGuardedInitialSender({ orders: observedOrders, logger });
  // A missing ARCH-046 final permit is a startup error, never a fallback to
  // the generic sendTemplate path (which lacks Woo's final SQL consent gate).
  if (!guardedSender || typeof guardedSender.sendInitial !== "function" ||
    typeof guardedSender.findExistingAdmission !== "function") {
    throw new Error("Woo guarded initial sender unavailable");
  }
  const outreach = createWooRecoveryOutreachService({
    coordinator, orders: observedOrders, guardedSender,
    enqueue: initialQueue, logger,
  });
  const orchestrator = new WooRecoveryOrchestratorService({
    checkout: createWooCheckoutActivityService({ coordinator, observedOrders, candidates }),
    order: new WooOrderReconciliationService(prisma, candidates, coordinator, observedOrders, logger),
    admission: new WooRecoveryAdmissionService({
      coordinator, candidates, orders: observedOrders, logger,
      onDeniedAdmission: createWooRecoveryConsentDeniedAdmissionNotifier({
        candidates, notifier: recoveryConsentMerchantNoticeService, logger,
      }),
    }),
    outreach,
    logger,
    async assertWooShop(shopId) {
      const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { platform: true } });
      if (shop?.platform !== "WOOCOMMERCE") throw new Error("WOO_RECOVERY_SHOP_PLATFORM_MISMATCH");
    },
    async assertInitialAttempt(recoveryId, attemptId) {
      const attempt = await prisma.recoveryOutreachAttempt.findUnique({
        where: { id: attemptId },
        select: { checkoutRecoveryId: true, sequence: true,
          checkoutRecovery: { select: { shop: { select: { platform: true } } } },
        },
      });
      if (!attempt || attempt.checkoutRecoveryId !== recoveryId || attempt.sequence !== 1 ||
        attempt.checkoutRecovery.shop.platform !== "WOOCOMMERCE") {
        throw new Error("WOO_INITIAL_DISPATCH_OWNERSHIP_MISMATCH");
      }
    },
    clearMatured: (candidate, jobId) => clearMaturedWooCandidate(
      { coordinator, index, queue: candidateQueue }, candidate, jobId,
    ),
  });

  return {
    orchestrator,
    async close(): Promise<void> {
      const results = await Promise.allSettled([initialQueue.close(), candidateQueue.close()]);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Woo recovery queue cleanup failed");
    },
  };
}
