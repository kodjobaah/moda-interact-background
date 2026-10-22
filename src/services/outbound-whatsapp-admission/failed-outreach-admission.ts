import type { Prisma } from "@prisma/client";

type AttemptReader = Pick<Prisma.TransactionClient, "recoveryOutreachAttempt">;

/** Compensation removes the hard-limit row. The immutable failed-attempt link
 * remains a durable idempotency fence for the same recovery outreach source.
 */
export async function failedRecipientOutreach(
  database: AttemptReader, idempotencyKey: string,
): Promise<null | { shopId: string; message: {
  id: string; conversationId: string; status: string; sentAt: Date | null;
  providerFailureCode: string | null;
} }> {
  const attemptId = /^recovery-outreach:([A-Za-z0-9_-]+)$/.exec(idempotencyKey)?.[1];
  if (!attemptId) return null;
  const attempt = await database.recoveryOutreachAttempt.findUnique({
    where: { id: attemptId },
    select: {
      checkoutRecovery: { select: { shopId: true } },
      outboundMessage: { select: {
        id: true, conversationId: true, status: true, sentAt: true, providerFailureCode: true,
      } },
    },
  });
  if (!attempt) return null;
  const message = attempt.outboundMessage;
  if (!message || message.status !== "FAILED" || message.providerFailureCode !== "131026") {
    return null;
  }
  return { shopId: attempt.checkoutRecovery.shopId, message };
}
