import { describe, expect, it, vi } from "vitest";
import { createOpenAITranslationProvider } from "../../../../src/providers/translation.provider.js";
import { TemplateTranslationBatchLifecycle } from "../../../../src/services/template-translation/lifecycle.js";
import { TemplateTranslationRepository } from "../../../../src/services/template-translation/repository.js";
import { prepareTemplateTranslation, parseTemplateTranslationSnapshot } from "../../../../src/services/template-translation/segment-codec.js";
import { backgroundRuntimeConfig } from "../../../helpers/background-runtime-config.js";
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("../../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
const hash = "a".repeat(64);
const snapshot = parseTemplateTranslationSnapshot({ schemaVersion: 1, definitionId: "synthetic-definition",
  sourceHash: hash, sourceLanguageTag: "en", segments: [
    { key: "body", text: "Hello <PERSON>", protectedTokens: [{ marker: "<PERSON>", variable: "person.name" }] },
  ] }, { definitionId: "synthetic-definition", sourceHash: hash });
const valid = { schemaVersion: 1, segments: [{ key: "body", text: "Merhaba __MODA_PROTECTED_0_0__" }] };

async function ingest(body: unknown, error?: unknown) {
  const repository = new TemplateTranslationRepository({} as never);
  vi.spyOn(repository, "loadBatch").mockResolvedValue({ id: "run-id", definitionId: "synthetic-definition",
    sourceHash: hash, definitionSourceHash: hash, sourceSchemaVersion: 1, sourceLanguageTag: "en",
    sourceSnapshot: snapshot, provider: "openai", providerModelId: "gpt-4.1-mini", environment: "TEST",
    batchStatus: "PROVIDER_COMPLETED", status: "PROCESSING", outputFileId: "synthetic-file", errorFileId: null,
    submittedAt: new Date(),
  } as never);
  vi.spyOn(repository, "members").mockResolvedValue([{ providerCustomId: "exact-result-id" }] as never);
  const write = vi.spyOn(repository, "setResult").mockResolvedValue(true);
  vi.spyOn(repository, "finishBatch").mockResolvedValue(undefined);
  const line = JSON.stringify({ custom_id: "exact-result-id", ...(error ? { error } : { response: { status_code: 200, body } }) });
  const client = { files: { content: vi.fn(async () => new Response(line)) } };
  const provider = createOpenAITranslationProvider({ client: client as never, model: "gpt-4.1-mini" });
  const lifecycle = new TemplateTranslationBatchLifecycle({ repository,
    queue: { add: vi.fn() }, runtimeConfig: { current: () => backgroundRuntimeConfig() },
    providerFactory: () => provider, credentialResolverFactory: async () => ({ resolve: async () => "synthetic-key" }) as never,
  });
  expect(await lifecycle.ingest("batch-id")).toBe("completed");
  return write.mock.calls[0]?.[0];
}
const output = (text: string) => ({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });

describe("actual provider JSONL -> strict codec -> worker ingestion", () => {
  it("accepts valid exact output and restores protected occurrences", async () => {
    const result = await ingest(output(JSON.stringify(valid)));
    expect(result).toMatchObject({ translated: { schemaVersion: 1, segments: [{ key: "body", text: "Merhaba <PERSON>" }] }, failureCode: null });
    expect(prepareTemplateTranslation(snapshot).restore(JSON.stringify(valid))).toEqual(result?.translated);
  });
  it.each(["protectedTokens", "context", "unknown"])("rejects echoed %s through worker without cleanup or auto retry", async (property) => {
    const result = await ingest(output(JSON.stringify({ ...valid,
      segments: valid.segments.map((segment) => ({ ...segment, [property]: [] })) })));
    expect(result).toMatchObject({ translated: null, failureCode: "INVALID_TRANSLATED_SEGMENTS", maxRetries: 0, retrySeconds: 0 });
  });
  it("rejects truncated JSON and refusal-only output", async () => {
    expect(await ingest(output('{"schemaVersion":1,"segments":['))).toMatchObject({ translated: null, failureCode: "INVALID_PROVIDER_JSON", maxRetries: 0 });
    expect(await ingest({ output: [{ type: "message", content: [{ type: "refusal", refusal: "synthetic refusal" }] }] }))
      .toMatchObject({ translated: null, failureCode: "malformed-provider-output" });
  });
  it("preserves provider failure handling and refuses marker/key drift", async () => {
    expect(await ingest(null, { code: "synthetic-provider-error" })).toMatchObject({ translated: null, failureCode: "synthetic-provider-error" });
    expect(await ingest(output(JSON.stringify({ ...valid, segments: [{ key: "foreign", text: "Synthetic" }] }))))
      .toMatchObject({ translated: null, failureCode: "SEGMENT_MEMBERSHIP_MISMATCH", maxRetries: 0 });
    expect(await ingest(output(JSON.stringify({ ...valid, segments: [{ key: "body", text: "Synthetic" }] }))))
      .toMatchObject({ translated: null, failureCode: "PROTECTED_TOKEN_MISMATCH", maxRetries: 0 });
  });
});
