import { createHash } from "node:crypto";

import { merchantKnowledgeContentUnits } from "./merchant-knowledge-normalization.js";

const CHUNK_SIZE_CODE_POINTS = 1200;
const CHUNK_STEP_CODE_POINTS = 1000;

export interface MerchantKnowledgeChunkContent {
  ordinal: number;
  content: string;
  contentUnits: number;
  contentHash: string;
}

export function chunkMerchantKnowledgeText(content: string): MerchantKnowledgeChunkContent[] {
  const codePoints = [...content];
  const chunks: MerchantKnowledgeChunkContent[] = [];

  for (let start = 0; start < codePoints.length; start += CHUNK_STEP_CODE_POINTS) {
    const chunkContent = codePoints.slice(start, start + CHUNK_SIZE_CODE_POINTS).join("");
    if (chunkContent.length === 0) continue;
    chunks.push({
      ordinal: chunks.length,
      content: chunkContent,
      contentUnits: merchantKnowledgeContentUnits(chunkContent),
      contentHash: createHash("sha256").update(chunkContent, "utf8").digest("hex"),
    });
  }

  return chunks;
}