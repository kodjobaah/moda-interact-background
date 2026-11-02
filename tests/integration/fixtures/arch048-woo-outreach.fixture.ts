import { randomBytes, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { WooRecoveryConsentReader } from "../../../src/services/woocommerce-recovery-consent.service.js";
import { createWooRecoveryOutreachService } from "../../../src/services/woocommerce-recovery/woo-recovery-outreach.adapters.js";
import type {
  WooGuardedInitialSender,
} from "../../../src/services/woocommerce-recovery/woo-recovery-outreach.service.js";
import { seedApprovedInitialWooTemplateRegistration } from "./woo-approved-initial-template.fixture.js";
import type {
  WooCheckoutCoordinator,
  WooObservedOrderStateReader,
  WooTerminalObservation,
} from "../../../src/services/woocommerce-recovery/contracts.js";
import { WooCheckoutCoordinatorService } from "../../../src/services/woocommerce-recovery/woo-order-reconciliation.service.js";
import { WooCheckoutLeaseGuard } from "../../../src/services/pending-recovery-candidate/checkout-order-guard.service.js";

/**
 * BG004's disposable Postgres/BullMQ harness. BG002's production checkout
 * coordinator and ARCH-046's production final-send guard are NOT available in
 * this snapshot. Their ports are backed by Postgres advisory locks and a
 * persisted test sender here; BG005/system testing must verify the real wiring.
 */
export async function createWooOutreachFixture(options: { includeCheckoutItemsBinding?: boolean } = {}) {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
  const redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  const runId = randomUUID();
  const shopId = randomUUID();
  const recipient = "+447400123456";
  const canonicalRecipient = "447400123456";
  const checkoutToken = `woo-checkout-${runId}`;
  const queue = new Queue(`arch048-outreach-${runId}`, { connection: redis });
  const orderKey = `arch048:observed-order:${runId}`;
  const sentAt = new Date();
  const providerTemplateRequests: Array<{
    shopId: string;
    recoveryId: string;
    attemptId: string;
    conversationId: string;
    templateName: string;
    bodyParameters: string[];
  }> = [];
  let providerRequests = 0;
  let beforePermit: (() => Promise<void>) | undefined;

  try {
    const feature = await db.feature.upsert({
      where: { key: "checkout_recovery" },
      create: { key: "checkout_recovery", displayName: "Checkout recovery", activationMode: "ALWAYS_ENABLED" },
      update: {},
    });
    if (!feature.active) throw new Error("checkout_recovery feature is inactive in the integration fixture");
    const plan = await db.billingPlan.create({ data: {
      shopifyPlanHandle: `arch048-woo-${runId}`, name: "ARCH048 Woo free", kind: "FREE",
    } });
    const shop = await db.shop.create({ data: {
      id: shopId, domain: `https://${runId}.example.test`, platform: "WOOCOMMERCE",
      status: "ACTIVE", defaultCountryCode: "GB", defaultLanguageTag: "en-GB",
    } });
    const install = await db.wooCommerceInstallation.create({ data: {
      shopId, canonicalSiteUrl: shop.domain, credentialDigest: Uint8Array.from(randomBytes(32)),
    } });
    await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id } });
    if (feature.activationMode === "MERCHANT_OPT_IN") {
      await db.shopFeaturePreference.create({ data: { shopId, featureId: feature.id, enabled: true } });
    }
    await db.subscription.create({ data: {
      shopId, planId: plan.id, status: "ACTIVE", observedShopifyPlanHandle: plan.shopifyPlanHandle,
    } });
    await db.platformBillingPolicy.upsert({
      where: { id: "default" }, update: {},
      create: { id: "default", absoluteOutboundHardLimit: 20, defaultWarningPercent: 80 },
    });
    await db.shopEntitlementCounter.create({ data: {
      shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 1,
    } });
  await seedApprovedInitialWooTemplateRegistration(
    db, shopId, shop.domain, options.includeCheckoutItemsBinding ?? true,
  );
    let platformPrompt = await db.commerceAgentPrompt.findFirst({
      where: { scope: "PLATFORM", shopId: null },
      select: { id: true },
    });
    if (!platformPrompt) {
      platformPrompt = await db.commerceAgentPrompt.create({ data: { scope: "PLATFORM", shopId: null }, select: { id: true } });
    }
    const shopPromptId = randomUUID();
    const shopRevisionId = randomUUID();
    const activePlatform = await db.commerceAgentConfiguration.findFirst({
      where: { environment: "TEST", scope: "PLATFORM", shopId: null },
      select: { activePromptRevisionId: true },
    });
    let platformRevisionId = activePlatform?.activePromptRevisionId;
    if (!platformRevisionId) {
      const publishedPlatformRevision = await db.commerceAgentPromptRevision.findFirst({
        where: { promptId: platformPrompt.id, status: "PUBLISHED" },
        orderBy: { revisionNumber: "desc" },
        select: { id: true },
      });
      platformRevisionId = publishedPlatformRevision?.id ?? randomUUID();
      if (!publishedPlatformRevision) {
        await db.commerceAgentPromptRevision.create({ data: {
          id: platformRevisionId, promptId: platformPrompt.id, revisionNumber: 1,
          status: "PUBLISHED", promptText: "Platform safety rules.", publishedAt: sentAt,
        } });
      }
      await db.commerceAgentConfiguration.create({ data: {
        environment: "TEST", scope: "PLATFORM", shopId: null, activePromptRevisionId: platformRevisionId,
      } });
    }
    await db.commerceAgentPrompt.create({ data: { id: shopPromptId, scope: "SHOP", shopId } });
    await db.commerceAgentPromptRevision.create({ data: {
      id: shopRevisionId, promptId: shopPromptId, revisionNumber: 1,
      status: "PUBLISHED", promptText: "Merchant recovery instructions.", publishedAt: sentAt,
    } });
    await db.commerceAgentConfiguration.create({ data: {
      environment: "TEST", scope: "SHOP", shopId, activePromptRevisionId: shopRevisionId,
    } });
    const customer = await db.customer.create({ data: { shopId, phone: recipient } });
    const phone = await db.customerPhone.create({ data: { customerId: customer.id, phone: recipient } });
    // The real ARCH-046 DB trigger requires immutable Woo consent evidence in
    // the very transaction that updates the current CustomerPhone projection.
    await db.$transaction(async (tx) => {
      const updated = await tx.customerPhone.update({ where: { id: phone.id }, data: {
        whatsappCanonicalPhone: canonicalRecipient,
        whatsappPhoneVerifiedAt: sentAt,
        whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
        whatsappConsentDecision: "GRANTED", whatsappConsentSource: "WOO_MODA_CHECKBOX",
        whatsappConsentProviderObservedAt: sentAt, whatsappConsentVerifiedAt: sentAt,
        whatsappConsentRevision: { increment: 1 },
        whatsappConsentDecisionSequence: { increment: 1 },
      } });
      await tx.whatsAppConsentEvidence.create({ data: {
        id: randomUUID(), eventId: `arch048-${runId}`,
        shopId, installationId: install.id, customerId: customer.id,
        customerPhoneId: phone.id, canonicalPhone: canonicalRecipient,
        payloadDigest: Uint8Array.from(randomBytes(32)), decision: "GRANT",
        decisionAt: sentAt,
        decisionSequence: updated.whatsappConsentDecisionSequence,
        phoneConsentRevision: updated.whatsappConsentRevision,
        disclosureText: "I agree to WhatsApp recovery marketing", disclosureVersion: "test-v1",
        disclosureLocale: "en-GB",
      } });
    });
    const recovery = await db.checkoutRecovery.create({ data: {
      shopId, customerId: customer.id, checkoutToken, lastExternalActivityAt: sentAt,
      currency: "GBP", checkoutUrl: `${shop.domain}/checkout/${checkoutToken}`,
      lineItems: [{ productId: "woo-product-1", variantId: null, title: "Test item", quantity: 1, price: "10.00" }],
    } });
    const reader = new WooRecoveryConsentReader(db);

    const redisCoordinator = new WooCheckoutCoordinatorService(new WooCheckoutLeaseGuard(redis));
    const advisoryCoordinator: WooCheckoutCoordinator = {
      async withCheckoutLock<T>(ref: { shopId: string; checkoutToken: string }, run: () => Promise<T>): Promise<T> {
        return db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 AS acquired FROM (SELECT pg_advisory_xact_lock(hashtext(${ref.shopId}), hashtext(${ref.checkoutToken}))) held`;
          return run();
        }, { maxWait: 15_000, timeout: 60_000 });
      },
    };
    let activeCoordinator: WooCheckoutCoordinator = advisoryCoordinator;
    const coordinator: WooCheckoutCoordinator = {
      withCheckoutLock: (ref, run) => activeCoordinator.withCheckoutLock(ref, run),
    };
    const orders: WooObservedOrderStateReader = {
      async read(): Promise<WooTerminalObservation> {
        const observed = await redis.get(orderKey);
        if (observed === "placed") return { kind: "order-placed", orderId: "woo-order-1" };
        if (observed === "paid") return { kind: "order-paid", orderId: "woo-order-1" };
        if (observed === "cancelled") return { kind: "order-cancelled", orderId: "woo-order-1" };
        if (observed === "ambiguous") return { kind: "ambiguous", reason: "conflicting-events" };
        return { kind: "none-observed" };
      },
    };
    const sender: WooGuardedInitialSender = {
      async findExistingAdmission(idempotencyKey) {
        return db.conversationMessage.findUnique({
          where: { providerDispatchKey: idempotencyKey },
          select: { id: true, conversationId: true, status: true, sentAt: true, providerFailureCode: true },
        });
      },
      async sendInitial(input) {
        if (beforePermit) await beforePermit();
        // Test-only final permit: refreshed DB STOP/consent and received-order
        // observations are checked AFTER reservation/revalidation, immediately
        // before the emulated irreversible send. This is NOT the production guard.
        if ((await orders.read({ shopId, checkoutToken })).kind !== "none-observed")
          return { kind: "suppressed", reason: "order-terminal" };
        const permission = await reader.evaluateStoredRecipient({
          shopId, customerId: customer.id, recipient: input.recipient, expected: input.consent,
        });
        if (permission.status !== "ALLOWED")
          return { kind: "suppressed", reason: "consent-or-stop" };
        if (await sender.findExistingAdmission(input.idempotencyKey))
          return { kind: "suppressed", reason: "duplicate" };
        // A dispatch identity is only admissible for the conversation's current
        // control revision and AI mode (ARCH-040 trigger). The real production
        // fence owns the atomic permit; this test sender must preserve the same
        // durable admission invariant instead of bypassing the trigger.
        const control = await db.conversation.findUnique({
          where: { id: input.conversationId },
          select: { controlMode: true, controlRevision: true },
        });
        if (control?.controlMode !== "AI")
          return { kind: "suppressed", reason: "conversation-not-ai-controlled" };
        providerTemplateRequests.push({
          shopId: input.recovery.shopId,
          recoveryId: input.recovery.id,
          attemptId: input.attemptId,
          conversationId: input.conversationId,
          templateName: input.template.name,
          bodyParameters: input.template.sendFields?.bodyParameters ?? [],
        });
        const admittedAt = new Date();
        await db.conversationMessage.create({ data: {
          conversationId: input.conversationId,
          direction: "OUTBOUND", senderType: "AUTOMATION", status: "SENT",
          content: "Integration-only Marketing template", sentAt: admittedAt,
          providerDispatchKey: input.idempotencyKey,
          providerDispatchAdmittedAt: admittedAt,
          providerDispatchControlRevision: control.controlRevision,
          providerMessageId: `wamid-arch048-${runId}-${providerRequests + 1}`,
        } });
        ++providerRequests;
        return { kind: "admitted" };
      },
    };
    const service = createWooRecoveryOutreachService({
      coordinator, orders, guardedSender: sender,
      logger: createLogger({ serviceName: "moda-recovery-worker", environment: "test" }),
      enableTestOutbound: () => true,
      enqueue: { async initial(recoveryId, attemptId) {
        await queue.add("initial-outreach", { recoveryId, attemptId }, {
          jobId: `arch048-${attemptId}`, removeOnComplete: false,
        });
      } },
    });
    return {
      db, redis, queue, shopId, shopUrl: shop.domain, checkoutToken, recoveryId: recovery.id, customerId: customer.id,
      guardedSender: sender,
      phoneId: phone.id, service, coordinator,
      providerTemplateRequests,
      useRedisCheckoutCoordinator() { activeCoordinator = redisCoordinator; },
      get providerRequests() { return providerRequests; },
      setBeforePermit(run: (() => Promise<void>) | undefined) { beforePermit = run; },
      async setObservedOrder(kind: "placed" | "paid" | "cancelled" | "ambiguous") {
        await redis.set(orderKey, kind);
      },
      async stop() {
        await db.customerPhone.update({ where: { id: phone.id }, data: {
          whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP",
          whatsappNoContactAt: new Date(), whatsappNoContactRevision: { increment: 1 },
        } });
      },
      async resumePreviousRecovery() {
        const current = await db.checkoutRecovery.findUniqueOrThrow({ where: { id: recovery.id } });
        await db.$transaction(async (tx) => {
          const closed = await tx.checkoutRecovery.updateMany({
            where: { id: recovery.id, shopId, checkoutToken, status: current.status },
            data: { status: "CANCELLED" },
          });
          if (closed.count !== 1) throw new Error("ARCH048_RESUMPTION_FIXTURE_CLOSE_CONFLICT");
          await tx.checkoutRecoveryStatusHistory.create({ data: {
            checkoutRecoveryId: recovery.id, fromStatus: current.status, toStatus: "CANCELLED",
            source: "woocommerce.checkout", reason: "CHECKOUT_RESUMED",
            metadata: { eventId: `arch048-resume-${runId}`, nextGeneration: 2 },
          } });
        });
      },
      async cleanup() {
        await queue.obliterate({ force: true });
        await queue.close();
        await redis.del(orderKey);
        await redis.quit();
        // ARCH-045 consent evidence is append-only. Do not delete or mutate it
        // to clean a fixture: the integration runner owns this disposable DB.
        await db.$disconnect();
      },
    };
  } catch (error) {
    await queue.close();
    await redis.quit();
    await db.$disconnect();
    throw error;
  }
}

export type WooOutreachIntegrationFixture = Awaited<ReturnType<typeof createWooOutreachFixture>>;
