import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

import { RecoveryCreditRefundCorrectionService } from "../../src/services/recovery-credit-refund-correction.service.js";
import { WooChargeRefundReceiptReconciliationService } from "../../src/services/woocommerce-billing/charge-refund-reconciliation.service.js";
import { WooChargeReceiptReconciliationService } from "../../src/services/woocommerce-billing/charge-receipt-reconciliation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDisposableDatabase = testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;
const receivedAt = new Date("2026-10-10T12:00:00.000Z");
const reconciledAt = new Date("2026-10-11T12:00:00.000Z");
const catalogueLocales = [
  "cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl", "pl",
  "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
] as const;

type Fixture = { shopId: string; contractId: string; catalogueHandle: string; purchaseId: string; operationId: string };

function database(): PrismaClient {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
  return new PrismaClient({ datasourceUrl: testDatabaseUrl });
}

async function createFixture(client: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const shopId = `woo-refund-${suffix}`;
  const contractId = `charge-${suffix}`;
  const catalogueHandle = `arch027-refund-${suffix}`;
  const catalogue = await client.$transaction(async (tx) => {
    const cataloguePosition = await tx.merchantPricingPlan.count();
    const [merchantPlan, plan] = await Promise.all([
      tx.merchantPricingPlan.create({
        data: {
          id: `catalogue-${suffix}`,
          shopifyPlanHandle: catalogueHandle,
          displayName: "Refund integration fixture",
          planKind: "PAID_METERED",
          cataloguePosition,
          includedRecoveryCredits: 10,
          allowancePeriod: "EVERY_30_DAYS",
          billingPeriod: "EVERY_30_DAYS",
          recurringAmountMinor: 1999,
          currency: "USD",
          translations: { create: catalogueLocales.map((locale) => ({ locale, merchantDescription: "Integration fixture" })) },
        },
      }),
      tx.billingPlan.create({ data: { shopifyPlanHandle: catalogueHandle, name: "Refund integration fixture", kind: "FREE" } }),
    ]);
    const usageEvent = await tx.merchantPricingUsageEvent.create({
      data: {
        merchantPricingPlanId: merchantPlan.id,
        eventHandle: "recovery-credit-pack",
        adminLabel: "Recovery credit pack",
        creditsGrantedPerUnit: 10,
        position: 0,
        pricingMode: "FIXED",
        currency: "USD",
        fixedUnitAmountMinor: 1234,
      },
    });
    return { plan, usageEvent };
  });
  await client.shop.create({ data: { id: shopId, domain: `${suffix}.woo.test`, platform: "WOOCOMMERCE", status: "ACTIVE" } });
  await client.subscription.create({ data: { shopId, planId: catalogue.plan.id, status: "ACTIVE" } });
  const purchaseId = `purchase-${suffix}`;
  await client.recoveryCreditPurchase.create({
    data: { id: purchaseId, shopId, planId: catalogue.plan.id, creditsGranted: 10, provider: "WOOCOMMERCE" },
  });
  const operation = await client.billingOperation.create({
    data: {
      shopId,
      kind: "ONE_TIME_CHARGE",
      state: "AWAITING_CONFIRMATION",
      requestKey: `request-${suffix}`,
      requestFingerprint: randomBytes(32),
      merchantPricingUsageEventId: catalogue.usageEvent.id,
      quotedAmountMinor: 1234,
      quotedCurrency: "USD",
      recoveryCreditPurchaseId: purchaseId,
      providerReference: contractId,
    },
    select: { id: true },
  });
  return { shopId, contractId, catalogueHandle, purchaseId, operationId: operation.id };
}

function activationPayload(contractId: string): Prisma.InputJsonValue {
  return {
    charge: {
      id: contractId,
      status: "active",
      billing_intents: [{ id: 17, status: "completed" }],
      transactions: [{
        id: 42,
        billing_intent_id: 17,
        completed_at: "2026-10-09T11:59:00.000Z",
        amount: "12.34",
        amount_refunded: "0.00",
      }],
    },
  };
}

function refundPayload(contractId: string, amountRefunded: string): Prisma.InputJsonValue {
  return {
    charge: {
      id: contractId,
      status: "canceled",
      transactions: [{
        id: 42,
        completed_at: "2026-10-10T11:59:00.000Z",
        amount: "12.34",
        amount_refunded: amountRefunded,
      }],
    },
  };
}

async function createReceipt(
  client: PrismaClient,
  fixture: Fixture,
  topic: string,
  payload: Prisma.InputJsonValue,
  at: Date,
): Promise<string> {
  const receipt = await client.wooCommerceBillingWebhookReceipt.create({
    data: { topic, providerContractId: fixture.contractId, payloadSha256: randomBytes(32), normalizedPayload: payload, receivedAt: at },
    select: { id: true },
  });
  return receipt.id;
}

