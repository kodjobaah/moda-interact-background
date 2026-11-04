import type { Prisma } from "@prisma/client";
import type {
  ExistingInitialOutreachCreditInput,
  InitialOutreachCreditIdentity,
} from "./recovery-billing.types.js";
import { readExactAutomatedUsage } from "../recovery-delivery-compensation/automated-usage.js";
import { requireLineage } from "../recovery-delivery-compensation/types.js";
import type { AutomatedUsage } from "../recovery-delivery-compensation/lineage.js";

type Transaction = Prisma.TransactionClient;

export type InitialAttemptEvidence = {
  id: string;
  checkoutRecoveryId: string;
  sequence: number;
  trigger: string;
  status: string;
  outboundMessageId: string | null;
  sentAt: Date | null;
  failureCode: string | null;
  checkoutRecovery: {
    id: string;
    shopId: string;
    conversation: { id: string; shopId: string | null } | null;
  };
};

export type InitialMessageEvidence = {
  id: string;
  providerMessageId: string | null;
  conversationId: string;
  direction: string;
  senderType: string;
  status: string;
  providerDispatchKey: string | null;
  providerDispatchAdmittedAt: Date | null;
  providerDispatchControlRevision: number | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  providerFailureCode: string | null;
  failedAt: Date | null;
  recoveryOutreachAttempt: { id: string } | null;
  merchantSendCommand: { id: string } | null;
  conversation: {
    id: string;
    shopId: string | null;
    checkoutRecovery: { id: string; shopId: string } | null;
  };
};

export async function readInitialAttempt(
  tx: Transaction,
  input: InitialOutreachCreditIdentity,
): Promise<InitialAttemptEvidence> {
  const attempt = await tx.recoveryOutreachAttempt.findUnique({
    where: { id: input.outreachAttemptId },
    select: {
      id: true,
      checkoutRecoveryId: true,
      sequence: true,
      trigger: true,
      status: true,
      outboundMessageId: true,
      sentAt: true,
      failureCode: true,
      checkoutRecovery: {
        select: {
          id: true,
          shopId: true,
          conversation: { select: { id: true, shopId: true } },
        },
      },
    },
  });
  requireLineage(attempt && attempt.id === input.outreachAttemptId &&
    attempt.checkoutRecoveryId === input.recoveryId &&
    attempt.checkoutRecovery.id === input.recoveryId &&
    attempt.checkoutRecovery.shopId === input.shopId &&
    (!attempt.checkoutRecovery.conversation?.shopId ||
      attempt.checkoutRecovery.conversation.shopId === input.shopId) &&
    attempt.sequence === 1 && attempt.trigger === "INITIAL",
  "initial attempt/recovery/Shop identity mismatch");
  return attempt;
}

export async function readInitialMessage(
  tx: Transaction,
  messageId: string,
): Promise<InitialMessageEvidence | null> {
  return tx.conversationMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      providerMessageId: true,
      conversationId: true,
      direction: true,
      senderType: true,
      status: true,
      providerDispatchKey: true,
      providerDispatchAdmittedAt: true,
      providerDispatchControlRevision: true,
      sentAt: true,
      deliveredAt: true,
      readAt: true,
      providerFailureCode: true,
      failedAt: true,
      recoveryOutreachAttempt: { select: { id: true } },
      merchantSendCommand: { select: { id: true } },
      conversation: {
        select: {
          id: true,
          shopId: true,
          checkoutRecovery: { select: { id: true, shopId: true } },
        },
      },
    },
  });
}

export async function validateInitialMessageIdentity(
  tx: Transaction,
  input: InitialOutreachCreditIdentity,
  attempt: InitialAttemptEvidence,
  message: InitialMessageEvidence,
  requireUsage: boolean,
): Promise<AutomatedUsage | null> {
  requireLineage(message.direction === "OUTBOUND" && message.senderType === "AUTOMATION" &&
    message.conversation.id === attempt.checkoutRecovery.conversation?.id &&
    message.conversation.checkoutRecovery?.id === input.recoveryId &&
    message.conversation.checkoutRecovery.shopId === input.shopId &&
    (!message.conversation.shopId || message.conversation.shopId === input.shopId),
  "initial message ownership mismatch");
  requireLineage(!attempt.outboundMessageId || attempt.outboundMessageId === message.id,
    "initial attempt links another message");
  requireLineage(!message.recoveryOutreachAttempt ||
    message.recoveryOutreachAttempt.id === attempt.id,
  "message links another outreach attempt");

  const command = await tx.merchantConversationSendCommand.findFirst({
    where: {
      OR: [
        { outboundMessageId: message.id },
        { recoveryOutreachAttemptId: attempt.id },
      ],
    },
    select: { id: true },
  });
  requireLineage(!command && !message.merchantSendCommand,
    "automated initial message has a merchant command");

  const linkedAttempt = await tx.recoveryOutreachAttempt.findUnique({
    where: { outboundMessageId: message.id },
    select: { id: true, sequence: true, trigger: true },
  });
  requireLineage(!linkedAttempt || (linkedAttempt.id === attempt.id &&
    linkedAttempt.sequence === 1 && linkedAttempt.trigger === "INITIAL"),
  "initial message has a conflicting attempt claim");

  const usage = await readExactAutomatedUsage(tx, input.shopId, message.id);
  const canonicalUsage = await tx.usageEvent.findUnique({
    where: { idempotencyKey: `recovery-outreach:${attempt.id}` },
    select: { id: true, shopId: true, sourceId: true, sourceType: true, metric: true },
  });
  requireLineage(!canonicalUsage || (canonicalUsage.shopId === input.shopId &&
    canonicalUsage.sourceId === message.id &&
    canonicalUsage.sourceType === "OUTBOUND_AUTOMATED_MESSAGE" &&
    canonicalUsage.metric === "OUTBOUND_AUTOMATED_MESSAGE" &&
    canonicalUsage.id === usage?.id),
  "canonical automated-message usage identity mismatch");
  if (requireUsage || !attempt.outboundMessageId || usage || canonicalUsage) {
    requireLineage(usage?.sourceType === "OUTBOUND_AUTOMATED_MESSAGE" &&
      usage.idempotencyKey === `recovery-outreach:${attempt.id}` &&
      canonicalUsage?.id === usage.id,
    "initial automated-message usage identity mismatch");
  }
  return usage;
}

export async function assertNoInitialMessageEvidence(
  tx: Transaction,
  input: ExistingInitialOutreachCreditInput,
  attempt: InitialAttemptEvidence,
): Promise<void> {
  requireLineage((attempt.status === "PENDING" || attempt.status === "CAPACITY_BLOCKED") &&
    attempt.outboundMessageId === null && attempt.sentAt === null &&
    attempt.failureCode === null,
  "initial attempt has existing message or send evidence");
  const [linkedMessage, canonicalUsage] = await Promise.all([
    tx.conversationMessage.findFirst({
      where: { recoveryOutreachAttempt: { is: { id: attempt.id } } },
      select: { id: true },
    }),
    tx.usageEvent.findUnique({
      where: { idempotencyKey: `recovery-outreach:${attempt.id}` },
      select: { id: true },
    }),
  ]);
  requireLineage(!linkedMessage && !canonicalUsage,
    "initial attempt has a discoverable message or automated usage event");
}