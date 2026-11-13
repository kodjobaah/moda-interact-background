import { TemplateTranslationRepository, type TemplateRunRecord, type TemplateTranslationDatabase } from "../../../../src/services/template-translation/repository.js";
import { describe, it, expect, vi } from "vitest";
import {
  parseTemplateTranslationSnapshot, prepareTemplateTranslation,
  templateTranslationContentHash, TemplateTranslationValidationError,
} from "../../../../src/services/template-translation/segment-codec.js";

// Snapshot validation performs no database operation; isolate the default client.
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));

const HASH = "a".repeat(64);
const input = () => ({
  schemaVersion: 1,
  definitionId: "template-v2",
  sourceHash: HASH,
  sourceLanguageTag: "en-GB",
  segments: [
    { key: "header.text", text: "Hi, brand A1", protectedTokens: [] },
    { key: "body.text", text: "Hello <P1>! Purchase <P2> now.", protectedTokens: [
      { marker: "<P1>", variable: "customer.firstName", hint: "first name" },
      { marker: "<P2>", variable: "checkout.total" },
    ] },
    { key: "footer.text", text: "Thank you", protectedTokens: [] },
    { key: "buttons.0.text", text: "View <URL_1>", protectedTokens: [
      { marker: "<URL_1>", variable: "checkout.recoveryUrl" },
    ] },
  ],
});
const source = () => parseTemplateTranslationSnapshot(input(), {
  definitionId: "template-v2", sourceHash: HASH,
  sourceLanguageTag: "en-GB", sourceSchemaVersion: 1,
});

function toProvider(inputText: string): { schemaVersion: number; segments: Array<{ key: string; text: string }> } {
  const result = JSON.parse(inputText) as { schemaVersion: number; segments: Array<{ key: string; text: string }> };
  return { schemaVersion: result.schemaVersion, segments: result.segments.map(({ key, text }) => ({ key, text })) };
}

