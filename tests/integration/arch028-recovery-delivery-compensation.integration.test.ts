import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it } from "vitest";
import { RecoveryDeliveryCompensationService } from
  "../../src/services/recovery-delivery-compensation/reconcile.service.js";
import { WhatsAppProviderStatusService } from "../../src/services/whatsapp-provider-status.service.js";

type SourceKind = "free" | "paid" | "promotional" | "purchased";
type TestCase = {
  source?: SourceKind;
  provider?: "SHOPIFY" | "WOOCOMMERCE";
  status?: "RESERVED" | "COMMITTED";
  active?: boolean;
  sender?: "AUTOMATION" | "HUMAN";
  humanKind?: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE";
  linkMessage?: boolean;
  initialStatus?: "SENT" | "FAILED" | "DELIVERED" | "READ";
};

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

async function fixture(input: TestCase = {}) {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
  const id = randomUUID();
  const shopId = `arch028-${id}`;
  const recoveryId = randomUUID();
  const attemptId = randomUUID();
  const messageId = randomUUID();
  const providerMessageId = `wamid-${id}`;
  const provider = input.provider ?? "SHOPIFY";
  const source = input.source ?? "free";
  const state = input.status ?? "COMMITTED";
  const active = input.active !== false;
  const sender = input.sender ?? "AUTOMATION";
  const linked = input.linkMessage !== false;
  const now = new Date();
  // Closed source windows must still have a positive duration. Making start=end
  // would fail the database boundary checks before compensation is exercised.
  const day = 24 * 60 * 60_000;
  const periodStart = new Date(now.getTime() - (active ? day : 2 * day));
  const periodEnd = new Date(now.getTime() + (active ? day : -day));
  const plan = await db.billingPlan.create({ data: {
    shopifyPlanHandle: `arch028-${id}`, name: "ARCH028", kind: source === "paid" ? "PAID_METERED" : "FREE",
  } });
  await db.shop.create({ data: { id: shopId, domain: `${id}.example.test`, platform: provider, status: "ACTIVE" } });
  const subscription = await db.subscription.create({ data: {
    shopId, planId: plan.id, status: "ACTIVE", observedShopifyPlanHandle: plan.shopifyPlanHandle,
    ...(source === "paid" ? { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd } : {}),
  } });
  await db.checkoutRecovery.create({ data: {
    id: recoveryId, shopId, checkoutToken: `checkout-${id}`,
    lastExternalActivityAt: now, status: "MESSAGE_SENT",
  } });
  const conversation = await db.conversation.create({ data: {
    type: "RECOVERY", checkoutRecoveryId: recoveryId,
  } });
  await db.conversationMessage.create({ data: {
    id: messageId, conversationId: conversation.id, direction: "OUTBOUND", senderType: sender,
    status: input.initialStatus ?? "FAILED", content: "recovery attempt", providerMessageId,
    sentAt: now, ...(input.initialStatus === "DELIVERED" ? { deliveredAt: now } : {}),
    ...(input.initialStatus === "READ" ? { deliveredAt: now, readAt: now } : {}),
    ...(!input.initialStatus || input.initialStatus === "FAILED"
      ? { providerFailureCode: "131026", failedAt: now } : {}),
  } });
  await db.recoveryOutreachAttempt.create({ data: {
    id: attemptId, checkoutRecoveryId: recoveryId, recipient: "15551234567",
    sequence: sender === "HUMAN" ? 2 : 1,
    trigger: sender === "HUMAN" ? "NO_RESPONSE_FOLLOW_UP" : "INITIAL",
    configuredOfferMode: "NONE", status: "NO_RESPONSE",
    ...(linked ? { outboundMessageId: messageId } : {}),
  } });
  if (sender === "AUTOMATION") {
    await db.usageEvent.create({ data: {
      shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
      sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: messageId,
      idempotencyKey: `recovery-outreach:${attemptId}`,
    } });
  } else {
    // ARCH-040 requires an INSERT to be an accepted intent with no outbound
    // identity. Link the produced message in a separate guarded UPDATE.
    const command = await db.merchantConversationSendCommand.create({ data: {
      shopId, conversationId: conversation.id,
      kind: input.humanKind ?? "RECOVERY_FOLLOW_UP_TEMPLATE",
      recipientSnapshot: "15551234567", idempotencyKey: `human-${id}`,
      payloadSha256: "0".repeat(64), expectedControlRevision: 1,
      ...(input.humanKind === "HUMAN_TEXT"
        ? { textBody: "Ordinary merchant reply" }
        : { templateName: "recovery_follow_up", templateLanguageCode: "en",
          recoveryOutreachAttemptId: attemptId }),
    } });
    await db.merchantConversationSendCommand.update({
      where: { id: command.id }, data: { outboundMessageId: messageId },
    });
  }
  const logicalKey = createRecoveryIdempotencyKey(shopId, `recovery-outreach:${attemptId}`);
  let sourceKey = logicalKey;
  let counterId: string | null = null;
  let billingPeriodEntitlementCounterId: string | null = null;
  let promotionalCreditGrantId: string | null = null;
  let purchasedCreditPurchaseId: string | null = null;
  let periodId: string | null = null;
  if (source === "free" || source === "purchased") {
    const counter = await db.shopEntitlementCounter.create({ data: {
      shopId, counter: source === "free" ? "LIFETIME_FREE_RECOVERY_CREDITS" : "PURCHASED_RECOVERY_CREDITS",
      grantedQuantity: 1, committedQuantity: state === "COMMITTED" ? 1 : 0,
      reservedQuantity: state === "RESERVED" ? 1 : 0,
    } });
    counterId = counter.id;
    if (source === "purchased") {
      // ARCH-027 requires distinct evidence shapes. WooCommerce purchases
      // use their provider reference and must NOT contain Shopify usage fields.
      const purchaseId = randomUUID();
      const shopifyEvidence = async () => {
        const billingPeriod = await db.billingPeriod.create({ data: {
          shopId, subscriptionId: subscription.id, planId: plan.id,
          periodStart, periodEnd, status: "OPEN",
        } });
        const purchaseEvent = await db.usageEvent.create({ data: {
          shopId, provider, billingPeriodId: billingPeriod.id,
          metric: "RECOVERY_CREDIT_PACK_PURCHASE", quantity: 1,
          idempotencyKey: `purchase-event:${purchaseId}`,
          sourceType: "RECOVERY_CREDIT_PACK_PURCHASE", sourceId: purchaseId,
          shopifyReportState: "REPORTED", shopifyEventHandle: `purchase-${id}`,
        } });
        return {
          billingPeriodId: billingPeriod.id,
          shopifyPlanHandleSnapshot: plan.shopifyPlanHandle,
          shopifyEventHandleSnapshot: `purchase-${id}`,
          providerSubscriptionIdSnapshot: `gid://shopify/AppSubscription/${id}`,
          providerUsageQuantityBeforeSnapshot: 0,
          providerUsageCostBeforeSnapshot: new Prisma.Decimal("10.00"),
          providerUsageCostCurrencyBeforeSnapshot: "USD",
          providerUsageQuantityAfterSnapshot: 1,
          providerUsageCostAfterSnapshot: new Prisma.Decimal("11.00"),
          providerUsageCostCurrencyAfterSnapshot: "USD",
          usageEventId: purchaseEvent.id,
        };
      };
      const providerEvidence = provider === "SHOPIFY"
        ? await shopifyEvidence()
        : { providerReference: `woo-credit-pack-${id}` };
      const purchase = await db.recoveryCreditPurchase.create({ data: {
        id: purchaseId, shopId, planId: plan.id, provider,
        ...providerEvidence,
        providerPurchaseAmount: new Prisma.Decimal("1.00"),
        providerPurchaseCurrency: "USD", providerValuationConfirmedAt: now,
        providerPriceSnapshot: { amount: "1.00", currency: "USD" },
        creditsGranted: 1,
        currentAmount: state === "RESERVED" ? 1 : 0,
        reservedAmount: state === "RESERVED" ? 1 : 0,
        status: state === "RESERVED" ? "ACTIVE" : "COMPLETED",
        activatedAt: now,
      } });
      purchasedCreditPurchaseId = purchase.id;
    }
  }
  if (source === "paid") {
    const period = await db.billingPeriod.create({ data: {
      shopId, subscriptionId: subscription.id, periodStart, periodEnd,
      status: active ? "OPEN" : "CLOSED",
      ...(!active ? { closedAt: now } : {}),
    } });
    periodId = period.id;
    await db.subscription.update({ where: { id: subscription.id }, data: { billingPeriodId: period.id } });
    const counter = await db.billingPeriodEntitlementCounter.create({ data: {
      shopId, billingPeriodId: period.id, counter: "INCLUDED_RECOVERY_CREDITS",
      grantedQuantity: 1, committedQuantity: state === "COMMITTED" ? 1 : 0,
      reservedQuantity: state === "RESERVED" ? 1 : 0,
    } });
    billingPeriodEntitlementCounterId = counter.id;
    sourceKey = `paid-included:${period.id}:${logicalKey}`;
  }
  if (source === "promotional") {
    const administrator = await db.platformAdmin.create({ data: { email: `${id}@example.test` } });
    const campaign = await db.promotionCampaign.create({ data: {
      name: `ARCH028-${id}`, scope: "GLOBAL", quantity: 1,
      startsAt: periodStart, expiresAt: periodEnd,
      status: active ? "ACTIVE" : "CLOSED", createdByPlatformAdminId: administrator.id,
    } });
    const grant = await db.promotionalCreditGrant.create({ data: {
      shopId, campaignId: campaign.id, quantity: 1,
      committedQuantity: state === "COMMITTED" ? 1 : 0,
      reservedQuantity: state === "RESERVED" ? 1 : 0,
    } });
    promotionalCreditGrantId = grant.id;
  }
  const reservation = await db.usageReservation.create({ data: {
    shopId, sourceKey, quantity: 1, status: state,
    counterId, billingPeriodEntitlementCounterId,
    purchasedCreditPurchaseId, promotionalCreditGrantId,
  } });
  if (state === "COMMITTED") {
    const usageEvent = await db.usageEvent.create({ data: {
      shopId, provider, metric: "RECOVERY_CONVERSATION", quantity: 1,
      billingPeriodId: periodId, idempotencyKey: createRecoveryIdempotencyKey(shopId, sourceKey),
      sourceType: source === "free" ? "FREE_RECOVERY_RESERVATION"
        : source === "paid" ? "PAID_RECOVERY_CONVERSATION"
        : source === "promotional" ? "PROMOTIONAL_RECOVERY_CREDITS" : "PURCHASED_RECOVERY_CREDITS",
      sourceId: source === "paid" ? sourceKey : reservation.id,
      shopifyReportState: source === "paid" && provider === "SHOPIFY" ? "PENDING" : "NOT_APPLICABLE",
      ...(source === "paid" && provider === "SHOPIFY" ? {
        shopifyEventHandle: "gid://shopify/AppUsagePricing/1",
        shopifyIdempotencyKey: `shopify-${id}`,
      } : {}),
    } });
    await db.usageReservation.update({ where: { id: reservation.id },
      data: { committedUsageEventId: usageEvent.id } });
  }
  return { db, shopId, recoveryId, attemptId, messageId, providerMessageId,
    reservationId: reservation.id, counterId, billingPeriodEntitlementCounterId,
    promotionalCreditGrantId, purchasedCreditPurchaseId, sourceKey,
    compensate: new RecoveryDeliveryCompensationService(db),
    close: () => db.$disconnect(),
  };
}

