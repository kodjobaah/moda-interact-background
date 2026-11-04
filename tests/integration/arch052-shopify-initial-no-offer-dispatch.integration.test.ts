import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoveryBillingService } from "../../src/services/recovery-billing.service.js";
import { RecoveryInitiationService } from "../../src/services/checkout-recovery/recovery-initiation.service.js";
import { RecoveryOutreachFinalizationService } from
  "../../src/services/checkout-recovery/recovery-outreach-finalization.service.js";
import { recoveryShopifyCustomerService } from
  "../../src/services/checkout-recovery/recovery-shopify-customer.service.js";
import { outboundWhatsAppAdmissionService } from "../../src/services/outbound-whatsapp-admission.service.js";
import { whatsAppService } from "../../src/services/whatsapp.service.js";
import { ShopifyWhatsAppConsentService } from "../../src/services/shopify-whatsapp-consent.service.js";
import { moderationAssessmentService } from "../../src/services/conversation-moderation/moderation-assessment.service.js";
import { abandonedCheckoutLookupService } from "../../src/services/abandoned-checkout-lookup.service.js";
import type { RecoveryCheckoutSeed } from "../../src/events/checkout-events.js";
import { seedApprovedInitialWooTemplateRegistration, WOO_TEST_SENDER_WABA } from
  "./fixtures/woo-approved-initial-template.fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDatabase = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const clients: PrismaClient[] = [];

vi.mock("../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: {
    current: () => ({ version: 1, pendingRecoveryQueueGlobalConcurrency: 1 }),
    subscribe: () => () => undefined,
  },
}));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
});

