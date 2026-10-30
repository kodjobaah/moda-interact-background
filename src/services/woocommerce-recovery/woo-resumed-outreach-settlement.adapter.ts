import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import prisma from "../../lib/db.js";
import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "../paid-included-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import type { WooInitialAttempt, WooOutreachRecovery } from "./woo-recovery-outreach.service.js";

type ReservationOwner = "lifetime-free" | "paid-included" | "purchased" | "promotional";
type ReservationStatus = "RESERVED" | "COMMITTED" | "RELEASED" | "AMBIGUOUS";

type PersistedAdmission = Readonly<{
  id: string;
  conversationId: string;
  status: string;
  sentAt: Date | null;
  providerFailureCode: string | null;
  providerDispatchKey: string | null;
  providerDispatchAdmittedAt: Date | null;
}>;

export type WooResumedAttemptSettlement =
  | { kind: "cancelled"; sourceKey?: string; owner?: ReservationOwner }
  | { kind: "provider-confirmed"; message: PersistedAdmission }
  | { kind: "provider-failed"; message: PersistedAdmission; sourceKey: string;
      reservationStatus: ReservationStatus | null }
  | { kind: "provider-uncertain" }
  | { kind: "ignored" }
  | { kind: "not-resumed" };

type SettlementDatabase = Pick<PrismaClient,
  "$transaction" | "$queryRaw" | "usageEvent" | "conversationMessage" | "usageReservation" | "recoveryOutreachAttempt">;

type ReservationRecord = Readonly<{
  id: string;
  shopId: string;
  sourceKey: string;
  quantity: number;
  status: ReservationStatus;
  counterId: string | null;
  billingPeriodEntitlementCounterId: string | null;
  purchasedCreditPurchaseId: string | null;
  promotionalCreditGrantId: string | null;
  counter: { counter: string } | null;
}>;

function providerDispatchKey(shopId: string, attemptId: string): string {
  return `arch046-woo-initial-${createHash("sha256").update(shopId).update("\0").update(attemptId).digest("hex")}`;
}

function reservationOwner(reservation: ReservationRecord, shopId: string, sourceKey: string): ReservationOwner {
  if (reservation.shopId !== shopId || reservation.sourceKey !== sourceKey || reservation.quantity !== 1)
    throw new Error("WOO_RESUMED_RESERVATION_IDENTITY_MISMATCH");
  const freeCounter = reservation.counterId !== null &&
    reservation.counter?.counter === "LIFETIME_FREE_RECOVERY_CREDITS";
  const owners = [
    freeCounter ? "lifetime-free" : null,
    reservation.billingPeriodEntitlementCounterId ? "paid-included" : null,
    reservation.purchasedCreditPurchaseId ? "purchased" : null,
    reservation.promotionalCreditGrantId ? "promotional" : null,
  ].filter((owner): owner is ReservationOwner => owner !== null);
  if (owners.length !== 1) throw new Error("WOO_RESUMED_RESERVATION_OWNER_UNRECOGNISED");
  const owner = owners[0]!;
  if (reservation.counterId !== null && !reservation.counter)
    throw new Error("WOO_RESUMED_RESERVATION_OWNER_UNRECOGNISED");
  // Purchased reservations also hold the aggregate PURCHASED_RECOVERY_CREDITS
  // counter. It is a supporting ledger relation, not a second owner bucket.
  if (owner === "purchased" && reservation.counterId !== null &&
    reservation.counter?.counter !== "PURCHASED_RECOVERY_CREDITS")
    throw new Error("WOO_RESUMED_RESERVATION_OWNER_UNRECOGNISED");
  if (reservation.counterId !== null && !freeCounter && owner !== "purchased")
    throw new Error("WOO_RESUMED_RESERVATION_OWNER_UNRECOGNISED");
  return owner;
}

const isConfirmed = (message: PersistedAdmission | undefined): message is PersistedAdmission & { sentAt: Date } =>
  !!message && ["SENT", "DELIVERED", "READ"].includes(message.status) && message.sentAt !== null;

/**
 * Woo-only resumption settlement. The recovery row is locked and must already
 * be durably CANCELLED with Woo CHECKOUT_RESUMED history before this adapter
 * can cancel an attempt or release its reservation.
 */
