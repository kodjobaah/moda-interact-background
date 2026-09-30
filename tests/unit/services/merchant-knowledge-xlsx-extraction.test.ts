import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  assertSafeMerchantKnowledgeXlsxEntries,
  assertValidMerchantKnowledgeXlsxEntries,
  extractMerchantKnowledgeXlsx,
  MerchantKnowledgeXlsxExtractionError,
} from "../../../src/services/merchant-knowledge-xlsx-extraction.js";

async function workbookBytes(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const visible = workbook.addWorksheet("Visible");
  visible.addRow(["Name", "", "Details", "Boolean", "Date", "Formula", "No cache"]);
  visible.addRow([
    " Widget ",
    12.5,
    "Description",
    false,
    new Date("2026-09-30T12:00:00.000Z"),
    { formula: "1+1", result: 2 },
    { formula: "1+2" },
  ]);
  visible.addRow([]);
  const hidden = workbook.addWorksheet("Hidden");
  hidden.state = "hidden";
  hidden.addRows([["Secret"], ["not emitted"]]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

describe("extractMerchantKnowledgeXlsx", () => {
  it("extracts only visible worksheets in order with deterministic scalar values and cached formulas", async () => {
    await expect(
      extractMerchantKnowledgeXlsx("catalog.XLSX", await workbookBytes(), 100_000),
    ).resolves.toBe(
      "Worksheet: Visible\nName:  Widget \nColumn 2: 12.5\nDetails: Description\nBoolean: false\nDate: 2026-09-30T12:00:00.000Z\nFormula: 2",
    );
  });

  it("rejects invalid names and malformed ZIP data", async () => {
    await expect(extractMerchantKnowledgeXlsx("catalog.xls", new Uint8Array(), 100)).rejects.toMatchObject({
      code: "INVALID_FILENAME",
    });
    await expect(extractMerchantKnowledgeXlsx("catalog.xlsx", Uint8Array.of(1, 2, 3), 100)).rejects.toMatchObject({
      code: "INVALID_XLSX",
    });
  });

  it("rejects encrypted entries, active content paths, and excessive expanded size", () => {
    const safeEntry = {
      fileName: "xl/worksheets/sheet1.xml",
      uncompressedSize: 10,
      generalPurposeBitFlag: 0,
    };

    expect(() => assertSafeMerchantKnowledgeXlsxEntries([safeEntry], 10)).not.toThrow();
    expect(() => assertSafeMerchantKnowledgeXlsxEntries([safeEntry], 9)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_XLSX" }),
    );
    expect(() => assertSafeMerchantKnowledgeXlsxEntries([
      { ...safeEntry, fileName: "XL/EXTERNALlinks/externalLink1.xml" },
    ], 100)).toThrowError(expect.objectContaining({ code: "UNSAFE_XLSX" }));
    expect(() => assertSafeMerchantKnowledgeXlsxEntries([
      { ...safeEntry, generalPurposeBitFlag: 1 },
    ], 100)).toThrowError(expect.objectContaining({ code: "UNSAFE_XLSX" }));
    expect(MerchantKnowledgeXlsxExtractionError).toBeTypeOf("function");
  });

  it("requires the core OOXML parts in the central directory", () => {
    expect(() => assertValidMerchantKnowledgeXlsxEntries([
      { fileName: "random.txt" },
    ])).toThrowError(expect.objectContaining({ code: "INVALID_XLSX" }));
    expect(() => assertValidMerchantKnowledgeXlsxEntries([
      { fileName: "[Content_Types].xml" },
      { fileName: "xl/workbook.xml" },
    ])).not.toThrow();
  });

  it("checks the archive expansion limit before loading the workbook", async () => {
    const bytes = await workbookBytes();
    await expect(extractMerchantKnowledgeXlsx("catalog.xlsx", bytes, 1)).rejects.toMatchObject({
      code: "UNSAFE_XLSX",
    });
  });
});