async function fixture(consentAllowed = true) {
  const db = new PrismaClient({ datasourceUrl: databaseUrl! });
  clients.push(db);
  const suffix = randomUUID().replaceAll("-", "");
  const shopId = `bg052-shopify-${suffix}`;
  const domain = `${shopId}.myshopify.com`;
  const phone = "+447400123456";
  const recipient = "447400123456";
  const shopifyCustomerId = "125678912345";
  const checkoutToken = `checkout-${suffix}`;
  const checkoutUrl = `https://${domain}/checkouts/${suffix}`;
  const now = new Date();
  const lineItems = [{ productId: "gid://shopify/Product/42", variantId: "gid://shopify/ProductVariant/7",
    title: "Saved checkout item", variantTitle: "Blue", quantity: 2, price: "12.50" }];

  const feature = await db.feature.upsert({
    where: { key: "checkout_recovery" },
    create: { key: "checkout_recovery", displayName: "Checkout recovery", activationMode: "ALWAYS_ENABLED" },
    update: {},
  });
  const plan = await db.billingPlan.create({ data: {
    shopifyPlanHandle: `bg052-shopify-${suffix}`, name: "ARCH052 Shopify free", kind: "FREE",
  } });
  await db.shop.create({ data: {
    id: shopId, domain, platform: "SHOPIFY", status: "ACTIVE", onboardingCompleted: true,
    defaultCountryCode: "GB", defaultLanguageTag: "en-GB",
  } });
  await db.shopSettings.create({ data: {
    shopId, recoveryOfferMode: "NONE", notifyOnInitialRecoveryOutreach: false,
  } });
  await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: feature.id } });
  await db.subscription.create({ data: {
    shopId, planId: plan.id, status: "ACTIVE", observedShopifyPlanHandle: plan.shopifyPlanHandle,
  } });
  await db.platformBillingPolicy.upsert({
    where: { id: "default" }, update: {},
    create: { id: "default", absoluteOutboundHardLimit: 20, defaultWarningPercent: 80 },
  });
  await db.backgroundRuntimeConfig.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  await db.shopEntitlementCounter.create({ data: {
    shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 1,
  } });
  const template = await seedApprovedInitialWooTemplateRegistration(db, shopId, `https://${domain}`);
  const customer = await db.customer.create({ data: {
    shopId, shopifyCustomerId, firstName: "Taylor", phone,
  } });
  const customerPhone = await db.customerPhone.create({ data: { customerId: customer.id, phone } });
  if (consentAllowed) {
    const consent = new ShopifyWhatsAppConsentService({
      readCurrent: vi.fn(async () => ({
        kind: "OBSERVED" as const,
        customerGid: `gid://shopify/Customer/${shopifyCustomerId}`,
        phoneNumber: phone,
        state: "SUBSCRIBED" as const,
        updatedAt: now.toISOString(),
      })),
    }, db);
    const outcome = await consent.evaluateRecipient({
      shopId, customerId: customer.id,
      shopifyCustomerId: `gid://shopify/Customer/${shopifyCustomerId}`, recipient: phone,
    });
    expect(outcome.status).toBe("ALLOWED");
  }

  vi.spyOn(recoveryShopifyCustomerService, "resolve").mockResolvedValue(customer as never);
  vi.spyOn(outboundWhatsAppAdmissionService, "getProviderAccountId").mockResolvedValue(WOO_TEST_SENDER_WABA);
  vi.spyOn(whatsAppService, "getProviderAccountId").mockResolvedValue(WOO_TEST_SENDER_WABA);
  const providerSend = vi.spyOn(whatsAppService, "sendWhatsAppTemplate")
    .mockResolvedValue({ providerMessageId: `wamid-${suffix}` } as never);
  vi.spyOn(moderationAssessmentService, "assessText").mockResolvedValue({
    kind: "allow", assessmentId: `assessment-${suffix}`, digest: "a".repeat(64),
    policyVersion: "arch040-moderation-v1",
  });
  vi.spyOn(moderationAssessmentService, "requireCurrentAllowance").mockResolvedValue(true);
  const upsertRecovery = vi.fn(async (event: RecoveryCheckoutSeed) => db.checkoutRecovery.create({ data: {
    shopId, customerId: customer.id, checkoutToken: event.checkoutToken,
    cartToken: event.cartToken, status: "DETECTED", generation: 1,
    currency: event.currency, totalPrice: event.totalPrice, checkoutUrl: event.checkoutUrl,
    lineItems: event.lineItems, detectedAt: new Date(event.detectedAt),
    lastExternalActivityAt: new Date(event.lastExternalActivityAt ?? event.detectedAt),
  } }));
  const ports = {
    upsertRecovery,
    resolveRecipient: vi.fn(() => phone),
    markRecoveryCapacityBlocked: vi.fn(async () => undefined),
  };
  const consentAdmission = {
    evaluateFirst: vi.fn(async () => consentAllowed),
    evaluateReentry: vi.fn(async () => consentAllowed),
    notifyMissingRecipient: vi.fn(async () => undefined),
  };
  const suppressionAdmission = { evaluate: vi.fn(async () => ({ kind: "allowed" as const })) };
  const finalizer = new RecoveryOutreachFinalizationService(recoveryBillingService);
  const service = new RecoveryInitiationService(
    recoveryBillingService, finalizer, ports, suppressionAdmission as never, consentAdmission,
  );
  const event = {
    shop: domain, checkoutToken, cartToken: `cart-${suffix}`, currency: "GBP", totalPrice: "25.00",
    checkoutUrl, lineItems, detectedAt: now.toISOString(), lastExternalActivityAt: now.toISOString(),
    completedAt: null,
    customer: { phone, shopifyCustomerId: `gid://shopify/Customer/${shopifyCustomerId}`,
      firstName: "Taylor", lastName: null, email: null },
    internationalContext: { countryCode: "GB" },
  } as unknown as RecoveryCheckoutSeed;

  return { db, shopId, domain, phone, recipient, customer, customerPhone, checkoutToken,
    checkoutUrl, lineItems, template, event, service, ports, consentAdmission, providerSend };
}

