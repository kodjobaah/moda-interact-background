import type { MessageSenderType } from "@prisma/client";

export type OutboundAdmissionInput = {
  shopId: string;
  conversationId: string;
  idempotencyKey: string;
  senderType: Extract<MessageSenderType, "AGENT" | "AUTOMATION">;
  content?: string;
  recoveryCreditSourceKey?: string;
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
  | "subscription-frozen";
