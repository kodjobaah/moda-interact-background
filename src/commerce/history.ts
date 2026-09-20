import type { Prisma } from "@prisma/client";
import prisma from "../lib/db.js";
import type { AgentMessage } from "../agents/types.js";

const visible: Prisma.ConversationMessageWhereInput = {
  contentType: { not: "UNSUPPORTED" },
  transcriptionStatus: { in: ["NOT_REQUIRED", "COMPLETED"] },
  OR: [
    { direction: "INBOUND", senderType: "CUSTOMER" },
    { direction: "OUTBOUND", sentAt: { not: null } },
  ],
};
type HistoryRow = {
  id: string;
  direction: string;
  content: string;
  senderType: string;
};
const select = {
  id: true,
  direction: true,
  content: true,
  senderType: true,
} as const;
export function boundHistory(prior: HistoryRow[], current: HistoryRow[]) {
  const seen = new Set<string>();
  const map = (rows: HistoryRow[]): AgentMessage[] =>
    rows
      .filter((row) => !seen.has(row.id) && !!seen.add(row.id))
      .map((row) => ({
        role: row.direction === "INBOUND" ? "user" : "assistant",
        // Outreach records may contain a template descriptor, not its rendered body.
        content:
          row.senderType === "AUTOMATION" && row.direction === "OUTBOUND"
            ? `[Recorded automation context; not a verbatim customer-visible message] ${row.content}`
            : row.content,
      }));
  const currentMessages = map(current);
  const history = map(prior).slice(-20);
  const size = (messages: AgentMessage[]) =>
    [...JSON.stringify(messages)].length;
  const oversized = size(currentMessages) > 32000;
  while (history.length && size([...history, ...currentMessages]) > 32000)
    history.shift();
  return { history, currentMessages, oversized };
}
export async function loadCommerceHistory(
  conversationId: string,
  pendingTurnStartedAt: Date,
) {
  const [prior, current] = await Promise.all([
    prisma.conversationMessage.findMany({
      where: {
        AND: [
          visible,
          { conversationId, OR: [
            { contentType: { not: "AUDIO" }, createdAt: { lt: pendingTurnStartedAt } },
            { contentType: "AUDIO", transcriptionCompletedAt: { lt: pendingTurnStartedAt } },
          ] },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      select,
    }),
    prisma.conversationMessage.findMany({
      where: {
        AND: [
          visible,
          {
            conversationId,
            OR: [
              { contentType: { not: "AUDIO" }, createdAt: { gte: pendingTurnStartedAt } },
              { contentType: "AUDIO", transcriptionCompletedAt: { gte: pendingTurnStartedAt } },
            ],
            direction: "INBOUND",
            senderType: "CUSTOMER",
          },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select,
    }),
  ]);
  return boundHistory(prior.reverse(), current);
}
