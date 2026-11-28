import {
  Prisma,
  RecoveryOutreachStatus,
  RecoveryOutreachTrigger,
} from "@prisma/client";
import prisma from "../lib/db.js";
import type { RecoveryPolicySnapshot } from "./recovery-policy.service.js";
import {
  originalOutreachTrigger,
  type OriginalOutreachSequence,
} from "../domain/recovery-outreach-identity.js";

export class RecoveryOutreachAttemptService {
  constructor(private readonly database = prisma) {}

  private get attemptModel() {
    return (
      this.database as unknown as {
        recoveryOutreachAttempt?: typeof prisma.recoveryOutreachAttempt;
      }
    ).recoveryOutreachAttempt;
  }

  private requireAttemptModel() {
    const model = this.attemptModel;
    if (!model) {
      throw new Error("Recovery outreach attempt persistence is unavailable");
    }
    return model;
  }

  async getOrCreate(input: {
    recoveryId: string;
    sequence: OriginalOutreachSequence;
    policy: RecoveryPolicySnapshot;
    recipient: string;
  }) {
    const attemptModel = this.requireAttemptModel();
    const trigger = originalOutreachTrigger(input.sequence);
    return attemptModel.upsert({
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
        recipient: input.recipient,
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
    recipient: string;
    initialAttempt: {
      configuredOfferMode: RecoveryPolicySnapshot["recoveryOfferMode"];
      fixedShopifyDiscountId: string | null;
      offerSnapshot: unknown;
    };
  }) {
    const attemptModel = this.requireAttemptModel();
    return attemptModel.upsert({
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
        recipient: input.recipient,
        configuredOfferMode: input.initialAttempt.configuredOfferMode,
        fixedShopifyDiscountId: input.initialAttempt.fixedShopifyDiscountId,
        offerSnapshot:
          input.initialAttempt.offerSnapshot === null
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

  async markNoResponseIfWaiting(id: string) {
    if (!this.attemptModel) return null;
    return this.attemptModel.updateMany({
      where: {
        id,
        status: RecoveryOutreachStatus.WAITING_FOR_RESPONSE,
        customerRespondedAt: null,
      },
      data: { status: RecoveryOutreachStatus.NO_RESPONSE },
    });
  }

  async markWaitingAfterConfirmedSend(
    id: string,
    data: {
      sentAt: Date;
      outboundMessageId: string;
      followUpDueAt?: Date | null;
    },
  ) {
    if (!this.attemptModel) return null;
    return this.attemptModel.updateMany({
      where: {
        id,
        OR: [
          {
            status: {
              in: [
                RecoveryOutreachStatus.PENDING,
                RecoveryOutreachStatus.CAPACITY_BLOCKED,
              ],
            },
          },
          {
            status: RecoveryOutreachStatus.WAITING_FOR_RESPONSE,
            outboundMessageId: data.outboundMessageId,
          },
        ],
      },
      data: { status: RecoveryOutreachStatus.WAITING_FOR_RESPONSE, ...data },
    });
  }

  async markEngagedFromInbound(recoveryId: string, occurredAt: Date) {
    if (!this.attemptModel) return null;
    const attempt = await this.attemptModel.findFirst({
      where: {
        checkoutRecoveryId: recoveryId,
        status: {
          in: [
            RecoveryOutreachStatus.WAITING_FOR_RESPONSE,
            RecoveryOutreachStatus.ENGAGED,
          ],
        },
        sentAt: { lte: occurredAt },
      },
      orderBy: [{ sentAt: "desc" }, { sequence: "desc" }],
    });
    if (!attempt) return null;
    return this.attemptModel.updateMany({
      where: {
        id: attempt.id,
        status: {
          in: [
            RecoveryOutreachStatus.WAITING_FOR_RESPONSE,
            RecoveryOutreachStatus.ENGAGED,
          ],
        },
        OR: [
          { customerRespondedAt: null },
          { customerRespondedAt: { gt: occurredAt } },
        ],
      },
      data: {
        status: RecoveryOutreachStatus.ENGAGED,
        customerRespondedAt: occurredAt,
      },
    });
  }

  async markEngagedForConversation(conversationId: string, occurredAt: Date) {
    const conversationModel = (
      this.database as unknown as {
        conversation?: {
          findUnique?: (args: {
            where: { id: string };
            select: { checkoutRecoveryId: true };
          }) => Promise<{ checkoutRecoveryId: string | null } | null>;
        };
      }
    ).conversation;
    if (!conversationModel?.findUnique) return null;
    const conversation = await conversationModel.findUnique({
      where: { id: conversationId },
      select: { checkoutRecoveryId: true },
    });
    if (!conversation?.checkoutRecoveryId) return null;
    return this.markEngagedFromInbound(
      conversation.checkoutRecoveryId,
      occurredAt,
    );
  }
}

export const recoveryOutreachAttemptService =
  new RecoveryOutreachAttemptService();
