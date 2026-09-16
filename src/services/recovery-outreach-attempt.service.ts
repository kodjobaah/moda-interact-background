import { Prisma, RecoveryOutreachStatus, RecoveryOutreachTrigger } from "@prisma/client";
import prisma from "../lib/db.js";
import type { RecoveryPolicySnapshot } from "./recovery-policy.service.js";

export class RecoveryOutreachAttemptService {
  constructor(private readonly database = prisma) {}

  private get attemptModel() {
    return (this.database as unknown as {
      recoveryOutreachAttempt?: typeof prisma.recoveryOutreachAttempt;
    }).recoveryOutreachAttempt;
  }

  async getOrCreate(input: {
    recoveryId: string;
    sequence: 1 | 2;
    policy: RecoveryPolicySnapshot;
  }) {
    const trigger = input.sequence === 1
      ? RecoveryOutreachTrigger.INITIAL
      : RecoveryOutreachTrigger.NO_RESPONSE_FOLLOW_UP;
    if (!this.attemptModel) {
      return {
        id: `recovery-outreach:${input.recoveryId}:${input.sequence}`,
        checkoutRecoveryId: input.recoveryId,
        sequence: input.sequence,
        trigger,
        status: RecoveryOutreachStatus.PENDING,
      };
    }
    return this.attemptModel.upsert({
      where: {
        checkoutRecoveryId_sequence: {
          checkoutRecoveryId: input.recoveryId,
          sequence: input.sequence,
        },
      },
      create: {
        checkoutRecoveryId: input.recoveryId,
        sequence: input.sequence,
        trigger,
        configuredOfferMode: input.policy.recoveryOfferMode,
        fixedShopifyDiscountId: input.policy.fixedShopifyDiscountId,
        offerSnapshot: input.policy.offerSnapshot
          ? (input.policy.offerSnapshot as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
      update: {},
    });
  }

  async getOrCreateFollowUp(input: {
    recoveryId: string;
    initialAttempt: {
      configuredOfferMode: RecoveryPolicySnapshot["recoveryOfferMode"];
      fixedShopifyDiscountId: string | null;
      offerSnapshot: unknown;
    };
  }) {
    if (!this.attemptModel) {
      return {
        id: `recovery-outreach:${input.recoveryId}:2`,
        checkoutRecoveryId: input.recoveryId,
        sequence: 2,
        trigger: RecoveryOutreachTrigger.NO_RESPONSE_FOLLOW_UP,
        status: RecoveryOutreachStatus.PENDING,
      };
    }
    return this.attemptModel.upsert({
      where: {
        checkoutRecoveryId_sequence: {
          checkoutRecoveryId: input.recoveryId,
          sequence: 2,
        },
      },
      create: {
        checkoutRecoveryId: input.recoveryId,
        sequence: 2,
        trigger: RecoveryOutreachTrigger.NO_RESPONSE_FOLLOW_UP,
        configuredOfferMode: input.initialAttempt.configuredOfferMode,
        fixedShopifyDiscountId: input.initialAttempt.fixedShopifyDiscountId,
        offerSnapshot: input.initialAttempt.offerSnapshot === null
          ? Prisma.JsonNull
          : (input.initialAttempt.offerSnapshot as Prisma.InputJsonValue),
      },
      update: {},
    });
  }

  async markStatus(
    id: string,
    status: RecoveryOutreachStatus,
    data: {
      sentAt?: Date | null;
      followUpDueAt?: Date | null;
      outboundMessageId?: string | null;
      failureCode?: string | null;
      customerRespondedAt?: Date | null;
    } = {},
  ) {
    if (!this.attemptModel) return null;
    return this.attemptModel.update({
      where: { id },
      data: { status, ...data },
    });
  }

  async markEngagedFromInbound(recoveryId: string, occurredAt: Date) {
    if (!this.attemptModel) return null;
    const attempt = await this.attemptModel.findFirst({
      where: {
        checkoutRecoveryId: recoveryId,
        status: RecoveryOutreachStatus.WAITING_FOR_RESPONSE,
        sentAt: { lte: occurredAt },
      },
      orderBy: { sequence: "desc" },
    });
    if (!attempt) return null;
    return this.attemptModel.updateMany({
      where: { id: attempt.id, status: RecoveryOutreachStatus.WAITING_FOR_RESPONSE },
      data: {
        status: RecoveryOutreachStatus.ENGAGED,
        customerRespondedAt: attempt.customerRespondedAt && attempt.customerRespondedAt <= occurredAt
          ? attempt.customerRespondedAt
          : occurredAt,
      },
    });
  }

  async markEngagedForConversation(conversationId: string, occurredAt: Date) {
    const conversationModel = (this.database as unknown as {
      conversation?: {
        findUnique?: (args: {
          where: { id: string };
          select: { checkoutRecoveryId: true };
        }) => Promise<{ checkoutRecoveryId: string | null } | null>;
      };
    }).conversation;
    if (!conversationModel?.findUnique) return null;
    const conversation = await conversationModel.findUnique({
      where: { id: conversationId },
      select: { checkoutRecoveryId: true },
    });
    if (!conversation?.checkoutRecoveryId) return null;
    return this.markEngagedFromInbound(conversation.checkoutRecoveryId, occurredAt);
  }
}

export const recoveryOutreachAttemptService = new RecoveryOutreachAttemptService();