suite("ARCH-028 generic recovery delivery compensation (PostgreSQL)", () => {
  it.each(["SHOPIFY", "WOOCOMMERCE"] as const)(
    "corrects %s committed Free once with exact source/provider, including NO_RESPONSE", async (provider) => {
      const f = await fixture({ provider });
      try {
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("restored-spendable");
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("restored-spendable");
        const reservation = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } });
        expect(reservation.compensationReason).toBe("WHATSAPP_RECIPIENT_UNDELIVERABLE");
        expect(reservation.compensationDisposition).toBe("RESTORED_SPENDABLE");
        const usage = await f.db.usageEvent.findMany({ where: { shopId: f.shopId,
          metric: "RECOVERY_CONVERSATION" } });
        expect(usage).toHaveLength(2);
        expect(usage.find((event) => event.quantity.isNegative())).toMatchObject({
          id: reservation.compensationUsageEventId, shopId: f.shopId, provider,
          quantity: expect.anything(), shopifyReportState: "NOT_APPLICABLE",
          shopifyIdempotencyKey: null, shopifyEventHandle: null,
          nextReportAt: null, lastReportAttemptAt: null, reportedAt: null,
        });
        expect(usage.find((event) => event.quantity.isNegative())?.quantity.toNumber()).toBe(-1);
        expect(usage.find((event) => event.quantity.isNegative())?.correctionOfUsageEventId)
          .toBe(reservation.committedUsageEventId);
        expect((await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } })).committedQuantity).toBe(0);
        expect(await f.db.usageEvent.count({ where: { shopId: f.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE" } })).toBe(0);
        expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } })).status).toBe("NO_RESPONSE");
      } finally { await f.close(); }
    },
  );

  it.each([true, false])("paid included %s period gets historical-only as needed", async (active) => {
    const f = await fixture({ source: "paid", active });
    try {
      expect(await f.compensate.reconcile(f.providerMessageId))
        .toBe(active ? "restored-spendable" : "historical-only");
      const reservation = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } });
      expect(reservation.compensationDisposition).toBe(active ? "RESTORED_SPENDABLE" : "HISTORICAL_ONLY");
      const counter = await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({
        where: { id: f.billingPeriodEntitlementCounterId! },
      });
      expect(counter.committedQuantity).toBe(0);
      expect(counter.forfeitedQuantity).toBe(active ? 0 : 1);
      const correction = await f.db.usageEvent.findUniqueOrThrow({ where: { id: reservation.compensationUsageEventId! } });
      expect(correction).toMatchObject({ shopId: f.shopId, provider: "SHOPIFY", shopifyReportState: "NOT_APPLICABLE",
        shopifyEventHandle: null, shopifyIdempotencyKey: null });
      expect(correction.billingPeriodId).toBe(counter.billingPeriodId);
    } finally { await f.close(); }
  });

  it.each([true, false])("promotional %s grant restores only when spendable", async (active) => {
    const f = await fixture({ source: "promotional", active, provider: "WOOCOMMERCE" });
    try {
      expect(await f.compensate.reconcile(f.providerMessageId))
        .toBe(active ? "restored-spendable" : "historical-only");
      expect((await f.db.promotionalCreditGrant.findUniqueOrThrow({
        where: { id: f.promotionalCreditGrantId! },
      })).committedQuantity).toBe(active ? 0 : 1);
      const reservation = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } });
      expect(reservation.compensationDisposition).toBe(active ? "RESTORED_SPENDABLE" : "HISTORICAL_ONLY");
    } finally { await f.close(); }
  });

  it.each(["free", "paid", "promotional", "purchased"] as const)(
    "releases RESERVED %s using its original owner without negative usage", async (source) => {
      const f = await fixture({ source, status: "RESERVED" });
      try {
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("released");
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("already-released");
        expect((await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } })).status).toBe("RELEASED");
        expect(await f.db.usageEvent.count({ where: {
          shopId: f.shopId, metric: "RECOVERY_CONVERSATION",
        } })).toBe(0);
        expect(await f.db.usageEvent.count({ where: {
          shopId: f.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE",
        } })).toBe(0);
      } finally { await f.close(); }
    },
  );

  it("restores COMMITTED purchased compensation and removes exact outbound usage", async () => {
    const f = await fixture({ source: "purchased" });
    try {
      expect(await f.compensate.reconcile(f.providerMessageId)).toBe("restored-spendable");
      expect(await f.compensate.reconcile(f.providerMessageId)).toBe("restored-spendable");
      const source = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } });
      expect(source.compensationUsageEventId).not.toBeNull();
      expect(source.status).toBe("COMMITTED");
      expect(await f.db.usageEvent.count({ where: { sourceId: f.messageId,
        metric: "OUTBOUND_AUTOMATED_MESSAGE" } })).toBe(0);
    } finally { await f.close(); }
  });

  it("requires exact recovery-template linkage for HUMAN follow-up, not HUMAN_TEXT", async () => {
    const linked = await fixture({ sender: "HUMAN", source: "free" });
    const ordinary = await fixture({ sender: "HUMAN", humanKind: "HUMAN_TEXT", linkMessage: false });
    try {
      expect(await linked.compensate.reconcile(linked.providerMessageId)).toBe("restored-spendable");
      expect(await ordinary.compensate.reconcile(ordinary.providerMessageId)).toBe("not-recovery");
      expect((await ordinary.db.usageReservation.findUniqueOrThrow({ where: { id: ordinary.reservationId } })).compensationUsageEventId).toBeNull();
    } finally { await linked.close(); await ordinary.close(); }
  });

  it("fails closed when a matched credit has no durable source, without deleting its hard-limit entry", async () => {
    const f = await fixture();
    try {
      await f.db.usageReservation.update({ where: { id: f.reservationId },
        data: { sourceKey: `invalid-${f.sourceKey}` } });
      await expect(f.compensate.reconcile(f.providerMessageId)).rejects.toThrow(/missing or ambiguous reservation/);
      expect(await f.db.usageEvent.count({ where: { sourceId: f.messageId,
        metric: "OUTBOUND_AUTOMATED_MESSAGE" } })).toBe(1);
    } finally { await f.close(); }
  });

  it("rejects cross-Shop credit lineage rather than correcting another merchant", async () => {
    const f = await fixture({ status: "RESERVED" });
    try {
      const otherShopId = randomUUID();
      await f.db.shop.create({ data: { id: otherShopId,
        domain: `${otherShopId}.example.test`, status: "ACTIVE" } });
      await f.db.usageReservation.update({ where: { id: f.reservationId },
        data: { shopId: otherShopId } });
      await expect(f.compensate.reconcile(f.providerMessageId)).rejects.toThrow(/reservation shop\/quantity mismatch/);
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } })).status).toBe("RESERVED");
    } finally { await f.close(); }
  });

  it("does not compensate an unrelated automated recovery conversation message", async () => {
    const f = await fixture({ linkMessage: false });
    try {
      await f.db.usageEvent.updateMany({ where: { sourceId: f.messageId,
        metric: "OUTBOUND_AUTOMATED_MESSAGE" },
        data: { idempotencyKey: `ordinary-automated-${f.messageId}` } });
      expect(await f.compensate.reconcile(f.providerMessageId)).toBe("not-recovery");
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } })).compensationUsageEventId).toBeNull();
    } finally { await f.close(); }
  });

  it("supports a durable synchronous failed message without a provider ID through the same owner", async () => {
    const f = await fixture();
    try {
      await f.db.conversationMessage.update({ where: { id: f.messageId },
        data: { providerMessageId: null } });
      expect(await f.compensate.reconcileMessage(f.messageId)).toBe("restored-spendable");
      expect(await f.compensate.reconcileMessage(f.messageId)).toBe("restored-spendable");
      expect(await f.compensate.reconcile(f.providerMessageId)).toBe("not-terminal");
    } finally { await f.close(); }
  });

  it("does not credit a delivered message and never claws back a correction after late delivery", async () => {
    const delivered = await fixture({ initialStatus: "DELIVERED" });
    const failed = await fixture();
    try {
      expect(await delivered.compensate.reconcile(delivered.providerMessageId)).toBe("not-terminal");
      expect((await delivered.db.usageReservation.findUniqueOrThrow({ where: { id: delivered.reservationId } })).compensationUsageEventId).toBeNull();
      await failed.compensate.reconcile(failed.providerMessageId);
      const event = { schemaVersion: 3, providerAccountId: "account",
        providerPhoneNumberId: "phone", providerMessageId: failed.providerMessageId,
        status: "DELIVERED", occurredAt: new Date().toISOString() };
      const service = new WhatsAppProviderStatusService(failed.db, undefined, 3, failed.compensate);
      expect(await service.process(event)).toBe("applied");
      expect((await failed.db.conversationMessage.findUniqueOrThrow({ where: { id: failed.messageId } })).status).toBe("DELIVERED");
      expect((await failed.db.usageReservation.findUniqueOrThrow({ where: { id: failed.reservationId } })).compensationUsageEventId).not.toBeNull();
    } finally { await delivered.close(); await failed.close(); }
  });
});

