import ExcelJS from "exceljs";
import yauzl, { type Entry } from "yauzl";

export class MerchantKnowledgeXlsxExtractionError extends Error {
  constructor(readonly code: "INVALID_FILENAME" | "INVALID_XLSX" | "UNSAFE_XLSX") {
    super(code);
    this.name = "MerchantKnowledgeXlsxExtractionError";
  }
}

const forbiddenArchivePaths = [
  "xl/vbaproject.bin",
  "xl/externallinks/",
  "xl/embeddings/",
  "xl/oleobjects/",
  "xl/connections.xml",
] as const;

type ArchiveEntryMetadata = Pick<
  Entry,
  "fileName" | "uncompressedSize" | "generalPurposeBitFlag"
>;

export function assertSafeMerchantKnowledgeXlsxEntries(
  entries: readonly ArchiveEntryMetadata[],
  maximumUncompressedBytes: number,
): void {
  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
      throw new MerchantKnowledgeXlsxExtractionError("UNSAFE_XLSX");
    }

    const normalizedPath = entry.fileName.replaceAll("\\", "/").toLowerCase();
    if (forbiddenArchivePaths.some((path) =>
      path.endsWith("/")
        ? normalizedPath.startsWith(path)
        : normalizedPath === path,
    )) {
      throw new MerchantKnowledgeXlsxExtractionError("UNSAFE_XLSX");
    }

    if (
      !Number.isSafeInteger(entry.uncompressedSize)
      || entry.uncompressedSize < 0
      || totalUncompressedBytes > maximumUncompressedBytes - entry.uncompressedSize
    ) {
      throw new MerchantKnowledgeXlsxExtractionError("UNSAFE_XLSX");
    }
    totalUncompressedBytes += entry.uncompressedSize;
  }
}

export function assertValidMerchantKnowledgeXlsxEntries(
  entries: readonly Pick<ArchiveEntryMetadata, "fileName">[],
): void {
  const paths = new Set(entries.map((entry) => entry.fileName.replaceAll("\\", "/").toLowerCase()));
  if (!paths.has("[content_types].xml") || !paths.has("xl/workbook.xml")) {
    throw new MerchantKnowledgeXlsxExtractionError("INVALID_XLSX");
  }
}

async function readCentralDirectory(bytes: Uint8Array): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(new MerchantKnowledgeXlsxExtractionError("INVALID_XLSX"));
          return;
        }

        const entries: Entry[] = [];
        let settled = false;
        const fail = (failure: Error) => {
          if (settled) return;
          settled = true;
          zipfile.close();
          reject(failure);
        };

        zipfile.on("error", () => fail(new MerchantKnowledgeXlsxExtractionError("INVALID_XLSX")));
        zipfile.on("entry", (entry) => {
          entries.push(entry);
          zipfile.readEntry();
        });
        zipfile.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(entries);
        });
        zipfile.readEntry();
      },
    );
  });
}

function scalar(value: ExcelJS.CellValue | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object" && "formula" in value) {
    return scalar(value.result as ExcelJS.CellValue | undefined);
  }

  return undefined;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

export async function extractMerchantKnowledgeXlsx(
  filename: string,
  bytes: Uint8Array,
  maximumUncompressedBytes: number,
): Promise<string> {
  if (!filename.toLowerCase().endsWith(".xlsx")) {
    throw new MerchantKnowledgeXlsxExtractionError("INVALID_FILENAME");
  }
  if (!Number.isSafeInteger(maximumUncompressedBytes) || maximumUncompressedBytes <= 0) {
    throw new MerchantKnowledgeXlsxExtractionError("UNSAFE_XLSX");
  }

  const entries = await readCentralDirectory(bytes);
  if (entries.length === 0) {
    throw new MerchantKnowledgeXlsxExtractionError("INVALID_XLSX");
  }
  assertValidMerchantKnowledgeXlsxEntries(entries);
  assertSafeMerchantKnowledgeXlsxEntries(entries, maximumUncompressedBytes);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new MerchantKnowledgeXlsxExtractionError("INVALID_XLSX");
  }

  const outputRows: string[] = [];
  for (const worksheet of workbook.worksheets) {
    if (worksheet.state !== "visible") continue;

    let header: string[] | undefined;
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.from({ length: row.cellCount }, (_, index) =>
        scalar(row.getCell(index + 1).value),
      );

      if (!header) {
        if (!values.some((value) => !isBlank(value))) return;
        header = values.map((value, index) =>
          isBlank(value) ? `Column ${index + 1}` : value!,
        );
        return;
      }

      if (!values.some((value) => !isBlank(value))) return;
      const fields = [`Worksheet: ${worksheet.name}`];
      for (let index = 0; index < header.length; index += 1) {
        const value = values[index];
        if (!isBlank(value)) fields.push(`${header[index]}: ${value}`);
      }
      if (fields.length > 1) outputRows.push(fields.join("\n"));
    });
  }

  return outputRows.join("\n\n");
}
