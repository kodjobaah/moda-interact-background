import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * This is an Admin-prepared transport, NOT the WhatsApp authoring AST.
 * Every protected marker identifies one occurrence; `variable` is a non-sensitive
 * semantic hint, not a customer's value. Never include an AST in the Batch input.
 */
const ProtectedOccurrence = z.object({
  marker: z.string().min(1).max(128),
  variable: z.string().min(1).max(128),
  hint: z.string().max(256).optional(),
}).strict();
const SourceSegment = z.object({
  key: z.string().min(1).max(256),
  text: z.string().min(1).max(4096),
  protectedTokens: z.array(ProtectedOccurrence).max(64).optional(),
  context: z.string().max(512).optional(),
}).strict();
const SnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  definitionId: z.string().min(1).optional(),
  sourceHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  sourceLanguageTag: z.string().min(2).max(16),
  segments: z.array(SourceSegment).min(1).max(64),
}).strict();
const ResultSchema = z.object({
  schemaVersion: z.literal(1),
  segments: z.array(z.object({
    key: z.string().min(1).max(256),
    text: z.string().min(1).max(8192),
  }).strict()).min(1).max(64),
}).strict();

export type TemplateSourceSnapshot = z.infer<typeof SnapshotSchema>;
export type KeyedTranslationResult = z.infer<typeof ResultSchema>;

export class TemplateTranslationValidationError extends Error {
  constructor(readonly code: string) {
    super(code); // Never echo customer text or provider payloads in exceptions/logs.
    this.name = "TemplateTranslationValidationError";
  }
}

export function parseTemplateTranslationSnapshot(raw: unknown, expected: {
  definitionId: string;
  sourceHash: string;
  sourceLanguageTag?: string;
  sourceSchemaVersion?: number;
}): TemplateSourceSnapshot {
  const decoded = SnapshotSchema.safeParse(raw);
  if (!decoded.success) throw new TemplateTranslationValidationError("INVALID_SOURCE_SEGMENTS_V1");
  const snapshot = decoded.data;
  if (snapshot.definitionId !== undefined && snapshot.definitionId !== expected.definitionId ||
      snapshot.sourceHash !== expected.sourceHash ||
      expected.sourceSchemaVersion !== undefined && expected.sourceSchemaVersion !== snapshot.schemaVersion ||
      expected.sourceLanguageTag !== undefined && expected.sourceLanguageTag !== snapshot.sourceLanguageTag) {
    throw new TemplateTranslationValidationError("STALE_SOURCE_SNAPSHOT");
  }
  const keys = new Set<string>();
  const markers = new Set<string>();
  for (const segment of snapshot.segments) {
    if (keys.has(segment.key)) throw new TemplateTranslationValidationError("DUPLICATE_SOURCE_KEY");
    keys.add(segment.key);
    for (const token of segment.protectedTokens ?? []) {
      if ((segment.protectedTokens ?? []).some((other) => other !== token && (other.marker.includes(token.marker) || token.marker.includes(other.marker)))) {
        throw new TemplateTranslationValidationError("OVERLAPPING_PROTECTED_TOKENS");
      }
      if (markers.has(token.marker) || !segment.text.includes(token.marker) ||
          segment.text.indexOf(token.marker) !== segment.text.lastIndexOf(token.marker)) {
        throw new TemplateTranslationValidationError("INVALID_PROTECTED_TOKEN_IDENTITY");
      }
      markers.add(token.marker);
    }
    // Without an explicit token map, numbered Meta variables cannot be trusted
    // to survive translation. Only Admin decides which placeholders are semantic.
    const rawParameters = segment.text.match(/\{\{[^{}]+\}\}/g) ?? [];
    for (const parameter of rawParameters) {
      if (!(segment.protectedTokens ?? []).some((token) => token.marker === parameter)) {
        throw new TemplateTranslationValidationError("UNPROTECTED_VARIABLE");
      }
    }
  }
  return snapshot;
}

export type PreparedSegmentTranslation = {
  requestText: string;
  restore(providerText: string): KeyedTranslationResult;
};

