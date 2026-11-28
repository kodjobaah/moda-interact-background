import { randomUUID } from "node:crypto";
import type { UsageReservation } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { expect } from "vitest";
import { PurchasedRecoveryReservationService } from "../../../src/services/purchased-recovery-reservation.service.js";
import type { createInitialOutreachCreditFixture } from "./arch056-initial-outreach-credit.fixture.js";

type Fixture = Awaited<ReturnType<typeof createInitialOutreachCreditFixture>>;

/** Seed one confirmed purchase, separate from any lot used by initial outreach.
 * Shopify retains purchased inventory after a plan change; its historical
 * purchase needs a real paid period, purchase usage event and valuation evidence.
 * WooCommerce uses its provider-specific confirmed charge shape. Neither setup
 * grants free capacity or mocks reservation, settlement or compensation. */
export async function reserveAndCommitPurchasedFollowUp(
  f: Fixture,
  sourceKey: string,
): Promise<UsageReservation> {
  const id = randomUUID();
  const at = new Date(f.sentAt.getTime() - 60_000);
  const common = {
    id,
    shopId: f.shopId,
    provider: f.provider,
    creditsGranted: 1,
    currentAmount: 1,
    reservedAmount: 0,
    status: "ACTIVE" as const,
    activatedAt: at,
    providerPurchaseAmount: "1.00",
    providerPurchaseCurrency: "USD",
    providerValuationConfirmedAt: at,
    providerPriceSnapshot: { amount: "1.00", currency: "USD" },
  };
  await f.db.$transaction(async (tx) => {
    const subscription = await tx.subscription.findUniqueOrThrow({
      where: { id: f.subscriptionId },
    });
    if (f.provider === "SHOPIFY") {
      const handle = `follow-up-purchase-${id}`;
      const eventHandle = "fixture-recovery-credit-pack";
      const plan = await tx.billingPlan.create({
        data: {
          shopifyPlanHandle: handle,
          name: "Historical purchased credit plan",
          kind: "PAID_METERED",
          active: true,
        },
      });
      const periodEnd = new Date(f.sentAt.getTime() - 1_000);
      const period = await tx.billingPeriod.create({
        data: {
          shopId: f.shopId,
          subscriptionId: subscription.id,
          planId: plan.id,
          shopifyPlanHandleSnapshot: handle,
          planKindSnapshot: "PAID_METERED",
          periodStart: new Date(periodEnd.getTime() - 30 * 24 * 60 * 60_000),
          periodEnd,
          status: "CLOSED",
          closedAt: periodEnd,
          closeReason: "PLAN_CHANGED",
        },
      });
      const event = await tx.usageEvent.create({
        data: {
          shopId: f.shopId,
          provider: "SHOPIFY",
          billingPeriodId: period.id,
          metric: "RECOVERY_CREDIT_PACK_PURCHASE",
          quantity: 1,
          idempotencyKey: `purchase-fixture:${id}`,
          sourceType: "RECOVERY_CREDIT_PACK_PURCHASE",
          sourceId: id,
          shopifyReportState: "REPORTED",
          shopifyEventHandle: eventHandle,
          occurredAt: at,
          reportedAt: at,
        },
      });
      await tx.recoveryCreditPurchase.create({
        data: {
          ...common,
          planId: plan.id,
          billingPeriodId: period.id,
          shopifyPlanHandleSnapshot: handle,
          shopifyEventHandleSnapshot: eventHandle,
          providerSubscriptionIdSnapshot: `fixture-subscription-${id}`,
          usageEventId: event.id,
          providerUsageQuantityBeforeSnapshot: 0,
          providerUsageCostBeforeSnapshot: "0.00",
          providerUsageCostCurrencyBeforeSnapshot: "USD",
          providerUsageQuantityAfterSnapshot: 1,
          providerUsageCostAfterSnapshot: "1.00",
          providerUsageCostCurrencyAfterSnapshot: "USD",
        },
      });
    } else {
      if (!subscription.planId)
        throw new Error("Purchased fixture subscription plan missing");
      await tx.recoveryCreditPurchase.create({
        data: {
          ...common,
          planId: subscription.planId,
          providerReference: `wc-follow-up-purchase-${id}`,
        },
      });
    }
    await tx.shopEntitlementCounter.upsert({
      where: {
        shopId_counter: {
          shopId: f.shopId,
          counter: "PURCHASED_RECOVERY_CREDITS",
        },
      },
      create: {
        shopId: f.shopId,
        counter: "PURCHASED_RECOVERY_CREDITS",
        grantedQuantity: 1,
      },
      update: { grantedQuantity: { increment: 1 }, version: { increment: 1 } },
    });
  });
  const owner = new PurchasedRecoveryReservationService(f.db);
  const reserved = await owner.reserve({
    shopId: f.shopId,
    sourceKey,
    quantity: 1,
  });
  if (reserved.kind !== "reserved")
    throw new Error(`Historical purchased follow-up reserve: ${reserved.kind}`);
  expect(reserved.reservation).toMatchObject({
    purchasedCreditPurchaseId: id,
    quantity: 1,
    status: "RESERVED",
  });
  const committed = await owner.commit({
    shopId: f.shopId,
    sourceKey,
    quantity: 1,
  });
  if (committed.kind !== "committed")
    throw new Error(`Historical purchased follow-up commit: ${committed.kind}`);
  expect(committed.reservation).toMatchObject({
    id: reserved.reservation.id,
    purchasedCreditPurchaseId: id,
    status: "COMMITTED",
  });
  return reserved.reservation;
}

