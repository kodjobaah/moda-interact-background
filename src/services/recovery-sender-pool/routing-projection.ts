import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import prisma from '../../lib/db.js';
import { commerceHistoryActivityAt, orderCommerceHistory } from '../../commerce/history-selection.js';

/** Projection metadata is ephemeral. Authentic transcript content is never rewritten. */
export type RoutingHistoryRow = {
  id: string; content: string; direction: string; senderType: string;
  createdAt?: Date; contentType?: string; transcriptionStatus?: string;
  transcriptionCompletedAt?: Date | null;
  routingObjectiveGroup?: string; routingActivityAt?: Date; routingObjectiveOrder?: number;
};
type MessageRow = RoutingHistoryRow & { conversationId: string; providerMessageId: string | null };
type Binding = { role: 'SELECT_ONLY' | 'SELECT_AND_QUESTION' | 'NEW_QUESTION';
  current: MessageRow; original: MessageRow | null;
  clause: { start: number; end: number; sha256: string } | null; group: string; at: Date };
export type RoutingHistoryProjection = { bindings: Binding[]; excludedMessageIds: string[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const invalid = (): never => { throw new Error('routing_history_evidence_invalid'); };
const messageSelect = { id: true, conversationId: true, providerMessageId: true, content: true,
  direction: true, senderType: true, createdAt: true, contentType: true,
  transcriptionStatus: true, transcriptionCompletedAt: true } as const;

/** Read only terminal, explicitly associated decisions for this exact Conversation.
 * No pending input, candidates, merchant history or reverse-child inference is read. */
export async function readRoutingHistoryProjection(conversationId: string, database: PrismaClient = prisma): Promise<RoutingHistoryProjection> {
  const turns = await database.recoveryBasketRoutingTurn.findMany({
    where: { selectedConversationId: conversationId, state: 'RESOLVED' },
    select: { inboundProviderMessageId: true, resolutionInboundProviderMessageId: true,
      parentProviderMessageId: true, threadId: true, routeId: true, routingDecision: true, resolvedAt: true,
      parent: { select: { inboundProviderMessageId: true, threadId: true, routeId: true,
        state: true, selectedConversationId: true, resolutionInboundProviderMessageId: true } } },
  });
  const resolvers = turns.filter(turn => turn.resolutionInboundProviderMessageId === turn.inboundProviderMessageId);
  const parsed = resolvers.map(turn => {
    const d = turn.routingDecision;
    if (!object(d) || d.schemaVersion !== 1 ||
      !['SELECT_ONLY', 'SELECT_AND_QUESTION', 'NEW_QUESTION'].includes(String(d.role)) ||
      d.currentInboundProviderMessageId !== turn.inboundProviderMessageId ||
      d.selectedAssignmentConversationId !== conversationId || !object(d.associatedMessages) ||
      typeof d.associatedMessages.currentMessageId !== 'string') invalid();
    const decision = d as Record<string, unknown>;
    const associated = decision.associatedMessages as Record<string, unknown>;
    const selection = decision.role !== 'NEW_QUESTION';
    if (selection && (typeof associated.originalMessageId !== 'string' ||
      decision.originalTurnId !== turn.parentProviderMessageId || !turn.parent ||
      turn.parent.inboundProviderMessageId !== decision.originalTurnId ||
      turn.parent.threadId !== turn.threadId || turn.parent.routeId !== turn.routeId ||
      turn.parent.state !== 'RESOLVED' || turn.parent.selectedConversationId !== conversationId ||
      turn.parent.resolutionInboundProviderMessageId !== turn.inboundProviderMessageId)) invalid();
    return { turn, decision, currentId: associated.currentMessageId as string,
      originalId: selection ? associated.originalMessageId as string : null };
  });
  if (!parsed.length) return { bindings: [], excludedMessageIds: [] };
  const ids = [...new Set(parsed.flatMap(item => [item.currentId, ...(item.originalId ? [item.originalId] : [])]))];
  const messages = await database.conversationMessage.findMany({ where: { conversationId, id: { in: ids } }, select: messageSelect });
  const byId = new Map(messages.map(message => [message.id, message]));
  const bindings: Binding[] = parsed.map(({ turn, decision, currentId, originalId }) => {
    const current = byId.get(currentId), original = originalId ? byId.get(originalId) : null;
    if (!current || current.conversationId !== conversationId || current.direction !== 'INBOUND' ||
      current.senderType !== 'CUSTOMER' || current.providerMessageId !== turn.inboundProviderMessageId ||
      hash(current.content) !== decision.currentTextSha256 || !object(decision.moderation) ||
      !object(decision.moderation.current) || typeof decision.moderation.current.id !== 'string' ||
      decision.moderation.current.hash !== decision.currentTextSha256 ||
      originalId && (!original || original.conversationId !== conversationId || original.direction !== 'INBOUND' ||
        original.senderType !== 'CUSTOMER' || original.providerMessageId !== decision.originalInboundProviderMessageId ||
        hash(original.content) !== decision.originalTextSha256)) invalid();
    if (decision.role === 'NEW_QUESTION' && (
      decision.originalTurnId !== null && decision.originalTurnId !== turn.inboundProviderMessageId ||
      hash(current!.content) !== decision.originalTextSha256)) invalid();
    let clause: Binding['clause'] = null;
    if (decision.role === 'SELECT_AND_QUESTION') {
      const c = decision.clause;
      if (!object(c) || !Number.isInteger(c.start) || !Number.isInteger(c.end) ||
        (c.start as number) < 0 || (c.end as number) <= (c.start as number) ||
        (c.end as number) > current!.content.length || typeof c.sha256 !== 'string') invalid();
      clause = c as Binding['clause'];
      if (hash(current!.content.slice(clause!.start, clause!.end)) !== clause!.sha256 ||
        !object(decision.moderation) || !object(decision.moderation.clause) ||
        decision.moderation.clause.hash !== clause!.sha256 || typeof decision.moderation.clause.id !== 'string') invalid();
    } else if (decision.clause !== null) invalid();
    const at = turn.resolvedAt;
    if (!at || !Number.isFinite(at.getTime())) invalid();
    return { role: decision.role as Binding['role'], current: current!, original: original ?? null,
      clause, group: turn.inboundProviderMessageId, at: at! };
  });
  return { bindings, excludedMessageIds: bindings.filter(b => b.role === 'SELECT_ONLY').map(b => b.current.id) };
}

/** Apply role semantics before chronology, newest-question selection or any cap. */
export function projectRoutingHistory(rows: RoutingHistoryRow[], projection: RoutingHistoryProjection, pendingSince?: Date): RoutingHistoryRow[] {
  const input = new Map<string, RoutingHistoryRow>(rows.map(row => [row.id, row]));
  for (const binding of projection.bindings) {
    const present = input.has(binding.current.id) || !!binding.original && input.has(binding.original.id) ||
      !!pendingSince && binding.at >= pendingSince;
    if (!present) continue;
    input.delete(binding.current.id);
    if (binding.original) input.set(binding.original.id, { ...binding.original,
      routingObjectiveGroup: binding.group, routingActivityAt: binding.at, routingObjectiveOrder: 0 });
    if (binding.role !== 'SELECT_ONLY') input.set(binding.current.id, { ...binding.current,
      content: binding.clause ? binding.current.content.slice(binding.clause.start, binding.clause.end) : binding.current.content,
      routingObjectiveGroup: binding.group, routingActivityAt: binding.at, routingObjectiveOrder: 1 });
  }
  return orderRoutingHistory([...input.values()]);
}
export function orderRoutingHistory<T extends RoutingHistoryRow>(rows: T[]): T[] {
  return orderCommerceHistory(rows.map(row => row.routingActivityAt
    ? { ...row, createdAt: row.routingActivityAt, transcriptionCompletedAt: row.contentType === 'AUDIO' ? row.routingActivityAt : row.transcriptionCompletedAt }
    : row)).sort((a, b) => {
      const left = commerceHistoryActivityAt(a)?.getTime(), right = commerceHistoryActivityAt(b)?.getTime();
      if (left === undefined || right === undefined) return 0;
      return left - right ||
        (a.routingObjectiveGroup ?? a.id).localeCompare(b.routingObjectiveGroup ?? b.id) ||
        (a.routingObjectiveOrder ?? 0) - (b.routingObjectiveOrder ?? 0);
    });
}
export function latestRoutingObjective<T extends RoutingHistoryRow>(rows: T[]): T[] {
  const ordered = orderRoutingHistory(rows), last = ordered.at(-1);
  if (!last) return [];
  return last.routingObjectiveGroup ? ordered.filter(row => row.routingObjectiveGroup === last.routingObjectiveGroup) : [last];
}
