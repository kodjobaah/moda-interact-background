/** Shared minimal projection for logical outreach selection. Use exact message
 * and intent relations; sequence alone is not delivery or retry evidence.
 */
export const recoveryOutreachIdentitySelect = {
  id: true,
  checkoutRecoveryId: true,
  sequence: true,
  trigger: true,
  recipient: true,
  initiatedBy: true,
  status: true,
  sentAt: true,
  customerRespondedAt: true,
  outboundMessageId: true,
  outboundMessage: {
    select: {
      id: true,
      conversationId: true,
      direction: true,
      senderType: true,
      status: true,
      providerMessageId: true,
      sentAt: true,
      deliveredAt: true,
      readAt: true,
      failedAt: true,
    },
  },
  deliveryRetryIntent: {
    select: {
      id: true,
      failedAttemptId: true,
      failedMessageId: true,
      cancelledAt: true,
    },
  },
} as const;
