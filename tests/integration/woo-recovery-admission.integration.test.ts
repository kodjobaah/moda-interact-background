import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { connectionRedis } from "../../src/lib/redis.js";
import { CheckoutOrderGuardService } from "../../src/services/pending-recovery-candidate/checkout-order-guard.service.js";
import { WooRecoveryConsentReader } from "../../src/services/woocommerce-recovery-consent.service.js";
import type { WooPendingCandidate } from "../../src/services/woocommerce-recovery/contracts.js";
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

async function setup(db: PrismaClient) {
  const shopId = randomUUID();
  const site = `https://${shopId}.example.test`;
  await db.shop.create({ data: { id: shopId, domain: site, platform: "WOOCOMMERCE",
    status: "ACTIVE", onboardingCompleted: true, defaultCountryCode: "GB" } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    shopId, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(randomBytes(32)),
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
    lastEventId: `ev-${randomUUID()}`, lastActivityAt,
    basket: { kind: "nonempty", checkout: {
      currency: "GBP", total: "10.00", items: [{ productId: "p1", quantity: 1, total: "10.00" }],
      contact: { phone: PHONE, email: "customer@example.test" },
    } },
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
      const service = new WooRecoveryAdmissionService({
        database: db,
        coordinator: { withCheckoutLock: (ref, run) => lock.withCheckoutLock(ref.shopId, ref.checkoutToken, run) },
        candidates: {
          getPending: async () => { const value = await redis.get(key); return value ? JSON.parse(value) as WooPendingCandidate : null; },
          cancelPending: async () => "absent" as const,
        },
        orders: { read: async () => ({ kind: "none-observed" }) },
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
        currency: "GBP" });
      expect(rows[0]!.totalPrice?.toString()).toBe("10");
      const id = rows[0]!.id;
      expect(await db.checkoutRecoveryStatusHistory.count({ where: { checkoutRecoveryId: id } })).toBe(1);
      expect(await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: id } })).toBe(0);
      expect(await db.usageEvent.count({ where: { shopId } })).toBe(0);
      await redis.del(key); // completed BullMQ job/index no longer exists.
      expect(await service.evaluateMatured(incoming)).toEqual({
        kind: "already-exists", recoveryId: id, status: "DETECTED",
      });
      await db.checkoutRecovery.update({ where: { id }, data: { status: "EXPIRED" } });
      expect((await service.evaluateMatured(incoming)).kind).toBe("already-exists");
      expect(await db.checkoutRecovery.count({ where: { shopId, checkoutToken: token } })).toBe(1);
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
});
