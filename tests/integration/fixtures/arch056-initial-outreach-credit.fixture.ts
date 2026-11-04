import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { InitialOutreachCreditService } from "../../../src/services/recovery-billing/initial-outreach-credit.service.js";

export async function createInitialOutreachCreditFixture(input: {
  databaseUrl?: string;
  withCredit?: boolean;
  source?: "free" | "paid" | "purchased" | "promotional";
} = {}) {
  const db = new PrismaClient({ datasourceUrl: input.databaseUrl ?? process.env.TEST_DATABASE_URL! });
  const suffix = randomUUID();
  const shopId = `arch056-${suffix}`;
  const recoveryId = randomUUID();
  const attemptId = randomUUID();
  const messageId = randomUUID();
  const providerMessageId = `wamid-${suffix}`;
  const now = new Date();
  const source = input.source ?? "free";
  const provider = source === "purchased" ? "WOOCOMMERCE" : "SHOPIFY";
  const periodStart = new Date(now.getTime() - 15 * 24 * 60 * 60_000);
  const periodEnd = new Date(now.getTime() + 15 * 24 * 60 * 60_000);
  const plan = await db.billingPlan.create({ data: {
    shopifyPlanHandle: `arch056-${suffix}`,
    name: "ARCH056 free",
    kind: source === "paid" ? "PAID_METERED" : "FREE",
    active: true,
    ...(source === "paid" ? { shopifyUsageEventHandle: "basic-recovery-conversation" } : {}),
  } });
  const recoveryFeature = await db.feature.upsert({
    where: { key: "checkout_recovery" },
    create: { key: "checkout_recovery", displayName: "Checkout recovery", activationMode: "ALWAYS_ENABLED" },
    update: {},
  });
  await db.billingPlanFeature.create({ data: { planId: plan.id, featureId: recoveryFeature.id } });
  await db.platformBillingPolicy.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", absoluteOutboundHardLimit: 20, defaultWarningPercent: 80 },
  });
  await db.shop.create({ data: {
    id: shopId,
    domain: `${suffix}.example.test`,
    platform: provider,
    status: "ACTIVE",
  } });
  let subscription = await db.subscription.create({ data: {
    shopId,
    planId: plan.id,
    status: "ACTIVE",
    observedShopifyPlanHandle: plan.shopifyPlanHandle,
    ...(source === "paid" ? { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd } : {}),
  } });
  await db.checkoutRecovery.create({ data: {
    id: recoveryId,
    shopId,
    checkoutToken: `checkout-${suffix}`,
    lastExternalActivityAt: now,
    status: "MESSAGE_SENT",
  } });
  const conversation = await db.conversation.create({ data: {
    type: "RECOVERY",
    checkoutRecoveryId: recoveryId,
  } });
  const sentAt = new Date(now.getTime() - 1_000);
  if (input.withCredit !== false) {
    await db.conversationMessage.create({ data: {
      id: messageId,
      conversationId: conversation.id,
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      status: "SENT",
      content: "Initial recovery outreach",
      providerMessageId,
      sentAt,
    } });
  }
  await db.recoveryOutreachAttempt.create({ data: {
    id: attemptId,
    checkoutRecoveryId: recoveryId,
    recipient: "15551234567",
    sequence: 1,
    trigger: "INITIAL",
    configuredOfferMode: "NONE",
    status: "PENDING",
    ...(input.withCredit !== false ? { outboundMessageId: messageId, sentAt } : {}),
  } });
  let counterId: string | null = null;
  let periodCounterId: string | null = null;
  let purchaseId: string | null = null;
  let grantId: string | null = null;
  let reservationId: string | null = null;
  let sourceKey: string | null = null;
  if (input.withCredit !== false) {
    const logicalSource = createRecoveryIdempotencyKey(shopId, `recovery-outreach:${attemptId}`);
    let counterKey: { id: string } | null = null;
    let purchaseKey: string | null = null;
    let grantKey: string | null = null;
    sourceKey = logicalSource;
    if (source === "free" || source === "purchased") {
      counterKey = await db.shopEntitlementCounter.create({ data: {
        shopId,
        counter: source === "free" ? "LIFETIME_FREE_RECOVERY_CREDITS" : "PURCHASED_RECOVERY_CREDITS",
        grantedQuantity: 1,
        reservedQuantity: 1,
      } });
      counterId = counterKey.id;
    }
    if (source !== "free") {
      await db.shopEntitlementCounter.create({ data: {
        shopId,
        counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 0,
      } });
    }
    if (source === "paid") {
      const period = await db.billingPeriod.create({ data: {
        shopId,
        subscriptionId: subscription.id,
        planId: plan.id,
        periodStart,
        periodEnd,
        status: "OPEN",
      } });
      subscription = await db.subscription.update({ where: { id: subscription.id }, data: { billingPeriodId: period.id } });
      const periodCounter = await db.billingPeriodEntitlementCounter.create({ data: {
        shopId,
        billingPeriodId: period.id,
        counter: "INCLUDED_RECOVERY_CREDITS",
        grantedQuantity: 1,
        reservedQuantity: 1,
      } });
      periodCounterId = periodCounter.id;
      sourceKey = `paid-included:${period.id}:${logicalSource}`;
    }
    if (source === "purchased") {
      const purchase = await db.recoveryCreditPurchase.create({ data: {
        id: randomUUID(),
        shopId,
        planId: plan.id,
        provider: "WOOCOMMERCE",
        providerReference: `arch056-purchase-${suffix}`,
        providerPurchaseAmount: "1.00",
        providerPurchaseCurrency: "USD",
        providerValuationConfirmedAt: now,
        providerPriceSnapshot: { amount: "1.00", currency: "USD" },
        creditsGranted: 1,
        currentAmount: 1,
        reservedAmount: 1,
        status: "ACTIVE",
        activatedAt: now,
      } });
      purchaseId = purchase.id;
      purchaseKey = purchase.id;
    }
    if (source === "promotional") {
      const admin = await db.platformAdmin.create({ data: { email: `${suffix}@example.test` } });
      const campaign = await db.promotionCampaign.create({ data: {
        name: `ARCH056-${suffix}`,
        scope: "GLOBAL",
        quantity: 1,
        startsAt: periodStart,
        expiresAt: periodEnd,
        status: "ACTIVE",
        createdByPlatformAdminId: admin.id,
      } });
      const grant = await db.promotionalCreditGrant.create({ data: {
        shopId,
        campaignId: campaign.id,
        quantity: 1,
        reservedQuantity: 1,
      } });
      await db.merchantPromotionSelection.create({ data: { shopId, promotionalCreditGrantId: grant.id } });
      grantId = grant.id;
      grantKey = grant.id;
    }
    const reservation = await db.usageReservation.create({ data: {
      shopId,
      counterId: counterKey?.id ?? null,
      billingPeriodEntitlementCounterId: periodCounterId,
      purchasedCreditPurchaseId: purchaseKey,
      promotionalCreditGrantId: grantKey,
      sourceKey,
      quantity: 1,
      status: "RESERVED",
    } });
    reservationId = reservation.id;
  }
  return {
    db,
    shopId,
    recoveryId,
    attemptId,
    messageId,
    providerMessageId,
    provider,
    source,
    sentAt,
    subscriptionId: subscription.id,
    counterId,
    periodCounterId,
    purchaseId,
    grantId,
    reservationId,
    sourceKey,
    service: new InitialOutreachCreditService(db),
    close: async () => db.$disconnect(),
  };
}

