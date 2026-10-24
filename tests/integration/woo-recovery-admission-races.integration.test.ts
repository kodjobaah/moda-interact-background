import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { connectionRedis } from "../../src/lib/redis.js";
import { CheckoutOrderGuardService } from "../../src/services/pending-recovery-candidate/checkout-order-guard.service.js";
import { WooRecoveryConsentReader } from "../../src/services/woocommerce-recovery-consent.service.js";
import type {
  WooPendingCandidate, WooTerminalObservation,
} from "../../src/services/woocommerce-recovery/contracts.js";
import { WooRecoveryAdmissionService } from "../../src/services/woocommerce-recovery/woo-recovery-admission.service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = databaseUrl && redisUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const PHONE = "+447400123456";
const DIGITS = "447400123456";
const SILENT_LOGGER = {
  info() {}, warn() {}, error() {}, debug() {}, child() { return this; },
} as unknown as StructuredLogger;

async function fixture(run: (state: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const db = new PrismaClient({ datasourceUrl: databaseUrl! });
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  try {
    await run(await setup(db, redis));
  } finally {
    await redis.quit();
    await db.$disconnect();
  }
}

async function setup(db: PrismaClient, redis: Redis) {
  const shopId = randomUUID();
  const checkoutToken = `checkout-${randomUUID()}`;
  const site = `https://${shopId}.example.test`;
  await db.shop.create({ data: { id: shopId, domain: site, platform: "WOOCOMMERCE",
    status: "ACTIVE", onboardingCompleted: true, defaultCountryCode: "GB" } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    shopId, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(randomBytes(32)),
  } });
  const customer = await db.customer.create({ data: { shopId, email: "customer@example.test" } });
  const phone = await db.customerPhone.create({ data: { customerId: customer.id, phone: PHONE } });
  const observedAt = new Date();
  await db.$transaction(async (tx) => {
    const current = await tx.customerPhone.update({ where: { id: phone.id }, data: {
      whatsappCanonicalPhone: DIGITS, whatsappPhoneVerifiedAt: observedAt,
      whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY", whatsappConsentDecision: "GRANTED",
      whatsappConsentSource: "WOO_MODA_CHECKBOX", whatsappConsentProviderObservedAt: observedAt,
      whatsappConsentVerifiedAt: observedAt, whatsappConsentRevision: { increment: 1 },
      whatsappConsentDecisionSequence: { increment: 1 },
    } });
    await tx.whatsAppConsentEvidence.create({ data: {
      id: randomUUID(), eventId: `woo-admission-race-${randomUUID()}`,
      shopId, installationId: installation.id, customerId: customer.id,
      customerPhoneId: phone.id, canonicalPhone: DIGITS, decision: "GRANT",
      phoneConsentRevision: current.whatsappConsentRevision,
      decisionSequence: current.whatsappConsentDecisionSequence, decisionAt: observedAt,
      payloadDigest: Uint8Array.from(randomBytes(32)),
      disclosureText: "I agree to checkout recovery messages on WhatsApp",
      disclosureVersion: "woo-admission-race-v1", disclosureLocale: "en-GB",
    } });
  });

  const prefix = `arch048-bg003-race:${shopId}:${checkoutToken}`;
  const pendingKey = `${prefix}:candidate`;
  const terminalKey = `${prefix}:order`;
  const guard = new CheckoutOrderGuardService();
  let onAdmissionLockAttempt: (() => void) | undefined;
  const service = new WooRecoveryAdmissionService({
    database: db,
    coordinator: { withCheckoutLock: <T>(ref: { shopId: string; checkoutToken: string },
      action: () => Promise<T>) => {
      onAdmissionLockAttempt?.();
      return guard.withCheckoutLock(ref.shopId, ref.checkoutToken, action);
    } },
    candidates: {
      getPending: async () => {
        const value = await redis.get(pendingKey);
        return value ? JSON.parse(value) as WooPendingCandidate : null;
      },
      cancelPending: async () => await redis.del(pendingKey) ? "cancelled" : "absent",
    },
    orders: { read: async (): Promise<WooTerminalObservation> => {
      const value = await redis.get(terminalKey);
      return value ? JSON.parse(value) as WooTerminalObservation : { kind: "none-observed" };
    } },
    execution: { evaluate: async (id) => ({ allowed: true, shopId: id }) },
    policy: { resolve: async () => ({ recoveryDelayMinutes: 30 }) } as never,
    consent: new WooRecoveryConsentReader(db), logger: SILENT_LOGGER,
  });
  const candidate = (lastEventId = `event-${randomUUID()}`,
    lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString()): WooPendingCandidate => ({
    source: "woocommerce", shopId, checkoutToken, lastEventId, lastActivityAt,
    basket: { kind: "nonempty", checkout: {
      currency: "GBP", total: "10.00",
      items: [{ productId: "p1", quantity: 1, total: "10.00" }],
      contact: { phone: PHONE, email: "customer@example.test" },
    } },
  });
  const store = async (incoming: WooPendingCandidate) => {
    await redis.set(pendingKey, JSON.stringify(incoming), "EX", 600);
  };
  const noOutboundOrBilling = async () => {
    expect(await db.recoveryOutreachAttempt.count({ where: { checkoutRecovery: { shopId } } })).toBe(0);
    expect(await db.usageReservation.count({ where: { shopId } })).toBe(0);
    expect(await db.usageEvent.count({ where: { shopId } })).toBe(0);
    expect(await db.conversationMessage.count({ where: { OR: [
      { conversation: { shopId } }, { conversation: { checkoutRecovery: { shopId } } },
    ] } })).toBe(0);
  };
  /** The event producer holds the actual Redis checkout lock before admission tries. */
  const raceWithWriter = async (change: () => Promise<void>, incoming: WooPendingCandidate) => {
    let announce!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { announce = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const writer = guard.withCheckoutLock(shopId, checkoutToken, async () => {
      await change();
      announce();
      await released;
    });
    try {
      await held;
      let attempted!: () => void;
      const attemptedLock = new Promise<void>((resolve) => { attempted = resolve; });
      onAdmissionLockAttempt = attempted;
      const admission = service.evaluateMatured(incoming, { jobId: "stale-delayed-job" });
      await attemptedLock;
      release();
      await writer;
      return await admission;
    } finally {
      release();
      onAdmissionLockAttempt = undefined;
    }
  };
  return { db, redis, shopId, checkoutToken, customerId: customer.id, service,
    guard, pendingKey, terminalKey, candidate, store, raceWithWriter, noOutboundOrBilling };
}

integration("ARCH-048 BG003: received Woo event races (PostgreSQL + Redis)", () => {
  afterAll(async () => { await connectionRedis.quit(); });

  it("does not materialise a stale maturity job when a new candidate is concurrently created", async () => {
    await fixture(async (f) => {
      const stale = f.candidate("event-before-materialisation");
      const fresh = f.candidate("event-after-materialisation", new Date().toISOString());
      expect(await f.raceWithWriter(() => f.store(fresh), stale))
        .toEqual({ kind: "superseded", reason: "EVENT_WATERMARK_CHANGED" });
      expect(await f.service.evaluateMatured(fresh))
        .toEqual({ kind: "deferred", reason: "CANDIDATE_NOT_MATURE" });
      expect(await f.db.checkoutRecovery.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await f.db.checkoutRecoveryStatusHistory.count({ where: { checkoutRecovery: { shopId: f.shopId } } })).toBe(0);
      await f.noOutboundOrBilling();
    });
  }, 45_000);

  it("serialises an updated watermark against old maturity, then admits only one generation", async () => {
    await fixture(async (f) => {
      const stale = f.candidate("event-before-update");
      await f.store(stale);
      // Same activity timestamp: an event-ID revision must not be treated as the old snapshot.
      const updated = { ...stale, lastEventId: "event-after-update" };
      expect(await f.raceWithWriter(() => f.store(updated), stale))
        .toEqual({ kind: "superseded", reason: "EVENT_WATERMARK_CHANGED" });
      expect(await f.db.checkoutRecovery.count({ where: { shopId: f.shopId } })).toBe(0);
      const admitted = await f.service.evaluateMatured(updated);
      expect(admitted.kind).toBe("created");
      expect(await f.service.evaluateMatured(stale)).toMatchObject({
        kind: "already-exists", recoveryId: admitted.kind === "created" ? admitted.recoveryId : "",
      });
      const rows = await f.db.checkoutRecovery.findMany({ where: { shopId: f.shopId, checkoutToken: f.checkoutToken } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ generation: 1, status: "DETECTED" });
      expect(await f.db.checkoutRecoveryStatusHistory.count({ where: { checkoutRecoveryId: rows[0]!.id } })).toBe(1);
      await f.noOutboundOrBilling();
    });
  }, 45_000);

  it("cancellation removes the pending candidate while admission waits; stale replay sees terminal order", async () => {
    await fixture(async (f) => {
      const stale = f.candidate("event-before-cancel");
      await f.store(stale);
      const cancelled = { kind: "order-cancelled", orderId: `order-${randomUUID()}` } as const;
      expect(await f.raceWithWriter(async () => {
        await f.redis.set(f.terminalKey, JSON.stringify(cancelled), "EX", 600);
        await f.redis.del(f.pendingKey);
      }, stale)).toEqual({ kind: "deferred", reason: "CANDIDATE_NOT_AVAILABLE" });
      // A delayed duplicate reintroducing a stale candidate still cannot bypass order evidence.
      await f.store(stale);
      expect(await f.service.evaluateMatured(stale))
        .toEqual({ kind: "superseded", reason: "ORDER_EVENT_OBSERVED" });
      expect(await f.db.checkoutRecovery.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await f.db.checkoutRecoveryStatusHistory.count({ where: { checkoutRecovery: { shopId: f.shopId } } })).toBe(0);
      await f.noOutboundOrBilling();
    });
  }, 45_000);

  it("does not reopen an existing MESSAGE_SENT recovery when both candidate and job have disappeared", async () => {
    await fixture(async (f) => {
      const stale = f.candidate("event-original-sent");
      const previous = await f.db.checkoutRecovery.create({ data: {
        shopId: f.shopId, checkoutToken: f.checkoutToken, customerId: f.customerId,
        generation: 1, status: "MESSAGE_SENT", lastExternalActivityAt: new Date(stale.lastActivityAt),
        messageSentAt: new Date(), currency: "GBP", totalPrice: "10.00",
      } });
      await f.db.checkoutRecoveryStatusHistory.createMany({ data: [
        { checkoutRecoveryId: previous.id, fromStatus: null, toStatus: "DETECTED", source: "WOOCOMMERCE" },
        { checkoutRecoveryId: previous.id, fromStatus: "DETECTED", toStatus: "MESSAGE_SENT", source: "WOOCOMMERCE" },
      ] });
      const conversation = await f.db.conversation.create({ data: {
        type: "RECOVERY", checkoutRecoveryId: previous.id,
      } });
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
        status: "SENT", content: "Previously sent recovery message", sentAt: new Date(),
      } });
      const initial = await f.db.recoveryOutreachAttempt.create({ data: {
        checkoutRecoveryId: previous.id, recipient: DIGITS, sequence: 1,
        trigger: "INITIAL", status: "WAITING_FOR_RESPONSE", configuredOfferMode: "NONE",
        sentAt: new Date(), outboundMessageId: message.id,
      } });
      const charged = await f.db.usageEvent.create({ data: {
        shopId: f.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
        idempotencyKey: `woo-admission-sent-${randomUUID()}`,
        sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: message.id,
        provider: "WOOCOMMERCE",
      } });
      expect(await f.redis.exists(f.pendingKey)).toBe(0);
      expect(await f.service.evaluateMatured(stale, { jobId: "removed-bullmq-job" })).toEqual({
        kind: "already-exists", recoveryId: previous.id, status: "MESSAGE_SENT",
      });
      // Even an independently re-materialised candidate cannot create generation 2.
      await f.store(f.candidate("new-maturity-after-sent"));
      expect(await f.service.evaluateMatured(stale)).toMatchObject({
        kind: "already-exists", recoveryId: previous.id, status: "MESSAGE_SENT",
      });
      const rows = await f.db.checkoutRecovery.findMany({ where: { shopId: f.shopId, checkoutToken: f.checkoutToken } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: previous.id, generation: 1, status: "MESSAGE_SENT" });
      expect(await f.db.checkoutRecoveryStatusHistory.count({ where: { checkoutRecoveryId: previous.id } })).toBe(2);
      expect(await f.db.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: previous.id } }))
        .toEqual([expect.objectContaining({ id: initial.id, sequence: 1, trigger: "INITIAL" })]);
      expect(await f.db.conversationMessage.findMany({ where: { conversationId: conversation.id } }))
        .toEqual([expect.objectContaining({ id: message.id, status: "SENT" })]);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await f.db.usageEvent.findMany({ where: { shopId: f.shopId } }))
        .toEqual([expect.objectContaining({ id: charged.id })]);
    });
  }, 45_000);
});
