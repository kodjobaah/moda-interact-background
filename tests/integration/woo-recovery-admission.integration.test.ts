import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { connectionRedis } from "../../src/lib/redis.js";
import { CheckoutOrderGuardService } from "../../src/services/pending-recovery-candidate/checkout-order-guard.service.js";
import { WooRecoveryConsentReader } from "../../src/services/woocommerce-recovery-consent.service.js";
import type { WooPendingCandidate } from "../../src/services/woocommerce-recovery/contracts.js";
import { WooRecoveryAdmissionService } from "../../src/services/woocommerce-recovery/woo-recovery-admission.service.js";
import { WOO_REPLAY_BUFFER_MS, WooActivityWatermarkStore } from "../../src/services/woocommerce-recovery/woo-activity-watermark.store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = databaseUrl && redisUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const PHONE = "+447400123456";
const DIGITS = "447400123456";
const SILENT_LOGGER = {
  info() {}, warn() {}, error() {}, debug() {}, child() { return this; },
} as unknown as StructuredLogger;

async function setup(db: PrismaClient) {
  const shopId = randomUUID();
  const site = `https://${shopId}.example.com`;
  await db.shop.create({ data: { id: shopId, domain: site, platform: "WOOCOMMERCE",
    status: "ACTIVE", onboardingCompleted: true, defaultCountryCode: "GB" } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    shopId, canonicalSiteUrl: `${site}/store`, credentialDigest: Uint8Array.from(randomBytes(32)),
  } });
  const customer = await db.customer.create({ data: { shopId, email: "customer@example.test" } });
  const phone = await db.customerPhone.create({ data: { customerId: customer.id, phone: PHONE } });
  const observationAt = new Date();
  // Existing ARCH-045 database evidence constraint: projection and immutable
  // grant evidence are committed together; do not bypass the consent writer.
  await db.$transaction(async (tx) => {
    const updated = await tx.customerPhone.update({ where: { id: phone.id }, data: {
      whatsappCanonicalPhone: DIGITS,
      whatsappPhoneVerifiedAt: observationAt,
      whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
      whatsappConsentDecision: "GRANTED",
      whatsappConsentSource: "WOO_MODA_CHECKBOX",
      whatsappConsentProviderObservedAt: observationAt,
      whatsappConsentVerifiedAt: observationAt,
      whatsappConsentRevision: { increment: 1 },
      whatsappConsentDecisionSequence: { increment: 1 },
    } });
    await tx.whatsAppConsentEvidence.create({ data: {
      id: randomUUID(), eventId: `woo-admission-${randomUUID()}`,
      shopId, installationId: installation.id,
      customerId: customer.id, customerPhoneId: phone.id,
      canonicalPhone: DIGITS, decision: "GRANT",
      phoneConsentRevision: updated.whatsappConsentRevision,
      decisionSequence: updated.whatsappConsentDecisionSequence,
      decisionAt: observationAt,
      payloadDigest: Uint8Array.from(randomBytes(32)),
      disclosureText: "I agree to checkout recovery messages on WhatsApp",
      disclosureVersion: "woo-admission-test-v1", disclosureLocale: "en-GB",
    } });
  });
  return { shopId, customerId: customer.id, phoneId: phone.id };
}

function candidate(shopId: string, checkoutToken: string): WooPendingCandidate {
  const lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
  return {
    source: "woocommerce", shopId, checkoutToken,
    generation: 1,
    lastEventId: `ev-${randomUUID()}`, lastActivityAt,
    basket: { kind: "nonempty", checkout: {
      currency: "GBP", total: "10.00",
      restoration: { schemaVersion: "woo.cart-restore.v1", kind: "supported",
        appliedCouponCodes: ["original10"], lines: [{ productId: 42, quantity: 1 }] },
      items: [{ productId: "p1", quantity: 1, total: "10.00" }],
      contact: { phone: PHONE, email: "customer@example.test" },
    } },
  };
}

function acceptedWatermark(candidate: WooPendingCandidate) {
  return {
    generation: candidate.generation!, lastEventId: candidate.lastEventId,
    lastActivityAt: candidate.lastActivityAt,
    checkoutDigest: createHash("sha256")
      .update(JSON.stringify(candidate.basket.kind === "nonempty" ? candidate.basket.checkout : {})).digest("hex"),
    state: "nonempty" as const,
  };
}

