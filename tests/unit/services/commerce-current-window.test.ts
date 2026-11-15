vi.mock("../../../src/services/recovery-sender-pool/routing-projection.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/services/recovery-sender-pool/routing-projection.js")>(),
  readRoutingHistoryProjection: vi.fn(async () => ({ bindings: [], excludedMessageIds: [] })),
}));
import { expect, it, vi } from "vitest";
const { findMany, moderate } = vi.hoisted(() => ({ findMany: vi.fn(), moderate: vi.fn(async (rows: any[]) => rows.filter(row => row.id !== "blocked")) }));
vi.mock("../../../src/lib/db.js", () => ({ default: { conversationMessage: { findMany } } }));
vi.mock("../../../src/services/conversation-moderation/moderation-history.js", () => ({ allowedHistoryCandidates: moderate }));
import { loadCommerceHistory } from "../../../src/commerce/history.js";
it("loads only the current conversation customer window with transcript readiness, moderation and deterministic order", async () => {
 const boundary = new Date("2026-11-12T00:00:00Z");
 const row = (id: string, content: string) => ({ id, content, direction: "INBOUND", senderType: "CUSTOMER" });
 findMany.mockResolvedValueOnce([row("first", "First current fragment"), row("blocked", "Blocked text"), row("second", "New named subject")]);
 findMany.mockResolvedValueOnce([{ id: "merchant", content: "Old merchant reply", direction: "OUTBOUND", senderType: "HUMAN" }]);
 const result = await loadCommerceHistory("conversation", boundary);
 const query = findMany.mock.calls[0]![0];
 expect(query.where.AND[1]).toMatchObject({ conversationId: "conversation", direction: "INBOUND", senderType: "CUSTOMER" });
 expect(query.where.AND[1].OR).toEqual([{ contentType: { not: "AUDIO" }, createdAt: { gte: boundary } }, { contentType: "AUDIO", transcriptionCompletedAt: { gte: boundary } }]);
 expect(query.where.AND[0]).toMatchObject({ contentType: { not: "UNSUPPORTED" }, transcriptionStatus: { in: ["NOT_REQUIRED", "COMPLETED"] } });
 expect(query.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
 expect(moderate).toHaveBeenCalledTimes(2);
 expect(result.currentMessages).toEqual([{ role: "user", content: "New named subject" }]);
 expect(result.history).toContainEqual({role:"user",content:"First current fragment"});
 expect(result.history[0]!.content).toContain("Merchant-authored");
 expect(result.currentMessages.some(row => row.content.includes("merchant") || row.content.includes("Blocked"))).toBe(false);
});

it("does not resurrect an old allowed question when the newest question is blocked",async()=>{
 findMany.mockReset();moderate.mockClear();
 const row=(id:string)=>({id,content:id,direction:'INBOUND',senderType:'CUSTOMER'});
 findMany.mockResolvedValueOnce([row('old'),row('blocked')]).mockResolvedValueOnce([]);
 const result=await loadCommerceHistory('c',new Date());
 expect(result.currentMessages).toEqual([]);expect(result.history).toContainEqual({role:'user',content:'old'});
});

it('projects a newly admitted selection before latest identity and SQL history caps', async () => {
 const { readRoutingHistoryProjection } = await import('../../../src/services/recovery-sender-pool/routing-projection.js');
 const at = new Date('2026-11-15T12:00:00Z');
 const original = {id:'original',content:'Can it arrive Friday?',direction:'INBOUND',senderType:'CUSTOMER',createdAt:new Date(at.getTime()-60000)};
 const current = {id:'control',content:'running shoes',direction:'INBOUND',senderType:'CUSTOMER',createdAt:new Date(at.getTime()-1000)};
 vi.mocked(readRoutingHistoryProjection).mockResolvedValueOnce({bindings:[{role:'SELECT_ONLY',original,current,clause:null,group:'selection',at}],excludedMessageIds:['control']} as never);
 findMany.mockReset();moderate.mockClear();
 findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([current]);
 const result = await loadCommerceHistory('conversation',at);
 expect(result.currentMessages).toEqual([{role:'user',content:original.content}]);
 expect(result.history).toEqual([]);
 expect(findMany.mock.calls[1]![0].where.AND[1]).toEqual({id:{notIn:['control']}});
});
