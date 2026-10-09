import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { WooSubscriptionReceiptReconciliationService } from "../../src/services/woocommerce-billing/subscription-receipt-reconciliation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDisposableDatabase = testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;
const now = new Date("2026-10-09T00:00:00.000Z");
const activationAt = new Date("2026-10-01T09:30:00.000Z");

type Fixture = {
  shopId: string;
  contractId: string;
  freePlanId: string;
  cataloguePlanId: string;
  paidPlanId: string;
  subscriptionId: string;
  receiptIds: string[];
  operationIds: string[];
  periodIds: string[];
  planHandles: string[];
};

function database(url = testDatabaseUrl): PrismaClient {
  if (!url) throw new Error("TEST_DATABASE_URL is required");
  return new PrismaClient({ datasourceUrl: url });
}

async function createFixture(client: PrismaClient, contractId = `contract-${randomUUID()}`): Promise<Fixture> {
  const suffix = randomUUID();
  const shopId = `woo-${suffix}`;
  const freeHandle = `arch027-free-${suffix}`;
  const paidHandle = `arch027-paid-${suffix}`;
  const [freePlan, paidPlan, cataloguePlan] = await Promise.all([
    client.billingPlan.create({ data: { shopifyPlanHandle: freeHandle, name: "Fixture Free", kind: "FREE" } }),
    client.billingPlan.create({
      data: {
        shopifyPlanHandle: paidHandle,
        name: "Fixture Paid",
        kind: "PAID_METERED",
        includedRecoveryConversationAllowance: 10,
      },
    }),
    client.merchantPricingPlan.create({
      data: {
        id: `catalogue-${suffix}`,
        shopifyPlanHandle: paidHandle,
        displayName: "Fixture Paid",
        planKind: "PAID_METERED",
        cataloguePosition: 1,
        includedRecoveryCredits: 10,
        allowancePeriod: "EVERY_30_DAYS",
        billingPeriod: "EVERY_30_DAYS",
        recurringAmountMinor: 1999,
        currency: "USD",
      },
    }),
  ]);
  await client.shop.create({
    data: { id: shopId, domain: `${suffix}.woo.test`, platform: "WOOCOMMERCE", status: "ACTIVE" },
  });
  const subscription = await client.subscription.create({
    data: { shopId, planId: freePlan.id, status: "ACTIVE" },
  });
  const fixture: Fixture = {
    shopId,
    contractId,
    freePlanId: freePlan.id,
    cataloguePlanId: cataloguePlan.id,
    paidPlanId: paidPlan.id,
    subscriptionId: subscription.id,
    receiptIds: [],
    operationIds: [],
    periodIds: [],
    planHandles: [freeHandle, paidHandle],
  };
  await createOperation(client, fixture, "SUBSCRIPTION_CREATE", contractId, cataloguePlan.id, 1999, activationAt);
  return fixture;
}

async function createOperation(
  client: PrismaClient,
  fixture: Fixture,
  kind: "SUBSCRIPTION_CREATE" | "PLAN_SWITCH" | "CANCEL",
  contractId: string,
  cataloguePlanId: string | null,
  amountMinor: number | null,
  createdAt: Date,
): Promise<string> {
  const operation = await client.billingOperation.create({
    data: {
      shopId: fixture.shopId,
      kind,
      state: "AWAITING_CONFIRMATION",
      requestKey: `${kind.toLowerCase()}-${randomUUID()}`,
      requestFingerprint: randomBytes(32),
      merchantPricingPlanId: cataloguePlanId,
      quotedAmountMinor: amountMinor,
      quotedCurrency: amountMinor === null ? null : "USD",
      quotedBillingPeriod: amountMinor === null ? null : "EVERY_30_DAYS",
      providerReference: contractId,
      createdAt,
    },
    select: { id: true },
  });
  fixture.operationIds.push(operation.id);
  return operation.id;
}

