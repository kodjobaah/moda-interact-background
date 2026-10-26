import { describe, expect, it } from "vitest";
import {
  digest, readPreparedWrapper, stableJson,
} from "../../../../src/services/conversation-wrappers/projection.js";
import { renderPreparedWrapper } from "../../../../src/services/conversation-wrappers/render.js";
import type {
  PreparedWrapper, VerifiedWrapperContext,
} from "../../../../src/services/conversation-wrappers/contracts.js";

const prepared: PreparedWrapper = {
  schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: "response.body",
  header: [{ kind: "text", value: "From " }, { kind: "variable", name: "shop.name" }],
  body: [{ kind: "text", value: "Hello " }, { kind: "variable", name: "customer.firstName" },
    { kind: "text", value: ": " }, { kind: "responseSlot", name: "response.body" }],
  footer: [{ kind: "text", value: "Thanks" }],
  conditionals: [{ when: "checkout.available", tokens: [
    { kind: "text", value: "Checkout: " }, { kind: "variable", name: "checkout.url" },
  ] }],
};
const context: VerifiedWrapperContext = {
  conversationId: "conv", shopId: "shop", conversationLanguageTag: "en", merchantLanguageTag: "en",
  variables: { "customer.firstName": "Ada", "shop.name": "Moda Shop", "checkout.url": "https://shop.test/checkout/one" },
  checkoutAvailable: true,
};
const envelope = (value: unknown, hash = digest(stableJson(value))) =>
  readPreparedWrapper({ schemaVersion: 1, authoring: { unrelated: true }, prepared: value }, hash);

const mutate = (cb: (value: Record<string, unknown>) => void) => {
  const obj = JSON.parse(JSON.stringify(prepared)) as Record<string, unknown>;
  cb(obj);
  return obj;
};

describe("ARCH-047 BG005 prepared wrapper projection", () => {
  it("verifies Admin's canonical JSON content digest without interpreting authoring", () => {
    expect(envelope(prepared)).toEqual({ kind: "ok", prepared });
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
    expect(envelope(prepared, "0".repeat(64))).toEqual({ kind: "invalid" });
    expect(readPreparedWrapper({ schemaVersion: 1, authoring: {} }, "0".repeat(64))).toEqual({ kind: "missing" });
  });
  it("fails closed for missing, duplicate, or misplaced response slot", () => {
    expect(envelope(mutate((v) => { v.body = [{ kind: "text", value: "no response" }]; }))).toEqual({ kind: "invalid" });
    expect(envelope(mutate((v) => { (v.body as unknown[]).push({ kind: "responseSlot", name: "response.body" }); }))).toEqual({ kind: "invalid" });
    expect(envelope(mutate((v) => { v.header = [{ kind: "responseSlot", name: "response.body" }]; }))).toEqual({ kind: "invalid" });
  });
  it("rejects unknown variables, AST nodes, invalid URL placement, extra fields and malformed sections", () => {
    expect(envelope(mutate((v) => { v.footer = [{ kind: "variable", name: "offer.code" }]; }))).toEqual({ kind: "invalid" });
    expect(envelope(mutate((v) => { v.header = [{ type: "text", value: "bad" }]; }))).toEqual({ kind: "invalid" });
    expect(envelope(mutate((v) => { v.footer = [{ kind: "variable", name: "checkout.url" }]; }))).toEqual({ kind: "invalid" });
    expect(envelope(mutate((v) => { v.undocumented = "x"; }))).toEqual({ kind: "invalid" });
    expect(envelope(mutate((v) => { v.conditionals = [{ when: "somethingElse", tokens: [] }]; }))).toEqual({ kind: "invalid" });
    expect(envelope(mutate((v) => { v.footer = [{ kind: "text", value: "{{shop.name}}" }]; }))).toEqual({ kind: "invalid" });
  });
});

describe("ARCH-047 BG005 pure prepared renderer", () => {
  it("inserts the response exactly and retains ordered header/checkout/footer fragments", () => {
    const result = renderPreparedWrapper({ prepared, context, responseBody: "A  \nB!" });
    expect(result).toEqual({ kind: "rendered", body:
      "From Moda Shop\nHello Ada: A  \nB!\nCheckout: https://shop.test/checkout/one\nThanks" });
  });
  it("omits the checkout conditional when context is missing or stale", () => {
    const result = renderPreparedWrapper({ prepared,
      context: { ...context, checkoutAvailable: false, variables: { "shop.name": "Moda Shop", "customer.firstName": "Ada" } },
      responseBody: "A" });
    expect(result).toEqual({ kind: "rendered", body: "From Moda Shop\nHello Ada: A\nThanks" });
  });
  it("omits the entire optional conditional if its value is unavailable", () => {
    const result = renderPreparedWrapper({ prepared,
      context: { ...context, variables: { "shop.name": "Moda Shop", "customer.firstName": "Ada" } },
      responseBody: "B" });
    expect(result).toEqual({ kind: "rendered", body: "From Moda Shop\nHello Ada: B\nThanks" });
  });
  it("refuses absent required variables, oversized output and already-wrapped input", () => {
    expect(renderPreparedWrapper({ prepared, context: { ...context, variables: {} }, responseBody: "x" }))
      .toEqual({ kind: "rejected", reason: "VARIABLE_UNAVAILABLE" });
    expect(renderPreparedWrapper({ prepared, context, responseBody: "x".repeat(4096) }))
      .toEqual({ kind: "rejected", reason: "OUTPUT_TOO_LONG" });
    const first = renderPreparedWrapper({ prepared, context, responseBody: "Hello" });
    expect(first.kind).toBe("rendered");
    if (first.kind === "rendered") expect(renderPreparedWrapper({ prepared, context, responseBody: first.body }))
      .toEqual({ kind: "rejected", reason: "ALREADY_WRAPPED" });
  });
});
