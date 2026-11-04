import { createLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";

export const input = {
  shopId: "shop-1",
  recoveryId: "recovery-1",
  outreachAttemptId: "attempt-1",
};

export function attemptEvidence() {
  return {
    id: input.outreachAttemptId,
    checkoutRecoveryId: input.recoveryId,
    sequence: 1,
    trigger: "INITIAL",
    status: "PENDING",
    outboundMessageId: null,
    sentAt: null,
    failureCode: null,
    checkoutRecovery: {
      id: input.recoveryId,
      shopId: input.shopId,
      conversation: { id: "conversation-1", shopId: input.shopId },
    },
  };
}

export function captureLogger(records: LogRecord[]) {
  return createLogger({
    serviceName: "initial-outreach-credit-test",
    environment: "test",
    sink: (record) => records.push(record),
  });
}

export function transactionForAttempt(overrides: Record<string, unknown> = {}) {
  return {
    recoveryOutreachAttempt: {
      findUnique: async () => attemptEvidence(),
    },
    conversationMessage: {
      findUnique: async () => null,
      findFirst: async () => null,
    },
    usageEvent: {
      findUnique: async () => null,
      findMany: async () => [],
    },
    merchantConversationSendCommand: { findFirst: async () => null },
    ...overrides,
  };
}

export function databaseFor(transaction: Record<string, unknown>) {
  return {
    $transaction: async (operation: (tx: Record<string, unknown>) => unknown) =>
      operation(transaction),
  };
}
