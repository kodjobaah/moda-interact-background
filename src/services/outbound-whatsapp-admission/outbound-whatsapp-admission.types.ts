import type { MessageSenderType } from "@prisma/client";

export type OutboundAdmissionInput = {
  shopId: string;
  conversationId: string;
  idempotencyKey: string;
  senderType: Extract<MessageSenderType, "AGENT" | "AUTOMATION">;
  content?: string;
  recoveryCreditSourceKey?: string;
  initialOutreach?: InitialOutreachAdmissionScope;
};

export type OutboundAdmissionResult =
  | {
      kind: "admitted";
      shopId: string;
      messageId: string;
      conversationId: string;
      terminal: boolean;
      executionScope?: "general" | "recovery";
    }
  | { kind: "suppressed"; reason: OutboundSuppressionReason };

export type OutboundSuppressionReason =
  | "paused"
  | "normal-cap-reached"
  | "terminal-already-used"
  | "duplicate"
  | "conversation-invalid"
  | "shop-unavailable"
  | "contract-required"
  | "subscription-frozen"
  | "TEMPLATE_REGISTRATION_UNAVAILABLE"
  | "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"
  | "TEMPLATE_PROVIDER_STATUS_STALE";

export type InitialOutreachAdmissionScope = Readonly<{
  shopId: string;
  recoveryId: string;
  outreachAttemptId: string;
}>;

export type InitialOutreachMessageEvidence = Readonly<{
  id: string;
  conversationId: string;
  status: import("@prisma/client").MessageStatus;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  providerMessageId: string | null;
  providerDispatchKey: string | null;
  providerDispatchAdmittedAt: Date | null;
  providerDispatchControlRevision: number | null;
  providerFailureCode: string | null;
}>;

export type InitialOutreachAdmissionLookup =
  | { kind: "absent" }
  | { kind: "prepared"; message: InitialOutreachMessageEvidence }
  | { kind: "confirmed"; message: InitialOutreachMessageEvidence & { sentAt: Date } }
  | { kind: "failed"; message: InitialOutreachMessageEvidence;
      disposition: "pre-permit-refused" | "provider-rejected" | "recipient-unreachable" }
  | { kind: "held"; reason: "provider-outcome-unknown" | "lineage-conflict" };
