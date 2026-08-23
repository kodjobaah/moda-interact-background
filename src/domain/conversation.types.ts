export interface ConversationVersion {
  conversationId: string;
  version: number;
  duplicate: boolean;
}

export interface AgentConversationSnapshot {
  conversationId: string;
  version: number;
  summary: string | null;
  messages: AgentMessage[];
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}