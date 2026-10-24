import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooOrderCapture } from "../../src/events/woo-order-capture.js";
import type { WooCandidateManager } from "../../src/services/woocommerce-recovery/contracts.js";
import { WooCheckoutLeaseGuard } from "../../src/services/pending-recovery-candidate/checkout-order-guard.service.js";
import {
  WooCheckoutCoordinatorService,
  WooOrderReconciliationService,
  WooOrderTerminalEvidenceStore,
  WOO_ORDER_EVIDENCE_TTL_MS,
} from "../../src/services/woocommerce-recovery/woo-order-reconciliation.service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = databaseUrl && redisUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

integration("ARCH-048-BACKGROUND-002 PostgreSQL + Redis order reconciliation", () => {
  it("retains a terminal order-first marker beyond one hour and creates no recovery", async () => {
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const database = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shopId = `woo-arch048-${randomUUID()}`;
    const checkoutToken = `checkout-${randomUUID()}`;
    const orderId = `order-${randomUUID()}`;
    const markerKey = `woo-recovery:observed-order:v1:${createHash("sha256").update(shopId).update("\0").update(checkoutToken).digest("hex")}`;
    const candidate: WooCandidateManager = {
      getPending: async () => null,
      cancelPending: vi.fn(async () => "absent" as const),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as StructuredLogger;
    const evidence = new WooOrderTerminalEvidenceStore(redis);
    const coordinator = new WooCheckoutCoordinatorService(new WooCheckoutLeaseGuard(redis));
    const reconciler = new WooOrderReconciliationService(database, candidate, coordinator, evidence, logger);
    const input: WooOrderCapture = {
      schemaVersion: "woo.activity.v1", shopId, checkoutKey: checkoutToken,
      eventId: `evt-${randomUUID()}`, eventType: "ORDER_PAID",
      occurredAt: new Date().toISOString(),
      order: { orderId, checkoutKey: checkoutToken, status: "processing" },
    };
    try {
      await database.shop.create({ data: { id: shopId, domain: `${shopId}.example.test`, platform: "WOOCOMMERCE", status: "ACTIVE" } });
      await expect(reconciler.reconcileOrder(input)).resolves.toEqual({ kind: "paid-terminal" });
      expect(await evidence.read({ shopId, checkoutToken })).toEqual({ kind: "order-paid", orderId });
      expect(await database.checkoutRecovery.count({ where: { shopId, checkoutToken } })).toBe(0);
      // An actual Redis expiry, not a mocked TTL: max allowed seven-day
      // merchant delay + 48 hours, so the old one-hour marker is insufficient.
      const ttl = await redis.pttl(markerKey);
      expect(ttl).toBeGreaterThan(60 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(WOO_ORDER_EVIDENCE_TTL_MS);
      await expect(reconciler.reconcileOrder(input)).resolves.toEqual({ kind: "ignored-duplicate", reason: "event-replayed" });
    } finally {
      await redis.del(markerKey);
      await database.shop.deleteMany({ where: { id: shopId } });
      await database.$disconnect();
      await redis.quit();
    }
  }, 45_000);

  it("reconciles an already-delivered recovery with no candidate, and concurrent retries record one history", async () => {
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const database = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shopId = `woo-arch048-${randomUUID()}`;
    const checkoutToken = `checkout-${randomUUID()}`;
    const recoveryId = randomUUID();
    const markerKey = `woo-recovery:observed-order:v1:${createHash("sha256").update(shopId).update("\0").update(checkoutToken).digest("hex")}`;
    const candidate: WooCandidateManager = {
      getPending: async () => null,
      cancelPending: vi.fn(async () => "absent" as const),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as StructuredLogger;
    const evidence = new WooOrderTerminalEvidenceStore(redis);
    const coordinator = new WooCheckoutCoordinatorService(new WooCheckoutLeaseGuard(redis));
    const reconciler = new WooOrderReconciliationService(database, candidate, coordinator, evidence, logger);
    const input: WooOrderCapture = {
      schemaVersion: "woo.activity.v1", shopId, checkoutKey: checkoutToken,
      eventId: `evt-${randomUUID()}`, eventType: "ORDER_PAID",
      occurredAt: new Date().toISOString(),
      order: { orderId: `order-${randomUUID()}`, checkoutKey: checkoutToken, status: "processing" },
    };
    try {
      await database.shop.create({ data: { id: shopId, domain: `${shopId}.example.test`, platform: "WOOCOMMERCE", status: "ACTIVE" } });
      await database.checkoutRecovery.create({ data: {
        id: recoveryId, shopId, checkoutToken, status: "MESSAGE_SENT", lastExternalActivityAt: new Date(),
      } });
      // A delivered outreach attempt must link to a real outbound message in
      // this recovery's conversation (ARCH-016 check + ARCH-040 FK guard).
      const conversationId = randomUUID();
      const outboundMessageId = randomUUID();
      const sentAt = new Date();
      await database.conversation.create({ data: {
        id: conversationId, checkoutRecoveryId: recoveryId, type: "RECOVERY",
      } });
      await database.conversationMessage.create({ data: {
        id: outboundMessageId, conversationId, direction: "OUTBOUND", senderType: "AUTOMATION",
        status: "SENT", content: "Initial recovery outreach", sentAt,
      } });
      await database.recoveryOutreachAttempt.create({ data: {
        checkoutRecoveryId: recoveryId, recipient: "15551234567", sequence: 1,
        trigger: "INITIAL", configuredOfferMode: "NONE", status: "WAITING_FOR_RESPONSE",
        sentAt, outboundMessageId,
      } });
      const [first, second] = await Promise.all([
        reconciler.reconcileOrder(input), reconciler.reconcileOrder(input),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(["ignored-duplicate", "paid-terminal"]);
      const recovery = await database.checkoutRecovery.findUniqueOrThrow({ where: { id: recoveryId } });
      expect(recovery.status).toBe("COMPLETED");
      const history = await database.checkoutRecoveryStatusHistory.findMany({ where: { checkoutRecoveryId: recoveryId } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ fromStatus: "MESSAGE_SENT", toStatus: "COMPLETED", source: "woocommerce.order" });
      const initial = await database.recoveryOutreachAttempt.findFirstOrThrow({ where: { checkoutRecoveryId: recoveryId, sequence: 1 } });
      expect(initial.status).toBe("WAITING_FOR_RESPONSE");
      expect(initial.sentAt).not.toBeNull();
      expect(initial.outboundMessageId).toBe(outboundMessageId);
      expect(candidate.cancelPending).toHaveBeenCalledTimes(2);
    } finally {
      await redis.del(markerKey);
      // Delete the linked sent attempt before its outbound message cascades,
      // avoiding ON DELETE SET NULL on an immutable ARCH-040 sent identity.
      await database.recoveryOutreachAttempt.deleteMany({ where: { checkoutRecoveryId: recoveryId } });
      await database.shop.deleteMany({ where: { id: shopId } });
      await database.$disconnect();
      await redis.quit();
    }
  }, 45_000);
});