withDatabase("ARCH-052 Shopify initial no-offer dispatch (disposable PostgreSQL)", () => {
  it("sends the prepared fallback once under its attempt identity and finalizes one credit", async () => {
    const f = await fixture();
    const resumeInitialTemplate = vi.spyOn(outboundWhatsAppAdmissionService, "resumeInitialTemplate");

    await f.service.handleCheckoutCreated(f.event, 1, f.phone);
    expect(resumeInitialTemplate).toHaveBeenCalledOnce();

    const recovery = await f.db.checkoutRecovery.findFirstOrThrow({
      where: { shopId: f.shopId, checkoutToken: f.checkoutToken },
    });
    const attempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: recovery.id, sequence: 1 } },
    });
    const admissionEvent = await f.db.usageEvent.findUnique({
      where: { idempotencyKey: `recovery-outreach:${attempt.id}` },
    });
    expect(admissionEvent).not.toBeNull();
    expect(resumeInitialTemplate).toHaveBeenCalledOnce();
    expect(await resumeInitialTemplate.mock.results[0]!.value)
      .toMatchObject({ kind: "admitted", executionScope: "recovery" });
    expect(f.providerSend).toHaveBeenCalledOnce();
    expect(attempt).toMatchObject({ status: "WAITING_FOR_RESPONSE", outboundMessageId: expect.any(String) });
    const message = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: attempt.outboundMessageId! } });
    const reservation = await f.db.usageReservation.findFirstOrThrow({ where: { shopId: f.shopId } });
    const counter = await f.db.shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    });

    expect(f.ports.upsertRecovery).toHaveBeenCalledOnce();
    expect(f.providerSend).toHaveBeenCalledOnce();
    expect(message).toMatchObject({
      direction: "OUTBOUND", senderType: "AUTOMATION", status: "SENT",
      providerDispatchKey: expect.stringMatching(/^arch040-auto-/),
      providerMessageId: expect.stringMatching(/^wamid-/),
    });
    expect(message.providerDispatchAdmittedAt).not.toBeNull();
    expect(admissionEvent.sourceId).toBe(message.id);
    expect(message.sentAt).not.toBeNull();
    expect(message.content).toContain('"recoveryPromise":{"kind":"NO_OFFER"}');
    expect(message.content).toContain("Saved checkout item");
    expect(attempt).toMatchObject({
      sequence: 1, status: "WAITING_FOR_RESPONSE", sentAt: message.sentAt, outboundMessageId: message.id,
    });
    expect(recovery.status).toBe("MESSAGE_SENT");
    expect(reservation).toMatchObject({ status: "COMMITTED", quantity: 1 });
    expect(counter).toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
    expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(1);
    expect(await f.db.usageEvent.count({ where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(1);
  }, 90_000);

  it("resumes the same prepared message and credit through the real candidate worker after pre-permit interruption", async () => {
    const f = await fixture();
    const interruption = new Error("interrupted before provider permit");
    const resume = vi.spyOn(outboundWhatsAppAdmissionService, "resumeInitialTemplate")
      .mockRejectedValueOnce(interruption);
    await expect(f.service.handleCheckoutCreated(f.event, 1, f.phone)).rejects.toBe(interruption);

    const recovery = await f.db.checkoutRecovery.findFirstOrThrow({
      where: { shopId: f.shopId, checkoutToken: f.checkoutToken },
    });
    const attempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: recovery.id, sequence: 1 } },
    });
    const preparedUsage = await f.db.usageEvent.findUniqueOrThrow({
      where: { idempotencyKey: `recovery-outreach:${attempt.id}` },
    });
    const preparedMessage = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: preparedUsage.sourceId } });
    expect(preparedMessage).toMatchObject({ status: "PENDING", providerDispatchKey: null,
      providerDispatchAdmittedAt: null, providerMessageId: null, sentAt: null });
    expect(preparedUsage).toMatchObject({ sourceId: preparedMessage.id });
    expect(await f.db.usageReservation.count({ where: { shopId: f.shopId, status: "RESERVED" } })).toBe(1);
    expect(f.providerSend).not.toHaveBeenCalled();

    const lookup = vi.spyOn(abandonedCheckoutLookupService, "lookup").mockResolvedValue({
      kind: "found",
      checkout: {
        shopifyAbandonedCheckoutId: null,
        abandonedCheckoutUrl: f.checkoutUrl,
        createdAt: f.event.detectedAt,
        completedAt: null,
        currencyCode: "GBP",
        totalPrice: "25.00",
        internationalContext: f.event.internationalContext!,
        customer: {
          shopifyCustomerId: "gid://shopify/Customer/125678912345",
          email: null, phone: f.phone, firstName: "Taylor", lastName: null,
        },
        lineItems: f.lineItems,
      },
    });
    const [{ Queue, QueueEvents }, { connectionRedis }, domain, workerModule] = await Promise.all([
      import("bullmq"),
      import("../../src/lib/redis.js"),
      import("../../src/domain/pending-recovery-candidate.js"),
      import("../../src/workers/pending-recovery-candidate.worker.js"),
    ]);
    const queue = new Queue(domain.PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const events = new QueueEvents(domain.PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const worker = workerModule.createPendingRecoveryCandidateWorker();
    const jobId = `prepared-resume-${randomUUID()}`;
    const candidate = {
      shopId: f.shopId, shopDomain: f.domain, checkoutToken: f.checkoutToken,
      cartToken: f.event.cartToken, abandonedCheckoutUrl: f.checkoutUrl,
      checkoutCreatedAt: f.event.detectedAt,
      internationalContext: f.event.internationalContext,
    };
    await queue.add(domain.EVALUATE_PENDING_RECOVERY_JOB, candidate, {
      jobId, attempts: 1, removeOnComplete: false, removeOnFail: false,
    });
    try {
      await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Prepared candidate did not finish: ${jobId}`)), 25_000);
        worker.on("completed", (completed) => {
          if (completed.id !== jobId) return;
          clearTimeout(timer);
          resolve();
        });
        worker.on("failed", (failed, error) => {
          if (failed?.id !== jobId) return;
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(lookup).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledTimes(2);
      expect(resume.mock.calls[1]?.[0]).toMatchObject({ messageId: preparedMessage.id,
        outreachAttemptId: attempt.id, recoveryCreditSourceKey: expect.any(String) });
      expect(await resume.mock.results[1]!.value).toMatchObject({ kind: "admitted", executionScope: "recovery" });
      expect(f.providerSend).toHaveBeenCalledOnce();
      const finalAttempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      const finalMessage = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: preparedMessage.id } });
      expect(finalAttempt).toMatchObject({ status: "WAITING_FOR_RESPONSE", outboundMessageId: preparedMessage.id });
      expect(finalMessage).toMatchObject({ status: "SENT", providerMessageId: expect.any(String) });
      expect(await f.db.usageEvent.count({ where: { idempotencyKey: `recovery-outreach:${attempt.id}` } })).toBe(1);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(1);
      expect(await f.db.usageReservation.findFirstOrThrow({ where: { shopId: f.shopId } }))
        .toMatchObject({ status: "COMMITTED", quantity: 1 });
      expect((await f.db.checkoutRecovery.findUniqueOrThrow({ where: { id: recovery.id } })).status)
        .toBe("MESSAGE_SENT");
    } finally {
      lookup.mockRestore();
      resume.mockRestore();
      await worker.close();
      await events.close();
      await queue.close();
    }
  }, 90_000);

  it("keeps a permitted message held in the real candidate worker without a second provider request", async () => {
    const f = await fixture();
    const resume = vi.spyOn(outboundWhatsAppAdmissionService, "resumeInitialTemplate");
    const providerTimeout = new Error("provider outcome unknown after permit");
    f.providerSend.mockRejectedValueOnce(providerTimeout);
    await expect(f.service.handleCheckoutCreated(f.event, 1, f.phone)).rejects.toBe(providerTimeout);

    const recovery = await f.db.checkoutRecovery.findFirstOrThrow({
      where: { shopId: f.shopId, checkoutToken: f.checkoutToken },
    });
    const attempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: recovery.id, sequence: 1 } },
    });
    const usage = await f.db.usageEvent.findUniqueOrThrow({
      where: { idempotencyKey: `recovery-outreach:${attempt.id}` },
    });
    const message = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: usage.sourceId } });
    expect(message).toMatchObject({ status: "PENDING", providerDispatchKey: expect.any(String),
      providerDispatchAdmittedAt: expect.any(Date), providerMessageId: null, sentAt: null });
    expect(await f.db.usageReservation.count({ where: { shopId: f.shopId, status: "RESERVED" } })).toBe(1);
    expect(f.providerSend).toHaveBeenCalledOnce();
    const initialResumeCount = resume.mock.calls.length;

    const lookup = vi.spyOn(abandonedCheckoutLookupService, "lookup").mockResolvedValue({
      kind: "found",
      checkout: {
        shopifyAbandonedCheckoutId: null,
        abandonedCheckoutUrl: f.checkoutUrl,
        createdAt: f.event.detectedAt,
        completedAt: null,
        currencyCode: "GBP",
        totalPrice: "25.00",
        internationalContext: f.event.internationalContext!,
        customer: {
          shopifyCustomerId: "gid://shopify/Customer/125678912345",
          email: null, phone: f.phone, firstName: "Taylor", lastName: null,
        },
        lineItems: f.lineItems,
      },
    });
    const [{ Queue, QueueEvents }, { connectionRedis }, domain, workerModule] = await Promise.all([
      import("bullmq"),
      import("../../src/lib/redis.js"),
      import("../../src/domain/pending-recovery-candidate.js"),
      import("../../src/workers/pending-recovery-candidate.worker.js"),
    ]);
    const queue = new Queue(domain.PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const events = new QueueEvents(domain.PENDING_RECOVERY_CANDIDATE_QUEUE, { connection: connectionRedis });
    const worker = workerModule.createPendingRecoveryCandidateWorker();
    const jobId = `permitted-uncertain-${randomUUID()}`;
    const candidate = {
      shopId: f.shopId, shopDomain: f.domain, checkoutToken: f.checkoutToken,
      cartToken: f.event.cartToken, abandonedCheckoutUrl: f.checkoutUrl,
      checkoutCreatedAt: f.event.detectedAt,
      internationalContext: f.event.internationalContext,
    };
    await queue.add(domain.EVALUATE_PENDING_RECOVERY_JOB, candidate, {
      jobId, attempts: 1, removeOnComplete: false, removeOnFail: false,
    });
    try {
      await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Uncertain candidate did not finish: ${jobId}`)), 25_000);
        worker.on("completed", (completed) => {
          if (completed.id !== jobId) return;
          clearTimeout(timer);
          reject(new Error("Provider-uncertain candidate unexpectedly completed"));
        });
        worker.on("failed", (failed) => {
          if (failed?.id !== jobId) return;
          clearTimeout(timer);
          resolve();
        });
      });

      expect(await (await queue.getJob(jobId))?.getState()).toBe("failed");
      expect(lookup).not.toHaveBeenCalled();
      expect(resume).toHaveBeenCalledTimes(initialResumeCount);
      expect(f.providerSend).toHaveBeenCalledOnce();
      expect(await f.db.conversationMessage.findUniqueOrThrow({ where: { id: message.id } }))
        .toMatchObject({ status: "PENDING", providerDispatchAdmittedAt: expect.any(Date),
          providerMessageId: null, sentAt: null });
      expect(await f.db.usageReservation.findFirstOrThrow({ where: { shopId: f.shopId } }))
        .toMatchObject({ status: "RESERVED", quantity: 1 });
      expect(await f.db.merchantSupportMessage.count({ where: { checkoutRecoveryId: recovery.id } })).toBe(0);
      expect((await f.db.checkoutRecovery.findUniqueOrThrow({ where: { id: recovery.id } })).status)
        .toBe("DETECTED");
    } finally {
      lookup.mockRestore();
      resume.mockRestore();
      await worker.close();
      await events.close();
      await queue.close();
    }
  }, 90_000);

  it("does not create an attempt, reserve credit or call Meta when required consent is denied", async () => {
    const f = await fixture(false);

    await f.service.handleCheckoutCreated(f.event, 1, f.phone);

    expect(f.consentAdmission.evaluateFirst).toHaveBeenCalledOnce();
    expect(f.ports.upsertRecovery).not.toHaveBeenCalled();
    expect(f.providerSend).not.toHaveBeenCalled();
    expect(await f.db.checkoutRecovery.count({ where: { shopId: f.shopId } })).toBe(0);
    expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecovery: { shopId: f.shopId } } })).toBe(0);
    expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(0);
  }, 90_000);
});