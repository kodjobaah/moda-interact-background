import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ScheduledFollowUpRetryFundingService } from "../../src/services/recovery-delivery-retry/follow-up-funding.js";
import { ScheduledFollowUpRetryReconciliationService } from "../../src/services/recovery-delivery-retry/follow-up-reconciliation.js";
import {
  followUpRetryDispatchKey,
  checkScheduledFollowUpRetryPermit,
} from "../../src/services/recovery-delivery-retry/follow-up-permit.js";
import { lockRecoveryContext } from "../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { RecoveryDeliveryCompensationService } from "../../src/services/recovery-delivery-compensation/reconcile.service.js";
import {
  prepareCompensatedFollowUp,
  registerHistoricalSender,
} from "./fixtures/follow-up-retry.fixture.js";
import { withOneRecoveryTransactionFault } from "./fixtures/recovery-transaction-fault.fixture.js";

const suite =
  process.env.TEST_DATABASE_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

async function fundedFixture(source: "free" | "purchased") {
  const fixture = await prepareCompensatedFollowUp(source);
  try {
    const { f, conversation, intent } = fixture;
    const due = new Date(
      Math.max(Date.now(), intent.notBeforeAt!.getTime() + 1),
    );
    const scope = {
      shopId: f.shopId,
      recoveryId: f.recoveryId,
      conversationId: conversation.id,
      intentId: intent.id,
    };
    await f.db.shopSettings.create({
      data: {
        shopId: f.shopId,
        followUpEnabled: true,
        followUpDelayMinutes: 30,
      },
    });
    await registerHistoricalSender(fixture);
    const funding = await new ScheduledFollowUpRetryFundingService(
      f.db,
      () => due,
    ).claimAndFund(scope);
    if (funding.kind !== "funded")
      throw new Error(`Expected funded fixture, received ${funding.kind}`);
    const originalReservation = await f.db.usageReservation.findUniqueOrThrow({
      where: { id: fixture.reservation.id },
    });
    const originalBlock =
      await f.db.conversationAllowanceBlock.findUniqueOrThrow({
        where: { id: fixture.block.id },
      });
    const reconciler = new ScheduledFollowUpRetryReconciliationService(
      f.db,
      () => due,
    );
    const reservation = () =>
      f.db.usageReservation.findUniqueOrThrow({
        where: { id: funding.reservationId },
      });
    const block = () =>
      f.db.conversationAllowanceBlock.findUniqueOrThrow({
        where: { id: funding.blockId },
      });
    const attempt = () =>
      f.db.recoveryOutreachAttempt.findUniqueOrThrow({
        where: { id: funding.attemptId },
      });
    const assertHistory = async () => {
      expect(
        await f.db.usageReservation.findUniqueOrThrow({
          where: { id: fixture.reservation.id },
        }),
      ).toEqual(originalReservation);
      expect(
        await f.db.conversationAllowanceBlock.findUniqueOrThrow({
          where: { id: fixture.block.id },
        }),
      ).toEqual(originalBlock);
    };
    const prepare = async () => {
      const content = "Prepared follow-up retry";
      const message = await f.db.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTBOUND",
          senderType: "AUTOMATION",
          status: "PENDING",
          allowanceBlockId: funding.blockId,
          content,
        },
      });
      const usage = await f.db.usageEvent.create({
        data: {
          shopId: f.shopId,
          metric: "OUTBOUND_AUTOMATED_MESSAGE",
          quantity: 1,
          provider: f.provider,
          idempotencyKey: `recovery-outreach:${funding.attemptId}`,
          sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
          sourceId: message.id,
        },
      });
      return {
        message,
        usage,
        permit: async () =>
          f.db.$transaction(async (tx) => {
            const owner = await lockRecoveryContext(tx, conversation.id);
            if (!owner) throw new Error("Missing fixture owner");
            const check = await checkScheduledFollowUpRetryPermit(tx, owner, {
              ...scope,
              attemptId: funding.attemptId,
              messageId: message.id,
              recipient: "15551234567",
              expectedContent: content,
              sourceKey: funding.admission.sourceKey,
              now: due,
            });
            if (check.kind !== "ready")
              throw new Error(`Fixture permit held: ${check.reason}`);
            return tx.conversationMessage.update({
              where: { id: message.id },
              data: {
                providerDispatchKey: followUpRetryDispatchKey(
                  funding.attemptId,
                ),
                providerDispatchAdmittedAt: due,
                providerDispatchControlRevision: owner.revision,
                dispatchProviderAccountId: check.sender.providerAccountId,
                dispatchProviderPhoneNumberId:
                  check.sender.providerPhoneNumberId,
              },
            });
          }),
      };
    };
    return {
      ...fixture,
      due,
      funding,
      reconciler,
      reservation,
      block,
      attempt,
      assertHistory,
      prepare,
    };
  } catch (error) {
    await fixture.f.close();
    throw error;
  }
}

