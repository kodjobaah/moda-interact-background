import { parse } from "csv-parse/sync";

export class MerchantKnowledgeCsvExtractionError extends Error {
  constructor(readonly code: "INVALID_FILENAME" | "INVALID_UTF8" | "INVALID_CSV") {
    super(code);
    this.name = "MerchantKnowledgeCsvExtractionError";
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

export function extractMerchantKnowledgeCsv(
  filename: string,
  bytes: Uint8Array,
): string {
  if (!filename.toLowerCase().endsWith(".csv")) {
    throw new MerchantKnowledgeCsvExtractionError("INVALID_FILENAME");
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MerchantKnowledgeCsvExtractionError("INVALID_UTF8");
  }

  let records: string[][];
  try {
    records = parse(decoded, {
      bom: true,
      delimiter: ",",
      quote: '"',
      escape: '"',
      skip_empty_lines: true,
      relax_column_count: true,
      record_delimiter: ["\r\n", "\n", "\r"],
    }) as string[][];
  } catch {
    throw new MerchantKnowledgeCsvExtractionError("INVALID_CSV");
  }

  const headerIndex = records.findIndex((record) => record.some((cell) => !isBlank(cell)));
  if (headerIndex < 0) return "";

  const header = records[headerIndex]!.map((cell, index) =>
    isBlank(cell) ? `Column ${index + 1}` : cell!,
  );
  const outputRows: string[] = [];

  for (const record of records.slice(headerIndex + 1)) {
    if (!record.some((cell) => !isBlank(cell))) continue;

    const fields: string[] = [];
    for (let index = 0; index < header.length; index += 1) {
      const value = record[index];
      if (!isBlank(value)) fields.push(`${header[index]}: ${value}`);
    }
    if (fields.length > 0) outputRows.push(fields.join("\n"));
  }

  return outputRows.join("\n\n");
}
