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
      await database.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
      const usageEvent = await database.usageEvent.create({
        data: {
          shopId,
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
          shopifyPlanHandleSnapshot: "top-up-plan",
          shopifyEventHandleSnapshot: "pack-meter",
          creditsGranted: 1,
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
      expect(lot.reservedQuantity + lot.refundingQuantity).toBe(1);
      expect(aggregate.committedQuantity).toBe(0);
      expect(lot.committedQuantity).toBe(0);
      expect(lot.refundedQuantity).toBe(0);
      expect(aggregate.grantedQuantity - aggregate.committedQuantity - aggregate.reservedQuantity - aggregate.refundingQuantity).toBeGreaterThanOrEqual(0);
      expect(lot.creditsGranted - lot.committedQuantity - lot.reservedQuantity - lot.refundingQuantity - lot.refundedQuantity).toBeGreaterThanOrEqual(0);

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
});

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
        const lotSpendable = lot.creditsGranted - lot.committedQuantity - lot.reservedQuantity - lot.refundingQuantity - lot.refundedQuantity;
        if (aggregateSpendable < 1 || lotSpendable < 1 || lot.status !== "ACTIVE") return "unavailable";

        const aggregateUpdated = await transaction.shopEntitlementCounter.updateMany({
          where: { id: aggregate.id, version: aggregate.version, refundingQuantity: { lte: aggregate.grantedQuantity - aggregate.committedQuantity - aggregate.reservedQuantity - 1 } },
          data: { refundingQuantity: { increment: 1 }, version: { increment: 1 } },
        });
        if (aggregateUpdated.count !== 1) throw new RefundHoldConflict();

        const lotUpdated = await transaction.recoveryCreditPurchase.updateMany({
          where: { id: lot.id, version: lot.version, status: "ACTIVE", refundingQuantity: { lte: lot.creditsGranted - lot.committedQuantity - lot.reservedQuantity - lot.refundedQuantity - 1 } },
          data: { refundingQuantity: { increment: 1 }, version: { increment: 1 } },
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
