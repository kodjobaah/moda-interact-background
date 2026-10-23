import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it } from "vitest";
import { PurchasedRecoveryReservationService } from
  "../../src/services/purchased-recovery-reservation.service.js";
import { inspectFollowUpCredit } from
  "../../src/services/recovery-conversation/recovery-follow-up-billing.service.js";
import { OutboundSendFenceService } from
  "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
type Fixture = Awaited<ReturnType<typeof humanDispatchFixture>>;

/** A real Woo purchased credit, using ARCH-027's confirmed valuation shape.
 * Only one lot is reserved by the production reservation owner; the second
 * lot proves that cancellation does not touch unrelated inventory.
 */
async function purchasedFixture(f: Fixture, lots = 2) {
  const plan = await f.db.billingPlan.create({ data: {
    shopifyPlanHandle: `arch040-purchased-${randomUUID()}`,
    name: "ARCH-040 purchased follow-up fixture", kind: "PAID_METERED",
  } });
  const lotIds: string[] = [];
  for (let i = 0; i < lots; i++) {
    const id = randomUUID();
    lotIds.push(id);
    await f.db.recoveryCreditPurchase.create({ data: {
      id, shopId: f.shopId, planId: plan.id, provider: "WOOCOMMERCE",
      providerReference: `wc-test-${id}`,
      providerPurchaseAmount: new Prisma.Decimal("1.00"), providerPurchaseCurrency: "GBP",
      providerValuationConfirmedAt: new Date("2026-10-20T00:00:00Z"),
      providerPriceSnapshot: { amount: "1.00", currency: "GBP" },
      creditsGranted: 1, currentAmount: 1, reservedAmount: 0,
      status: "ACTIVE", activatedAt: new Date(Date.UTC(2026, 9, 20 + i)),
    } });
  }
  await f.db.shopEntitlementCounter.create({ data: {
    shopId: f.shopId, counter: "PURCHASED_RECOVERY_CREDITS", grantedQuantity: lots,
  } });
  return lotIds;
}

async function claimedPurchased(f: Fixture, lots = 2) {
  const lotIds = await purchasedFixture(f, lots);
  const { commandId, attemptId } = await f.addMerchantFollowUpCommand();
  const sourceKey = createRecoveryIdempotencyKey(f.shopId, `recovery-outreach:${attemptId}`);
  const purchase = new PurchasedRecoveryReservationService(f.db);
  expect(await purchase.reserve({ shopId: f.shopId, sourceKey, quantity: 1 }))
    .toMatchObject({ kind: "reserved", reservation: {
      sourceKey, purchasedCreditPurchaseId: lotIds[0], quantity: 1,
      counterId: expect.any(String),
    } });
  const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
  expect(claim.id).toBe(commandId);
  return { commandId, attemptId, sourceKey, lotIds, purchase, leaseToken: claim.leaseToken };
}

function cancellation(f: Fixture, purchase: PurchasedRecoveryReservationService) {
  return f.cancellationService(async (credit) => {
    expect(credit).toMatchObject({ kind: "persisted", shopId: f.shopId,
      capacity: "purchased", quantity: 1 });
    const released = await purchase.release(credit);
    if (released.kind !== "released" && released.kind !== "already-released")
      throw new Error("Purchased source owner did not confirm release");
  });
}

async function shopCreditState(f: Fixture) {
  return f.db.shopEntitlementCounter.findUniqueOrThrow({ where: {
    shopId_counter: { shopId: f.shopId, counter: "PURCHASED_RECOVERY_CREDITS" },
  } });
}