async function createWooRefundHold(client: PrismaClient, fixture: Fixture): Promise<string> {
  const refundId = `refund-${randomUUID()}`;
  await client.$transaction(async (tx) => {
    await tx.recoveryCreditPurchase.update({
      where: { id: fixture.purchaseId },
      data: { status: "WITHDRAWN", refundAttemptedAt: receivedAt },
    });
    await tx.shopEntitlementCounter.update({
      where: { shopId_counter: { shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      data: { refundingQuantity: { increment: 10 }, version: { increment: 1 } },
    });
    await tx.recoveryCreditRefund.create({
      data: {
        id: refundId,
        shopId: fixture.shopId,
        purchaseId: fixture.purchaseId,
        source: "ADMIN",
        purchaseCreditsGrantedSnapshot: 10,
        currentAmountAtRequestSnapshot: 10,
        reservedAmountAtRequestSnapshot: 0,
        availableAmountAtRequestSnapshot: 10,
        billingPeriodIdSnapshot: null,
        providerSubscriptionIdSnapshot: null,
        planHandleSnapshot: null,
        eventHandleSnapshot: null,
        provider: "WOOCOMMERCE",
        shopifyPartnerDevelopmentSnapshot: false,
        purchaseProviderAmountSnapshot: new Prisma.Decimal("12.34"),
        purchaseProviderCurrencySnapshot: "USD",
        status: "REQUESTED",
        requestKey: `woo-vendor-refund-${fixture.purchaseId}`,
      },
    });
  });
  return refundId;
}

async function cleanup(client: PrismaClient, fixture: Fixture): Promise<void> {
  await client.wooCommerceBillingWebhookReceipt.deleteMany({ where: { providerContractId: fixture.contractId } });
  await client.shop.deleteMany({ where: { id: fixture.shopId } });
  await client.billingPlan.deleteMany({ where: { shopifyPlanHandle: fixture.catalogueHandle } });
  await client.merchantPricingPlan.deleteMany({ where: { shopifyPlanHandle: fixture.catalogueHandle } });
}

describeWithDisposableDatabase("Woo charge refund reconciliation PostgreSQL", () => {
  it("requires an exact local hold, completes Free null-period allowance independent of money, and replays idempotently", async () => {
    const client = database();
    const fixture = await createFixture(client);
    try {
      const activationReceipt = await createReceipt(
        client, fixture, "saas_billing_contract.activated", activationPayload(fixture.contractId), receivedAt,
      );
      const chargeService = new WooChargeReceiptReconciliationService(client, () => reconciledAt, { schedule: vi.fn(async () => "resume") });
      expect((await chargeService.reconcileBatch()).activated).toBe(1);
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: activationReceipt } }))
        .toMatchObject({ processedAt: reconciledAt });

      const firstReceipt = await createReceipt(
        client, fixture, "saas_billing_contract.refunded", refundPayload(fixture.contractId, "99.99"), receivedAt,
      );
      const receiptService = new WooChargeRefundReceiptReconciliationService(client, () => reconciledAt);
      expect((await receiptService.reconcileBatch()).retryable).toBe(1);
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: firstReceipt } }))
        .toMatchObject({ processedAt: null, processingError: "WOO_REFUND_REQUEST_NOT_FOUND" });
      expect(await client.recoveryCreditRefund.count({ where: { purchaseId: fixture.purchaseId } })).toBe(0);
      expect(await client.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      })).toMatchObject({ grantedQuantity: 10, refundingQuantity: 0 });

      const refundId = await createWooRefundHold(client, fixture);
      const correction = new RecoveryCreditRefundCorrectionService(client as never, {} as never, () => reconciledAt);
      expect(await correction.processDue()).toMatchObject({ selected: 1, providerActionRequired: 1 });
      expect(await client.recoveryCreditRefund.findUniqueOrThrow({ where: { id: refundId } }))
        .toMatchObject({
          status: "PROVIDER_ACTION_REQUIRED",
          finalCreditQuantity: 10,
          expectedProviderAmount: null,
          expectedProviderCurrency: null,
          reason: "WOO_VENDOR_DASHBOARD_REFUND_REQUIRED",
        });

      const secondReceipt = await createReceipt(
        client,
        fixture,
        "saas_billing_contract.refunded",
        refundPayload(fixture.contractId, "4.56"),
        new Date(receivedAt.getTime() + 1000),
      );
      expect(await receiptService.reconcileBatch()).toMatchObject({ claimed: 2, processed: 2, retryable: 0 });
      expect(await client.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }))
        .toMatchObject({ status: "REFUNDED", currentAmount: 0, reservedAmount: 0, billingPeriodId: null });
      expect(await client.recoveryCreditRefund.findUniqueOrThrow({ where: { id: refundId } }))
        .toMatchObject({ status: "COMPLETED", finalCreditQuantity: 10, expectedProviderAmount: null, providerCurrency: "USD" });
      const persistedRefund = await client.recoveryCreditRefund.findUniqueOrThrow({ where: { id: refundId } });
      expect(persistedRefund.providerAmount?.toString()).toBe("99.99");
      expect(await client.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      })).toMatchObject({ grantedQuantity: 0, refundingQuantity: 0 });
      expect(await client.wooCommerceBillingWebhookReceipt.findMany({ where: { id: { in: [firstReceipt, secondReceipt] } } }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: firstReceipt, processedAt: expect.any(Date), processingError: null }),
          expect.objectContaining({ id: secondReceipt, processedAt: expect.any(Date), processingError: null }),
        ]));
    } finally {
      await cleanup(client, fixture);
      await client.$disconnect();
    }
  }, 30_000);
});

afterAll(() => {
  vi.restoreAllMocks();
});