async function createReceipt(
  client: PrismaClient,
  fixture: Fixture,
  topic: string,
  payload: Prisma.InputJsonValue,
): Promise<string> {
  const receipt = await client.wooCommerceBillingWebhookReceipt.create({
    data: {
      topic,
      providerContractId: fixture.contractId,
      payloadSha256: randomBytes(32),
      normalizedPayload: payload,
    },
    select: { id: true },
  });
  fixture.receiptIds.push(receipt.id);
  return receipt.id;
}

function wrapper(
  contractId: string,
  status: string,
  input: {
    modifiedAt?: string;
    nextPaymentAt?: string | null;
    endAt?: string | null;
    price?: string;
    includePayment?: boolean;
    includeFailedIntent?: boolean;
  } = {},
): Prisma.InputJsonValue {
  const billingIntents = input.includePayment
    ? [{ id: 1, status: "completed", updated_at: "2026-10-01 09:29:00" }]
    : input.includeFailedIntent
      ? [{ id: 2, status: "failed", updated_at: input.modifiedAt ?? "2026-10-02 09:00:00" }]
      : [];
  return {
    subscription: {
      id: contractId,
      status,
      name: "Fixture plan",
      price: input.price ?? "19.99",
      date_modified: input.modifiedAt ?? "2026-10-01 09:30:00",
      next_payment_date: input.nextPaymentAt === undefined ? "2026-11-01 09:30:00" : input.nextPaymentAt,
      end_date: input.endAt ?? null,
      billing_intents: billingIntents,
      transactions: input.includePayment
        ? [{ id: 10, billing_intent_id: 1, completed_at: "2026-10-01 09:30:00" }]
        : [],
    },
  };
}

async function activate(client: PrismaClient, fixture: Fixture): Promise<string> {
  const receiptId = await createReceipt(
    client,
    fixture,
    "saas_billing_contract.activated",
    wrapper(fixture.contractId, "active", { includePayment: true }),
  );
  const result = await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
  expect(result.processed).toBeGreaterThan(0);
  fixture.periodIds.push((await client.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } })).billingPeriodId!);
  return receiptId;
}

async function cleanup(client: PrismaClient, fixtures: readonly Fixture[]): Promise<void> {
  const shopIds = fixtures.map(({ shopId }) => shopId);
  const handles = fixtures.flatMap(({ planHandles }) => planHandles);
  await client.wooCommerceBillingWebhookReceipt.deleteMany({
    where: { providerContractId: { in: fixtures.map(({ contractId }) => contractId) } },
  });
  await client.shop.deleteMany({ where: { id: { in: shopIds } } });
  await client.billingPlan.deleteMany({ where: { shopifyPlanHandle: { in: handles } } });
  await client.merchantPricingPlan.deleteMany({ where: { shopifyPlanHandle: { in: handles } } });
}

