import { expect, it, vi } from "vitest";
const findMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../../../src/lib/db.js", () => ({ default: {conversationMessage:{findMany}} }));
import { boundHistory, loadCommerceHistory } from "../../../src/commerce/history.js";
const row = (
  id: string,
  content: string,
  direction = "INBOUND",
  senderType = "CUSTOMER",
) => ({ id, content, direction, senderType });
it("preserves a prior agent question and deduplicates current fragments", () => {
  const result = boundHistory(
    [row("q", "Which size?", "OUTBOUND", "AGENT"), row("a", "large")],
    [row("a", "large")],
  );
  expect(result.history).toEqual([
    { role: "assistant", content: "Which size?" },
  ]);
  expect(result.currentMessages).toEqual([{ role: "user", content: "large" }]);
});
it("drops oldest prior content before current input and bounds Unicode code points", () => {
  const result = boundHistory(
    [row("old", "a".repeat(31990)), row("new", "recent")],
    [row("current", "🙂".repeat(100))],
  );
  expect(result.history).toEqual([{ role: "user", content: "recent" }]);
  expect(result.oversized).toBe(false);
  expect(boundHistory([], [row("big", "a".repeat(32001))]).oversized).toBe(
    true,
  );
});
it("does not present stored template descriptors as actual delivered copy", () => {
  expect(
    boundHistory(
      [row("out", "template: initial", "OUTBOUND", "AUTOMATION")],
      [],
    ).history[0]?.content,
  ).toContain("not a verbatim");
});

it("uses transcript completion rather than original event time to select current audio",async()=>{
 const boundary=new Date(); await loadCommerceHistory("c",boundary);
 const current=findMany.mock.calls.at(-2)?.[0];
 expect(current.where.AND[1].OR).toContainEqual({contentType:"AUDIO",transcriptionCompletedAt:{gte:boundary}});
 expect(current.where.AND[0].transcriptionStatus.in).toEqual(["NOT_REQUIRED","COMPLETED"]);
});

it("demotes the failed categories backlog while keeping only the latest exact question current",()=>{
 const result=boundHistory([], [row('old','What categories do you sell?'),row('latest','Tell me about The Videographer Snowboard')]);
 expect(result.currentMessages).toEqual([{role:'user',content:'Tell me about The Videographer Snowboard'}]);
 expect(result.history).toEqual([{role:'user',content:'What categories do you sell?'}]);
});
it("retains burst fragments as context for the latest continuation without a second objective",()=>{
 const result=boundHistory([row('merchant','We stock red and blue','OUTBOUND','HUMAN')],[row('first','The snowboard'),row('last','in blue please')]);
 expect(result.currentMessages).toEqual([{role:'user',content:'in blue please'}]);
 expect(result.history.at(-1)).toEqual({role:'user',content:'The snowboard'});
 expect(result.history[0]!.content).toContain('Merchant-authored');
});
it("selects delayed audio by ready time and deterministically breaks timestamp ties",()=>{
 const earlier=new Date('2026-11-14T17:25:20Z'),later=new Date('2026-11-15T01:02:03Z');
 const audio={...row('audio','completed audio question'),contentType:'AUDIO',createdAt:earlier,transcriptionCompletedAt:later};
 const text={...row('text','old text question'),contentType:'TEXT',createdAt:new Date(later.getTime()-1000)};
 expect(boundHistory([],[audio,text]).currentMessages).toEqual([{role:'user',content:'completed audio question'}]);
 expect(boundHistory([],[{...text,id:'b',createdAt:later},{...text,id:'a',createdAt:later}]).currentMessages).toEqual([{role:'user',content:'old text question'}]);
 const tied=boundHistory([],[{...text,id:'b',content:'B',createdAt:later},{...text,id:'a',content:'A',createdAt:later}]);expect(tied.currentMessages[0]!.content).toBe('B');
});
