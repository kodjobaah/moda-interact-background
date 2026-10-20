/**
 * Run explicitly (outside the normal Vitest suite):
 *   node --import tsx --test tests/diagnostics/merchant-knowledge-uploaded-xlsx.diagnostic.ts
 *
 * This uses the merchant's ORIGINAL failed XLSX bytes to guard the
 * SpreadsheetML namespace compatibility fix.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import JSZip from "jszip";

import { extractMerchantKnowledgeXlsx } from "../../src/services/merchant-knowledge-xlsx-extraction.js";

const fileUrl = new URL(
  "../fixtures/merchant-knowledge/moda_merchant_knowledge_support_test.xlsx",
  import.meta.url,
);
const expectedSha256 = "ed12cb0742ee5d5033ba2d982bb58150ccbf56827a3a6a751736b684a3ce2ef7";

async function fixtureBytes(): Promise<Buffer> {
  return readFile(fileUrl);
}

function reportFailure(stage: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[merchant-knowledge-xlsx] stage=${stage} error=${name} message=${JSON.stringify(message)}`,
  );
}

test("original XLSX fixture is unchanged", async () => {
  const bytes = await fixtureBytes();
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256);
});

test("the original uploaded workbook uses prefixed SpreadsheetML elements", async () => {
  const archive = await JSZip.loadAsync(await fixtureBytes());
  const workbook = await archive.file("xl/workbook.xml")?.async("string");
  assert.match(workbook ?? "", /<x:workbook\s/);
  assert.match(workbook ?? "", /<x:sheets>/);
});

test("Moda extracts content from the same original workbook", async () => {
  let text: string;
  try {
    text = await extractMerchantKnowledgeXlsx(
      "moda_merchant_knowledge_support_test.xlsx",
      await fixtureBytes(),
      1_000_000,
    );
  } catch (error) {
    reportFailure("moda_extract", error);
    throw error;
  }
  assert.match(text, /Worksheet: Products/);
  assert.match(text, /Classic Cotton T-Shirt/);
  assert.match(text, /Worksheet: Policies/);
  assert.match(text, /Standard UK delivery/);
  assert.match(text, /Worksheet: FAQ/);
  assert.match(text, /How do I track my order\?/);
});