/** State setup mirrors ARCH-027's lot/counter ownership; no provider API calls. */
async function preparePurchasedRefund(
  f: Awaited<ReturnType<typeof fixture>>,
  provider: "SHOPIFY" | "WOOCOMMERCE",
  status: "REQUESTED" | "PROVIDER_ACTION_REQUIRED" | "COMPLETED",
): Promise<string> {
  const purchaseId = f.purchasedCreditPurchaseId!;
  const purchase = await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: purchaseId } });
  const historical = status === "COMPLETED";
  await f.db.recoveryCreditPurchase.update({ where: { id: purchaseId }, data: {
    creditsGranted: 2, currentAmount: historical ? 0 : 1,
    status: historical ? "REFUNDED" : "WITHDRAWN", version: { increment: 1 },
  } });
  await f.db.shopEntitlementCounter.update({ where: { id: f.counterId! }, data: {
    grantedQuantity: historical ? 1 : 2,
    refundingQuantity: historical ? 0 : 1,
    version: { increment: 1 },
  } });
  const refund = await f.db.recoveryCreditRefund.create({ data: {
    shopId: f.shopId, purchaseId, provider, source: "ADMIN",
    status, requestKey: `arch028-refund:${purchaseId}`,
    purchaseCreditsGrantedSnapshot: purchase.creditsGranted,
    currentAmountAtRequestSnapshot: 1,
    reservedAmountAtRequestSnapshot: 0, availableAmountAtRequestSnapshot: 1,
    billingPeriodIdSnapshot: purchase.billingPeriodId,
    providerSubscriptionIdSnapshot: purchase.providerSubscriptionIdSnapshot,
    planHandleSnapshot: purchase.shopifyPlanHandleSnapshot,
    eventHandleSnapshot: purchase.shopifyEventHandleSnapshot,
    purchaseProviderAmountSnapshot: purchase.providerPurchaseAmount ?? new Prisma.Decimal("1.00"),
    purchaseProviderCurrencySnapshot: purchase.providerPurchaseCurrency ?? "USD",
    ...(status !== "REQUESTED" ? { finalCreditQuantity: 1 } : {}),
    ...(historical ? {
      completedAt: new Date(), providerConfirmedAt: new Date(),
      providerReference: `refund-${purchaseId}`, providerActionKind: "REFUND",
      providerAmount: new Prisma.Decimal("1.00"), providerCurrency: "USD",
    } : {}),
  } });
  return refund.id;
}