export function prepareTemplateTranslation(snapshot: TemplateSourceSnapshot): PreparedSegmentTranslation {
  const restoreMaps = new Map<string, Array<{ sentinel: string; marker: string }>>();
  const encodedSegments = snapshot.segments.map((segment, segmentIndex) => {
    const tokens = (segment.protectedTokens ?? []).map((token, tokenIndex) => {
      // Stable per-run position, deliberately independent of semantic variables.
      const sentinel = `__MODA_PROTECTED_${segmentIndex}_${tokenIndex}__`;
      if (segment.text.includes(sentinel)) throw new TemplateTranslationValidationError("SENTINEL_COLLISION");
      return { sentinel, marker: token.marker };
    });
    restoreMaps.set(segment.key, tokens);
    let text = segment.text;
    for (const token of tokens) text = text.replace(token.marker, token.sentinel);
    return { key: segment.key, text,
      ...(segment.context ? { context: segment.context } : {}),
      protectedTokens: tokens.map((token, index) => ({
        sentinel: token.sentinel, variable: segment.protectedTokens![index]!.variable,
        ...(segment.protectedTokens![index]!.hint ? { hint: segment.protectedTokens![index]!.hint } : {}),
      })),
    };
  });
  const requestText = JSON.stringify({ schemaVersion: 1, segments: encodedSegments });
  if (requestText.length > 12_000) throw new TemplateTranslationValidationError("SOURCE_TOO_LARGE_FOR_BATCH");
  return {
    requestText,
    restore(providerText) {
      let decoded: unknown;
      try { decoded = JSON.parse(providerText); }
      catch { throw new TemplateTranslationValidationError("INVALID_PROVIDER_JSON"); }
      const parsed = ResultSchema.safeParse(decoded);
      if (!parsed.success) throw new TemplateTranslationValidationError("INVALID_TRANSLATED_SEGMENTS");
      if (parsed.data.segments.length !== snapshot.segments.length) {
        throw new TemplateTranslationValidationError("SEGMENT_MEMBERSHIP_MISMATCH");
      }
      const resultMap = new Map<string, string>();
      for (const segment of parsed.data.segments) {
        if (resultMap.has(segment.key) || !restoreMaps.has(segment.key)) {
          throw new TemplateTranslationValidationError("SEGMENT_MEMBERSHIP_MISMATCH");
        }
        resultMap.set(segment.key, segment.text);
      }
      // Always persist in source-key order, never provider order. Token identities
      // must match per segment, but occurrence positions may legitimately change.
      const segments = snapshot.segments.map((source) => {
        const rawText = resultMap.get(source.key);
        if (rawText === undefined) throw new TemplateTranslationValidationError("SEGMENT_MEMBERSHIP_MISMATCH");
        const tokens = restoreMaps.get(source.key)!;
        let text = rawText;
        const found = rawText.match(/__MODA_PROTECTED_[0-9]+_[0-9]+__/g) ?? [];
        if (found.length !== tokens.length || tokens.some((token) =>
          found.filter((actual) => actual === token.sentinel).length !== 1)) {
          throw new TemplateTranslationValidationError("PROTECTED_TOKEN_MISMATCH");
        }
        // A marker leaked or a placeholder invented outside the recognised set.
        for (const original of snapshot.segments) {
          for (const token of original.protectedTokens ?? []) {
            if (text.includes(token.marker)) throw new TemplateTranslationValidationError("UNEXPECTED_PROTECTED_TOKEN");
          }
        }
        if (/\{\{[^{}]+\}\}/.test(text)) throw new TemplateTranslationValidationError("INVENTED_VARIABLE");
        for (const token of tokens) text = text.replace(token.sentinel, token.marker);
        if (/__MODA_PROTECTED_/.test(text)) throw new TemplateTranslationValidationError("INVENTED_TOKEN");
        return { key: source.key, text };
      });
      return { schemaVersion: 1, segments };
    },
  };
}

export function templateTranslationContentHash(result: KeyedTranslationResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}
