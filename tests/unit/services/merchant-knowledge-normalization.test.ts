import { describe, expect, it } from "vitest";

import {
  countMerchantKnowledgeCodePoints,
  merchantKnowledgeContentUnits,
  normalizeMerchantKnowledgeText,
} from "../../../src/services/merchant-knowledge-normalization.js";

describe("normalizeMerchantKnowledgeText", () => {
  it("applies NFC, line-ending, whitespace, and blank-line normalization in order", () => {
    expect(normalizeMerchantKnowledgeText("  Cafe\u0301\tmenu \r\n\u00a0\n\n\n\n Price  "))
      .toBe("Caf\u00e9 menu\n\nPrice");
  });

  it("converts Unicode White_Space other than LF to spaces", () => {
    expect(normalizeMerchantKnowledgeText("a\u0085\u00a0\u2003b\u2028c\u2029d"))
      .toBe("a b c d");
  });

  it("counts supplementary characters as single code points", () => {
    const normalized = normalizeMerchantKnowledgeText("A\u{1f9ed}B");
    expect(countMerchantKnowledgeCodePoints(normalized)).toBe(3);
    expect(merchantKnowledgeContentUnits(normalized)).toBe(1);
  });

  it("trims only spaces and LF at the boundaries", () => {
    expect(normalizeMerchantKnowledgeText(" \n\u0000 x \u0000 \n "))
      .toBe("\u0000 x \u0000");
  });
});