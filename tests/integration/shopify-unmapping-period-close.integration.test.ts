import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  BillingPeriodCloseReason,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  Prisma,
  PrismaClient,
  SubscriptionProjectionStatus,
  UsageReservationReleaseReason,
  UsageReservationStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { PartnerSubscription } from "../../src/providers/shopify-partner-billing.provider.js";
import { GenericSubscriptionProjectionService } from "../../src/services/billing-reconciliation/generic-subscription-projection.service.js";
import { classifyObservedPlanProjection } from "../../src/services/billing-reconciliation/observed-plan-projection.js";
import { retireUnmappedCurrentPeriod } from "../../src/services/billing-period-transition/retire-unmapped-current-period.js";

const suite =
  process.env.TEST_DATABASE_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;
const start = new Date("2026-09-01T00:00:00.000Z");
const end = new Date("2026-10-01T00:00:00.000Z");
const observedAt = new Date("2026-09-15T12:00:00.000Z");

async function setupPeriod(db: PrismaClient) {
  const shopId = `unmapping-${randomUUID()}`;
  const plan = await db.billingPlan.create({
    data: {
      name: "Paid unmapping integration fixture",
      kind: BillingPlanKind.PAID_METERED,
      shopifyPlanHandle: `paid-${shopId}`,
      includedRecoveryConversationAllowance: 10,
    },
  });
  await db.shop.create({
    data: { id: shopId, domain: `${shopId}.example.test` },
  });
  const subscription = await db.subscription.create({
    data: {
      shopId,
      planId: plan.id,
      status: SubscriptionProjectionStatus.ACTIVE,
      observedShopifyPlanHandle: plan.shopifyPlanHandle,
      currentPeriodStart: start,
      currentPeriodEnd: end,
    },
  });
  const period = await db.billingPeriod.create({
    data: {
      shopId,
      subscriptionId: subscription.id,
      planId: plan.id,
      shopifyPlanHandleSnapshot: plan.shopifyPlanHandle,
      planNameSnapshot: plan.name,
      planKindSnapshot: BillingPlanKind.PAID_METERED,
      includedRecoveryCreditsGranted: 10,
      periodStart: start,
      periodEnd: end,
    },
  });
  await db.subscription.update({
    where: { id: subscription.id },
    data: { billingPeriodId: period.id },
  });
  const counter = await db.billingPeriodEntitlementCounter.create({
    data: {
      shopId,
      billingPeriodId: period.id,
      counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
      grantedQuantity: 10,
      committedQuantity: 3,
      reservedQuantity: 2,
    },
  });
  const reservation = await db.usageReservation.create({
    data: {
      shopId,
      billingPeriodEntitlementCounterId: counter.id,
      sourceKey: `unmapping-${randomUUID()}`,
      quantity: 2,
      status: UsageReservationStatus.RESERVED,
    },
  });
  return { shopId, plan, subscription, period, counter, reservation };
}

type Fixture = Awaited<ReturnType<typeof setupPeriod>>;

async function cleanup(db: PrismaClient, fixture: Fixture) {
  await db.usageReservation.deleteMany({
    where: { id: fixture.reservation.id },
  });
  await db.billingPeriodEntitlementCounter.deleteMany({
    where: { id: fixture.counter.id },
  });
  await db.subscription.update({
    where: { id: fixture.subscription.id },
    data: { billingPeriodId: null },
  });
  await db.billingPeriod.deleteMany({ where: { id: fixture.period.id } });
  await db.subscription.deleteMany({ where: { id: fixture.subscription.id } });
  await db.shop.deleteMany({ where: { id: fixture.shopId } });
  await db.billingPlan.deleteMany({ where: { id: fixture.plan.id } });
}

function unknownProvider(shopId: string): PartnerSubscription {
  return {
    planHandle: `unmapped-${shopId}`,
    usageEventHandles: [],
    status: "ACTIVE",
    pendingPlanHandle: null,
    pendingEffectiveAt: null,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: `provider-${shopId}`,
    providerUsageSnapshot: [],
    providerUsagePricingSnapshot: [],
  };
}

