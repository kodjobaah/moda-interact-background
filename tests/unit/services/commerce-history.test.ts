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
 const current=findMany.mock.calls.at(-1)?.[0];
 expect(current.where.AND[1].OR).toContainEqual({contentType:"AUDIO",transcriptionCompletedAt:{gte:boundary}});
 expect(current.where.AND[0].transcriptionStatus.in).toEqual(["NOT_REQUIRED","COMPLETED"]);
});