export async function addSharedCounterInitialOutreach(
  fixture: Awaited<ReturnType<typeof createInitialOutreachCreditFixture>>,
) {
  if (!fixture.counterId) throw new Error("A free-credit fixture counter is required");
  const suffix = randomUUID();
  const recoveryId = randomUUID();
  const attemptId = randomUUID();
  const messageId = randomUUID();
  const providerMessageId = `wamid-${suffix}`;
  const now = new Date();
  const sentAt = new Date(now.getTime() - 1_000);
  await fixture.db.shopEntitlementCounter.update({
    where: { id: fixture.counterId },
    data: { grantedQuantity: 2, reservedQuantity: 2 },
  });
  await fixture.db.checkoutRecovery.create({ data: {
    id: recoveryId,
    shopId: fixture.shopId,
    checkoutToken: `checkout-${suffix}`,
    lastExternalActivityAt: now,
    status: "MESSAGE_SENT",
  } });
  const conversation = await fixture.db.conversation.create({ data: {
    type: "RECOVERY",
    checkoutRecoveryId: recoveryId,
  } });
  await fixture.db.conversationMessage.create({ data: {
    id: messageId,
    conversationId: conversation.id,
    direction: "OUTBOUND",
    senderType: "AUTOMATION",
    status: "SENT",
    content: "Second initial recovery outreach",
    providerMessageId,
    sentAt,
  } });
  await fixture.db.recoveryOutreachAttempt.create({ data: {
    id: attemptId,
    checkoutRecoveryId: recoveryId,
    recipient: "15551234567",
    sequence: 1,
    trigger: "INITIAL",
    configuredOfferMode: "NONE",
    status: "PENDING",
    outboundMessageId: messageId,
    sentAt,
  } });
  const sourceKey = createRecoveryIdempotencyKey(fixture.shopId, `recovery-outreach:${attemptId}`);
  const reservation = await fixture.db.usageReservation.create({ data: {
    shopId: fixture.shopId,
    counterId: fixture.counterId,
    sourceKey,
    quantity: 1,
    status: "RESERVED",
  } });
  return { recoveryId, attemptId, messageId, providerMessageId, sentAt, sourceKey, reservationId: reservation.id };
}