suite(
  "Follow-up retry reconciliation (real PostgreSQL, seeded receipt evidence)",
  () => {
    it.each(["free", "purchased"] as const)(
      "holds a permit through expiry then settles the exact accepted %s-platform retry once",
      async (source) => {
        const t = await fundedFixture(source);
        try {
          expect(await t.reconciler.reconcile(t.funding.blockId)).toEqual({
            kind: "ready",
            reason: "unprepared",
          });
          const prepared = await t.prepare();
          expect(await t.reconciler.reconcile(t.funding.blockId)).toEqual({
            kind: "ready",
            reason: "prepared",
          });
          await prepared.permit();
          const expired = new Date(
            (await t.block()).repairDeadlineAt!.getTime() + 1,
          );
          const restarted = new ScheduledFollowUpRetryReconciliationService(
            t.f.db,
            () => expired,
          );
          expect(await restarted.reconcile(t.funding.blockId)).toEqual({
            kind: "held",
            reason: "opening-unknown",
          });
          expect(await t.reservation()).toMatchObject({
            status: "RESERVED",
            committedUsageEventId: null,
          });
          expect(await t.block()).toMatchObject({ state: "PENDING" });
          const providerMessageId = `wamid-${randomUUID()}`;
          await t.f.db.conversationMessage.update({
            where: { id: prepared.message.id },
            data: { status: "SENT", providerMessageId, sentAt: t.due },
          });
          const fault = withOneRecoveryTransactionFault(t.f.db, "lost-ack");
          const replay = new ScheduledFollowUpRetryReconciliationService(
            fault.database,
            () => expired,
          );
          expect(await replay.reconcile(t.funding.blockId)).toEqual({
            kind: "unchanged",
            reason: "block-active",
          });
          expect(fault.injected()).toBe(true);
          const settled = await t.reservation();
          expect(settled).toMatchObject({
            status: "COMMITTED",
            compensationUsageEventId: null,
          });
          expect(settled.committedUsageEventId).toBeTruthy();
          expect(await t.block()).toMatchObject({
            state: "ACTIVE",
            repairAt: null,
            creditReservationId: t.funding.reservationId,
          });
          expect(await t.attempt()).toMatchObject({
            status: "WAITING_FOR_RESPONSE",
            outboundMessageId: prepared.message.id,
            sentAt: t.due,
            followUpDueAt: null,
          });
          expect(await restarted.reconcile(t.funding.blockId)).toEqual({
            kind: "unchanged",
            reason: "block-active",
          });
          expect(await t.reservation()).toEqual(settled);
          // The existing provider-status compensation owner must be able to
          // correct this exact new commitment without touching the prior block.
          await t.f.db.conversationMessage.update({
            where: { id: prepared.message.id },
            data: {
              status: "FAILED",
              failedAt: expired,
              providerFailureCode: "131016",
            },
          });
          expect(
            await new RecoveryDeliveryCompensationService(t.f.db).reconcile(
              providerMessageId,
            ),
          ).toBe("restored-spendable");
          expect(await t.block()).toMatchObject({ state: "CANCELLED" });
          expect(await t.reservation()).toMatchObject({
            status: "COMMITTED",
            compensationReason: "WHATSAPP_DELIVERY_FAILED",
          });
          expect(
            await t.f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({
              where: { failedAttemptId: t.funding.attemptId },
            }),
          ).toMatchObject({
            fundingReservationId: t.funding.reservationId,
            failedMessageId: prepared.message.id,
          });
          await t.assertHistory();
        } finally {
          await t.f.close();
        }
      },
      60_000,
    );

    it.each(["free", "purchased"] as const)(
      "cancels obsolete prepared %s-platform work without a permit and never recreates funding",
      async (source) => {
        const t = await fundedFixture(source);
        try {
          const prepared = await t.prepare();
          await t.f.db.recoveryOutreachRetryIntent.update({
            where: { id: t.intent.id },
            data: { cancelledAt: t.due },
          });
          expect(await t.reconciler.reconcile(t.funding.blockId)).toMatchObject(
            { kind: "cancelled", reservationId: t.funding.reservationId },
          );
          expect(await t.block()).toMatchObject({
            state: "CANCELLED",
            repairAt: null,
          });
          expect(await t.reservation()).toMatchObject({
            status: "RELEASED",
            committedUsageEventId: null,
          });
          expect(await t.attempt()).toMatchObject({
            status: "FAILED",
            failureCode: "PRE_PROVIDER_REFUSED",
            outboundMessageId: prepared.message.id,
          });
          expect(
            await t.f.db.usageEvent.findUnique({
              where: { id: prepared.usage.id },
            }),
          ).toBeNull();
          expect(await t.reconciler.reconcile(t.funding.blockId)).toEqual({
            kind: "unchanged",
            reason: "block-cancelled",
          });
          await t.assertHistory();
        } finally {
          await t.f.close();
        }
      },
      60_000,
    );

    it("reconciles definitive negative receipt before local acceptance settlement", async () => {
      const t = await fundedFixture("free");
      try {
        const prepared = await t.prepare();
        await prepared.permit();
        await t.f.db.conversationMessage.update({
          where: { id: prepared.message.id },
          data: {
            status: "FAILED",
            providerMessageId: `wamid-${randomUUID()}`,
            sentAt: t.due,
            failedAt: new Date(t.due.getTime() + 1000),
            providerFailureCode: "131016",
          },
        });
        expect(await t.reconciler.reconcile(t.funding.blockId)).toMatchObject({
          kind: "compensated",
          disposition: "released",
        });
        expect(await t.block()).toMatchObject({
          state: "CANCELLED",
          repairAt: null,
        });
        expect(await t.reservation()).toMatchObject({
          status: "RELEASED",
          committedUsageEventId: null,
        });
        expect(
          await t.f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({
            where: { failedAttemptId: t.funding.attemptId },
          }),
        ).toMatchObject({
          fundingReservationId: t.funding.reservationId,
          failedMessageId: prepared.message.id,
        });
        await t.assertHistory();
      } finally {
        await t.f.close();
      }
    }, 60_000);
  },
);
