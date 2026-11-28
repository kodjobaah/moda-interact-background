import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  projectRoutingHistory,
  latestRoutingObjective,
  readRoutingHistoryProjection,
} from "../../../../src/services/recovery-sender-pool/routing-projection.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const original = {
  id: "original-message",
  providerMessageId: "original",
  conversationId: "conversation",
  content: "Can it arrive Friday?",
  direction: "INBOUND",
  senderType: "CUSTOMER",
  createdAt: new Date(1000),
};
const selected = {
  ...original,
  id: "selection-message",
  providerMessageId: "selection",
  content: "2. Can I collect on Saturday?",
  createdAt: new Date(5000),
};
const decision = (role = "SELECT_ONLY") => ({
  schemaVersion: 1,
  role,
  currentInboundProviderMessageId: "selection",
  originalTurnId: "original",
  originalInboundProviderMessageId: "original",
  selectedAssignmentConversationId: "conversation",
  associatedMessages: {
    originalMessageId: original.id,
    currentMessageId: selected.id,
  },
  originalTextSha256: hash(original.content),
  currentTextSha256: hash(selected.content),
  clause:
    role === "SELECT_AND_QUESTION"
      ? {
          start: 3,
          end: selected.content.length,
          sha256: hash(selected.content.slice(3)),
        }
      : null,
  moderation: {
    current: { id: "moderation-current", hash: hash(selected.content) },
    original: { id: "moderation-original", hash: hash(original.content) },
    clause: { id: "moderation-clause", hash: hash(selected.content.slice(3)) },
  },
});
function fixture(role = "SELECT_ONLY") {
  const turn = {
    inboundProviderMessageId: "selection",
    resolutionInboundProviderMessageId: "selection",
    resolvedAt: new Date(6000),
    parentProviderMessageId: "original",
    threadId: "thread",
    routeId: "route",
    routingDecision: decision(role),
    parent: {
      inboundProviderMessageId: "original",
      threadId: "thread",
      routeId: "route",
      state: "RESOLVED",
      selectedConversationId: "conversation",
      resolutionInboundProviderMessageId: "selection",
    },
  };
  const db = {
    recoveryBasketRoutingTurn: { findMany: vi.fn().mockResolvedValue([turn]) },
    conversationMessage: {
      findMany: vi.fn().mockResolvedValue([original, selected]),
    },
  };
  return { turn, db };
}
describe("R15 authentic Commerce projection", () => {
  it("hides selection-only text and restores the exact original as current", async () => {
    const f = fixture();
    const projection = await readRoutingHistoryProjection(
      "conversation",
      f.db as never,
    );
    const rows = projectRoutingHistory([selected], projection);
    expect(rows.map((row) => row.content)).toEqual([original.content]);
    expect(latestRoutingObjective(rows).map((row) => row.id)).toEqual([
      original.id,
    ]);
    expect(projection.excludedMessageIds).toEqual([selected.id]);
    expect(f.db.recoveryBasketRoutingTurn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { selectedConversationId: "conversation", state: "RESOLVED" },
      }),
    );
  });
  it("keeps original and exact independently moderated additional clause in one objective", async () => {
    const f = fixture("SELECT_AND_QUESTION");
    const projection = await readRoutingHistoryProjection(
      "conversation",
      f.db as never,
    );
    const rows = projectRoutingHistory([selected], projection);
    expect(latestRoutingObjective(rows).map((row) => row.content)).toEqual([
      original.content,
      "Can I collect on Saturday?",
    ]);
    expect(selected.content).toBe("2. Can I collect on Saturday?");
  });
  it("independent NEW_QUESTION does not promote or consume an older original", async () => {
    const f = fixture("NEW_QUESTION");
    f.turn.parentProviderMessageId = null as never;
    f.turn.parent = null as never;
    const d = f.turn.routingDecision;
    d.originalTurnId = null as never;
    d.originalInboundProviderMessageId = null as never;
    d.associatedMessages.originalMessageId = null as never;
    d.originalTextSha256 = hash(selected.content);
    const projection = await readRoutingHistoryProjection(
      "conversation",
      f.db as never,
    );
    const rows = projectRoutingHistory([original, selected], projection);
    expect(latestRoutingObjective(rows).map((row) => row.content)).toEqual([
      selected.content,
    ]);
  });
  it("uses exact admission readiness when original and selection event times precede the pending window", async () => {
    const f = fixture();
    const projection = await readRoutingHistoryProjection(
      "conversation",
      f.db as never,
    );
    expect(
      projectRoutingHistory([], projection, new Date(6000)).map(
        (row) => row.content,
      ),
    ).toEqual([original.content]);
    expect(projectRoutingHistory([], projection, new Date(6001))).toEqual([]);
  });
  it("ordinary numeric input without resolved routing evidence stays authentic", () => {
    const rows = projectRoutingHistory([{ ...selected, content: "2" }], {
      bindings: [],
      excludedMessageIds: [],
    });
    expect(latestRoutingObjective(rows)[0]?.content).toBe("2");
  });
  it.each(["thread", "route", "resolution"])(
    "rejects foreign %s evidence rather than projecting a selection",
    async (field) => {
      const f = fixture();
      if (field === "thread") f.turn.parent.threadId = "foreign";
      if (field === "route") f.turn.parent.routeId = "foreign";
      if (field === "resolution")
        f.turn.parent.resolutionInboundProviderMessageId = "another-selection";
      await expect(
        readRoutingHistoryProjection("conversation", f.db as never),
      ).rejects.toThrow("routing_history_evidence_invalid");
    },
  );
  it("rejects missing authentic records and altered original or clause text", async () => {
    for (const changed of [
      [original],
      [selected],
      [{ ...original, content: "altered" }, selected],
      [original, { ...selected, content: "2. Another question entirely" }],
      [original, { ...selected, content: "3. Can I collect on Saturday?" }],
    ]) {
      const f = fixture("SELECT_AND_QUESTION");
      f.db.conversationMessage.findMany.mockResolvedValue(changed);
      await expect(
        readRoutingHistoryProjection("conversation", f.db as never),
      ).rejects.toThrow("routing_history_evidence_invalid");
    }
  });
  it("rejects a mutated selection-only control despite an unchanged original", async () => {
    const f = fixture();
    f.db.conversationMessage.findMany.mockResolvedValue([
      original,
      { ...selected, content: "another basket" },
    ]);
    await expect(
      readRoutingHistoryProjection("conversation", f.db as never),
    ).rejects.toThrow("routing_history_evidence_invalid");
  });
  it("does not infer resolver from unresolved or original CLARIFY rows", async () => {
    const f = fixture();
    f.turn.resolutionInboundProviderMessageId = "later-resolver";
    expect(
      await readRoutingHistoryProjection("conversation", f.db as never),
    ).toEqual({ bindings: [], excludedMessageIds: [] });
    expect(f.db.conversationMessage.findMany).not.toHaveBeenCalled();
  });
  it("projects controls before latest selection even when many controls follow the original", async () => {
    const f = fixture();
    const projection = await readRoutingHistoryProjection(
      "conversation",
      f.db as never,
    );
    const rows = projectRoutingHistory([original, selected], projection);
    expect(rows).toHaveLength(1);
    expect(latestRoutingObjective(rows)[0]?.content).toBe(original.content);
  });
});