suite("Shopify unmapping paid-period close PostgreSQL integrity", () => {
  it("closes and detaches a paid period exactly once with concurrent observations and replay", async () => {
    const first = new PrismaClient({
      datasourceUrl: process.env.TEST_DATABASE_URL!,
    });
    const second = new PrismaClient({
      datasourceUrl: process.env.TEST_DATABASE_URL!,
    });
    let fixture: Fixture | undefined;
    try {
      fixture = await setupPeriod(first);
      const provider = unknownProvider(fixture.shopId);
      const existing = await first.subscription.findUniqueOrThrow({
        where: { id: fixture.subscription.id },
      });
      const scheduler = { enqueue: vi.fn(async () => undefined) };
      const logger = { warn: vi.fn() };
      const reconcile = (db: PrismaClient) =>
        new GenericSubscriptionProjectionService(
          db,
          scheduler as never,
          logger as never,
        ).reconcile({
          shopId: fixture!.shopId,
          provider,
          plan: null,
          existing,
          projection: classifyObservedPlanProjection(provider, null),
          now: observedAt,
        });

      const [left, right] = await Promise.allSettled([
        reconcile(first),
        reconcile(second),
      ]);
      for (const result of [left, right]) {
        if (result.status === "rejected") throw result.reason;
        expect(result.value.billingPeriodId).toBeNull();
      }
      const after = await first.subscription.findUniqueOrThrow({
        where: { id: fixture.subscription.id },
      });
      expect(after.status).toBe(SubscriptionProjectionStatus.UNMAPPED);
      expect(after.planId).toBeNull();
      expect(after.billingPeriodId).toBeNull();
      const period = await first.billingPeriod.findUniqueOrThrow({
        where: { id: fixture.period.id },
      });
      expect(period).toMatchObject({
        status: BillingPeriodStatus.CLOSED,
        closeReason: BillingPeriodCloseReason.PLAN_CHANGED,
      });
      const counter =
        await first.billingPeriodEntitlementCounter.findUniqueOrThrow({
          where: { id: fixture.counter.id },
        });
      expect(counter).toMatchObject({
        grantedQuantity: 10,
        committedQuantity: 3,
        reservedQuantity: 0,
        forfeitedQuantity: 7,
        version: 1,
      });
      const reservation = await first.usageReservation.findUniqueOrThrow({
        where: { id: fixture.reservation.id },
      });
      expect(reservation).toMatchObject({
        status: UsageReservationStatus.RELEASED,
        releaseReason: UsageReservationReleaseReason.PERIOD_CLOSED,
      });

      await new GenericSubscriptionProjectionService(
        first,
        scheduler as never,
        logger as never,
      ).reconcile({
        shopId: fixture.shopId,
        provider,
        plan: null,
        existing: after,
        projection: classifyObservedPlanProjection(provider, null),
        now: new Date(observedAt.getTime() + 60_000),
      });
      const replayed =
        await first.billingPeriodEntitlementCounter.findUniqueOrThrow({
          where: { id: fixture.counter.id },
        });
      expect(replayed.version).toBe(1);
      expect(replayed.forfeitedQuantity).toBe(7);
    } finally {
      try {
        if (fixture) await cleanup(first, fixture);
      } finally {
        await Promise.all([first.$disconnect(), second.$disconnect()]);
      }
    }
  }, 45_000);

  it("rolls back reservation release and period closure on a simulated counter version conflict", async () => {
    const db = new PrismaClient({
      datasourceUrl: process.env.TEST_DATABASE_URL!,
    });
    let fixture: Fixture | undefined;
    try {
      fixture = await setupPeriod(db);
      const fixed = fixture;
      await expect(
        db.$transaction(async (realTransaction) => {
          // Deterministically mimic a version change between the counter read
          // and its compare-and-swap. Use real PostgreSQL writes throughout.
          const conflictingTransaction = new Proxy(realTransaction, {
            get(target, property, receiver) {
              if (property !== "billingPeriodEntitlementCounter")
                return Reflect.get(target, property, receiver);
              return new Proxy(target.billingPeriodEntitlementCounter, {
                get(delegate, method) {
                  if (method !== "updateMany")
                    return Reflect.get(delegate, method);
                  return async (
                    args: Prisma.BillingPeriodEntitlementCounterUpdateManyArgs,
                  ) => {
                    await realTransaction.billingPeriodEntitlementCounter.update(
                      {
                        where: { id: fixed.counter.id },
                        data: { version: { increment: 1 } },
                      },
                    );
                    return delegate.updateMany(args);
                  };
                },
              });
            },
          }) as Prisma.TransactionClient;
          await retireUnmappedCurrentPeriod(conflictingTransaction, {
            subscriptionId: fixed.subscription.id,
            billingPeriodId: fixed.period.id,
            now: observedAt,
          });
          await conflictingTransaction.subscription.update({
            where: { id: fixed.subscription.id },
            data: {
              status: SubscriptionProjectionStatus.UNMAPPED,
              billingPeriodId: null,
              planId: null,
            },
          });
        }),
      ).rejects.toThrow(
        "Paid billing period included-credit counter changed during close",
      );

      const subscription = await db.subscription.findUniqueOrThrow({
        where: { id: fixed.subscription.id },
      });
      const period = await db.billingPeriod.findUniqueOrThrow({
        where: { id: fixed.period.id },
      });
      const counter =
        await db.billingPeriodEntitlementCounter.findUniqueOrThrow({
          where: { id: fixed.counter.id },
        });
      const reservation = await db.usageReservation.findUniqueOrThrow({
        where: { id: fixed.reservation.id },
      });
      expect(subscription).toMatchObject({
        status: SubscriptionProjectionStatus.ACTIVE,
        billingPeriodId: fixed.period.id,
      });
      expect(period).toMatchObject({
        status: BillingPeriodStatus.OPEN,
        closedAt: null,
      });
      expect(counter).toMatchObject({
        committedQuantity: 3,
        reservedQuantity: 2,
        forfeitedQuantity: 0,
        version: 0,
      });
      expect(reservation).toMatchObject({
        status: UsageReservationStatus.RESERVED,
        releaseReason: null,
      });
    } finally {
      try {
        if (fixture) await cleanup(db, fixture);
      } finally {
        await db.$disconnect();
      }
    }
  }, 45_000);
});