suite("ARCH-040-BACKGROUND-009 purchased follow-up release and repair", () => {
  it("cancels a pre-provider HUMAN follow-up, releases exactly its original lot, then reclaims sequence two", async () => {
    const f = await humanDispatchFixture("purchased-preprovider-release");
    try {
      const p = await claimedPurchased(f);
      expect(await f.db.$transaction((tx) => inspectFollowUpCredit(tx, {
        shopId: f.shopId, attemptId: p.attemptId,
      }))).toEqual({ kind: "reserved", admission: {
        kind: "persisted", shopId: f.shopId, sourceKey: p.sourceKey,
        capacity: "purchased", quantity: 1,
      } });
      expect((await shopCreditState(f)).reservedQuantity).toBe(1);
      expect((await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: p.lotIds[0]! } })).reservedAmount).toBe(1);
      expect(await cancellation(f, p.purchase).cancelClaimed(p.commandId, p.leaseToken,
        "human_content_moderation_blocked")).toBe("released");
      expect((await f.commandState(p.commandId)).state).toBe("CANCELLED");
      expect(await f.db.$transaction((tx) => inspectFollowUpCredit(tx, {
        shopId: f.shopId, attemptId: p.attemptId,
      }))).toEqual({ kind: "clear" });
      expect(await shopCreditState(f)).toMatchObject({ reservedQuantity: 0, committedQuantity: 0 });
      expect(await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: p.lotIds[0]! } }))
        .toMatchObject({ currentAmount: 1, reservedAmount: 0 });
      expect(await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: p.lotIds[1]! } }))
        .toMatchObject({ currentAmount: 1, reservedAmount: 0 });
      const newKey = `new-human-${randomUUID()}`;
      expect(await f.followUps.claimSequenceTwo({ recoveryId: f.recoveryId,
        initiator: "merchant_post_window", expectedRevision: 1,
        initiationKey: newKey, recipient: f.recipient, now: new Date(),
      })).toEqual({ kind: "claimed", attemptId: p.attemptId,
        billingSource: `recovery-outreach:${p.attemptId}` });
      expect(await f.db.recoveryOutreachAttempt.count({ where: {
        checkoutRecoveryId: f.recoveryId, sequence: 2,
      } })).toBe(1);
      expect(await p.purchase.reserve({ shopId: f.shopId, sourceKey: p.sourceKey }))
        .toMatchObject({ kind: "reserved", reservation: {
          sourceKey: p.sourceKey, purchasedCreditPurchaseId: p.lotIds[0]!,
        } });
      expect(await f.db.usageReservation.count({ where: { sourceKey: p.sourceKey } })).toBe(1);
      expect((await shopCreditState(f)).reservedQuantity).toBe(1);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId,
        metric: "RECOVERY_CONVERSATION" } })).toBe(0);
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("holds the original claim across a failed release, then repairs a cancelled command without a second send", async () => {
    const f = await humanDispatchFixture("purchased-cancel-repair");
    try {
      const p = await claimedPurchased(f, 1);
      const unreachable = f.cancellationService(async () => { throw new Error("source owner unavailable"); });
      expect(await unreachable.cancelClaimed(p.commandId, p.leaseToken,
        "human_content_moderation_blocked")).toBe("held");
      expect(await f.commandState(p.commandId)).toEqual(expect.objectContaining({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect((await shopCreditState(f)).reservedQuantity).toBe(1);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: p.attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      const competing = await f.followUps.claimSequenceTwo({ recoveryId: f.recoveryId,
        initiator: "merchant_post_window", expectedRevision: 1,
        initiationKey: `other-${randomUUID()}`, recipient: f.recipient, now: new Date(),
      });
      expect(competing).toEqual({ kind: "suppressed", reason: "already-claimed" });
      // The existing bounded repair scans due CANCELLED commands, not leased work.
      await f.db.merchantConversationSendCommand.update({ where: { id: p.commandId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      const repair = cancellation(f, p.purchase);
      expect(await repair.repairCancelledClaims()).toBe(1);
      expect(await repair.repairCancelledClaims()).toBe(0);
      expect((await shopCreditState(f)).reservedQuantity).toBe(0);
      expect((await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: p.lotIds[0]! } }))
        .reservedAmount).toBe(0);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: p.attemptId } }))
        .initiationKey).toBeNull();
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("repairs a crash after the original lot was durably released but before claim reset", async () => {
    const f = await humanDispatchFixture("purchased-release-then-crash");
    try {
      const p = await claimedPurchased(f, 1);
      const crashed = f.cancellationService(async (credit) => {
        const released = await p.purchase.release(credit);
        expect(released.kind).toBe("released");
        throw new Error("simulated worker crash before verifying claim reset");
      });
      expect(await crashed.cancelClaimed(p.commandId, p.leaseToken,
        "human_content_moderation_blocked")).toBe("held");
      expect((await shopCreditState(f)).reservedQuantity).toBe(0);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: p.attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      await f.db.merchantConversationSendCommand.update({ where: { id: p.commandId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      const repairWithoutRelease = f.cancellationService(async () => {
        throw new Error("An already-released purchased lot must not be released twice");
      });
      expect(await repairWithoutRelease.repairCancelledClaims()).toBe(1);
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: p.attemptId } }))
        .initiationKey).toBeNull();
      expect((await shopCreditState(f)).reservedQuantity).toBe(0);
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("fails closed on a real cross-shop purchased counter without releasing another shop's inventory", async () => {
    const f = await humanDispatchFixture("purchased-counter-cross-shop");
    const otherShopId = randomUUID();
    try {
      const p = await claimedPurchased(f, 1);
      await f.db.shop.create({ data: { id: otherShopId,
        domain: `${otherShopId}.example.test`, status: "ACTIVE" } });
      const originalLot = await f.db.recoveryCreditPurchase.findUniqueOrThrow({
        where: { id: p.lotIds[0]! },
      });
      const foreignPurchaseId = randomUUID();
      await f.db.recoveryCreditPurchase.create({ data: {
        id: foreignPurchaseId, shopId: otherShopId, planId: originalLot.planId,
        provider: "WOOCOMMERCE", providerReference: `wc-other-${foreignPurchaseId}`,
        providerPurchaseAmount: new Prisma.Decimal("1.00"), providerPurchaseCurrency: "GBP",
        providerValuationConfirmedAt: new Date("2026-10-20T00:00:00Z"),
        providerPriceSnapshot: { amount: "1.00", currency: "GBP" },
        creditsGranted: 1, currentAmount: 1, status: "ACTIVE",
        activatedAt: new Date("2026-10-20T00:00:00Z"),
      } });
      await f.db.usageReservation.update({ where: { sourceKey: p.sourceKey },
        data: { purchasedCreditPurchaseId: foreignPurchaseId } });
      expect(await f.db.$transaction((tx) => inspectFollowUpCredit(tx, {
        shopId: f.shopId, attemptId: p.attemptId,
      }))).toEqual({ kind: "unsafe" });
      // Restore the original lot and independently test the aggregate's Shop.
      await f.db.usageReservation.update({ where: { sourceKey: p.sourceKey },
        data: { purchasedCreditPurchaseId: p.lotIds[0]! } });
      const foreign = await f.db.shopEntitlementCounter.create({ data: {
        shopId: otherShopId, counter: "PURCHASED_RECOVERY_CREDITS", grantedQuantity: 1,
      } });
      await f.db.usageReservation.update({ where: { sourceKey: p.sourceKey },
        data: { counterId: foreign.id } });
      expect(await f.db.$transaction((tx) => inspectFollowUpCredit(tx, {
        shopId: f.shopId, attemptId: p.attemptId,
      }))).toEqual({ kind: "unsafe" });
      expect(await cancellation(f, p.purchase).cancelClaimed(p.commandId, p.leaseToken,
        "human_content_moderation_blocked")).toBe("held");
      expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: p.attemptId } }))
        .initiationKey).toBe(`merchant-${f.recoveryId}`);
      expect((await shopCreditState(f)).reservedQuantity).toBe(1);
      expect((await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: p.lotIds[0]! } }))
        .reservedAmount).toBe(1);
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally {
      // Restore FK before teardown: the deliberately malformed row belongs only
      // to this disposable database and must not leak into other scenarios.
      await f.db.shop.delete({ where: { id: otherShopId } }).catch(() => undefined);
      await f.close();
    }
  }, 60_000);

  it("serializes the final provider permit against cancellation: never release an admitted lot", async () => {
    const f = await humanDispatchFixture("purchased-permit-race");
    try {
      const p = await claimedPurchased(f, 1);
      const finalPermit = new OutboundSendFenceService(f.db, async () => null);
      const [permit, cancelled] = await Promise.all([
        finalPermit.admitFinalSend({ senderType: "HUMAN", shopId: f.shopId,
          conversationId: f.conversationId, recoveryId: f.recoveryId,
          expectedControlRevision: 1, commandId: p.commandId,
          leaseToken: p.leaseToken, recipient: f.recipient, now: new Date(),
        }),
        cancellation(f, p.purchase).cancelClaimed(p.commandId, p.leaseToken,
          "human_content_moderation_blocked"),
      ]);
      if (permit.kind === "admitted") {
        expect(cancelled).toBe("stale");
        expect(await f.db.usageReservation.findUniqueOrThrow({ where: { sourceKey: p.sourceKey } }))
          .toMatchObject({ status: "RESERVED", purchasedCreditPurchaseId: p.lotIds[0]! });
        expect((await shopCreditState(f)).reservedQuantity).toBe(1);
        expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: p.attemptId } }))
          .initiationKey).toBe(`merchant-${f.recoveryId}`);
      } else {
        expect(cancelled).toBe("released");
        expect((await shopCreditState(f)).reservedQuantity).toBe(0);
        expect((await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: p.attemptId } }))
          .initiationKey).toBeNull();
      }
      expect(await f.db.recoveryOutreachAttempt.count({ where: {
        checkoutRecoveryId: f.recoveryId, sequence: 2,
      } })).toBe(1);
      expect(f.providerHttpRequests).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);
});
