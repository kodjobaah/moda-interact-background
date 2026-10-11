import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

import { WooChargeReceiptReconciliationService } from "../../src/services/woocommerce-billing/charge-receipt-reconciliation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDisposableDatabase = testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;
const reconciliationTime = new Date("2026-10-10T00:00:00.000Z");
const receivedAt = new Date("2026-10-09T12:00:00.000Z");
const catalogueLocales = [
  "cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl", "pl",
  "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
] as const;

type Fixture = {
  shopId: string;
  contractId: string;
  planId: string;
  catalogueHandle: string;
  operationId: string;
  purchaseId: string;
  extraShopIds: string[];
};

function database(url = testDatabaseUrl): PrismaClient {
  if (!url) throw new Error("TEST_DATABASE_URL is required");
  return new PrismaClient({ datasourceUrl: url });
}

async function createFixture(
  client: PrismaClient,
  state = "AWAITING_CONFIRMATION",
  bindProviderReference = true,
): Promise<Fixture> {
  const suffix = randomUUID();
  const shopId = `woo-charge-${suffix}`;
  const contractId = `charge-${suffix}`;
  const catalogueHandle = `arch027-charge-${suffix}`;
  const catalogue = await client.$transaction(async (tx) => {
    const cataloguePosition = await tx.merchantPricingPlan.count();
    const [merchantPlan, plan] = await Promise.all([
      tx.merchantPricingPlan.create({
        data: {
          id: `catalogue-${suffix}`,
          shopifyPlanHandle: catalogueHandle,
          displayName: "Charge acquisition fixture",
          planKind: "PAID_METERED",
          cataloguePosition,
          includedRecoveryCredits: 10,
          allowancePeriod: "EVERY_30_DAYS",
          billingPeriod: "EVERY_30_DAYS",
          recurringAmountMinor: 1999,
          currency: "USD",
          translations: {
            create: catalogueLocales.map((locale) => ({ locale, merchantDescription: "Integration fixture" })),
          },
        },
      }),
      tx.billingPlan.create({
        data: {
          shopifyPlanHandle: catalogueHandle,
          name: "Charge acquisition fixture",
          kind: "FREE",
        },
      }),
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
  await client.shop.create({
    data: { id: shopId, domain: `${suffix}.woo.test`, platform: "WOOCOMMERCE", status: "ACTIVE" },
  });
  await client.subscription.create({ data: { shopId, planId: catalogue.plan.id, status: "ACTIVE" } });
  const purchaseId = `purchase-${suffix}`;
  await client.recoveryCreditPurchase.create({
    data: { id: purchaseId, shopId, planId: catalogue.plan.id, creditsGranted: 10, provider: "WOOCOMMERCE" },
  });
  const operation = await client.billingOperation.create({
    data: {
      shopId,
      kind: "ONE_TIME_CHARGE",
      state,
      requestKey: `request-${suffix}`,
      requestFingerprint: randomBytes(32),
      merchantPricingUsageEventId: catalogue.usageEvent.id,
      quotedAmountMinor: 1234,
      quotedCurrency: "USD",
      recoveryCreditPurchaseId: purchaseId,
      providerReference: bindProviderReference ? contractId : null,
    },
    select: { id: true },
  });
  return { shopId, contractId, planId: catalogue.plan.id, catalogueHandle, operationId: operation.id, purchaseId, extraShopIds: [] };
}

async function createReceipt(
  client: PrismaClient,
  fixture: Fixture,
  topic: string,
  payload: Prisma.InputJsonValue,
  at = receivedAt,
): Promise<string> {
  const receipt = await client.wooCommerceBillingWebhookReceipt.create({
    data: {
      topic,
      providerContractId: fixture.contractId,
      payloadSha256: randomBytes(32),
      normalizedPayload: payload,
      receivedAt: at,
    },
    select: { id: true },
  });
  return receipt.id;
}

function chargePayload(
  contractId: string,
  status = "active",
  payment: { amount?: string; amountRefunded?: string } = {},
): Prisma.InputJsonValue {
  return {
    charge: {
      id: contractId,
      status,
      billing_intents: [{ id: 17, status: "completed" }],
      transactions: [{
        id: 42,
        billing_intent_id: 17,
        completed_at: "2026-10-09T11:59:00.000Z",
        amount: payment.amount ?? "14.8100",
        amount_refunded: payment.amountRefunded ?? "0.000",
        url: "https://provider.invalid/private-transaction",
      }],
    },
  };
}

function reconciler(client: PrismaClient, schedule = vi.fn(async () => "resume-job")) {
  return new WooChargeReceiptReconciliationService(client, () => reconciliationTime, { schedule });
}

async function cleanup(client: PrismaClient, fixture: Fixture): Promise<void> {
  await client.wooCommerceBillingWebhookReceipt.deleteMany({ where: { providerContractId: fixture.contractId } });
  await client.shop.deleteMany({ where: { id: { in: [fixture.shopId, ...fixture.extraShopIds] } } });
  await client.billingPlan.deleteMany({ where: { shopifyPlanHandle: fixture.catalogueHandle } });
  await client.merchantPricingPlan.deleteMany({ where: { shopifyPlanHandle: fixture.catalogueHandle } });
}

describeWithDisposableDatabase("Woo charge acquisition receipt reconciliation PostgreSQL", () => {
  it("activates a Free null-period purchase atomically, separates tax-inclusive evidence, and schedules once after commit", async () => {
    const client = database();
    const fixture = await createFixture(client);
    const schedule = vi.fn(async () => {
      const persisted = await client.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
      expect(persisted.status).toBe("ACTIVE");
      return "resume-job";
    });
    try {
      const firstReceiptId = await createReceipt(client, fixture, "saas_billing_contract.activated", chargePayload(fixture.contractId));
      const result = await reconciler(client, schedule).reconcileBatch();
      const purchase = await client.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } });
      const counter = await client.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      });
      const operation = await client.billingOperation.findUniqueOrThrow({ where: { id: fixture.operationId } });
      const receipt = await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: firstReceiptId } });

      expect(result).toMatchObject({ claimed: 1, processed: 1, activated: 1, retryable: 0 });
      expect(purchase).toMatchObject({
        status: "ACTIVE",
        currentAmount: 10,
        reservedAmount: 0,
        provider: "WOOCOMMERCE",
        providerReference: fixture.contractId,
        providerPurchaseCurrency: "USD",
        providerValuationConfirmedAt: receivedAt,
        activatedAt: receivedAt,
        billingPeriodId: null,
        usageEventId: null,
      });
      expect(purchase.providerPurchaseAmount?.toString()).toBe("14.81");
      expect(purchase.providerPriceSnapshot).toEqual({
        schemaVersion: 1,
        provider: "WOOCOMMERCE",
        kind: "ONE_TIME_CHARGE",
        merchantPricingUsageEventId: operation.merchantPricingUsageEventId,
        quotedAmountMinor: 1234,
        quotedCurrency: "USD",
        providerBillingIntentId: "17",
        providerTransactionId: "42",
        providerTransactionAmount: "14.81",
        providerAmountRefunded: "0",
      });
      expect(counter).toMatchObject({ grantedQuantity: 10, committedQuantity: 0, reservedQuantity: 0, refundingQuantity: 0, version: 1 });
      expect(operation).toMatchObject({ state: "CONFIRMED", lastErrorCode: null });
      expect(receipt).toMatchObject({ processedAt: reconciliationTime, processingError: null, billingOperationId: fixture.operationId });
      expect(await client.usageEvent.count({ where: { shopId: fixture.shopId } })).toBe(0);
      expect(schedule).toHaveBeenCalledExactlyOnceWith({
        shopId: fixture.shopId,
        trigger: `woo-purchase-activation-${fixture.purchaseId}`,
      });

      await createReceipt(client, fixture, "saas_billing_contract.activated", chargePayload(fixture.contractId));
      expect((await reconciler(client, schedule).reconcileBatch()).processed).toBe(1);
      expect((await client.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      })).grantedQuantity).toBe(10);
      expect(schedule).toHaveBeenCalledOnce();
    } finally {
      await cleanup(client, fixture);
      await client.$disconnect();
    }
  }, 30_000);

  it("preserves existing purchased counter quantities and activates against a closed historical billing period", async () => {
    const client = database();
    const fixture = await createFixture(client);
    try {
      const subscription = await client.subscription.findUniqueOrThrow({ where: { shopId: fixture.shopId } });
      const period = await client.billingPeriod.create({
        data: {
          shopId: fixture.shopId,
          subscriptionId: subscription.id,
          planId: fixture.planId,
          planKindSnapshot: "PAID_METERED",
          periodStart: new Date("2026-08-01T00:00:00.000Z"),
          periodEnd: new Date("2026-09-01T00:00:00.000Z"),
          status: "CLOSED",
          closedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      await client.subscription.update({
        where: { id: subscription.id },
        data: { planId: fixture.planId, billingPeriodId: period.id, providerSubscriptionId: "historical-paid-contract" },
      });
      await client.recoveryCreditPurchase.update({ where: { id: fixture.purchaseId }, data: { billingPeriodId: period.id } });
      await client.shopEntitlementCounter.create({
        data: {
          shopId: fixture.shopId,
          counter: "PURCHASED_RECOVERY_CREDITS",
          grantedQuantity: 7,
          committedQuantity: 2,
          reservedQuantity: 3,
          refundingQuantity: 1,
          version: 4,
        },
      });
      await createReceipt(client, fixture, "saas_billing_contract.activated", chargePayload(fixture.contractId));
      expect((await reconciler(client).reconcileBatch()).activated).toBe(1);
      const counter = await client.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      });
      expect(counter).toMatchObject({ grantedQuantity: 17, committedQuantity: 2, reservedQuantity: 3, refundingQuantity: 1, version: 5 });
      expect((await client.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } })).billingPeriodId).toBe(period.id);
    } finally {
      await cleanup(client, fixture);
      await client.$disconnect();
    }
  }, 30_000);

  it("leaves missing correlation retryable and later reconciles the same receipt", async () => {
    const client = database();
    // Start before the provider reference is known: ARCH-027 makes a non-null
    // providerReference write-once, so clearing it after creation is invalid.
    const fixture = await createFixture(client, "INITIATING", false);
    try {
      const receiptId = await createReceipt(client, fixture, "saas_billing_contract.activated", chargePayload(fixture.contractId));
      expect((await reconciler(client).reconcileBatch()).retryable).toBe(1);
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: receiptId } }))
        .toMatchObject({ processedAt: null, processingError: "CHARGE_CORRELATION_NOT_READY" });

      await client.billingOperation.update({
        where: { id: fixture.operationId },
        data: { providerReference: fixture.contractId, state: "AWAITING_CONFIRMATION" },
      });
      expect((await reconciler(client).reconcileBatch()).activated).toBe(1);
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: receiptId } }))
        .toMatchObject({ processedAt: reconciliationTime, processingError: null });
    } finally {
      await cleanup(client, fixture);
      await client.$disconnect();
    }
  }, 30_000);

  it("activates an OUTCOME_UNKNOWN acquisition when exactly linked to the trusted charge", async () => {
    const client = database();
    const fixture = await createFixture(client, "OUTCOME_UNKNOWN");
    try {
      await createReceipt(client, fixture, "saas_billing_contract.activated", chargePayload(fixture.contractId));
      expect((await reconciler(client).reconcileBatch()).activated).toBe(1);
      expect(await client.billingOperation.findUniqueOrThrow({ where: { id: fixture.operationId } }))
        .toMatchObject({ state: "CONFIRMED", lastErrorCode: null });
    } finally {
      await cleanup(client, fixture);
      await client.$disconnect();
    }
  }, 30_000);

  it("fails closed for invalid operation state, ambiguous contracts and tenant mismatches", async () => {
    const client = database();
    const missingIntent = await createFixture(client);
    const ambiguous = await createFixture(client);
    const crossShop = await createFixture(client);
    try {
      // PostgreSQL forbids dropping the required frozen usage-event intent.
      // A terminal operation is a valid persisted state that must still fail closed.
      await expect(client.billingOperation.update({
        where: { id: missingIntent.operationId },
        data: { merchantPricingUsageEventId: null },
      })).rejects.toThrow();
      await client.billingOperation.update({
        where: { id: missingIntent.operationId },
        data: { state: "FAILED" },
      });
      const missingReceiptId = await createReceipt(
        client, missingIntent, "saas_billing_contract.activated", chargePayload(missingIntent.contractId),
      );

      const original = await client.billingOperation.findUniqueOrThrow({ where: { id: ambiguous.operationId } });
      // ARCH-027 requires one distinct, same-Shop purchase per ONE_TIME_CHARGE.
      // Only the provider contract reference is intentionally duplicated here.
      const secondPurchaseId = `ambiguous-purchase-${randomUUID()}`;
      await client.recoveryCreditPurchase.create({
        data: {
          id: secondPurchaseId,
          shopId: ambiguous.shopId,
          planId: ambiguous.planId,
          creditsGranted: 10,
          provider: "WOOCOMMERCE",
        },
      });
      await client.billingOperation.create({
        data: {
          shopId: ambiguous.shopId,
          kind: "ONE_TIME_CHARGE",
          state: "AWAITING_CONFIRMATION",
          requestKey: `second-${randomUUID()}`,
          requestFingerprint: randomBytes(32),
          merchantPricingUsageEventId: original.merchantPricingUsageEventId,
          quotedAmountMinor: 1234,
          quotedCurrency: "USD",
          recoveryCreditPurchaseId: secondPurchaseId,
          providerReference: ambiguous.contractId,
        },
      });
      const ambiguousReceiptId = await createReceipt(
        client, ambiguous, "saas_billing_contract.activated", chargePayload(ambiguous.contractId),
      );

      const otherShopId = `woo-other-${randomUUID()}`;
      crossShop.extraShopIds.push(otherShopId);
      await client.shop.create({ data: { id: otherShopId, domain: `${otherShopId}.woo.test`, platform: "WOOCOMMERCE" } });
      // A referenced purchase cannot be moved to another Shop: the accepted
      // ARCH-027 database invariant rejects the mutation at write time.
      await expect(client.recoveryCreditPurchase.update({
        where: { id: crossShop.purchaseId },
        data: { shopId: otherShopId },
      })).rejects.toThrow("ARCH027 purchase Shop change would mismatch its billing operation");
      expect((await client.recoveryCreditPurchase.findUniqueOrThrow({
        where: { id: crossShop.purchaseId },
      })).shopId).toBe(crossShop.shopId);
      // Exercise the runtime tenant guard using an otherwise valid persisted
      // charge belonging to a non-Woo Shop; never corrupt a purchase link.
      await client.shop.update({ where: { id: crossShop.shopId }, data: { platform: "SHOPIFY" } });
      const crossShopReceiptId = await createReceipt(
        client, crossShop, "saas_billing_contract.activated", chargePayload(crossShop.contractId),
      );

      await reconciler(client).reconcileBatch(3);
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: missingReceiptId } }))
        .toMatchObject({ processedAt: null, processingError: "CHARGE_OPERATION_STATE_CONFLICT" });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: ambiguousReceiptId } }))
        .toMatchObject({ processedAt: null, processingError: "CHARGE_OPERATION_AMBIGUOUS" });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: crossShopReceiptId } }))
        .toMatchObject({ processedAt: null, processingError: "CHARGE_TENANT_CONFLICT" });
      expect(await client.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: missingIntent.purchaseId } }))
        .toMatchObject({ status: "REQUESTED", currentAmount: 0 });
    } finally {
      // Removing the highest catalogue position first preserves the ARCH-014
      // contiguous-position invariant after every statement.
      await cleanup(client, crossShop);
      await cleanup(client, ambiguous);
      await cleanup(client, missingIntent);
      await client.$disconnect();
    }
  }, 30_000);

  it("fails canceled and prepaid unconfirmed checkouts once without changing the historical purchase", async () => {
    const client = database();
    const fixture = await createFixture(client, "OUTCOME_UNKNOWN");
    try {
      const canceledId = await createReceipt(
        client, fixture, "saas_billing_contract.canceled", chargePayload(fixture.contractId, "canceled"),
      );
      const prepaidId = await createReceipt(
        client, fixture, "saas_billing_contract.prepaid_term_ended", chargePayload(fixture.contractId, "canceled"),
      );
      // The first receipt cancels the operation; the second is an idempotent
      // cancellation replay, counted as processed but not a new cancellation.
      expect(await reconciler(client).reconcileBatch()).toMatchObject({
        claimed: 2, processed: 2, canceled: 1, retryable: 0,
      });
      expect(await client.billingOperation.findUniqueOrThrow({ where: { id: fixture.operationId } }))
        .toMatchObject({ state: "FAILED", lastErrorCode: "WOO_CHARGE_CANCELED_BEFORE_ACTIVATION" });
      expect(await client.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }))
        .toMatchObject({ status: "REQUESTED", currentAmount: 0, reservedAmount: 0, providerReference: null });
      expect(await client.wooCommerceBillingWebhookReceipt.findMany({ where: { id: { in: [canceledId, prepaidId] } } }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: canceledId, processedAt: reconciliationTime, processingError: null }),
          expect.objectContaining({ id: prepaidId, processedAt: reconciliationTime, processingError: null }),
        ]));
    } finally {
      await cleanup(client, fixture);
      await client.$disconnect();
    }
  }, 30_000);

  it("treats cancellation after activation as a no-op and never selects refunded receipts", async () => {
    const client = database();
    const fixture = await createFixture(client);
    try {
      await createReceipt(client, fixture, "saas_billing_contract.activated", chargePayload(fixture.contractId));
      await reconciler(client).reconcileBatch();
      const canceledId = await createReceipt(
        client, fixture, "saas_billing_contract.canceled", chargePayload(fixture.contractId, "canceled"),
      );
      const refundedId = await createReceipt(
        client, fixture, "saas_billing_contract.refunded", chargePayload(fixture.contractId, "canceled"),
      );
      const result = await reconciler(client).reconcileBatch();
      expect(result).toMatchObject({ claimed: 1, processed: 1, canceled: 1 });
      expect(await client.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }))
        .toMatchObject({ status: "ACTIVE", currentAmount: 10 });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: canceledId } }))
        .toMatchObject({ processedAt: reconciliationTime, processingError: null });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: refundedId } }))
        .toMatchObject({ processedAt: null, processingError: null });
    } finally {
      await cleanup(client, fixture);
      await client.$disconnect();
    }
  }, 30_000);

  it("caps each cycle at fifty receipts and serializes duplicate workers on one receipt", async () => {
    const client = database();
    const secondWorker = database();
    const fixture = await createFixture(client);
    const schedule = vi.fn(async () => "resume-job");
    try {
      const receiptIds: string[] = [];
      for (let index = 0; index < 51; index += 1) {
        receiptIds.push(await createReceipt(
          client,
          fixture,
          "saas_billing_contract.activated",
          chargePayload(fixture.contractId),
          new Date(receivedAt.getTime() + index),
        ));
      }
      const firstCycle = await reconciler(client, schedule).reconcileBatch();
      expect(firstCycle.claimed).toBe(50);
      expect(await client.wooCommerceBillingWebhookReceipt.count({
        where: { id: { in: receiptIds }, processedAt: null },
      })).toBe(1);
      // Clear the deliberate 51st receipt before exercising two workers.
      // Otherwise both may correctly claim different eligible receipts.
      expect((await reconciler(client, schedule).reconcileBatch(1)).claimed).toBe(1);
      expect(await client.wooCommerceBillingWebhookReceipt.count({
        where: { id: { in: receiptIds }, processedAt: null },
      })).toBe(0);

      const duplicateFixture = await createFixture(client);
      try {
        await createReceipt(client, duplicateFixture, "saas_billing_contract.activated", chargePayload(duplicateFixture.contractId));
        const workers = await Promise.all([
          reconciler(client, schedule).reconcileBatch(1),
          reconciler(secondWorker, schedule).reconcileBatch(1),
        ]);
        expect(workers.reduce((count, result) => count + result.claimed, 0)).toBe(1);
        expect(await client.shopEntitlementCounter.findUniqueOrThrow({
          where: { shopId_counter: { shopId: duplicateFixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
        })).toMatchObject({ grantedQuantity: 10, version: 1 });
      } finally {
        await cleanup(client, duplicateFixture);
      }
    } finally {
      await cleanup(client, fixture);
      await Promise.all([client.$disconnect(), secondWorker.$disconnect()]);
    }
  }, 30_000);

  it("does not roll back a committed activation when recovery resume scheduling fails", async () => {
    const client = database();
    const fixture = await createFixture(client);
    const schedule = vi.fn().mockRejectedValue(new Error("synthetic queue failure"));
    try {
      await createReceipt(client, fixture, "saas_billing_contract.activated", chargePayload(fixture.contractId));
      expect((await reconciler(client, schedule).reconcileBatch()).activated).toBe(1);
      expect(await client.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: fixture.purchaseId } }))
        .toMatchObject({ status: "ACTIVE", currentAmount: 10 });
      expect(schedule).toHaveBeenCalledOnce();
    } finally {
      await cleanup(client, fixture);
      await client.$disconnect();
    }
  }, 30_000);
});