describe("Admin-owned WhatsApp source snapshot -> keyed segments", () => {
  it("preserves HEADER, BODY, FOOTER and button segments; reorder tokens within BODY", () => {
    const prepared = prepareTemplateTranslation(source());
    const response = toProvider(prepared.requestText);
    response.segments[1]!.text = "Payer __MODA_PROTECTED_1_1__, bonjour __MODA_PROTECTED_1_0__";
    response.segments.reverse();
    const restored = prepared.restore(JSON.stringify(response));
    expect(restored).toEqual({ schemaVersion: 1, segments: [
      { key: "header.text", text: "Hi, brand A1" },
      { key: "body.text", text: "Payer <P2>, bonjour <P1>" },
      { key: "footer.text", text: "Thank you" },
      { key: "buttons.0.text", text: "View <URL_1>" },
    ] });
    expect(templateTranslationContentHash(restored)).toMatch(/^[0-9a-f]{64}$/);
    const providerRequest = JSON.parse(prepared.requestText);
    expect(providerRequest.segments[1].protectedTokens[0]).toEqual({
      sentinel: "__MODA_PROTECTED_1_0__", variable: "customer.firstName", hint: "first name",
    });
    expect(prepared.requestText).not.toContain("<P1>");
  });

  it.each([
    ["missing token", (v: string) => v.replace("__MODA_PROTECTED_1_1__", "")],
    ["duplicated token", (v: string) => `${v} __MODA_PROTECTED_1_0__`],
    ["invented token", (v: string) => `${v} __MODA_PROTECTED_1_99__`],
    ["changed token", (v: string) => v.replace("__MODA_PROTECTED_1_0__", "__MODA_PROTECTED_99_99__")],
    ["invented parameter", (v: string) => `${v} {{3}}`],
    ["leaked original", (v: string) => `${v} <P1>`],
  ])("rejects %s", (_label, transform) => {
    const prepared = prepareTemplateTranslation(source());
    const response = toProvider(prepared.requestText);
    response.segments[1]!.text = transform(response.segments[1]!.text);
    expect(() => prepared.restore(JSON.stringify(response))).toThrow(TemplateTranslationValidationError);
  });

  it("rejects tokens moved between segments", () => {
    const prepared = prepareTemplateTranslation(source());
    const response = toProvider(prepared.requestText);
    response.segments[1]!.text = response.segments[1]!.text.replace("__MODA_PROTECTED_1_0__", "");
    response.segments[2]!.text += "__MODA_PROTECTED_1_0__";
    expect(() => prepared.restore(JSON.stringify(response))).toThrow(TemplateTranslationValidationError);
  });

  it.each([
    ["duplicate key", (segments: Array<{key:string;text:string}>) => [...segments, segments[0]]],
    ["missing key", (segments: Array<{key:string;text:string}>) => segments.slice(1)],
    ["unknown key", (segments: Array<{key:string;text:string}>) => segments.map((s, i) => i === 0 ? { ...s, key: "extra" } : s)],
  ])("rejects %s in provider output", (_label, mutate) => {
    const prepared = prepareTemplateTranslation(source());
    const result = toProvider(prepared.requestText);
    result.segments = mutate(result.segments);
    expect(() => prepared.restore(JSON.stringify(result))).toThrow(TemplateTranslationValidationError);
  });

  it("rejects malformed, unsupported and extra-property provider output", () => {
    const prepared = prepareTemplateTranslation(source());
    expect(() => prepared.restore("not JSON")).toThrow(TemplateTranslationValidationError);
    const result = toProvider(prepared.requestText);
    expect(() => prepared.restore(JSON.stringify({ ...result, schemaVersion: 2 }))).toThrow(TemplateTranslationValidationError);
    expect(() => prepared.restore(JSON.stringify({ ...result, other: "data" }))).toThrow(TemplateTranslationValidationError);
  });

  it.each([
    ["empty key", "", "Synthetic"], ["oversized key", "k".repeat(257), "Synthetic"],
    ["empty text", "body.text", ""], ["oversized text", "body.text", "t".repeat(8193)],
  ])("keeps strict local %s bounds", (_label, key, text) => {
    const prepared = prepareTemplateTranslation(source());
    expect(() => prepared.restore(JSON.stringify({ schemaVersion: 1, segments: [{ key, text }] })))
      .toThrow(new TemplateTranslationValidationError("INVALID_TRANSLATED_SEGMENTS"));
  });
  it("keeps local segment count bounds and numeric literal schemaVersion", () => {
    const prepared = prepareTemplateTranslation(source());
    for (const value of [{ schemaVersion: 1, segments: [] },
      { schemaVersion: 1, segments: Array.from({ length: 65 }, (_, i) => ({ key: `key${i}`, text: "Synthetic" })) },
      { ...toProvider(prepared.requestText), schemaVersion: "1" }]) {
      expect(() => prepared.restore(JSON.stringify(value)))
        .toThrow(new TemplateTranslationValidationError("INVALID_TRANSLATED_SEGMENTS"));
    }
  });
  it.each(["protectedTokens", "context", "unknown"])("rejects echoed input-only %s segment metadata instead of stripping it", (property) => {
    const prepared = prepareTemplateTranslation(source());
    const result = toProvider(prepared.requestText);
    const echoed = { ...result, segments: result.segments.map((segment, index) => index === 1
      ? { ...segment, [property]: property === "protectedTokens" ? [] : "synthetic metadata" } : segment) };
    expect(() => prepared.restore(JSON.stringify(echoed)))
      .toThrow(new TemplateTranslationValidationError("INVALID_TRANSLATED_SEGMENTS"));
  });
  it("rejects incompatible source hashes, versions, duplicate keys and unprotected variables", () => {
    expect(() => parseTemplateTranslationSnapshot(input(), { definitionId: "template-v2", sourceHash: "b".repeat(64) }))
      .toThrow(TemplateTranslationValidationError);
    expect(() => parseTemplateTranslationSnapshot({ ...input(), schemaVersion: 4 }, { definitionId: "template-v2", sourceHash: HASH }))
      .toThrow(TemplateTranslationValidationError);
    expect(() => parseTemplateTranslationSnapshot({ ...input(), segments: [input().segments[0], input().segments[0]] }, { definitionId: "template-v2", sourceHash: HASH }))
      .toThrow(TemplateTranslationValidationError);
    const snapshot = input();
    snapshot.segments[1]!.text = "Hello {{1}}";
    expect(() => parseTemplateTranslationSnapshot(snapshot, { definitionId: "template-v2", sourceHash: HASH }))
      .toThrow(TemplateTranslationValidationError);
  });

  it("rejects reused or omitted protected marker identities and same-marker occurrences", () => {
    const snapshot = input();
    snapshot.segments[2]!.protectedTokens = [{ marker: "<P1>", variable: "customer.firstName" }];
    expect(() => parseTemplateTranslationSnapshot(snapshot, { definitionId: "template-v2", sourceHash: HASH }))
      .toThrow(TemplateTranslationValidationError);
    const doubleOccurrence = input();
    doubleOccurrence.segments[1]!.text += " again <P1>";
    expect(() => parseTemplateTranslationSnapshot(doubleOccurrence, { definitionId: "template-v2", sourceHash: HASH }))
      .toThrow(TemplateTranslationValidationError);
  });
});

