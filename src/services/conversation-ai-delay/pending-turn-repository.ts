import { Prisma } from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";

import { computePendingAiNotBeforeAt } from "./pending-turn-deadline.js";

type PendingTurnTransaction = Pick<
  PrismaTypes.TransactionClient,
  "$queryRaw" | "conversation" | "shopSettings"
>;

type LockedConversation = {
  id: string;
  type: string;
  checkoutRecoveryId: string | null;
  controlMode: string;
  controlRevision: number;
  inboundVersion: number;
  lastProcessedVersion: number;
  pendingTurnStartedAt: Date | null;
  recoveryId: string | null;
  recoveryShopId: string | null;
};

export async function recordProcessableInbound(
  tx: PendingTurnTransaction,
  conversationId: string,
  pendingStartedAt: Date,
  options: { conversationAlreadyLocked?: boolean } = {},
): Promise<{ version: number; scheduleAi: boolean }> {
  const rows = await tx.$queryRaw<LockedConversation[]>(Prisma.sql`
    SELECT c."id", c."type"::text AS "type", c."checkoutRecoveryId",
      c."controlMode"::text AS "controlMode", c."controlRevision",
      c."inboundVersion", c."lastProcessedVersion", c."pendingTurnStartedAt",
      r."id" AS "recoveryId", r."shopId" AS "recoveryShopId"
    FROM "whatsapp"."Conversation" c
    LEFT JOIN "commerce"."CheckoutRecovery" r
      ON r."id" = c."checkoutRecoveryId"
    WHERE c."id" = ${conversationId}
    ${options.conversationAlreadyLocked ? Prisma.empty : Prisma.sql`FOR UPDATE OF c`}`);
  const state = rows[0];
  if (!state) throw new Error("Conversation not found while recording inbound");

  const isRecovery = state.type === "RECOVERY";
  if (isRecovery !== (state.checkoutRecoveryId !== null)) {
    throw new Error("Conversation recovery ownership is inconsistent");
  }
  if (
    isRecovery &&
    (state.recoveryId !== state.checkoutRecoveryId || !state.recoveryShopId)
  ) {
    throw new Error("Recovery shop ownership is unavailable");
  }

  if (state.controlMode === "HUMAN") {
    const updated = await tx.conversation.update({
      where: { id: conversationId },
      data: {
        inboundVersion: { increment: 1 },
        lastProcessedVersion: state.inboundVersion + 1,
        pendingTurnStartedAt: null,
        pendingAiNotBeforeAt: null,
        pendingAiDelayMinutes: null,
        pendingAiControlRevision: null,
        processingInboundVersion: null,
        processingStartedAt: null,
      },
      select: { inboundVersion: true },
    });
    return { version: updated.inboundVersion, scheduleAi: false };
  }

  const opensPendingTurn = state.pendingTurnStartedAt === null;
  let pendingAiFields = {};
  if (opensPendingTurn && isRecovery) {
    const settings = await tx.shopSettings.findUnique({
      where: { shopId: state.recoveryShopId! },
      select: { aiResponseDelayMinutes: true },
    });
    const delayMinutes = settings === null
      ? 0
      : settings.aiResponseDelayMinutes;
    if (
      !Number.isInteger(delayMinutes) ||
      delayMinutes < 0 ||
      delayMinutes > 30
    ) {
      throw new RangeError("Persisted AI response delay must be an integer from 0 through 30");
    }
    pendingAiFields = {
      pendingAiNotBeforeAt: computePendingAiNotBeforeAt({
        pendingStartedAt,
        delayMinutes,
      }),
      pendingAiDelayMinutes: delayMinutes,
      pendingAiControlRevision: state.controlRevision,
    };
  }

  const updated = await tx.conversation.update({
    where: { id: conversationId },
    data: {
      inboundVersion: { increment: 1 },
      ...(opensPendingTurn ? { pendingTurnStartedAt: pendingStartedAt } : {}),
      ...pendingAiFields,
    },
    select: { inboundVersion: true },
  });
  return { version: updated.inboundVersion, scheduleAi: true };
}