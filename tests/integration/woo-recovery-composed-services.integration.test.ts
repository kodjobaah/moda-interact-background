import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { outboundWhatsAppAdmissionService } from "../../src/services/outbound-whatsapp-admission.service.js";
import { whatsappTemplateSelectorService } from "../../src/services/whatsapp-template-selector.service.js";
import { connectionRedis } from "../../src/lib/redis.js";
import { WooCheckoutLeaseGuard } from "../../src/services/pending-recovery-candidate/checkout-order-guard.service.js";
import { PendingRecoveryCandidateIndexStore } from "../../src/services/pending-recovery-candidate/candidate-index.store.js";
import { PENDING_RECOVERY_CANDIDATE_QUEUE } from "../../src/domain/pending-recovery-candidate.js";
import { WooCheckoutCoordinatorService, WooOrderReconciliationService, WooOrderTerminalEvidenceStore } from "../../src/services/woocommerce-recovery/woo-order-reconciliation.service.js";
import { WooPendingCandidateQueueService, wooCandidateJobId } from "../../src/services/woocommerce-recovery/woo-candidate-queue.service.js";
import { WooRecoveryAdmissionService } from "../../src/services/woocommerce-recovery/woo-recovery-admission.service.js";
import { createWooCheckoutActivityService } from "../../src/services/woocommerce-recovery/woo-checkout-activity.service.js";
import { createWooRecoveryOutreachService } from "../../src/services/woocommerce-recovery/woo-recovery-outreach.adapters.js";
import { WooInitialDispatchQueue } from "../../src/services/woocommerce-recovery/woo-initial-dispatch.queue.js";
import { WooRecoveryOrchestratorService } from "../../src/services/woocommerce-recovery/woo-recovery-orchestrator.service.js";
import { createPendingRecoveryCandidateWorker } from "../../src/workers/pending-recovery-candidate.worker.js";
import { createWooOutreachFixture, type WooOutreachIntegrationFixture } from "./fixtures/arch048-woo-outreach.fixture.js";

vi.mock("../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: {
    current: () => ({ version: 1, pendingRecoveryQueueGlobalConcurrency: 1 }),
    subscribe: () => () => undefined,
  },
}));

const integrated = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Woo composed pipeline did not reach durable completion");
}