// The worker receives Admin's protected occurrence transport, never the wrapper
// AST or resolved merchant URLs. Semantic hints must survive unchanged.
describe("common recovery website through the worker snapshot/translation codec", () => {
  function commonSource() {
    return {
      schemaVersion: 1,
      definitionId: "common-recovery-wrapper",
      sourceHash: HASH,
      sourceLanguageTag: "en",
      segments: [
        { key: "wrapper.header", text: "Shop <SHOP_NAME>\nWebsite <SHOP_WEBSITE>", protectedTokens: [
          { marker: "<SHOP_NAME>", variable: "shop.name" },
          { marker: "<SHOP_WEBSITE>", variable: "shop.websiteUrl" },
        ] },
        { key: "wrapper.checkoutConditional", text: "Return to your basket\n<CHECKOUT_URL>", protectedTokens: [
          { marker: "<CHECKOUT_URL>", variable: "checkout.url" },
        ] },
      ],
    };
  }

  function workerSnapshot() {
    const db = { $queryRaw: vi.fn(), $executeRaw: vi.fn(), $transaction: vi.fn() };
    const repository = new TemplateTranslationRepository(db as unknown as TemplateTranslationDatabase);
    const run: TemplateRunRecord = {
      id: "common-run", definitionId: "common-recovery-wrapper", status: "PENDING",
      sourceHash: HASH, definitionSourceHash: HASH, sourceSchemaVersion: 1,
      sourceLanguageTag: "en", sourceSnapshot: commonSource(),
      provider: "OPENAI", providerModelId: "synthetic-model", environment: "test",
    };
    return { db, repository, run, snapshot: repository.assertRunSnapshot(run) };
  }

  it("preserves name/website/checkout occurrence identities through actual worker snapshot validation and keyed reconstruction", () => {
    const { db, repository, run, snapshot } = workerSnapshot();
    const original = structuredClone(snapshot);
    const prepared = prepareTemplateTranslation(snapshot);
    const request = JSON.parse(prepared.requestText) as { segments: Array<{ protectedTokens: Array<{sentinel: string; variable: string}> }> };
    expect(request.segments.map(segment => segment.protectedTokens)).toEqual([
      [{ sentinel: "__MODA_PROTECTED_0_0__", variable: "shop.name" },
       { sentinel: "__MODA_PROTECTED_0_1__", variable: "shop.websiteUrl" }],
      [{ sentinel: "__MODA_PROTECTED_1_0__", variable: "checkout.url" }],
    ]);
    const translated = toProvider(prepared.requestText);
    translated.segments[0]!.text = "Site __MODA_PROTECTED_0_1__\nBoutique __MODA_PROTECTED_0_0__";
    translated.segments[1]!.text = "Retour au panier\n__MODA_PROTECTED_1_0__";
    translated.segments.reverse();
    expect(prepared.restore(JSON.stringify(translated))).toEqual({ schemaVersion: 1, segments: [
      { key: "wrapper.header", text: "Site <SHOP_WEBSITE>\nBoutique <SHOP_NAME>" },
      { key: "wrapper.checkoutConditional", text: "Retour au panier\n<CHECKOUT_URL>" },
    ] });
    expect(snapshot).toEqual(original);
    expect(() => repository.assertRunSnapshot({ ...run, definitionSourceHash: "b".repeat(64) }))
      .toThrow("STALE_TEMPLATE_DEFINITION_HASH");
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an omitted website occurrence even when name/checkout and segment membership remain valid", () => {
    const prepared = prepareTemplateTranslation(workerSnapshot().snapshot);
    const translated = toProvider(prepared.requestText);
    translated.segments[0]!.text = translated.segments[0]!.text.replace("__MODA_PROTECTED_0_1__", "");
    expect(() => prepared.restore(JSON.stringify(translated)))
      .toThrow(new TemplateTranslationValidationError("PROTECTED_TOKEN_MISMATCH"));
  });

  it("rejects moving the website occurrence into the checkout segment despite preserving its global count", () => {
    const prepared = prepareTemplateTranslation(workerSnapshot().snapshot);
    const translated = toProvider(prepared.requestText);
    translated.segments[0]!.text = translated.segments[0]!.text.replace("__MODA_PROTECTED_0_1__", "");
    translated.segments[1]!.text += "\n__MODA_PROTECTED_0_1__";
    expect(() => prepared.restore(JSON.stringify(translated)))
      .toThrow(new TemplateTranslationValidationError("PROTECTED_TOKEN_MISMATCH"));
  });
});
