import type {
  CheckoutRecoveryStatus,
  ConversationType,
} from "../domain/types.js";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentConversationContext {
  conversationId: string;
  shop: string;
  type: ConversationType;
  summary: string | null;
  version: number;
  messages: AgentMessage[];
}

export interface RecoveryAgentContext {
  shop: string;

  recovery: {
    id: string;
    status: CheckoutRecoveryStatus;
    checkoutToken: string;
    completedAt: Date | null;
    totalPrice: string | null;
  };

  customer: {
    id: string;
    phone: string | null;
    firstName: string | null;
  } | null;

  conversation: AgentConversationContext;
}