import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it } from "vitest";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { MerchantSendCommandService } from "../../src/services/recovery-conversation/merchant-send-command.service.js";
import { RecoveryDeliveryCompensationService } from "../../src/services/recovery-delivery-compensation/reconcile.service.js";
import { OutboundAdmissionReservationService } from "../../src/services/outbound-whatsapp-admission/outbound-admission-reservation.service.js";
import { RecoveryAllowanceService } from "../../src/services/recovery-allowance/renewal.service.js";
import {
  cancelReopenedContinuation,
  allowanceSourceKey,
  allowanceUsage,
  currentAllowance,
  notifyAllowanceBoundary,
} from "../../src/services/recovery-allowance/storage.js";
import { freeRecoveryReservationService } from "../../src/services/free-recovery-reservation.service.js";
import type { RecoveryBillingService } from "../../src/services/recovery-billing.service.js";

const suite =
  process.env.TEST_DATABASE_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;
const limits = { outboundHardLimit: 4, terminalMessageReservedSlots: 1 };
async function fixture(snapshot = limits, ageMs = 0) {
  const db = new PrismaClient({
    datasourceUrl: process.env.TEST_DATABASE_URL!,
  });
  const shopId = `arch076-${randomUUID()}`,
    recoveryId = randomUUID(),
    conversationId = randomUUID(),
    attemptId = randomUUID();
  const now = new Date(Date.now() - ageMs),
    sentAt = new Date(now.getTime() - 60_000);
  await db.shop.create({
    data: { id: shopId, domain: `${shopId}.example.test`, status: "ACTIVE" },
  });
  const plan = await db.billingPlan.create({
    data: {
      shopifyPlanHandle: shopId,
      name: "Allowance fixture",
      kind: "FREE",
    },
  });
  await db.subscription.create({
    data: {
      shopId,
      planId: plan.id,
      status: "ACTIVE",
      observedShopifyPlanHandle: plan.shopifyPlanHandle,
    },
  });
  await db.platformBillingPolicy.upsert({
    where: { id: "default" },
    update: {},
    create: {
      absoluteOutboundHardLimit: 20,
      defaultWarningPercent: 80,
      defaultOutboundSoftLimit: 10,
      defaultOutboundHardLimit: 20,
      terminalMessageReservedSlots: 1,
    },
  });
  await db.checkoutRecovery.create({
    data: {
      id: recoveryId,
      shopId,
      checkoutToken: randomUUID(),
      lastExternalActivityAt: now,
      status: "MESSAGE_SENT",
    },
  });
  await db.conversation.create({
    data: {
      id: conversationId,
      type: "RECOVERY",
      checkoutRecoveryId: recoveryId,
      lastInboundAt: now,
      inboundVersion: 1,
      pendingTurnStartedAt: now,
    },
  });
  const initial = await db.conversationMessage.create({
    data: {
      conversationId,
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      content: "original",
      status: "SENT",
      providerMessageId: `wamid-${randomUUID()}`,
      sentAt,
      createdAt: sentAt,
    },
  });
  await db.recoveryOutreachAttempt.create({
    data: {
      id: attemptId,
      checkoutRecoveryId: recoveryId,
      sequence: 1,
      trigger: "INITIAL",
      configuredOfferMode: "NONE",
      status: "ENGAGED",
      recipient: "12025550123",
      outboundMessageId: initial.id,
      sentAt,
      ...(ageMs ? { followUpDueAt: new Date(now.getTime() + 3_600_000) } : {}),
    },
  });
  await db.conversationMessage.create({
    data: {
      conversationId,
      direction: "INBOUND",
      senderType: "CUSTOMER",
      content: "latest genuine question",
      status: "DELIVERED",
      providerMessageId: `in-${randomUUID()}`,
      createdAt: now,
    },
  });
  const counter = await db.shopEntitlementCounter.create({
    data: {
      shopId,
      counter: "LIFETIME_FREE_RECOVERY_CREDITS",
      grantedQuantity: 10,
      committedQuantity: 1,
    },
  });
  const sourceKey = createRecoveryIdempotencyKey(
    shopId,
    `recovery-outreach:${attemptId}`,
  );
  const reservation = await db.usageReservation.create({
    data: {
      shopId,
      counterId: counter.id,
      sourceKey,
      quantity: 1,
      status: "COMMITTED",
    },
  });
  const usage = await db.usageEvent.create({
    data: {
      shopId,
      metric: "RECOVERY_CONVERSATION",
      quantity: 1,
      sourceType: "FREE_RECOVERY_RESERVATION",
      sourceId: reservation.id,
      idempotencyKey: createRecoveryIdempotencyKey(shopId, sourceKey),
    },
  });
  await db.usageReservation.update({
    where: { id: reservation.id },
    data: { committedUsageEventId: usage.id },
  });
  await db.usageEvent.create({
    data: {
      shopId,
      metric: "OUTBOUND_AUTOMATED_MESSAGE",
      quantity: 1,
      sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
      sourceId: initial.id,
      idempotencyKey: `recovery-outreach:${attemptId}`,
    },
  });
  for (
    let i = 1;
    i < snapshot.outboundHardLimit - snapshot.terminalMessageReservedSlots;
    i++
  ) {
    const message = await db.conversationMessage.create({
      data: {
        conversationId,
        direction: "OUTBOUND",
        senderType: "AGENT",
        content: "earlier answer",
        status: "SENT",
        sentAt,
        providerMessageId: `history-${randomUUID()}`,
      },
    });
    await db.usageEvent.create({
      data: {
        shopId,
        metric: "OUTBOUND_AUTOMATED_MESSAGE",
        quantity: 1,
        sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
        sourceId: message.id,
        idempotencyKey: message.id,
      },
    });
  }
  const block = await db.$transaction((tx) =>
    currentAllowance(tx, conversationId, snapshot),
  );
  const input = {
    shopId,
    conversationId,
    expectedControlRevision: 0,
    expectedInboundVersion: 1,
  };
  let denied = false,
    admissions = 0;
  const billing = {
    admit: async ({ fundingSourceId }: { fundingSourceId?: string }) => {
      admissions++;
      if (denied) return { kind: "blocked", reason: "capacity-exhausted" };
      const key = createRecoveryIdempotencyKey(shopId, fundingSourceId!);
      await freeRecoveryReservationService.reserve({
        shopId,
        sourceKey: key,
        quantity: 1,
      });
      return {
        kind: "admitted",
        admission: { kind: "free", shopId, sourceKey: key, quantity: 1 },
      };
    },
    revalidateBeforeProvider: async ({
      admission,
    }: {
      admission: unknown;
    }) => ({ kind: "admitted", admission }),
    releaseBeforeProvider: async () => {},
  } as unknown as Pick<
    RecoveryBillingService,
    "admit" | "revalidateBeforeProvider" | "releaseBeforeProvider"
  >;
  return {
    db,
    shopId,
    conversationId,
    recoveryId,
    block,
    input,
    counter,
    billing,
    setDenied(value: boolean) {
      denied = value;
    },
    get admissions() {
      return admissions;
    },
    service: () => new RecoveryAllowanceService(db, billing, () => new Date()),
    async close() {
      await db.$disconnect();
    },
  };
}