/** Full durable billing state, excluding outbound transport usage which is
 * intentionally a separate metric. Used to detect replay mutations as well
 * as unexpected free-credit consumption or changes to unrelated lots. */
export async function readPurchasedRetryLedger(f: Fixture) {
  const [counter, free, lots, reservations, events] = await Promise.all([
    f.db.shopEntitlementCounter.findUniqueOrThrow({
      where: {
        shopId_counter: {
          shopId: f.shopId,
          counter: "PURCHASED_RECOVERY_CREDITS",
        },
      },
    }),
    f.db.shopEntitlementCounter.findUniqueOrThrow({
      where: {
        shopId_counter: {
          shopId: f.shopId,
          counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        },
      },
    }),
    f.db.recoveryCreditPurchase.findMany({
      where: { shopId: f.shopId },
      orderBy: { id: "asc" },
    }),
    f.db.usageReservation.findMany({
      where: { shopId: f.shopId },
      orderBy: { id: "asc" },
    }),
    f.db.usageEvent.findMany({
      where: {
        shopId: f.shopId,
        metric: {
          in: ["RECOVERY_CONVERSATION", "RECOVERY_CREDIT_PACK_PURCHASE"],
        },
      },
      orderBy: { id: "asc" },
    }),
  ]);
  return { counter, free, lots, reservations, events };
}

type Ledger = Awaited<ReturnType<typeof readPurchasedRetryLedger>>;
type CreditState = "reserved" | "committed" | "released" | "corrected";

export function expectPurchasedCreditEvidence(
  ledger: Ledger,
  reservationId: string,
  lotId: string,
  provider: Fixture["provider"],
  state: CreditState,
) {
  const reservation = ledger.reservations.find((r) => r.id === reservationId);
  expect(reservation).toMatchObject({
    counterId: ledger.counter.id,
    purchasedCreditPurchaseId: lotId,
    quantity: 1,
    status:
      state === "reserved"
        ? "RESERVED"
        : state === "released"
          ? "RELEASED"
          : "COMMITTED",
  });
  if (!reservation) throw new Error("Purchased retry reservation missing");
  const entries = ledger.events.filter(
    (e) =>
      e.metric === "RECOVERY_CONVERSATION" && e.sourceId === reservation.id,
  );
  if (state === "reserved" || state === "released") {
    expect(reservation).toMatchObject({
      committedUsageEventId: null,
      compensationUsageEventId: null,
    });
    expect(entries).toHaveLength(0);
    return;
  }
  expect(entries).toHaveLength(state === "corrected" ? 2 : 1);
  const original = entries.find(
    (e) => e.id === reservation.committedUsageEventId,
  );
  expect(original).toMatchObject({
    provider,
    sourceType: "PURCHASED_RECOVERY_CREDITS",
    correctionOfUsageEventId: null,
    idempotencyKey: createRecoveryIdempotencyKey(
      reservation.shopId,
      reservation.sourceKey,
    ),
    shopifyReportState: "NOT_APPLICABLE",
  });
  expect(original?.quantity.toString()).toBe("1");
  if (state === "corrected") {
    expect(reservation).toMatchObject({
      compensationDisposition: "RESTORED_SPENDABLE",
      compensationReason: "WHATSAPP_DELIVERY_FAILED",
      compensatedAt: expect.any(Date),
    });
    const negative = entries.find(
      (e) => e.id === reservation.compensationUsageEventId,
    );
    expect(negative).toMatchObject({
      provider,
      sourceType: "RECOVERY_UNDELIVERABLE_COMPENSATION",
      correctionOfUsageEventId: original?.id,
      idempotencyKey: `arch028-undelivered:${reservation.id}`,
      shopifyReportState: "NOT_APPLICABLE",
    });
    expect(negative?.quantity.toString()).toBe("-1");
  } else expect(reservation.compensationUsageEventId).toBeNull();
}

export function expectPurchasedRetryDelta(
  before: Ledger,
  after: Ledger,
  lotId: string,
  retryId: string,
  state: CreditState,
) {
  expect(after.free).toEqual(before.free);
  expect(after.counter).toMatchObject({
    grantedQuantity: before.counter.grantedQuantity,
    refundingQuantity: before.counter.refundingQuantity,
    committedQuantity:
      before.counter.committedQuantity + (state === "committed" ? 1 : 0),
    reservedQuantity:
      before.counter.reservedQuantity + (state === "reserved" ? 1 : 0),
  });
  expect(after.lots).toHaveLength(before.lots.length);
  expect(after.lots.filter((lot) => lot.id !== lotId)).toEqual(
    before.lots.filter((lot) => lot.id !== lotId),
  );
  expect(after.lots.find((lot) => lot.id === lotId)).toMatchObject({
    creditsGranted: 1,
    currentAmount: state === "committed" ? 0 : 1,
    reservedAmount: state === "reserved" ? 1 : 0,
    status: state === "committed" ? "COMPLETED" : "ACTIVE",
  });
  expect(after.reservations.filter((r) => r.id !== retryId)).toEqual(
    before.reservations,
  );
  expect(after.reservations).toHaveLength(before.reservations.length + 1);
  const existingEventIds = new Set(before.events.map((e) => e.id));
  expect(after.events.filter((e) => existingEventIds.has(e.id))).toEqual(
    before.events,
  );
  expect(after.events).toHaveLength(
    before.events.length +
      (state === "committed" ? 1 : state === "corrected" ? 2 : 0),
  );
}