integration("ARCH-048 BG003: PostgreSQL recovery idempotency + Redis coordination", () => {
  afterAll(async () => { await connectionRedis.quit(); });
  it("two concurrent evaluations create one recovery/history, no attempts or charges; retry after removed job is inert", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const lock = new CheckoutOrderGuardService();
    try {
      const { shopId, customerId } = await setup(db);
      const token = `checkout-${randomUUID()}`;
      const incoming = candidate(shopId, token);
      const key = `arch048-bg003:${shopId}:${token}`;
      await redis.set(key, JSON.stringify(incoming), "EX", 600);
      const watermarks = new WooActivityWatermarkStore(redis);
      await watermarks.write({ shopId, checkoutToken: token }, acceptedWatermark(incoming), WOO_REPLAY_BUFFER_MS + 60_000);
      const service = new WooRecoveryAdmissionService({
        database: db,
        coordinator: { withCheckoutLock: (ref, run) => lock.withCheckoutLock(ref.shopId, ref.checkoutToken, run) },
        candidates: {
          getPending: async () => { const value = await redis.get(key); return value ? JSON.parse(value) as WooPendingCandidate : null; },
          cancelPending: async () => "absent" as const,
        },
        orders: { read: async () => ({ kind: "none-observed" }) }, watermarks,
        execution: { evaluate: async (id) => ({ allowed: true, shopId: id }) },
        policy: { resolve: async () => ({ recoveryDelayMinutes: 30 }) } as never,
        consent: new WooRecoveryConsentReader(db), logger: SILENT_LOGGER,
      });
      const [a, b] = await Promise.all([
        service.evaluateMatured(incoming, { jobId: "worker-A" }),
        service.evaluateMatured(incoming, { jobId: "worker-B" }),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(["already-exists", "created"]);
      const rows = await db.checkoutRecovery.findMany({ where: { shopId, checkoutToken: token } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ generation: 1, status: "DETECTED", customerId,
        currency: "GBP", wooRestoreSnapshot: { schemaVersion: "woo.cart-restore.v1",
          kind: "supported", appliedCouponCodes: ["original10"],
          lines: [{ productId: 42, quantity: 1 }] } });
      const firstUrl = new URL(rows[0]!.checkoutUrl!);
      expect(firstUrl.origin).toBe(`https://${shopId}.example.com`);
      expect(firstUrl.pathname).toBe("/store/");
      expect(firstUrl.searchParams.get("moda_interact_resume")).toBe("1");
      expect(firstUrl.searchParams.get("r")).toBe(rows[0]!.id);
      expect(firstUrl.searchParams.get("t")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(rows[0]!.totalPrice?.toString()).toBe("10");
      const id = rows[0]!.id;
      expect(await db.checkoutRecoveryStatusHistory.count({ where: { checkoutRecoveryId: id } })).toBe(1);
      expect(await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: id } })).toBe(0);
      expect(await db.usageEvent.count({ where: { shopId } })).toBe(0);
      await redis.del(key); // completed BullMQ job/index no longer exists.
      expect(await service.evaluateMatured(incoming)).toEqual({
        kind: "already-exists", recoveryId: id, status: "DETECTED", generation: 1, repairInitial: true,
      });
      expect((await db.checkoutRecovery.findUniqueOrThrow({ where: { id } })).checkoutUrl).toBe(firstUrl.href);
      await db.checkoutRecovery.update({ where: { id }, data: { status: "CANCELLED" } });
      await db.checkoutRecoveryStatusHistory.create({ data: {
        checkoutRecoveryId: id, fromStatus: "DETECTED", toStatus: "CANCELLED",
        source: "woocommerce.checkout", reason: "CHECKOUT_RESUMED",
        metadata: { eventId: "resume-generation-2", nextGeneration: 2 }, occurredAt: new Date(),
      } });
      const next = {
        ...incoming, generation: 2, lastEventId: `ev-${randomUUID()}`,
        lastActivityAt: new Date(Date.parse(incoming.lastActivityAt) + 60_000).toISOString(),
        basket: { kind: "nonempty" as const, checkout: {
          currency: "GBP", total: "20.00",
          restoration: { schemaVersion: "woo.cart-restore.v1" as const, kind: "supported" as const,
            appliedCouponCodes: ["next-generation"], lines: [{ productId: 77, quantity: 2 }] },
          items: [{ productId: "p2", quantity: 2, total: "20.00" }],
          contact: { phone: PHONE, email: "customer@example.test" },
        } },
      };
      await redis.set(key, JSON.stringify(next), "EX", 600);
      await watermarks.write({ shopId, checkoutToken: token }, acceptedWatermark(next), WOO_REPLAY_BUFFER_MS + 60_000);
      expect(await service.evaluateMatured(next)).toMatchObject({ kind: "created", generation: 2 });
      const generations = await db.checkoutRecovery.findMany({ where: { shopId, checkoutToken: token }, orderBy: { generation: "asc" } });
      expect(generations).toHaveLength(2);
      const secondUrl = new URL(generations[1]!.checkoutUrl!);
      expect(generations[1]).toMatchObject({ generation: 2, wooRestoreSnapshot: {
        schemaVersion: "woo.cart-restore.v1", kind: "supported",
        appliedCouponCodes: ["next-generation"], lines: [{ productId: 77, quantity: 2 }],
      } });
      expect(secondUrl.href).not.toBe(firstUrl.href);
      expect(secondUrl.searchParams.get("r")).toBe(generations[1]!.id);
      expect(secondUrl.searchParams.get("t")).not.toBe(firstUrl.searchParams.get("t"));
      expect(generations[0]!.checkoutUrl).toBe(firstUrl.href);
      expect(await service.evaluateMatured(incoming)).toMatchObject({ kind: "superseded", reason: "GENERATION_SUPERSEDED" });
      await db.checkoutRecovery.update({ where: { id: generations[1]!.id }, data: { status: "EXPIRED" } });
      expect(await service.evaluateMatured(next)).toMatchObject({ kind: "superseded", reason: "GENERATION_TERMINAL" });
    } finally { await redis.quit(); await db.$disconnect(); }
  }, 45_000);

  it("rechecks local STOP under the insertion transaction after earlier positive consent", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const lock = new CheckoutOrderGuardService();
    try {
      const { shopId, phoneId } = await setup(db);
      const token = `checkout-${randomUUID()}`;
      const incoming = candidate(shopId, token);
      const key = `arch048-bg003:${shopId}:${token}`;
      await redis.set(key, JSON.stringify(incoming), "EX", 600);
      const watermarks = new WooActivityWatermarkStore(redis);
      await watermarks.write({ shopId, checkoutToken: token }, acceptedWatermark(incoming), WOO_REPLAY_BUFFER_MS + 60_000);
      const realConsent = new WooRecoveryConsentReader(db);
      const service = new WooRecoveryAdmissionService({
        database: db,
        coordinator: { withCheckoutLock: (ref, run) => lock.withCheckoutLock(ref.shopId, ref.checkoutToken, run) },
        candidates: { getPending: async () => {
          const value = await redis.get(key); return value ? JSON.parse(value) as WooPendingCandidate : null;
        }, cancelPending: async () => "absent" as const },
        orders: { read: async () => ({ kind: "none-observed" }) },
        execution: { evaluate: async (id) => ({ allowed: true, shopId: id }) },
        policy: { resolve: async () => ({ recoveryDelayMinutes: 30 }) } as never,
        watermarks,
        consent: { evaluateRecipient: async (input) => {
          const result = await realConsent.evaluateRecipient(input);
          if (result.status === "ALLOWED") {
            await db.customerPhone.update({ where: { id: phoneId }, data: {
              whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP",
              whatsappNoContactAt: new Date(), whatsappNoContactRevision: { increment: 1 },
            } });
          }
          return result;
        } }, logger: SILENT_LOGGER,
      });
      expect(await service.evaluateMatured(incoming)).toEqual({ kind: "denied", reason: "CONSENT_CHANGED" });
      expect(await db.checkoutRecovery.count({ where: { shopId, checkoutToken: token } })).toBe(0);
    } finally { await redis.quit(); await db.$disconnect(); }
  }, 45_000);

  it("inserts a provenance-backed generation 2 from its latest basket without changing generation 1", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const lock = new CheckoutOrderGuardService();
    try {
      const { shopId, customerId } = await setup(db);
      const token = `checkout-${randomUUID()}`;
      const priorActivity = new Date(Date.now() - 60 * 60_000);
      const previous = await db.checkoutRecovery.create({ data: {
        shopId, checkoutToken: token, customerId, generation: 1, status: "CANCELLED",
        lastExternalActivityAt: priorActivity, currency: "GBP", totalPrice: "10.00",
        lineItems: [{ productId: "old-product", quantity: 1 }],
      } });
      await db.checkoutRecoveryStatusHistory.createMany({ data: [
        { checkoutRecoveryId: previous.id, fromStatus: null, toStatus: "DETECTED", source: "WOOCOMMERCE",
          reason: "FIRST_MATURE_CHECKOUT_ADMISSION", metadata: { generation: 1, lastEventId: "original-event" } },
        { checkoutRecoveryId: previous.id, fromStatus: "DETECTED", toStatus: "CANCELLED",
          source: "woocommerce.checkout", reason: "CHECKOUT_RESUMED",
          metadata: { eventId: "resumption-event", nextGeneration: 2 } },
      ] });
      const incoming = {
        ...candidate(shopId, token), generation: 2, lastEventId: "generation-2-event",
        lastActivityAt: new Date(Date.now() - 40 * 60_000).toISOString(),
        basket: { kind: "nonempty" as const, checkout: {
          currency: "USD", total: "99.00", items: [{ productId: "new-product", quantity: 3, total: "99.00" }],
          contact: { phone: PHONE, email: "customer@example.test" },
        } },
      };
      const key = `arch048-bg003:${shopId}:${token}`;
      await redis.set(key, JSON.stringify(incoming), "EX", 600);
      const watermarks = new WooActivityWatermarkStore(redis);
      await watermarks.write({ shopId, checkoutToken: token }, acceptedWatermark(incoming), WOO_REPLAY_BUFFER_MS + 60_000);
      const service = new WooRecoveryAdmissionService({
        database: db,
        coordinator: { withCheckoutLock: (ref, run) => lock.withCheckoutLock(ref.shopId, ref.checkoutToken, run) },
        candidates: { getPending: async () => {
          const value = await redis.get(key); return value ? JSON.parse(value) as WooPendingCandidate : null;
        }, cancelPending: async () => "absent" as const },
        orders: { read: async () => ({ kind: "none-observed" }) }, watermarks,
        execution: { evaluate: async (id) => ({ allowed: true, shopId: id }) },
        policy: { resolve: async () => ({ recoveryDelayMinutes: 30 }) } as never,
        consent: new WooRecoveryConsentReader(db), logger: SILENT_LOGGER,
      });
      const admitted = await service.evaluateMatured(incoming);
      expect(admitted.kind).toBe("created");
      if (admitted.kind !== "created") throw new Error("generation 2 was not admitted");
      expect(admitted.generation).toBe(2);
      expect(await service.evaluateMatured(incoming)).toMatchObject({ kind: "already-exists",
        recoveryId: admitted.recoveryId, generation: 2, repairInitial: true });
      const rows = await db.checkoutRecovery.findMany({ where: { shopId, checkoutToken: token }, orderBy: { generation: "asc" } });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: previous.id, generation: 1, status: "CANCELLED", currency: "GBP" });
      expect(rows[1]).toMatchObject({ id: admitted.recoveryId, generation: 2, status: "DETECTED",
        currency: "USD", customerId });
      expect(rows[1]!.totalPrice?.toString()).toBe("99");
      expect(rows[1]!.lineItems).toEqual([{ productId: "new-product", variantId: null, sku: null,
        title: null, quantity: 3, price: null, total: "99.00" }]);
      const origin = await db.checkoutRecoveryStatusHistory.findFirst({ where: { checkoutRecoveryId: admitted.recoveryId } });
      expect(origin).toMatchObject({ reason: "MATURE_CHECKOUT_REENTRY_ADMISSION", source: "WOOCOMMERCE",
        metadata: { generation: 2, lastEventId: "generation-2-event" } });
      expect(await db.checkoutRecoveryStatusHistory.count({ where: { checkoutRecoveryId: previous.id } })).toBe(2);
      expect(await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: admitted.recoveryId } })).toBe(0);
    } finally { await redis.quit(); await db.$disconnect(); }
  }, 45_000);
});