describeWithDisposableDatabase("Woo recurring receipt reconciliation PostgreSQL", () => {
  it("freezes on a current pause and reactivates on a newer paid renewal without resetting the period", async () => {
    const client = database();
    const fixture = await createFixture(client);
    try {
      await activate(client, fixture);
      const period = await client.billingPeriod.findFirstOrThrow({ where: { shopId: fixture.shopId } });
      await client.billingPeriodEntitlementCounter.update({
        where: { billingPeriodId_counter: { billingPeriodId: period.id, counter: "INCLUDED_RECOVERY_CREDITS" } },
        data: { committedQuantity: 3 },
      });

      await createReceipt(
        client,
        fixture,
        "saas_billing_contract.paused",
        wrapper(fixture.contractId, "paused", {
          modifiedAt: "2026-10-04 09:00:00",
          nextPaymentAt: null,
          includeFailedIntent: true,
        }),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
      expect(await client.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } }))
        .toMatchObject({ status: "FROZEN", currentPeriodEnd: period.periodEnd });

      await createReceipt(
        client,
        fixture,
        "saas_billing_contract.renewed",
        wrapper(fixture.contractId, "active", {
          modifiedAt: "2026-10-05 09:00:00",
          nextPaymentAt: "2026-11-05 09:30:00",
          includePayment: true,
        }),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
      expect(await client.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } }))
        .toMatchObject({ status: "ACTIVE", currentPeriodEnd: period.periodEnd });
      expect(await client.billingPeriod.findMany({ where: { shopId: fixture.shopId } })).toHaveLength(1);
      expect(await client.billingPeriodEntitlementCounter.findUniqueOrThrow({
        where: { billingPeriodId_counter: { billingPeriodId: period.id, counter: "INCLUDED_RECOVERY_CREDITS" } },
      })).toMatchObject({ grantedQuantity: 10, committedQuantity: 3, currentAllowanceQuantity: null });
    } finally {
      await cleanup(client, [fixture]);
      await client.$disconnect();
    }
  }, 30_000);

  it("atomically opens one exact 30-day period and serializes concurrent duplicate workers", async () => {
    const first = database();
    const second = database();
    const fixture = await createFixture(first);
    try {
      const receiptId = await createReceipt(
        first,
        fixture,
        "saas_billing_contract.activated",
        wrapper(fixture.contractId, "active", { includePayment: true }),
      );
      const duplicateReceiptId = await createReceipt(
        first,
        fixture,
        "saas_billing_contract.activated",
        wrapper(fixture.contractId, "active", { includePayment: true }),
      );
      const chargeReceiptId = await createReceipt(
        first,
        fixture,
        "charge.completed",
        { charge: { id: `charge-${randomUUID()}` } },
      );
      const results = await Promise.all([
        new WooSubscriptionReceiptReconciliationService(first, () => now).reconcileBatch(2),
        new WooSubscriptionReceiptReconciliationService(second, () => now).reconcileBatch(2),
      ]);
      const subscription = await first.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
      const periods = await first.billingPeriod.findMany({ where: { shopId: fixture.shopId }, include: { entitlementCounters: true } });
      const receipt = await first.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: receiptId } });

      expect(results.reduce((count, result) => count + result.claimed, 0)).toBe(2);
      expect(subscription).toMatchObject({
        status: "ACTIVE",
        planId: fixture.paidPlanId,
        providerSubscriptionId: fixture.contractId,
        currentPeriodStart: activationAt,
        currentPeriodEnd: new Date(activationAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      });
      expect(periods).toHaveLength(1);
      expect(periods[0]?.entitlementCounters[0]).toMatchObject({
        grantedQuantity: 10,
        currentAllowanceQuantity: null,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      });
      expect(receipt).toMatchObject({ processedAt: now, billingOperationId: fixture.operationIds[0] });
      expect(await first.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: duplicateReceiptId } }))
        .toMatchObject({ processedAt: now, billingOperationId: fixture.operationIds[0] });
      expect(await first.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: chargeReceiptId } }))
        .toMatchObject({ processedAt: null, processingError: null });
      fixture.periodIds.push(periods[0]!.id);
    } finally {
      await cleanup(first, [fixture]);
      await Promise.all([first.$disconnect(), second.$disconnect()]);
    }
  }, 30_000);

  it("keeps plan switches in-period and lets newer renewal defeat stale pause while cancellation remains scheduled", async () => {
    const client = database();
    const fixture = await createFixture(client);
    try {
      await activate(client, fixture);
      const originalPeriod = await client.billingPeriod.findFirstOrThrow({ where: { shopId: fixture.shopId } });
      await client.billingPeriodEntitlementCounter.update({
        where: { billingPeriodId_counter: { billingPeriodId: originalPeriod.id, counter: "INCLUDED_RECOVERY_CREDITS" } },
        data: { committedQuantity: 2, forfeitedQuantity: 1 },
      });
      const secondCatalogue = await client.merchantPricingPlan.create({
        data: {
          id: `catalogue-switch-${randomUUID()}`,
          shopifyPlanHandle: `arch027-switch-${randomUUID()}`,
          displayName: "Fixture Switch",
          planKind: "PAID_METERED",
          cataloguePosition: 2,
          includedRecoveryCredits: 20,
          allowancePeriod: "EVERY_30_DAYS",
          billingPeriod: "EVERY_30_DAYS",
          recurringAmountMinor: 2999,
          currency: "USD",
        },
      });
      const secondPaid = await client.billingPlan.create({
        data: {
          shopifyPlanHandle: secondCatalogue.shopifyPlanHandle,
          name: "Fixture Switch",
          kind: "PAID_METERED",
          includedRecoveryConversationAllowance: 20,
        },
      });
      fixture.planHandles.push(secondCatalogue.shopifyPlanHandle);
      fixture.planHandles.push(secondPaid.shopifyPlanHandle);
      const switchOperationId = await createOperation(
        client, fixture, "PLAN_SWITCH", fixture.contractId, secondCatalogue.id, 2999, new Date("2026-10-04T00:00:00Z"),
      );
      const update = await createReceipt(
        client,
        fixture,
        "saas_billing_contract.updated",
        wrapper(fixture.contractId, "active", {
          modifiedAt: "2026-10-05 09:00:00",
          nextPaymentAt: "2026-10-20 09:30:00",
          price: "29.99",
        }),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
      const switchedSubscription = await client.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
      expect(switchedSubscription).toMatchObject({ planId: secondPaid.id, currentPeriodEnd: originalPeriod.periodEnd });
      expect(switchedSubscription.providerCoverageEndAt).toEqual(new Date("2026-10-20T09:30:00.000Z"));
      const switchedCounter = await client.billingPeriodEntitlementCounter.findUniqueOrThrow({
        where: { billingPeriodId_counter: { billingPeriodId: originalPeriod.id, counter: "INCLUDED_RECOVERY_CREDITS" } },
      });
      expect(switchedCounter).toMatchObject({ grantedQuantity: 20, currentAllowanceQuantity: 20, committedQuantity: 2, forfeitedQuantity: 1 });

      const renewal = await createReceipt(
        client,
        fixture,
        "saas_billing_contract.renewed",
        wrapper(fixture.contractId, "active", {
          modifiedAt: "2026-10-06 09:00:00",
          nextPaymentAt: "2026-11-06 09:30:00",
          includePayment: true,
        }),
      );
      const stalePause = await createReceipt(
        client,
        fixture,
        "saas_billing_contract.paused",
        wrapper(fixture.contractId, "paused", {
          modifiedAt: "2026-10-04 09:00:00",
          nextPaymentAt: null,
          includeFailedIntent: true,
        }),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);

      const subscription = await client.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
      const currentPeriod = await client.billingPeriod.findUniqueOrThrow({ where: { id: originalPeriod.id } });
      const counter = await client.billingPeriodEntitlementCounter.findUniqueOrThrow({
        where: { billingPeriodId_counter: { billingPeriodId: originalPeriod.id, counter: "INCLUDED_RECOVERY_CREDITS" } },
      });
      expect(subscription).toMatchObject({ planId: secondPaid.id, status: "ACTIVE", currentPeriodEnd: originalPeriod.periodEnd });
      expect(subscription.providerCoverageEndAt).toEqual(new Date("2026-11-06T09:30:00.000Z"));
      expect(currentPeriod).toMatchObject({ id: originalPeriod.id, periodStart: originalPeriod.periodStart, periodEnd: originalPeriod.periodEnd });
      expect(counter).toMatchObject({ grantedQuantity: 20, currentAllowanceQuantity: 20, committedQuantity: 2, forfeitedQuantity: 1 });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: update } })).toMatchObject({ billingOperationId: switchOperationId });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: renewal } })).toMatchObject({ processedAt: now });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: stalePause } })).toMatchObject({ processedAt: now });

      const cancelOperationId = await createOperation(
        client, fixture, "CANCEL", fixture.contractId, null, null, new Date("2026-10-07T00:00:00Z"),
      );
      const canceled = await createReceipt(
        client,
        fixture,
        "saas_billing_contract.canceled",
        wrapper(fixture.contractId, "canceled", { modifiedAt: "2026-10-07 09:00:00", endAt: "2026-11-06 09:30:00" }),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
      const scheduled = await client.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
      expect(scheduled).toMatchObject({ status: "ACTIVE", cancelAtPeriodEnd: true, providerCoverageEndAt: new Date("2026-11-06T09:30:00.000Z") });
      expect(scheduled.currentPeriodEnd).toEqual(originalPeriod.periodEnd);
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: canceled } })).toMatchObject({ billingOperationId: cancelOperationId });

      const laterCatalogue = await client.merchantPricingPlan.create({
        data: {
          id: `catalogue-late-${randomUUID()}`,
          shopifyPlanHandle: `arch027-late-${randomUUID()}`,
          displayName: "Fixture Late Switch",
          planKind: "PAID_METERED",
          cataloguePosition: 3,
          includedRecoveryCredits: 30,
          allowancePeriod: "EVERY_30_DAYS",
          billingPeriod: "EVERY_30_DAYS",
          recurringAmountMinor: 3999,
          currency: "USD",
        },
      });
      const laterPaid = await client.billingPlan.create({
        data: { shopifyPlanHandle: laterCatalogue.shopifyPlanHandle, name: "Fixture Late Switch", kind: "PAID_METERED", includedRecoveryConversationAllowance: 30 },
      });
      fixture.planHandles.push(laterCatalogue.shopifyPlanHandle);
      fixture.planHandles.push(laterPaid.shopifyPlanHandle);
      await createOperation(client, fixture, "PLAN_SWITCH", fixture.contractId, laterCatalogue.id, 3999, new Date("2026-10-06T00:00:00Z"));
      await createReceipt(
        client,
        fixture,
        "saas_billing_contract.updated",
        wrapper(fixture.contractId, "active", { modifiedAt: "2026-10-08 09:00:00", price: "39.99", nextPaymentAt: "2026-10-18 09:30:00" }),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
      const afterLateUpdate = await client.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
      expect(afterLateUpdate).toMatchObject({ planId: laterPaid.id, cancelAtPeriodEnd: true, currentPeriodEnd: originalPeriod.periodEnd });
      expect(afterLateUpdate.providerCoverageEndAt).toEqual(new Date("2026-11-06T09:30:00.000Z"));
    } finally {
      await cleanup(client, [fixture]);
      await client.$disconnect();
    }
  }, 30_000);

  it("ends past-due cancellation and standalone prepaid-term evidence without resetting lifetime Free", async () => {
    const client = database();
    const cancellation = await createFixture(client);
    const terminal = await createFixture(client);
    try {
      await activate(client, cancellation);
      await activate(client, terminal);
      const lifetime = await client.shopEntitlementCounter.create({
        data: { shopId: cancellation.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 5, committedQuantity: 2 },
      });
      const pastCancellation = await createReceipt(
        client,
        cancellation,
        "saas_billing_contract.canceled",
        wrapper(cancellation.contractId, "canceled", { modifiedAt: "2026-10-08 09:00:00", endAt: "2026-10-08 09:30:00" }),
      );
      const terminalReceipt = await createReceipt(
        client,
        terminal,
        "saas_billing_contract.prepaid_term_ended",
        wrapper(terminal.contractId, "expired", { modifiedAt: "2026-10-08 09:00:00", endAt: "2026-10-08 09:30:00" }),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);

      for (const fixture of [cancellation, terminal]) {
        const subscription = await client.subscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
        expect(subscription).toMatchObject({
          status: "ACTIVE",
          planId: fixture.freePlanId,
          providerSubscriptionId: null,
          providerCoverageEndAt: null,
          billingPeriodId: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        });
        const closed = await client.billingPeriod.findMany({ where: { shopId: fixture.shopId } });
        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatchObject({ status: "CLOSED", closeReason: "CONTRACT_ENDED", periodEnd: new Date("2026-10-08T09:30:00.000Z") });
      }
      expect(await client.shopEntitlementCounter.findUniqueOrThrow({ where: { id: lifetime.id } }))
        .toMatchObject({ grantedQuantity: 5, committedQuantity: 2 });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: pastCancellation } })).toMatchObject({ processedAt: now });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: terminalReceipt } })).toMatchObject({ processedAt: now });

      const oldContractEvent = await createReceipt(
        client,
        terminal,
        "saas_billing_contract.renewed",
        wrapper(terminal.contractId, "active", { modifiedAt: "2026-10-08 10:00:00", includePayment: true }),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
      expect(await client.subscription.findUniqueOrThrow({ where: { id: terminal.subscriptionId } }))
        .toMatchObject({ planId: terminal.freePlanId, providerSubscriptionId: null, status: "ACTIVE" });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: oldContractEvent } }))
        .toMatchObject({ processedAt: now, processingError: null });
    } finally {
      await cleanup(client, [cancellation, terminal]);
      await client.$disconnect();
    }
  }, 30_000);

  it("isolates historical contracts and permanently records contradictory authenticated financial evidence", async () => {
    const client = database();
    const historical = await createFixture(client);
    const conflict = await createFixture(client);
    try {
      await activate(client, historical);
      await activate(client, conflict);
      const oldReceipt = await createReceipt(
        client,
        historical,
        "saas_billing_contract.paused",
        wrapper(historical.contractId, "paused", { modifiedAt: "2026-10-08 09:00:00", nextPaymentAt: null, includeFailedIntent: true }),
      );
      await client.subscription.update({
        where: { id: historical.subscriptionId },
        data: { providerSubscriptionId: `new-contract-${randomUUID()}` },
      });
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
      expect(await client.subscription.findUniqueOrThrow({ where: { id: historical.subscriptionId } }))
        .toMatchObject({ status: "ACTIVE", providerSubscriptionId: expect.not.stringContaining(historical.contractId) });
      expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id: oldReceipt } }))
        .toMatchObject({ processedAt: now, processingError: null });

      const firstConflict = await createReceipt(
        client,
        conflict,
        "saas_billing_contract.updated",
        wrapper(conflict.contractId, "active", { modifiedAt: "2026-10-08 10:00:00", nextPaymentAt: "2026-11-01 09:30:00" }),
      );
      const secondConflict = await createReceipt(
        client,
        conflict,
        "saas_billing_contract.updated",
        wrapper(conflict.contractId, "active", { modifiedAt: "2026-10-08 10:00:00", nextPaymentAt: "2026-12-01 09:30:00" }),
      );
      const refunded = await createReceipt(
        client,
        conflict,
        "saas_billing_contract.refunded",
        wrapper(conflict.contractId, "refunded"),
      );
      await new WooSubscriptionReceiptReconciliationService(client, () => now).reconcileBatch(10);
      const frozen = await client.subscription.findUniqueOrThrow({ where: { id: conflict.subscriptionId } });
      expect(frozen).toMatchObject({ status: "FROZEN", lastSyncErrorCode: "CONTRADICTORY_FINANCIAL_EVIDENCE", lastSyncErrorAt: now });
      for (const id of [firstConflict, secondConflict, refunded]) {
        expect(await client.wooCommerceBillingWebhookReceipt.findUniqueOrThrow({ where: { id } }))
          .toMatchObject({ processedAt: now, processingError: "CONTRADICTORY_FINANCIAL_EVIDENCE" });
      }
      expect(await client.recoveryCreditRefund.count({ where: { shopId: conflict.shopId } })).toBe(0);
    } finally {
      await cleanup(client, [historical, conflict]);
      await client.$disconnect();
    }
  }, 30_000);
});