export class WooResumedOutreachSettlementAdapter {
  constructor(private readonly database: SettlementDatabase = prisma) {}

  async hasResumedHistory(recoveryId: string, shopId: string): Promise<boolean> {
    const rows = await this.database.$queryRaw<Array<{ id: string }>>`
      SELECT h."id"
      FROM "commerce"."CheckoutRecoveryStatusHistory" h
      JOIN "commerce"."CheckoutRecovery" r ON r."id"=h."checkoutRecoveryId"
      JOIN "commerce"."Shop" s ON s."id"=r."shopId"
      WHERE h."checkoutRecoveryId"=${recoveryId} AND r."shopId"=${shopId}
        AND r."status"='CANCELLED' AND s."platform"='WOOCOMMERCE'
        AND h."toStatus"='CANCELLED' AND h."reason"='CHECKOUT_RESUMED'
        AND h."source"='woocommerce.checkout'
      LIMIT 1`;
    return rows.length === 1;
  }

  async findSettleableAttempts(recoveryId: string): Promise<WooInitialAttempt[]> {
    return this.database.recoveryOutreachAttempt.findMany({
      where: { checkoutRecoveryId: recoveryId, sequence: 1, status: { in: ["PENDING", "CAPACITY_BLOCKED", "CANCELLED"] } },
      orderBy: { id: "asc" },
      select: { id: true, sequence: true, recipient: true, status: true,
        sentAt: true, outboundMessageId: true, followUpDueAt: true },
    });
  }

