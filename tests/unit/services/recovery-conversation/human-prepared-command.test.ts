import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  HumanPreparedCommandService, currentHumanWrapperMatches, parsePreparedEvidence,
} from "../../../../src/services/recovery-conversation/human-prepared-command.service.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const text = "Original merchant reply";
const claim = { id: "command-1", shopId: "shop-1", conversationId: "conversation-1",
  kind: "HUMAN_TEXT" as const, textBody: text };
const frozenAt = new Date("2026-10-26T00:00:00Z");
const passthrough = { schemaVersion: 1 as const, outcome: "PASSTHROUGH" as const,
  reason: "NOT_CONFIGURED" as const, bodySha256: sha(text) };

function mockDb(initial: { body: string | null; evidence: unknown; at: Date | null }) {
  const state = { kind: "HUMAN_TEXT", conversationId: claim.conversationId, textBody: text,
    preparedTextBody: initial.body, preparedWrapperEvidence: initial.evidence, preparedAt: initial.at };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('UPDATE "whatsapp"."MerchantConversationSendCommand"')) {
      if (state.preparedTextBody !== null) return [];
      state.preparedTextBody = text;
      state.preparedWrapperEvidence = passthrough;
      state.preparedAt = frozenAt;
    }
    return [{ ...state }];
  });
  const db = { $queryRawUnsafe: query };
  return { db, query, state };
}

describe("ARCH-047-BG009 immutable prepared HUMAN_TEXT", () => {
  it("freezes original passthrough once with a lease-fenced CAS; replay never re-renders", async () => {
    const x = mockDb({ body: null, evidence: null, at: null });
    const renderer = { prepare: vi.fn(async () => ({ kind: "passthrough" as const, body: text })) };
    const svc = new HumanPreparedCommandService(x.db as never, renderer);
    expect(await svc.freeze(claim, "valid-lease")).toEqual({ kind: "frozen", body: text, evidence: passthrough });
    expect(await svc.freeze(claim, "valid-lease")).toEqual({ kind: "frozen", body: text, evidence: passthrough });
    expect(renderer.prepare).toHaveBeenCalledTimes(1);
    const sql = x.query.mock.calls.find(([sql]) => sql.includes('UPDATE "whatsapp"'))?.[0] ?? "";
    expect(sql).toContain('"leaseExpiresAt">statement_timestamp()');
    expect(sql).toContain('"preparedTextBody" IS NULL');
    expect(sql).toContain('"providerDispatchKey" IS NULL');
  });

  it("refuses absent/partial/bad digest evidence instead of emitting original text", async () => {
    for (const bad of [null, { ...passthrough, bodySha256: sha("different") },
      { ...passthrough, schemaVersion: 999 }]) {
      expect(parsePreparedEvidence(text, bad, frozenAt)).toBeNull();
    }
    const x = mockDb({ body: text, evidence: { ...passthrough, bodySha256: sha("tampered") }, at: frozenAt });
    const renderer = { prepare: vi.fn() };
    expect(await new HumanPreparedCommandService(x.db as never, renderer as never).freeze(claim, "lease"))
      .toEqual({ kind: "refused", reason: "prepared_invalid" });
    expect(renderer.prepare).not.toHaveBeenCalled();
  });

  it("refuses an expired lease without rendering or changing the accepted command", async () => {
    const db = { $queryRawUnsafe: vi.fn(async () => []) };
    const renderer = { prepare: vi.fn() };
    expect(await new HumanPreparedCommandService(db as never, renderer as never).freeze(claim, "expired-lease"))
      .toEqual({ kind: "refused", reason: "invalid_lease" });
    expect(renderer.prepare).not.toHaveBeenCalled();
  });

  it("blocks passthrough at final admission if an Admin activates a wrapper", async () => {
    const db = { $queryRawUnsafe: vi.fn(async () => [{
      audience: "HUMAN", definitionId: "other", editVersion: 1, kind: "MODA_CONVERSATION_WRAPPER",
      definitionAudience: "HUMAN", status: "PUBLISHED", publishedAt: frozenAt,
      retiredAt: null, sourceLanguageTag: "en", astSchemaVersion: 1,
    }]) };
    expect(await currentHumanWrapperMatches(db as never, text, passthrough, frozenAt)).toBe(false);
  });

  it("permits explicit no-wrapper evidence only while no active slot exists", async () => {
    const db = { $queryRawUnsafe: vi.fn(async () => []) };
    expect(await currentHumanWrapperMatches(db as never, text, passthrough, frozenAt)).toBe(true);
    expect(await currentHumanWrapperMatches(db as never, "tampered", passthrough, frozenAt)).toBe(false);
  });
});
