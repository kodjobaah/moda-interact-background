import { describe, expect, it } from "vitest";

import {
  extractMerchantKnowledgeCsv,
  MerchantKnowledgeCsvExtractionError,
} from "../../../src/services/merchant-knowledge-csv-extraction.js";

const encode = (input: string) => new TextEncoder().encode(input);

describe("extractMerchantKnowledgeCsv", () => {
  it("uses the first non-empty record as ordered headers and handles BOM, quotes, and multiline values", () => {
    const extracted = extractMerchantKnowledgeCsv(
      "catalog.CSV",
      encode('\uFEFF,,Notes,Extra\r\n\r\nA,"Tea, loose","line one\nline ""two""",ignored\nB, ,tail\r\n'),
    );

    expect(extracted).toBe(
      "Column 1: A\nColumn 2: Tea, loose\nNotes: line one\nline \"two\"\nExtra: ignored\n\nColumn 1: B\nNotes: tail",
    );
  });

  it("ignores empty records, omits blank cells, and ignores cells beyond the header", () => {
    expect(
      extractMerchantKnowledgeCsv(
        "records.csv",
        encode('Name,Description,\n\nWidget,,ignored\n,,\nGadget,Useful,extra,extra\n'),
      ),
    ).toBe("Name: Widget\nColumn 3: ignored\n\nName: Gadget\nDescription: Useful\nColumn 3: extra");
  });

  it("returns empty text when there is no non-empty record", () => {
    expect(extractMerchantKnowledgeCsv("empty.csv", encode("\r\n\n"))).toBe("");
  });

  it("requires the CSV extension and valid UTF-8", () => {
    expect(() => extractMerchantKnowledgeCsv("catalog.xlsx", encode("a,b"))).toThrowError(
      expect.objectContaining({ code: "INVALID_FILENAME" }),
    );
    expect(() => extractMerchantKnowledgeCsv("catalog.csv", Uint8Array.of(0xc3, 0x28))).toThrowError(
      expect.objectContaining({ code: "INVALID_UTF8" }),
    );
  });

  it("rejects malformed quoted input", () => {
    expect(() => extractMerchantKnowledgeCsv("catalog.csv", encode('name\n"unterminated'))).toThrowError(
      expect.objectContaining({
        name: "MerchantKnowledgeCsvExtractionError",
        code: "INVALID_CSV",
      }),
    );
    expect(MerchantKnowledgeCsvExtractionError).toBeTypeOf("function");
  });
});
