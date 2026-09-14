import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PurchasedRecoveryReservationService } from "../../src/services/purchased-recovery-reservation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

const MAX_REFUND_HOLD_RETRIES = 3;

class RefundHoldConflict extends Error {}

type RefundHoldOutcome = "held" | "unavailable";

describeWithDatabase("Purchased recovery reservation PostgreSQL concurrency", () => {
  it("allows exactly one owner between reservation and refund hold", async () => {
    const shopId = randomUUID();
    const purchaseId = `purchase-${shopId}`;
    const sourceKey = `${shopId}:recovery:1`;
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient();
    const reservationClient = new PrismaClient();
    const refundClient = new PrismaClient();

    try {
      const plan = await database.billingPlan.create({
        data: {
          shopifyPlanHandle: `purchased-${shopId}`,
          name: "Purchased integration plan",
          kind: "PAID_METERED",
          defaultOutboundSoftLimit: 10,
          defaultOutboundHardLimit: 20,
        },
      });
      await database.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
      const subscription = await database.subscription.create({
        data: {
          shopId,
          planId: plan.id,
          status: "ACTIVE",
          observedShopifyPlanHandle: plan.shopifyPlanHandle,
          currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        },
      });
      const billingPeriod = await database.billingPeriod.create({
        data: {
          shopId,
          subscriptionId: subscription.id,
          planId: plan.id,
          planKindSnapshot: "PAID_METERED",
          periodStart: new Date("2026-09-01T00:00:00.000Z"),
          periodEnd: new Date("2026-10-01T00:00:00.000Z"),
          status: "OPEN",
        },
      });
      const usageEvent = await database.usageEvent.create({
        data: {
          shopId,
          billingPeriodId: billingPeriod.id,
          metric: "RECOVERY_CREDIT_PACK_PURCHASE",
          quantity: 1,
          idempotencyKey: `purchase-event:${shopId}`,
          sourceType: "RECOVERY_CREDIT_PACK_PURCHASE",
          sourceId: purchaseId,
          shopifyReportState: "REPORTED",
          shopifyEventHandle: "pack-meter",
        },
      });
      await database.shopEntitlementCounter.create({
        data: {
          shopId,
          counter: "PURCHASED_RECOVERY_CREDITS",
          grantedQuantity: 1,
        },
      });
      await database.recoveryCreditPurchase.create({
        data: {
          id: purchaseId,
          shopId,
          planId: plan.id,
          billingPeriodId: billingPeriod.id,
          shopifyPlanHandleSnapshot: "top-up-plan",
          shopifyEventHandleSnapshot: "pack-meter",
          providerSubscriptionIdSnapshot: "provider-subscription",
          providerUsageQuantityBeforeSnapshot: 0,
          providerUsageCostBeforeSnapshot: new Prisma.Decimal("10.00"),
          providerUsageCostCurrencyBeforeSnapshot: "USD",
          providerUsageQuantityAfterSnapshot: 1,
          providerUsageCostAfterSnapshot: new Prisma.Decimal("11.00"),
          providerUsageCostCurrencyAfterSnapshot: "USD",
          providerPurchaseAmount: new Prisma.Decimal("1.00"),
          providerPurchaseCurrency: "USD",
          providerValuationConfirmedAt: new Date("2026-09-01T00:00:00.000Z"),
          providerPriceSnapshot: { amount: "1.00", currency: "USD" },
          creditsGranted: 1,
          currentAmount: 1,
          status: "ACTIVE",
          activatedAt: new Date("2026-09-01T00:00:00.000Z"),
          usageEventId: usageEvent.id,
        },
      });

      const [reservation, refundHold] = await Promise.all([
        new PurchasedRecoveryReservationService(reservationClient).reserve({ shopId, sourceKey }),
        holdRefundCapacity(refundClient, shopId, purchaseId),
      ]);

      expect((reservation.kind === "reserved") !== (refundHold === "held")).toBe(true);

      const aggregate = await database.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
      });
      const lot = await database.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: purchaseId } });
      expect(aggregate.reservedQuantity + aggregate.refundingQuantity).toBe(1);
      expect(lot.currentAmount - lot.reservedAmount).toBe(refundHold === "held" ? 1 : 0);
      expect(aggregate.committedQuantity).toBe(0);
      expect(aggregate.grantedQuantity - aggregate.committedQuantity - aggregate.reservedQuantity - aggregate.refundingQuantity).toBeGreaterThanOrEqual(0);

      const reservations = await database.usageReservation.findMany({ where: { sourceKey } });
      if (reservation.kind === "reserved") {
        expect(reservations).toHaveLength(1);
        expect(reservations[0]).toMatchObject({ purchasedCreditPurchaseId: purchaseId, quantity: 1 });
      } else {
        expect(reservations).toHaveLength(0);
      }
    } finally {
      await database.shop.delete({ where: { id: shopId } }).catch(() => undefined);
      await Promise.all([
        database.$disconnect(),
        reservationClient.$disconnect(),
        refundClient.$disconnect(),
      ]);
    }
  }, 30_000);

  it("lets a refund transition win, then retries reservation onto the next active FIFO lot", async () => {
    const fixture = await createFixture(2, [
      { id: "old-withdrawn", activatedAt: new Date("2026-09-01T00:00:00.000Z") },
      { id: "next-active", activatedAt: new Date("2026-09-02T00:00:00.000Z") },
    ]);
    try {
      expect(await holdRefundCapacity(fixture.refundClient, fixture.shopId, "old-withdrawn")).toBe("held");
      const result = await new PurchasedRecoveryReservationService(fixture.reservationClient)
        .reserve({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:retry` });
      expect(result).toMatchObject({ kind: "reserved", reservation: { purchasedCreditPurchaseId: "next-active" } });
      const withdrawn = await fixture.database.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: "old-withdrawn" } });
      expect(withdrawn.status).toBe("WITHDRAWN");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("allows a reservation winner to leave one credit available for the refund winner", async () => {
    const fixture = await createFixture(2, [{ id: "two-credit-lot", activatedAt: new Date("2026-09-01T00:00:00.000Z"), creditsGranted: 2 }]);
    try {
      const reservation = await new PurchasedRecoveryReservationService(fixture.reservationClient)
        .reserve({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:two-credit` });
      expect(reservation.kind).toBe("reserved");
      expect(await holdRefundCapacity(fixture.refundClient, fixture.shopId, "two-credit-lot")).toBe("held");
      const lot = await fixture.database.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: "two-credit-lot" } });
      expect(lot).toMatchObject({ status: "WITHDRAWN", currentAmount: 2, reservedAmount: 1 });
      expect(lot.currentAmount - lot.reservedAmount).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("releases a withdrawn reservation into refunding capacity using two clients", async () => {
    const fixture = await createFixture(1, [{ id: "withdrawn-release", activatedAt: new Date("2026-09-01T00:00:00.000Z") }]);
    try {
      const service = new PurchasedRecoveryReservationService(fixture.reservationClient);
      await service.reserve({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:release` });
      expect(await markReservedLotWithdrawn(fixture.refundClient, "withdrawn-release")).toBe(true);
      await expect(service.release({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:release` }))
        .resolves.toMatchObject({ kind: "released" });
      const [counter, lot] = await Promise.all([
        fixture.database.shopEntitlementCounter.findUniqueOrThrow({ where: { shopId_counter: { shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } } }),
        fixture.database.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: "withdrawn-release" } }),
      ]);
      expect(counter).toMatchObject({ reservedQuantity: 0, refundingQuantity: 1 });
      expect(lot).toMatchObject({ status: "WITHDRAWN", currentAmount: 1, reservedAmount: 0 });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("commits a withdrawn reservation and conserves aggregate committed capacity", async () => {
    const fixture = await createFixture(1, [{ id: "withdrawn-commit", activatedAt: new Date("2026-09-01T00:00:00.000Z") }]);
    try {
      const service = new PurchasedRecoveryReservationService(fixture.reservationClient);
      await service.reserve({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:commit` });
      expect(await markReservedLotWithdrawn(fixture.refundClient, "withdrawn-commit")).toBe(true);
      await expect(service.commit({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:commit` }))
        .resolves.toMatchObject({ kind: "committed" });
      const [counter, lot] = await Promise.all([
        fixture.database.shopEntitlementCounter.findUniqueOrThrow({ where: { shopId_counter: { shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS" } } }),
        fixture.database.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: "withdrawn-commit" } }),
      ]);
      expect(counter).toMatchObject({ reservedQuantity: 0, committedQuantity: 1, refundingQuantity: 0 });
      expect(lot).toMatchObject({ status: "COMPLETED", currentAmount: 0, reservedAmount: 0 });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("cancels a live refund when the last withdrawn reservation commits", async () => {
    const fixture = await createFixture(1, [{ id: "withdrawn-final", activatedAt: new Date("2026-09-01T00:00:00.000Z") }], true);
    try {
      const service = new PurchasedRecoveryReservationService(fixture.reservationClient);
      await service.reserve({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:final` });
      expect(await markReservedLotWithdrawn(fixture.refundClient, "withdrawn-final")).toBe(true);
      await service.commit({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:final` });
      const refund = await fixture.database.recoveryCreditRefund.findFirstOrThrow({ where: { purchaseId: "withdrawn-final" } });
      expect(refund).toMatchObject({ status: "CANCELLED", reason: "NO_CREDITS_REMAINING", providerReference: null });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("keeps a reactivated old lot ahead of newer lots and leaves unrelated lots untouched", async () => {
    const fixture = await createFixture(2, [
      { id: "old-lot", activatedAt: new Date("2026-09-01T00:00:00.000Z") },
      { id: "unrelated-lot", activatedAt: new Date("2026-09-02T00:00:00.000Z"), creditsGranted: 2 },
      { id: "new-lot", activatedAt: new Date("2026-09-03T00:00:00.000Z") },
    ]);
    try {
      expect(await markWithdrawn(fixture.refundClient, fixture.shopId, "old-lot")).toBe(true);
      await reactivateLot(fixture.refundClient, fixture.shopId, "old-lot");
      const result = await new PurchasedRecoveryReservationService(fixture.reservationClient)
        .reserve({ shopId: fixture.shopId, sourceKey: `${fixture.shopId}:reactivated` });
      expect(result).toMatchObject({ kind: "reserved", reservation: { purchasedCreditPurchaseId: "old-lot" } });
      const unrelated = await fixture.database.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: "unrelated-lot" } });
      expect(unrelated).toMatchObject({ status: "ACTIVE", currentAmount: 2, reservedAmount: 0, version: 0 });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

type Fixture = {
  database: PrismaClient;
  reservationClient: PrismaClient;
  refundClient: PrismaClient;
  shopId: string;
  cleanup: () => Promise<void>;
};

async function createFixture(
  grantedQuantity: number,
  lots: Array<{ id: string; activatedAt: Date; creditsGranted?: number }>,
  withRefund = false,
): Promise<Fixture> {
  process.env.DATABASE_URL = testDatabaseUrl;
  const database = new PrismaClient();
  const reservationClient = new PrismaClient();
  const refundClient = new PrismaClient();
  const shopId = randomUUID();
  const plan = await database.billingPlan.create({ data: { shopifyPlanHandle: `fixture-${shopId}`, name: "Fixture plan", kind: "PAID_METERED", defaultOutboundSoftLimit: 10, defaultOutboundHardLimit: 20 } });
  await database.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
  const subscription = await database.subscription.create({ data: { shopId, planId: plan.id, status: "ACTIVE", observedShopifyPlanHandle: plan.shopifyPlanHandle, currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") } });
  const billingPeriod = await database.billingPeriod.create({ data: { shopId, subscriptionId: subscription.id, planId: plan.id, planKindSnapshot: "PAID_METERED", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-10-01T00:00:00.000Z"), status: "OPEN" } });
  await database.shopEntitlementCounter.create({ data: { shopId, counter: "PURCHASED_RECOVERY_CREDITS", grantedQuantity } });
  for (const lot of lots) {
    const creditsGranted = lot.creditsGranted ?? 1;
    const usageEvent = await database.usageEvent.create({ data: { shopId, billingPeriodId: billingPeriod.id, metric: "RECOVERY_CREDIT_PACK_PURCHASE", quantity: creditsGranted, idempotencyKey: `fixture-event:${lot.id}`, sourceType: "RECOVERY_CREDIT_PACK_PURCHASE", sourceId: lot.id, shopifyReportState: "REPORTED", shopifyEventHandle: `fixture-${lot.id}` } });
    await database.recoveryCreditPurchase.create({ data: { id: lot.id, shopId, planId: plan.id, billingPeriodId: billingPeriod.id, shopifyPlanHandleSnapshot: "fixture-plan", shopifyEventHandleSnapshot: `fixture-${lot.id}`, providerSubscriptionIdSnapshot: "fixture-subscription", providerUsageQuantityBeforeSnapshot: 0, providerUsageCostBeforeSnapshot: new Prisma.Decimal("10.00"), providerUsageCostCurrencyBeforeSnapshot: "USD", providerUsageQuantityAfterSnapshot: 1, providerUsageCostAfterSnapshot: new Prisma.Decimal("11.00"), providerUsageCostCurrencyAfterSnapshot: "USD", providerPurchaseAmount: new Prisma.Decimal("1.00"), providerPurchaseCurrency: "USD", providerValuationConfirmedAt: lot.activatedAt, providerPriceSnapshot: { amount: "1.00", currency: "USD" }, creditsGranted, currentAmount: creditsGranted, status: "ACTIVE", activatedAt: lot.activatedAt, usageEventId: usageEvent.id } });
    if (withRefund && lot.id === "withdrawn-final") {
      await database.recoveryCreditRefund.create({ data: { shopId, purchaseId: lot.id, source: "ADMIN", purchaseCreditsGrantedSnapshot: creditsGranted, currentAmountAtRequestSnapshot: creditsGranted, reservedAmountAtRequestSnapshot: 0, availableAmountAtRequestSnapshot: creditsGranted, billingPeriodIdSnapshot: billingPeriod.id, providerSubscriptionIdSnapshot: "fixture-subscription", planHandleSnapshot: "fixture-plan", eventHandleSnapshot: `fixture-${lot.id}`, purchaseProviderAmountSnapshot: new Prisma.Decimal("1.00"), purchaseProviderCurrencySnapshot: "USD", requestKey: `refund:${lot.id}` } });
    }
  }
  return { database, reservationClient, refundClient, shopId, cleanup: async () => { await database.shop.delete({ where: { id: shopId } }).catch(() => undefined); await Promise.all([database.$disconnect(), reservationClient.$disconnect(), refundClient.$disconnect()]); } };
}

async function markWithdrawn(database: PrismaClient, shopId: string, purchaseId: string): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const [counter, lot] = await Promise.all([
      transaction.shopEntitlementCounter.findUniqueOrThrow({ where: { shopId_counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" } } }),
      transaction.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: purchaseId } }),
    ]);
    const counterUpdate = await transaction.shopEntitlementCounter.updateMany({ where: { id: counter.id, version: counter.version, refundingQuantity: { lte: counter.grantedQuantity - counter.committedQuantity - counter.reservedQuantity - 1 } }, data: { refundingQuantity: { increment: 1 }, version: { increment: 1 } } });
    const lotUpdate = await transaction.recoveryCreditPurchase.updateMany({ where: { id: lot.id, version: lot.version, status: "ACTIVE", currentAmount: { gte: lot.reservedAmount + 1 } }, data: { status: "WITHDRAWN", version: { increment: 1 } } });
    if (counterUpdate.count !== 1 || lotUpdate.count !== 1) throw new RefundHoldConflict();
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error) => {
    if (error instanceof RefundHoldConflict) return false;
    throw error;
  });
}

async function markReservedLotWithdrawn(database: PrismaClient, purchaseId: string): Promise<boolean> {
  const lot = await database.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: purchaseId } });
  const updated = await database.recoveryCreditPurchase.updateMany({
    where: { id: lot.id, version: lot.version, status: "ACTIVE", currentAmount: lot.reservedAmount },
    data: { status: "WITHDRAWN", version: { increment: 1 } },
  });
  return updated.count === 1;
}

async function reactivateLot(database: PrismaClient, shopId: string, purchaseId: string): Promise<void> {
  await database.$transaction(async (transaction) => {
    const lot = await transaction.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: purchaseId } });
    await transaction.recoveryCreditPurchase.updateMany({ where: { id: lot.id, version: lot.version, status: "WITHDRAWN" }, data: { status: "ACTIVE", version: { increment: 1 } } });
    await transaction.shopEntitlementCounter.updateMany({ where: { shopId, counter: "PURCHASED_RECOVERY_CREDITS", refundingQuantity: { gte: 1 } }, data: { refundingQuantity: { decrement: 1 }, version: { increment: 1 } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function holdRefundCapacity(
  database: PrismaClient,
  shopId: string,
  purchaseId: string,
): Promise<RefundHoldOutcome> {
  for (let attempt = 0; attempt < MAX_REFUND_HOLD_RETRIES; attempt += 1) {
    try {
      return await database.$transaction(async (transaction) => {
        const aggregate = await transaction.shopEntitlementCounter.findUnique({
          where: { shopId_counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" } },
        });
        const lot = await transaction.recoveryCreditPurchase.findUnique({ where: { id: purchaseId } });
        if (!aggregate || !lot) throw new Error("Refund-hold fixtures are missing");

        const aggregateSpendable = aggregate.grantedQuantity - aggregate.committedQuantity - aggregate.reservedQuantity - aggregate.refundingQuantity;
        const lotSpendable = lot.currentAmount - lot.reservedAmount;
        if (aggregateSpendable < 1 || lotSpendable < 1 || lot.status !== "ACTIVE") return "unavailable";

        const aggregateUpdated = await transaction.shopEntitlementCounter.updateMany({
          where: {
            id: aggregate.id,
            version: aggregate.version,
            refundingQuantity: { lte: aggregate.grantedQuantity - aggregate.committedQuantity - aggregate.reservedQuantity - 1 },
          },
          data: { refundingQuantity: { increment: 1 }, version: { increment: 1 } },
        });
        if (aggregateUpdated.count !== 1) throw new RefundHoldConflict();

        const lotUpdated = await transaction.recoveryCreditPurchase.updateMany({
          where: { id: lot.id, version: lot.version, status: "ACTIVE", currentAmount: { gte: lot.reservedAmount + 1 } },
          data: { status: "WITHDRAWN", version: { increment: 1 } },
        });
        if (lotUpdated.count !== 1) throw new RefundHoldConflict();
        return "held";
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof RefundHoldConflict) && !(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")) throw error;
      if (attempt === MAX_REFUND_HOLD_RETRIES - 1) return "unavailable";
    }
  }
  return "unavailable";
}