  async cancelIfPrePermit(input: {
    recovery: WooOutreachRecovery;
    attempt: WooInitialAttempt;
  }): Promise<WooResumedAttemptSettlement> {
    const { recovery, attempt } = input;
    const idempotencyKey = `recovery-outreach:${attempt.id}`;
    const sourceKey = createRecoveryIdempotencyKey(recovery.shopId, idempotencyKey);
    return this.database.$transaction(async (tx) => {
      const lockedRecovery = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT r."id",r."status"::text AS "status"
        FROM "commerce"."CheckoutRecovery" r
        JOIN "commerce"."Shop" s ON s."id"=r."shopId"
        WHERE r."id"=${recovery.id} AND r."shopId"=${recovery.shopId}
          AND r."checkoutToken"=${recovery.checkoutToken} AND s."platform"='WOOCOMMERCE'
        FOR UPDATE OF r`;
      if (lockedRecovery.length !== 1 || lockedRecovery[0]?.status !== "CANCELLED")
        return { kind: "not-resumed" } as const;
      const history = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "commerce"."CheckoutRecoveryStatusHistory"
        WHERE "checkoutRecoveryId"=${recovery.id} AND "toStatus"='CANCELLED'
          AND "reason"='CHECKOUT_RESUMED' AND "source"='woocommerce.checkout'
        LIMIT 1`;
      if (history.length !== 1) return { kind: "not-resumed" } as const;

      const lockedAttempt = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "commerce"."RecoveryOutreachAttempt"
        WHERE "id"=${attempt.id} AND "checkoutRecoveryId"=${recovery.id} AND "sequence"=1
        FOR UPDATE`;
      if (lockedAttempt.length !== 1) return { kind: "ignored" } as const;
      const current = await tx.recoveryOutreachAttempt.findUnique({
        where: { id: attempt.id },
        select: { id: true, checkoutRecoveryId: true, sequence: true, recipient: true, status: true,
          sentAt: true, outboundMessageId: true, followUpDueAt: true },
      });
      if (!current || current.sequence !== 1 || current.checkoutRecoveryId !== recovery.id)
        throw new Error("WOO_RESUMED_ATTEMPT_OWNERSHIP_MISMATCH");
      if (!["PENDING", "CAPACITY_BLOCKED", "CANCELLED"].includes(current.status))
        return { kind: "ignored" } as const;

      const usage = await tx.usageEvent.findUnique({
        where: { idempotencyKey },
        select: { id: true, shopId: true, metric: true, sourceId: true },
      });
      if (usage && (usage.shopId !== recovery.shopId || usage.metric !== "OUTBOUND_AUTOMATED_MESSAGE"))
        throw new Error("WOO_RESUMED_USAGE_OWNERSHIP_MISMATCH");
      const candidateIds = [...new Set([
        ...(usage?.sourceId ? [usage.sourceId] : []),
        ...(current.outboundMessageId ? [current.outboundMessageId] : []),
      ])];
      const candidateKeys = [idempotencyKey, providerDispatchKey(recovery.shopId, attempt.id)];
      const messages = await tx.conversationMessage.findMany({
        where: { OR: [
          ...(candidateIds.length ? [{ id: { in: candidateIds } }] : []),
          { providerDispatchKey: { in: candidateKeys } },
        ] },
        select: { id: true, conversationId: true, status: true, sentAt: true,
          providerFailureCode: true, providerDispatchKey: true, providerDispatchAdmittedAt: true,
          direction: true, senderType: true,
          conversation: { select: { shopId: true, checkoutRecoveryId: true } },
        },
      });
      if (messages.length > 1) throw new Error("WOO_RESUMED_MESSAGE_IDENTITY_AMBIGUOUS");
      const message = messages[0];
      if (message) {
        if (message.conversation.checkoutRecoveryId !== recovery.id ||
          (message.conversation.shopId !== null && message.conversation.shopId !== recovery.shopId) ||
          message.direction !== "OUTBOUND" || message.senderType !== "AUTOMATION" ||
          (current.outboundMessageId !== null && current.outboundMessageId !== message.id) ||
          (usage?.sourceId !== null && usage?.sourceId !== undefined && usage.sourceId !== message.id)) {
          throw new Error("WOO_RESUMED_MESSAGE_OWNERSHIP_MISMATCH");
        }
        const persisted: PersistedAdmission = {
          id: message.id, conversationId: message.conversationId, status: message.status,
          sentAt: message.sentAt, providerFailureCode: message.providerFailureCode,
          providerDispatchKey: message.providerDispatchKey,
          providerDispatchAdmittedAt: message.providerDispatchAdmittedAt,
        };
        if (isConfirmed(persisted)) {
          const reservation = await tx.usageReservation.findUnique({
            where: { sourceKey },
            select: { shopId: true, sourceKey: true, quantity: true, status: true,
              counterId: true, billingPeriodEntitlementCounterId: true,
              purchasedCreditPurchaseId: true, promotionalCreditGrantId: true,
              counter: { select: { counter: true } } },
          }) as ReservationRecord | null;
          if (!reservation) throw new Error("WOO_CONFIRMED_PROVIDER_RESERVATION_MISSING");
          reservationOwner(reservation, recovery.shopId, sourceKey);
          if (reservation.status === "RELEASED")
            throw new Error("WOO_CONFIRMED_PROVIDER_RESERVATION_RELEASED");
          return { kind: "provider-confirmed", message: persisted } as const;
        }
        const permitRecorded = message.providerDispatchKey !== null || message.providerDispatchAdmittedAt !== null;
        if (permitRecorded) {
          if (message.providerDispatchKey !== null && !candidateKeys.includes(message.providerDispatchKey))
            return { kind: "provider-uncertain" } as const;
          if (message.status === "FAILED") {
            const reservation = await tx.usageReservation.findUnique({
              where: { sourceKey },
              select: { shopId: true, sourceKey: true, quantity: true, status: true,
                counterId: true, billingPeriodEntitlementCounterId: true,
                purchasedCreditPurchaseId: true, promotionalCreditGrantId: true,
                counter: { select: { counter: true } } },
            }) as ReservationRecord | null;
            if (reservation) reservationOwner(reservation, recovery.shopId, sourceKey);
            return { kind: "provider-failed", message: persisted, sourceKey,
              reservationStatus: reservation?.status ?? null } as const;
          }
          return { kind: "provider-uncertain" } as const;
        }
        if (message.status !== "PENDING" && message.status !== "FAILED")
          return { kind: "provider-uncertain" } as const;
      } else if (usage?.sourceId || current.outboundMessageId) {
        throw new Error("WOO_RESUMED_MESSAGE_MISSING_FOR_RECORDED_OWNER");
      }

      // Attempt-level sentAt is evidence of a prior dispatch outcome too;
      // without a durable confirmed message it must never be called unsent.
      if (current.sentAt !== null) return { kind: "provider-uncertain" } as const;

      const cancelEligibleAttempt = async (): Promise<void> => {
        if (current.status === "CANCELLED") {
          // A replay is accepted only when the persisted row still proves an
          // unsent initial attempt. In particular, a follow-up due date must
          // never be treated as a completed cancellation.
          if (current.sentAt !== null || current.outboundMessageId !== null || current.followUpDueAt !== null)
            throw new Error("WOO_RESUMED_CANCELLED_ATTEMPT_NOT_PRE_PERMIT");
          return;
        }
        if (current.followUpDueAt !== null)
          throw new Error("WOO_RESUMED_FOLLOW_UP_ATTEMPT_NOT_CANCELLABLE");
        if ((current.status !== "PENDING" && current.status !== "CAPACITY_BLOCKED") ||
          current.outboundMessageId !== null)
          throw new Error("WOO_RESUMED_ATTEMPT_NOT_CANCELLABLE");

        const changed = await tx.recoveryOutreachAttempt.updateMany({
          where: { id: current.id, checkoutRecoveryId: recovery.id, sequence: 1,
            status: { in: ["PENDING", "CAPACITY_BLOCKED"] },
            sentAt: null, outboundMessageId: null, followUpDueAt: null },
          data: { status: "CANCELLED", closedAt: new Date() },
        });
        if (changed.count !== 1)
          throw new Error("WOO_RESUMED_ATTEMPT_CANCELLATION_CONFLICT");
      };

      const reservation = await tx.usageReservation.findUnique({
        where: { sourceKey },
        select: { shopId: true, sourceKey: true, quantity: true, status: true,
          counterId: true, billingPeriodEntitlementCounterId: true,
          purchasedCreditPurchaseId: true, promotionalCreditGrantId: true,
          counter: { select: { counter: true } } },
      }) as ReservationRecord | null;
      if (reservation) {
        const owner = reservationOwner(reservation, recovery.shopId, sourceKey);
        if (reservation.status === "RESERVED") {
          await cancelEligibleAttempt();
          return { kind: "cancelled", sourceKey, owner } as const;
        }
        if (reservation.status === "RELEASED") {
          await cancelEligibleAttempt();
          return { kind: "cancelled" } as const;
        }
        throw new Error("WOO_RESUMED_RESERVATION_NOT_PRE_PERMIT");
      }

      await cancelEligibleAttempt();
      return { kind: "cancelled" } as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async releaseReservedCredit(input: { shopId: string; sourceKey: string; owner: ReservationOwner }): Promise<void> {
    const reservation = await this.database.usageReservation.findUnique({
      where: { sourceKey: input.sourceKey },
      select: { shopId: true, sourceKey: true, quantity: true, status: true,
        counterId: true, billingPeriodEntitlementCounterId: true,
        purchasedCreditPurchaseId: true, promotionalCreditGrantId: true,
        counter: { select: { counter: true } } },
    }) as ReservationRecord | null;
    if (!reservation) throw new Error("WOO_RESUMED_RESERVATION_MISSING_ON_RELEASE");
    const owner = reservationOwner(reservation, input.shopId, input.sourceKey);
    if (owner !== input.owner) throw new Error("WOO_RESUMED_RESERVATION_OWNER_CHANGED");
    if (reservation.status === "RELEASED") return;
    if (reservation.status !== "RESERVED") throw new Error("WOO_RESUMED_RESERVATION_NOT_RELEASEABLE");
    const releaseInput = { shopId: input.shopId, sourceKey: input.sourceKey, quantity: 1 };
    const result = owner === "lifetime-free"
      ? await freeRecoveryReservationService.release(releaseInput)
      : owner === "paid-included"
        ? await paidIncludedRecoveryReservationService.release(releaseInput)
        : owner === "purchased"
          ? await purchasedRecoveryReservationService.release(releaseInput)
          : await promotionalRecoveryReservationService.release(releaseInput);
    if (result.kind !== "released" && result.kind !== "already-released")
      throw new Error("WOO_RESUMED_RESERVATION_RELEASE_INCOMPLETE");
  }
}

export type WooResumedSettlementPort = Pick<WooResumedOutreachSettlementAdapter,
  "hasResumedHistory" | "findSettleableAttempts" | "cancelIfPrePermit" | "releaseReservedCredit">;