suite("ARCH-076 funded allowance blocks", () => {
  it("adopts exact original funding without rewriting history; notice is durable and idempotent", async () => {
    const f = await fixture();
    try {
      await Promise.all(
        [1, 2, 3].map(() =>
          f.db.$transaction(async (tx) => {
            await currentAllowance(tx, f.conversationId, limits);
            await notifyAllowanceBoundary(tx, f.block, new Date());
          }),
        ),
      );
      expect(
        await f.db.merchantSupportMessage.count({
          where: {
            sourceKey: `recovery-allowance:${f.conversationId}:0:exhausted`,
          },
        }),
      ).toBe(1);
      expect(
        await f.db.conversationMessage.count({
          where: {
            conversationId: f.conversationId,
            allowanceBlockId: { not: null },
          },
        }),
      ).toBe(0);
      expect(await f.db.$transaction((tx) => allowanceUsage(tx, f.block))).toBe(
        3,
      );
      expect(
        await f.db.usageReservation.count({ where: { shopId: f.shopId } }),
      ).toBe(1);
    } finally {
      await f.close();
    }
  }, 60_000);
  it("concurrent genuine continuations reserve one credit; confirmed opener activates and closes predecessor", async () => {
    const f = await fixture();
    try {
      await f.db.$transaction((tx) =>
        notifyAllowanceBoundary(tx, f.block, new Date()),
      );
      await Promise.all([
        f.service().fundContinuation(f.input, limits),
        f.service().fundContinuation(f.input, limits),
      ]);
      const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      expect(
        await f.db.usageReservation.count({
          where: { sourceKey: allowanceSourceKey(f.shopId, pending.id) },
        }),
      ).toBe(1);
      expect(f.admissions).toBe(1);
      await f.service().reconcileConversation(f.conversationId);
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: pending.id },
          })
        ).state,
      ).toBe("PENDING"); // Other historical receipts are not this opening.

      const opening = await f.db.conversationMessage.create({
        data: {
          conversationId: f.conversationId,
          allowanceBlockId: pending.id,
          direction: "OUTBOUND",
          senderType: "AGENT",
          content: "answer",
          status: "SENT",
          providerMessageId: `out-${randomUUID()}`,
          sentAt: new Date(),
          providerDispatchKey: randomUUID(),
          providerDispatchAdmittedAt: new Date(),
          providerDispatchControlRevision: 0,
        },
      });
      await f.db.usageEvent.create({
        data: {
          shopId: f.shopId,
          metric: "OUTBOUND_AUTOMATED_MESSAGE",
          quantity: 1,
          sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
          sourceId: opening.id,
          idempotencyKey: opening.id,
        },
      });
      await f.service().reconcileConversation(f.conversationId);
      await f.service().reconcileConversation(f.conversationId);
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: pending.id },
          })
        ).state,
      ).toBe("ACTIVE");
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: f.block.id },
          })
        ).state,
      ).toBe("EXHAUSTED");
      expect(
        await f.db.conversation.count({
          where: { checkoutRecoveryId: f.recoveryId },
        }),
      ).toBe(1);
    } finally {
      await f.close();
    }
  }, 60_000);
  it("no-credit intent survives restart and resumes without a new conversation", async () => {
    const f = await fixture();
    try {
      await f.db.$transaction((tx) =>
        notifyAllowanceBoundary(tx, f.block, new Date()),
      );
      f.setDenied(true);
      expect(await f.service().fundContinuation(f.input, limits)).toBe(false);
      const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      expect(pending.creditReservationId).toBeNull();
      f.setDenied(false);
      await f.db.conversationAllowanceBlock.update({
        where: { id: pending.id },
        data: { repairAt: new Date(0) },
      });
      await f.service().repairPass();
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: pending.id },
          })
        ).creditReservationId,
      ).not.toBeNull();
      expect(
        await f.db.conversationMessage.count({
          where: { allowanceBlockId: pending.id },
        }),
      ).toBe(0);
    } finally {
      await f.close();
    }
  }, 60_000);
  it("recovers a reservation created before the FK bind and cancels only definitive pre-permit work", async () => {
    const f = await fixture();
    try {
      await f.db.$transaction((tx) =>
        notifyAllowanceBoundary(tx, f.block, new Date()),
      );
      f.setDenied(true);
      await f.service().fundContinuation(f.input, limits);
      const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      await freeRecoveryReservationService.reserve({
        shopId: f.shopId,
        sourceKey: allowanceSourceKey(f.shopId, pending.id),
        quantity: 1,
      });
      await f.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "whatsapp"."Conversation" SET "controlMode"='HUMAN',"controlRevision"=1,"controlChangedAt"=statement_timestamp() WHERE "id"=$1`,
          f.conversationId,
        );
        await tx.conversationControlEvent.create({
          data: {
            conversationId: f.conversationId,
            fromMode: "AI",
            toMode: "HUMAN",
            fromRevision: 0,
            toRevision: 1,
          },
        });
      });
      await f.service().reconcileConversation(f.conversationId);
      const cancelled = await f.db.conversationAllowanceBlock.findUniqueOrThrow(
        { where: { id: pending.id } },
      );
      expect(cancelled.state).toBe("CANCELLED");
      expect(cancelled.creditReservationId).not.toBeNull();
      expect(
        (
          await f.db.usageReservation.findUniqueOrThrow({
            where: { id: cancelled.creditReservationId! },
          })
        ).status,
      ).toBe("RELEASED");
    } finally {
      await f.close();
    }
  }, 60_000);
  it("provider-unknown expiry never refunds or sends another opener", async () => {
    const f = await fixture();
    try {
      await f.db.$transaction((tx) =>
        notifyAllowanceBoundary(tx, f.block, new Date()),
      );
      await f.service().fundContinuation(f.input, limits);
      const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      await f.db.conversationMessage.create({
        data: {
          conversationId: f.conversationId,
          allowanceBlockId: pending.id,
          direction: "OUTBOUND",
          senderType: "AGENT",
          content: "uncertain",
          status: "PENDING",
          providerDispatchKey: randomUUID(),
          providerDispatchAdmittedAt: new Date(),
          providerDispatchControlRevision: 0,
        },
      });
      const future = new Date(pending.repairDeadlineAt!.getTime() + 1);
      const service = new RecoveryAllowanceService(
        f.db,
        f.billing,
        () => future,
      );
      await service.reconcileConversation(f.conversationId);
      const held = await f.db.conversationAllowanceBlock.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(held.state).toBe("PENDING");
      expect(held.repairAt).toBeNull();
      expect(
        (
          await f.db.usageReservation.findUniqueOrThrow({
            where: { id: held.creditReservationId! },
          })
        ).status,
      ).toBe("RESERVED");
      expect(
        await f.db.conversationMessage.count({
          where: { allowanceBlockId: held.id },
        }),
      ).toBe(1);
    } finally {
      await f.close();
    }
  }, 60_000);

  it.each([false, true])(
    "surviving cap is rechecked before permit; frozen permit=%s",
    async (admitted) => {
      const f = await fixture();
      try {
        await f.service().fundContinuation(f.input, limits);
        const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
          where: { conversationId: f.conversationId, state: "PENDING" },
        });
        const opening = await f.db.conversationMessage.create({
          data: {
            conversationId: f.conversationId,
            allowanceBlockId: pending.id,
            direction: "OUTBOUND",
            senderType: "AGENT",
            content: "prepared",
            status: "PENDING",
            ...(admitted
              ? {
                  providerDispatchKey: randomUUID(),
                  providerDispatchAdmittedAt: new Date(),
                  providerDispatchControlRevision: 0,
                }
              : {}),
          },
        });
        const identity = `agent:${f.conversationId}:1`;
        await f.db.usageEvent.create({
          data: {
            shopId: f.shopId,
            metric: "OUTBOUND_AUTOMATED_MESSAGE",
            quantity: 1,
            sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
            sourceId: opening.id,
            idempotencyKey: identity,
          },
        });
        const prior = await f.db.usageEvent.findFirstOrThrow({
          where: {
            shopId: f.shopId,
            metric: "OUTBOUND_AUTOMATED_MESSAGE",
            idempotencyKey: {
              notIn: [
                identity,
                `recovery-outreach:${(await f.db.recoveryOutreachAttempt.findFirstOrThrow({ where: { checkoutRecoveryId: f.recoveryId, sequence: 1 } })).id}`,
              ],
            },
          },
        });
        await f.db.usageEvent.delete({ where: { id: prior.id } });
        expect(
          await f.db.$transaction((tx) =>
            cancelReopenedContinuation(tx, pending.id, opening.id),
          ),
        ).toBe(!admitted);
        if (!admitted) {
          const retried = await new OutboundAdmissionReservationService(
            f.db,
          ).reserve({
            shopId: f.shopId,
            conversationId: f.conversationId,
            idempotencyKey: identity,
            senderType: "AGENT",
            continuation: {
              expectedControlRevision: 0,
              expectedInboundVersion: 1,
            },
          });
          expect(retried.kind).toBe("admitted");
          if (retried.kind !== "admitted")
            throw new Error("original question lost");
          expect(
            (
              await f.db.conversationMessage.findUniqueOrThrow({
                where: { id: retried.messageId },
              })
            ).allowanceBlockId,
          ).toBe(f.block.id);
          expect(
            (
              await f.db.usageReservation.findUniqueOrThrow({
                where: { id: pending.creditReservationId! },
              })
            ).status,
          ).toBe("RELEASED");
        } else {
          await f.db.conversationMessage.update({
            where: { id: opening.id },
            data: {
              status: "SENT",
              sentAt: new Date(),
              providerMessageId: `sent-${randomUUID()}`,
            },
          });
          await f.service().reconcileConversation(f.conversationId);
          expect(
            (
              await f.db.conversationAllowanceBlock.findUniqueOrThrow({
                where: { id: pending.id },
              })
            ).state,
          ).toBe("ACTIVE");
        }
      } finally {
        await f.close();
      }
    },
    60_000,
  );
  it("late opening failure retains cancelled lineage and funds retry at a new ordinal", async () => {
    const f = await fixture();
    try {
      await f.service().fundContinuation(f.input, limits);
      const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      const opening = await f.db.conversationMessage.create({
        data: {
          conversationId: f.conversationId,
          allowanceBlockId: pending.id,
          direction: "OUTBOUND",
          senderType: "AGENT",
          content: "answer",
          status: "SENT",
          sentAt: new Date(),
          providerMessageId: `sent-${randomUUID()}`,
          providerDispatchKey: randomUUID(),
          providerDispatchAdmittedAt: new Date(),
          providerDispatchControlRevision: 0,
        },
      });
      await f.db.usageEvent.create({
        data: {
          shopId: f.shopId,
          metric: "OUTBOUND_AUTOMATED_MESSAGE",
          quantity: 1,
          sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
          sourceId: opening.id,
          idempotencyKey: opening.id,
        },
      });
      await f.service().reconcileConversation(f.conversationId);
      await f.db.conversationMessage.update({
        where: { id: opening.id },
        data: {
          status: "FAILED",
          failedAt: new Date(),
          providerFailureCode: "131026",
        },
      });
      await new RecoveryDeliveryCompensationService(f.db).reconcileMessage(
        opening.id,
      );
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: pending.id },
          })
        ).state,
      ).toBe("CANCELLED");
      expect(await f.service().fundContinuation(f.input, limits)).toBe(true);
      const retry = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      expect(retry.ordinal).toBe(2);
      expect(retry.predecessorId).toBe(f.block.id);
      expect(retry.id).not.toBe(pending.id);
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: f.block.id },
          })
        ).state,
      ).toBe("EXHAUSTED");
    } finally {
      await f.close();
    }
  }, 60_000);

  it("zero normal slots never reserve a credit or create a renewal intent", async () => {
    const f = await fixture();
    try {
      expect(
        await f.service().fundContinuation(f.input, {
          outboundHardLimit: 3,
          terminalMessageReservedSlots: 3,
        }),
      ).toBe(false);
      expect(f.admissions).toBe(0);
      expect(
        await f.db.conversationAllowanceBlock.count({
          where: { conversationId: f.conversationId },
        }),
      ).toBe(1);
    } finally {
      await f.close();
    }
  }, 60_000);

  it("concurrent final ordinary slots admit only configured remaining capacity without renewal", async () => {
    const f = await fixture();
    try {
      const history = await f.db.usageEvent.findMany({
        where: {
          shopId: f.shopId,
          metric: "OUTBOUND_AUTOMATED_MESSAGE",
          idempotencyKey: { not: { startsWith: "recovery-outreach:" } },
        },
      });
      await f.db.usageEvent.deleteMany({
        where: { id: { in: history.map((row) => row.id) } },
      });
      const service = new OutboundAdmissionReservationService(f.db);
      const results = await Promise.all(
        [1, 2, 3].map((i) =>
          service.reserve({
            shopId: f.shopId,
            conversationId: f.conversationId,
            senderType: "AGENT",
            idempotencyKey: `last-slot-${f.conversationId}-${i}`,
          }),
        ),
      );
      expect(results.filter((row) => row.kind === "admitted")).toHaveLength(2);
      expect(results.filter((row) => row.kind === "suppressed")).toHaveLength(
        1,
      );
      expect(await f.db.$transaction((tx) => allowanceUsage(tx, f.block))).toBe(
        3,
      );
      expect(
        await f.db.usageReservation.count({ where: { shopId: f.shopId } }),
      ).toBe(1);
    } finally {
      await f.close();
    }
  }, 60_000);
  it("zero reserved slots and a one-message normal budget support a third funded block", async () => {
    const one = { outboundHardLimit: 1, terminalMessageReservedSlots: 0 };
    const f = await fixture(one);
    try {
      for (let ordinal = 1; ordinal <= 2; ordinal++) {
        if (ordinal > 1) {
          await f.db.conversation.update({
            where: { id: f.conversationId },
            data: {
              inboundVersion: ordinal,
              lastProcessedVersion: ordinal - 1,
            },
          });
          await f.db.conversationMessage.create({
            data: {
              conversationId: f.conversationId,
              direction: "INBOUND",
              senderType: "CUSTOMER",
              content: "next genuine question",
              status: "DELIVERED",
              providerMessageId: `in-${randomUUID()}`,
            },
          });
        }
        expect(
          await f
            .service()
            .fundContinuation(
              { ...f.input, expectedInboundVersion: ordinal },
              one,
            ),
        ).toBe(true);
        const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
          where: { conversationId: f.conversationId, state: "PENDING" },
        });
        const opening = await f.db.conversationMessage.create({
          data: {
            conversationId: f.conversationId,
            allowanceBlockId: pending.id,
            direction: "OUTBOUND",
            senderType: "AGENT",
            content: "answer",
            status: "SENT",
            sentAt: new Date(),
            providerMessageId: `sent-${randomUUID()}`,
            providerDispatchKey: randomUUID(),
            providerDispatchAdmittedAt: new Date(),
            providerDispatchControlRevision: 0,
          },
        });
        await f.db.usageEvent.create({
          data: {
            shopId: f.shopId,
            metric: "OUTBOUND_AUTOMATED_MESSAGE",
            quantity: 1,
            sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
            sourceId: opening.id,
            idempotencyKey: opening.id,
          },
        });
        await f.service().reconcileConversation(f.conversationId);
        expect(pending.ordinal).toBe(ordinal);
      }
      expect(
        await f.db.conversationAllowanceBlock.count({
          where: { conversationId: f.conversationId },
        }),
      ).toBe(3);
      expect(
        await f.db.conversation.count({
          where: { checkoutRecoveryId: f.recoveryId },
        }),
      ).toBe(1);
      expect(
        await f.db.usageEvent.count({
          where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION" },
        }),
      ).toBe(3);
    } finally {
      await f.close();
    }
  }, 60_000);

  it("genuine HUMAN sequence-two template consumes one opening slot; ordinary human control cannot renew", async () => {
    const f = await fixture(limits, 25 * 60 * 60_000);
    try {
      await f.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "whatsapp"."Conversation" SET "controlMode"='HUMAN',"controlRevision"=1,"controlChangedAt"=statement_timestamp() WHERE "id"=$1`,
          f.conversationId,
        );
        await tx.conversationControlEvent.create({
          data: {
            conversationId: f.conversationId,
            fromMode: "AI",
            toMode: "HUMAN",
            fromRevision: 0,
            toRevision: 1,
          },
        });
      });
      const claimKey = randomUUID();
      const attempt = await f.db.recoveryOutreachAttempt.create({
        data: {
          checkoutRecoveryId: f.recoveryId,
          sequence: 2,
          trigger: "POST_WINDOW_FOLLOW_UP",
          configuredOfferMode: "NONE",
          status: "PENDING",
          recipient: "12025550123",
          initiatedBy: "HUMAN",
          initiationKey: claimKey,
          claimedAt: new Date(),
        },
      });
      const intent = await f.service().beginFollowUp({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        attemptId: attempt.id,
        limits,
      });
      const sourceKey = createRecoveryIdempotencyKey(
        f.shopId,
        `recovery-outreach:${attempt.id}`,
      );
      await freeRecoveryReservationService.reserve({
        shopId: f.shopId,
        sourceKey,
        quantity: 1,
      });
      await f.service().attachFollowUp(intent, sourceKey);
      const command = await f.db.merchantConversationSendCommand.create({
        data: {
          shopId: f.shopId,
          conversationId: f.conversationId,
          kind: "RECOVERY_FOLLOW_UP_TEMPLATE",
          recipientSnapshot: "12025550123",
          idempotencyKey: randomUUID(),
          payloadSha256: "0".repeat(64),
          expectedControlRevision: 1,
          followUpClaimKey: claimKey,
          recoveryOutreachAttemptId: attempt.id,
          templateName: "recovery_follow_up",
          templateLanguageCode: "en",
        },
      });
      const claimed = (
        await new MerchantSendCommandService(f.db).claimDueHumanCommands({
          limit: 1,
          now: new Date(),
        })
      )[0]!;
      expect(claimed.id).toBe(command.id);
      const fence = new OutboundSendFenceService(
        f.db,
        async () => null,
        () => new Date(),
        async () => null,
      );
      const input = {
        senderType: "HUMAN" as const,
        shopId: f.shopId,
        conversationId: f.conversationId,
        recoveryId: f.recoveryId,
        expectedControlRevision: 1,
        commandId: command.id,
        leaseToken: claimed.leaseToken,
        recipient: "12025550123",
        now: new Date(),
        deliveryKind: "TEMPLATE" as const,
        proactive: {
          consent: null,
          verifiedCategory: "MARKETING" as const,
          templateName: "recovery_follow_up",
          languageCode: "en",
          templateRegistration: {
            shopId: f.shopId,
            providerTemplateName: "recovery_follow_up",
            providerLanguageCode: "en",
            purpose: "FOLLOW_UP_NO_OFFER",
          } as never,
        },
      };
      const permit = await fence.admitFinalSend(input);
      expect(permit.kind).toBe("admitted");
      expect((await fence.admitFinalSend(input)).kind).toBe("suppressed");
      if (permit.kind !== "admitted") throw new Error(JSON.stringify(permit));
      const sent = await f.db.conversationMessage.findUniqueOrThrow({
        where: { id: permit.messageId },
      });
      expect(sent.senderType).toBe("HUMAN");
      expect(sent.allowanceBlockId).toBe(intent.id);
      expect(
        await f.db.usageEvent.count({
          where: { sourceId: sent.id, metric: "OUTBOUND_AUTOMATED_MESSAGE" },
        }),
      ).toBe(1);
      expect(
        await f.db.$transaction((tx) =>
          allowanceUsage(tx, { ...f.block, id: intent.id, ordinal: 1 }),
        ),
      ).toBe(1);
      await f.db.conversationMessage.update({
        where: { id: sent.id },
        data: {
          status: "SENT",
          providerMessageId: `human-${randomUUID()}`,
          sentAt: new Date(),
        },
      });
      await f.service().reconcileConversation(f.conversationId);
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: intent.id },
          })
        ).state,
      ).toBe("ACTIVE");
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: f.block.id },
          })
        ).state,
      ).toBe("CLOSED");
      expect(
        await f.db.usageReservation.count({ where: { shopId: f.shopId } }),
      ).toBe(2);

      expect(
        await f
          .service()
          .fundContinuation({ ...f.input, expectedControlRevision: 1 }, limits),
      ).toBe(false);
      expect(f.admissions).toBe(0);
    } finally {
      await f.close();
    }
  }, 60_000);

  it("definitive rejected opener cancels pending credit without exhausting predecessor", async () => {
    const f = await fixture();
    try {
      await f.service().fundContinuation(f.input, limits);
      const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      await f.db.conversationMessage.create({
        data: {
          conversationId: f.conversationId,
          allowanceBlockId: pending.id,
          direction: "OUTBOUND",
          senderType: "AGENT",
          content: "rejected",
          status: "FAILED",
          failedAt: new Date(),
          providerFailureCode: "2",
          providerDispatchKey: randomUUID(),
          providerDispatchAdmittedAt: new Date(),
          providerDispatchControlRevision: 0,
        },
      });
      await f.service().reconcileConversation(f.conversationId);
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: pending.id },
          })
        ).state,
      ).toBe("CANCELLED");
      expect(
        (
          await f.db.usageReservation.findUniqueOrThrow({
            where: { id: pending.creditReservationId! },
          })
        ).status,
      ).toBe("RELEASED");
      expect(
        (
          await f.db.conversationAllowanceBlock.findUniqueOrThrow({
            where: { id: f.block.id },
          })
        ).state,
      ).toBe("ACTIVE");
    } finally {
      await f.close();
    }
  }, 60_000);
  it("late failure after another provider permit preserves funding and exposes the incident", async () => {
    const f = await fixture();
    try {
      await f.service().fundContinuation(f.input, limits);
      const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      const opening = await f.db.conversationMessage.create({
        data: {
          conversationId: f.conversationId,
          allowanceBlockId: pending.id,
          direction: "OUTBOUND",
          senderType: "AGENT",
          content: "answer",
          status: "SENT",
          sentAt: new Date(),
          providerMessageId: `sent-${randomUUID()}`,
          providerDispatchKey: randomUUID(),
          providerDispatchAdmittedAt: new Date(),
          providerDispatchControlRevision: 0,
        },
      });
      await f.db.usageEvent.create({
        data: {
          shopId: f.shopId,
          metric: "OUTBOUND_AUTOMATED_MESSAGE",
          quantity: 1,
          sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
          sourceId: opening.id,
          idempotencyKey: opening.id,
        },
      });
      await f.service().reconcileConversation(f.conversationId);
      const later = await f.db.conversationMessage.create({
        data: {
          conversationId: f.conversationId,
          allowanceBlockId: pending.id,
          direction: "OUTBOUND",
          senderType: "AGENT",
          content: "later",
          status: "PENDING",
          providerDispatchKey: randomUUID(),
          providerDispatchAdmittedAt: new Date(),
          providerDispatchControlRevision: 0,
        },
      });
      await f.db.usageEvent.create({
        data: {
          shopId: f.shopId,
          metric: "OUTBOUND_AUTOMATED_MESSAGE",
          quantity: 1,
          sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
          sourceId: later.id,
          idempotencyKey: later.id,
        },
      });
      await f.db.conversationMessage.update({
        where: { id: opening.id },
        data: {
          status: "FAILED",
          failedAt: new Date(),
          providerFailureCode: "131026",
        },
      });
      await expect(
        new RecoveryDeliveryCompensationService(f.db).reconcileMessage(
          opening.id,
        ),
      ).rejects.toThrow("late allowance opening failure");
      const credit = await f.db.usageReservation.findUniqueOrThrow({
        where: { id: pending.creditReservationId! },
      });
      expect(credit.status).toBe("COMMITTED");
      expect(credit.compensationUsageEventId).toBeNull();
    } finally {
      await f.close();
    }
  }, 60_000);
  it.each(["STOP", "clarification", "window", "closed", "HUMAN"] as const)(
    "%s never consumes continuation funding",
    async (kind) => {
      const f = await fixture(limits, kind === "window" ? 25 * 60 * 60_000 : 0);
      try {
        if (kind === "STOP") {
          const customer = await f.db.customer.create({
            data: { shopId: f.shopId },
          });
          await f.db.customerPhone.create({
            data: {
              customerId: customer.id,
              phone: "+12025550123",
              whatsappCanonicalPhone: "12025550123",
              whatsappNoContact: true,
              whatsappNoContactReason: "CUSTOMER_STOP",
              whatsappNoContactAt: new Date(),
              whatsappNoContactRevision: 1,
            },
          });
        }
        if (kind === "closed")
          await f.db.checkoutRecovery.update({
            where: { id: f.recoveryId },
            data: { status: "EXPIRED" },
          });
        if (kind === "HUMAN")
          await f.db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `UPDATE "whatsapp"."Conversation" SET "controlMode"='HUMAN',"controlRevision"=1,"controlChangedAt"=statement_timestamp() WHERE "id"=$1`,
              f.conversationId,
            );
            await tx.conversationControlEvent.create({
              data: {
                conversationId: f.conversationId,
                fromMode: "AI",
                toMode: "HUMAN",
                fromRevision: 0,
                toRevision: 1,
              },
            });
          });
        if (kind === "clarification")
          expect(
            (
              await new OutboundAdmissionReservationService(f.db).reserve({
                shopId: f.shopId,
                conversationId: f.conversationId,
                idempotencyKey: randomUUID(),
                senderType: "AGENT",
                clarification: true,
                continuation: f.input,
              })
            ).kind,
          ).toBe("suppressed");
        else
          expect(await f.service().fundContinuation(f.input, limits)).toBe(
            false,
          );
        expect(f.admissions).toBe(0);
        expect(
          await f.db.usageReservation.count({ where: { shopId: f.shopId } }),
        ).toBe(1);
        expect(
          await f.db.conversationAllowanceBlock.count({
            where: { conversationId: f.conversationId },
          }),
        ).toBe(1);
      } finally {
        await f.close();
      }
    },
    60_000,
  );

  it("foreign historical receipt cannot release another block's funding or message usage", async () => {
    const f = await fixture();
    try {
      await f.service().fundContinuation(f.input, limits);
      const pending = await f.db.conversationAllowanceBlock.findFirstOrThrow({
        where: { conversationId: f.conversationId, state: "PENDING" },
      });
      const foreign = await f.db.conversationMessage.findFirstOrThrow({
        where: {
          conversationId: f.conversationId,
          direction: "OUTBOUND",
          allowanceBlockId: null,
        },
      });
      await expect(
        f.db.$transaction((tx) =>
          cancelReopenedContinuation(tx, pending.id, foreign.id),
        ),
      ).rejects.toThrow("reopened-opening-identity");
      expect(
        (
          await f.db.usageReservation.findUniqueOrThrow({
            where: { id: pending.creditReservationId! },
          })
        ).status,
      ).toBe("RESERVED");
      expect(await f.db.$transaction((tx) => allowanceUsage(tx, f.block))).toBe(
        3,
      );
    } finally {
      await f.close();
    }
  }, 60_000);
});
