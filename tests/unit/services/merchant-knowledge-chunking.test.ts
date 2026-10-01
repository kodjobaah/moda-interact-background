import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { chunkMerchantKnowledgeText } from "../../../src/services/merchant-knowledge-chunking.js";

describe("chunkMerchantKnowledgeText", () => {
  it("uses deterministic code-point starts and 200-code-point overlap", () => {
    const input = "a".repeat(2201);
    const chunks = chunkMerchantKnowledgeText(input);

    expect(chunks.map(({ ordinal, content }) => [ordinal, content.length])).toEqual([
      [0, 1200],
      [1, 1200],
      [2, 201],
    ]);
    expect(chunks[1]?.content).toBe(input.slice(1000, 2200));
    expect(chunks[2]?.content).toBe(input.slice(2000));
  });

  it("counts code points and hashes exact UTF-8 chunk content", () => {
    const chunks = chunkMerchantKnowledgeText("\u{1f9ed}".repeat(1201));
    expect(chunks.map(({ contentUnits }) => contentUnits)).toEqual([300, 51]);
    expect(chunks[0]?.content).toBe("\u{1f9ed}".repeat(1200));
    expect(chunks[0]?.contentHash).toBe(
      createHash("sha256").update(chunks[0]?.content ?? "", "utf8").digest("hex"),
    );
  });

  it("returns zero chunks for empty input", () => {
    expect(chunkMerchantKnowledgeText("")).toEqual([]);
  });
});