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
import type { RecoveryCheckoutSeed } from "../../src/events/checkout-events.js";
import { seedApprovedInitialWooTemplateRegistration, WOO_TEST_SENDER_WABA } from
  "./fixtures/woo-approved-initial-template.fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDatabase = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const clients: PrismaClient[] = [];

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

    await f.service.handleCheckoutCreated(f.event, 1, f.phone);

    const recovery = await f.db.checkoutRecovery.findFirstOrThrow({
      where: { shopId: f.shopId, checkoutToken: f.checkoutToken },
    });
    const attempt = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: recovery.id, sequence: 1 } },
    });
    const message = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: attempt.outboundMessageId! } });
    const admissionEvent = await f.db.usageEvent.findUniqueOrThrow({
      where: { idempotencyKey: `recovery-outreach:${attempt.id}` },
    });
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