suite("ARCH-028 committed purchased compensation (PostgreSQL)", () => {
  it.each(["SHOPIFY", "WOOCOMMERCE"] as const)(
    "restores exact %s purchased lot, copies provider and never reports correction", async (provider) => {
      const f = await fixture({ source: "purchased", provider });
      try {
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("restored-spendable");
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("restored-spendable");
        const reservation = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } });
        const lot = await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: f.purchasedCreditPurchaseId! } });
        const counter = await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } });
        const corrected = await f.db.usageEvent.findUniqueOrThrow({ where: { id: reservation.compensationUsageEventId! } });
        expect([lot.status, lot.currentAmount, counter.committedQuantity]).toEqual(["ACTIVE", 1, 0]);
        expect(reservation.compensationDisposition).toBe("RESTORED_SPENDABLE");
        expect(corrected).toMatchObject({
          provider, shopId: f.shopId, sourceId: f.reservationId,
          correctionOfUsageEventId: reservation.committedUsageEventId,
          shopifyReportState: "NOT_APPLICABLE", shopifyIdempotencyKey: null,
          shopifyEventHandle: null, nextReportAt: null, lastReportAttemptAt: null,
          reportedAt: null,
        });
        expect(corrected.quantity.toNumber()).toBe(-1);
        expect(await f.db.usageEvent.count({ where: { correctionOfUsageEventId: reservation.committedUsageEventId } })).toBe(1);
      } finally { await f.close(); }
    },
  );

  it.each(["SHOPIFY", "WOOCOMMERCE"] as const)(
    "keeps a %s live refund held and notifies only after correction/suppression", async (provider) => {
      const f = await fixture({ source: "purchased", provider });
      try {
        const refundId = await preparePurchasedRefund(f, provider, "REQUESTED");
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("held-for-refund");
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("held-for-refund");
        const lot = await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: f.purchasedCreditPurchaseId! } });
        const counter = await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } });
        expect([lot.status, lot.currentAmount, counter.committedQuantity, counter.refundingQuantity])
          .toEqual(["WITHDRAWN", 2, 0, 2]);
        expect((await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } })).compensationDisposition)
          .toBe("HELD_FOR_REFUND");
        expect((await f.db.recoveryCreditRefund.findUniqueOrThrow({ where: { id: refundId } })).status)
          .toBe("REQUESTED");
        expect(await f.db.recoveryCreditRefund.count({ where: { purchaseId: f.purchasedCreditPurchaseId! } })).toBe(1);
        const { RecipientReachabilityFailureService } = await import(
          "../../src/services/recipient-reachability-failure.service.js");
        const { RecipientReachabilityStore } = await import(
          "../../src/services/recipient-reachability-store.js");
        const { RecoveryDeliveryMerchantNotificationService } = await import(
          "../../src/services/recovery-delivery-merchant-notification.service.js");
        const { RecoveryDeliverySupportMessageService } = await import(
          "../../src/services/recovery-delivery-support-message.service.js");
        const reach = new RecipientReachabilityFailureService(f.db, new RecipientReachabilityStore(f.db));
        const notice = new RecoveryDeliveryMerchantNotificationService(f.db, new RecoveryDeliverySupportMessageService(f.db));
        const disposition = await f.compensate.reconcile(f.providerMessageId);
        const reachability = await reach.afterCorrection({ providerMessageId: f.providerMessageId }, disposition);
        expect(reachability).toMatch(/suppressed|unchanged/);
        expect(await notice.notify({ providerMessageId: f.providerMessageId }, disposition, reachability)).toBe("created");
        expect(await notice.notify({ providerMessageId: f.providerMessageId }, disposition, reachability)).toBe("duplicate");
        const messages = await f.db.merchantSupportMessage.findMany({
          where: { thread: { shopId: f.shopId }, systemCode: "ARCH028_RECOVERY_DELIVERY_FAILED" },
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]?.originalBody).toContain("held for refund");
      } finally { await f.close(); }
    },
  );

  it("holds restored credits for operator review when a Woo provider refund amount is frozen", async () => {
    const f = await fixture({ source: "purchased", provider: "WOOCOMMERCE" });
    try {
      const refundId = await preparePurchasedRefund(f, "WOOCOMMERCE", "PROVIDER_ACTION_REQUIRED");
      expect(await f.compensate.reconcileMessage(f.messageId)).toBe("held-for-refund");
      const refund = await f.db.recoveryCreditRefund.findUniqueOrThrow({ where: { id: refundId } });
      expect(refund.status).toBe("NEEDS_ATTENTION");
      expect(refund.finalCreditQuantity).toBe(1); // frozen financial snapshot is unchanged
      expect(refund.reason).toBe("ARCH028_DELIVERY_CORRECTION_REQUIRES_REFUND_REVIEW");
      const lot = await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: f.purchasedCreditPurchaseId! } });
      expect([lot.status, lot.currentAmount]).toEqual(["WITHDRAWN", 2]);
      expect(await f.compensate.reconcileMessage(f.messageId)).toBe("held-for-refund");
    } finally { await f.close(); }
  });

  it.each(["SHOPIFY", "WOOCOMMERCE"] as const)(
    "keeps a %s refunded source closed and corrects only historical committed usage", async (provider) => {
      const f = await fixture({ source: "purchased", provider });
      try {
        const refundId = await preparePurchasedRefund(f, provider, "COMPLETED");
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("historical-only");
        expect(await f.compensate.reconcile(f.providerMessageId)).toBe("historical-only");
        const lot = await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: f.purchasedCreditPurchaseId! } });
        const counter = await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } });
        expect([lot.status, lot.currentAmount, counter.grantedQuantity, counter.committedQuantity])
          .toEqual(["REFUNDED", 0, 0, 0]);
        expect((await f.db.recoveryCreditRefund.findUniqueOrThrow({ where: { id: refundId } })).status)
          .toBe("COMPLETED");
        expect((await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } })).compensationDisposition)
          .toBe("HISTORICAL_ONLY");
      } finally { await f.close(); }
    },
  );

  it("provider FAILED/131026 replay drives purchased correction, suppression and one notice", async () => {
    const f = await fixture({ source: "purchased", provider: "WOOCOMMERCE" });
    try {
      const status = new WhatsAppProviderStatusService(f.db);
      const event = { schemaVersion: 3 as const, providerAccountId: "account",
        providerPhoneNumberId: "phone", providerMessageId: f.providerMessageId,
        status: "FAILED" as const, failure: { providerCode: "131026" },
        occurredAt: new Date().toISOString() };
      await status.process(event);
      await status.process(event);
      const reservation = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } });
      expect(reservation.compensationDisposition).toBe("RESTORED_SPENDABLE");
      expect(await f.db.usageEvent.count({ where: { correctionOfUsageEventId: reservation.committedUsageEventId } })).toBe(1);
      expect(await f.db.merchantSupportMessage.count({ where: {
        thread: { shopId: f.shopId }, systemCode: "ARCH028_RECOVERY_DELIVERY_FAILED",
      } })).toBe(1);
      const reachability = await f.db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM "whatsapp"."WhatsAppRecipientReachability"
        WHERE "shopId"=${f.shopId}`;
      expect(reachability[0]?.count).toBe(1n);
    } finally { await f.close(); }
  });

  it("fails closed on orphan WITHDRAWN state and does not consume outbound usage", async () => {
    const f = await fixture({ source: "purchased" });
    try {
      // The database prohibits WITHDRAWN with a zero balance. Model an
      // orphaned *positive* withdrawn lot to exercise the application guard.
      await f.db.shopEntitlementCounter.update({ where: { id: f.counterId! },
        data: { grantedQuantity: 2 } });
      await f.db.recoveryCreditPurchase.update({ where: { id: f.purchasedCreditPurchaseId! },
        data: { creditsGranted: 2, currentAmount: 1, status: "WITHDRAWN" } });
      await expect(f.compensate.reconcile(f.providerMessageId)).rejects.toThrow(/live refund hold/);
      expect(await f.db.usageEvent.count({ where: { correctionOfUsageEventId: { not: null }, shopId: f.shopId } })).toBe(0);
      expect(await f.db.usageEvent.count({ where: { metric: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: f.messageId } })).toBe(1);
      expect((await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } })).committedQuantity).toBe(1);
    } finally { await f.close(); }
  });

  it("excludes unlinked HUMAN_TEXT, but corrects an exact linked sequence-two purchased template", async () => {
    const ordinary = await fixture({ source: "purchased", sender: "HUMAN", humanKind: "HUMAN_TEXT" });
    const followUp = await fixture({ source: "purchased", sender: "HUMAN" });
    try {
      expect(await ordinary.compensate.reconcile(ordinary.providerMessageId)).toBe("not-recovery");
      expect((await ordinary.db.usageReservation.findUniqueOrThrow({ where: { id: ordinary.reservationId } })).compensationUsageEventId).toBeNull();
      expect(await followUp.compensate.reconcile(followUp.providerMessageId)).toBe("restored-spendable");
    } finally { await ordinary.close(); await followUp.close(); }
  });

  it("ignores other provider failures and disallows fabricated suppression", async () => {
    const f = await fixture({ source: "purchased" });
    try {
      await f.db.conversationMessage.update({ where: { id: f.messageId },
        data: { providerFailureCode: "131047" } });
      expect(await f.compensate.reconcile(f.providerMessageId)).toBe("not-terminal");
      expect((await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId } })).compensationUsageEventId).toBeNull();
    } finally { await f.close(); }
  });
});
