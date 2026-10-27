/** Background-local contract for atomically finalising the first automated recovery send. */
export type ConfirmedInitialRecoveryOutreachInput = Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  outreachAttemptId: string;
  outboundMessageId: string;
  sentAt: Date;
  followUpDueAt: Date | null;
}>;

export type InitialOutreachNoticeResult =
  | { outcome: "created"; outreachAttemptId: string }
  | { outcome: "disabled"; outreachAttemptId: string }
  | { outcome: "replayed"; outreachAttemptId: string };

export interface ConfirmedInitialOutreachFinalizer {
  finalizeConfirmedInitial(
    input: ConfirmedInitialRecoveryOutreachInput,
  ): Promise<InitialOutreachNoticeResult>;
}
