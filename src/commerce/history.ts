import { commerceHistoryVisible as visible, priorCommerceHistorySelection, commerceHistoryActivityAt } from "./history-selection.js";
import prisma from "../lib/db.js";
import { allowedHistoryCandidates } from "../services/conversation-moderation/moderation-history.js";
import { readRoutingHistoryProjection, projectRoutingHistory, latestRoutingObjective, orderRoutingHistory, type RoutingHistoryRow } from "../services/recovery-sender-pool/routing-projection.js";
import type { AgentMessage } from "../agents/types.js";
import { historyDelivery, historyDeliverySelect, projectDeliveryHistoryMessage, type DeliveryHistoryRow } from "./history-delivery.js";

type HistoryRow = RoutingHistoryRow & DeliveryHistoryRow;
const select = {
  id: true,
  direction: true,
  content: true,
  senderType: true,
  createdAt: true,
  contentType: true,
  transcriptionCompletedAt: true,
  ...historyDeliverySelect,
} as const;
export function boundHistory(prior: HistoryRow[], current: HistoryRow[], witnesses: readonly DeliveryHistoryRow[] = [...prior, ...current]) {
  const seen = new Set<string>();
  const map = (rows: HistoryRow[]): AgentMessage[] =>
    rows.flatMap(row => {
      if (seen.has(row.id)) return [];
      const projected = projectDeliveryHistoryMessage(row, witnesses);
      if (!projected) return [];
      seen.add(row.id);
      return [projected];
    });
  const orderedCurrent = orderRoutingHistory(current);
  const objective = latestRoutingObjective(orderedCurrent);
  const objectiveIds = new Set(objective.map(row => row.id));
  const currentMessages = map(objective);
  // A failed pending turn may span hours. Older customer inputs remain context,
  // including burst fragments, but are not additional questions to answer.
  const history = map(orderRoutingHistory([...prior, ...orderedCurrent.filter(row => !objectiveIds.has(row.id))])).slice(-20);
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
  const projection = await readRoutingHistoryProjection(conversationId);
  const current = await prisma.conversationMessage.findMany({
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
    });
  const ordered = projectRoutingHistory(current, projection, pendingTurnStartedAt);
  const objective = latestRoutingObjective(ordered);
  const objectiveIds = new Set(objective.map(row => row.id));
  const latest = objective.at(-1);
  // Select identity BEFORE filtering moderation. A blocked newest message must
  // never promote an older allowed customer question into the objective.
  const priorSelection = priorCommerceHistorySelection(conversationId, latest ? commerceHistoryActivityAt(latest) ?? pendingTurnStartedAt : pendingTurnStartedAt, latest?.createdAt ? {id:latest.id,createdAt:latest.createdAt} : undefined);
  const prior = await prisma.conversationMessage.findMany({
    ...priorSelection,
    where: projection.excludedMessageIds.length ? { AND: [priorSelection.where, { id: { notIn: projection.excludedMessageIds } }] } : priorSelection.where,
    select,
  });
  // Keep exact persisted inbound quote metadata separate from projected text.
  // Only the bounded, same-conversation read can supply evidence.
  const witnesses = [...current, ...prior].filter(row => row.conversationId === conversationId);
  const historyCandidates = projectRoutingHistory([...prior.reverse(), ...ordered.filter(row => !objectiveIds.has(row.id))], projection)
    .filter(row => !objectiveIds.has(row.id) && historyDelivery(row, witnesses) !== "excluded");
  const uniqueHistory = [...new Map(historyCandidates.map(row => [row.id, row])).values()].slice(-20);
  const [safePrior, safeCurrent] = await Promise.all([
    allowedHistoryCandidates(uniqueHistory), allowedHistoryCandidates(objective),
  ]);
  return boundHistory(safePrior, safeCurrent.length === objective.length ? safeCurrent : [], witnesses);
}