integrated("ARCH-048-BG005 real Woo services through BullMQ and Postgres", () => {
  let fixture: WooOutreachIntegrationFixture | undefined;
  afterEach(async () => {
    try { if (fixture) await fixture.cleanup(); }
    finally { fixture = undefined; vi.restoreAllMocks(); }
  });

  it("composes BG001 checkout → BG003 consent/admission → BG004 attempt and credit → BG002 terminal order", async () => {
    vi.spyOn(outboundWhatsAppAdmissionService, "getProviderAccountId").mockResolvedValue("test-meta-account");
    vi.spyOn(whatsappTemplateSelectorService, "select").mockResolvedValue({
      outcome: "selected", verifiedCategory: "MARKETING", selectionSource: "merchant-fallback",
      canonicalLanguageTag: "en-GB", providerLanguageCode: "en_GB",
      providerTemplateName: "woo_checkout_recovery", providerTemplateId: "test-template-id",
      marketCapability: "supported",
    });
    fixture = await createWooOutreachFixture();
    const f = fixture;
    await f.db.shop.update({ where: { id: f.shopId }, data: { onboardingCompleted: true } });
    const sourceQueue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const initialQueue = new WooInitialDispatchQueue();
    const index = new PendingRecoveryCandidateIndexStore();
    const candidates = new WooPendingCandidateQueueService(sourceQueue, index);
    const coordinator = new WooCheckoutCoordinatorService(new WooCheckoutLeaseGuard());
    const orders = new WooOrderTerminalEvidenceStore(connectionRedis);
    const logger = createLogger({ serviceName: "moda-recovery-worker", environment: "test", sink: () => undefined });
    const outreach = createWooRecoveryOutreachService({
      coordinator, orders, guardedSender: f.guardedSender, enqueue: initialQueue, logger,
      enableTestOutbound: () => true,
    });
    const orchestrator = new WooRecoveryOrchestratorService({
      checkout: createWooCheckoutActivityService({ coordinator, observedOrders: orders, candidates }),
      order: new WooOrderReconciliationService(f.db, candidates, coordinator, orders, logger),
      admission: new WooRecoveryAdmissionService({ coordinator, candidates, orders, database: f.db, logger }),
      outreach, logger,
      async assertWooShop(shopId) {
        const shop = await f.db.shop.findUnique({ where: { id: shopId }, select: { platform: true } });
        if (shop?.platform !== "WOOCOMMERCE") throw new Error("WOO_RECOVERY_SHOP_PLATFORM_MISMATCH");
      },
      async assertInitialAttempt(recoveryId, attemptId) {
        const attempt = await f.db.recoveryOutreachAttempt.findUnique({ where: { id: attemptId } });
        if (!attempt || attempt.checkoutRecoveryId !== recoveryId || attempt.sequence !== 1)
          throw new Error("WOO_INITIAL_DISPATCH_OWNERSHIP_MISMATCH");
      },
      async clearMatured(candidate, jobId) { await index.remove(candidate, jobId); },
    });
    const checkoutToken = `new-checkout-${randomUUID()}`;
    const event = {
      schemaVersion: "woo.activity.v1" as const, shopId: f.shopId,
      eventId: `evt-${randomUUID()}`, eventType: "CHECKOUT_UPDATED" as const,
      checkoutKey: checkoutToken, occurredAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      checkout: { currency: "GBP", total: "20.00", items: [{ quantity: 1, title: "Test product" }],
        contact: { phone: "+447400123456" } },
    };
    let worker: ReturnType<typeof createPendingRecoveryCandidateWorker> | undefined;
    try {
      expect((await orchestrator.onCheckout(event)).kind).toBe("scheduled");
      const candidateId = wooCandidateJobId({ shopId: f.shopId, checkoutToken });
      expect((await sourceQueue.getJob(candidateId))?.data.source).toBe("woocommerce");
      worker = createPendingRecoveryCandidateWorker(orchestrator);
      await worker.waitUntilReady();
      await eventually(async () => (await f.db.checkoutRecovery.findFirst({
        where: { shopId: f.shopId, checkoutToken, status: "MESSAGE_SENT" },
      })) !== null);
      const recovered = await f.db.checkoutRecovery.findFirstOrThrow({ where: { shopId: f.shopId, checkoutToken } });
      const attempts = await f.db.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: recovered.id } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ sequence: 1, status: "WAITING_FOR_RESPONSE", followUpDueAt: null });
      expect(f.providerRequests).toBe(1);
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: recovered.id, sequence: 2 } })).toBe(0);
      expect(await f.db.usageEvent.count({ where: {
        shopId: f.shopId, metric: "RECOVERY_CONVERSATION",
      } })).toBe(1);
      expect((await orchestrator.onCheckout({ ...event, eventId: `evt-${randomUUID()}` })).kind)
        .toBe("existing-recovery");
      expect(f.providerRequests).toBe(1);
      // A local STOP received after the first send may not create a second send.
      await f.stop();
      await expect(orchestrator.onInitialDispatch(recovered.id, attempts[0]!.id))
        .resolves.toMatchObject({ kind: "already-initialized" });
      expect(f.providerRequests).toBe(1);
      expect((await orchestrator.onOrder({
        schemaVersion: "woo.activity.v1", eventId: `order-${randomUUID()}`,
        eventType: "ORDER_PAID", shopId: f.shopId, checkoutKey: checkoutToken,
        occurredAt: new Date().toISOString(),
        order: { orderId: `woo-order-${randomUUID()}`, checkoutKey: checkoutToken, status: "completed" },
      })).kind).toBe("paid-terminal");
      expect((await f.db.checkoutRecovery.findUniqueOrThrow({ where: { id: recovered.id } })).status)
        .toBe("COMPLETED");
      expect(f.providerRequests).toBe(1);
    } finally {
      if (worker) await worker.close();
      await Promise.allSettled([candidates.cancelPending({ shopId: f.shopId, checkoutToken })]);
      await sourceQueue.close();
      await initialQueue.close();
    }
  }, 100_000);
});
