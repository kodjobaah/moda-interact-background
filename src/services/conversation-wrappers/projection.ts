import { createHash } from "node:crypto";
import type { PreparedToken, PreparedWrapper, WrapperVariable } from "./contracts.js";

const VARIABLES = new Set<WrapperVariable>([
  "customer.firstName", "shop.name", "checkout.url", "shopBrand.brandName",
  "shopBrand.logoUrl", "shopBrand.logoAltText", "shopBrand.logoWidth",
  "shopBrand.logoHeight", "shopBrand.squareLogoUrl", "shopBrand.squareLogoAltText",
  "shopBrand.coverImageUrl",
]);
const SLOT = "response.body";
const TOKEN_MARKER = /\{\{[^{}]*\}\}|\{\{|\}\}/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Admin's documented stable JSON hashing protocol, without importing its AST/compiler. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("Non-JSON prepared projection value");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readTokens(value: unknown, where: "header" | "body" | "footer" | "conditional"):
  PreparedToken[] | null {
  if (!Array.isArray(value) || value.length > 80) return null;
  const limit = where === "body" ? 4_000 : 1_500;
  let length = 0;
  const result: PreparedToken[] = [];
  for (const node of value) {
    if (!object(node)) return null;
    if (node.kind === "text" && onlyKeys(node, ["kind", "value"]) &&
        typeof node.value === "string" && !TOKEN_MARKER.test(node.value)) {
      length += node.value.length;
      result.push({ kind: "text", value: node.value });
    } else if (node.kind === "variable" && onlyKeys(node, ["kind", "name"]) &&
               typeof node.name === "string" && VARIABLES.has(node.name as WrapperVariable) &&
               (node.name !== "checkout.url" || where === "conditional")) {
      length += 5;
      result.push({ kind: "variable", name: node.name as WrapperVariable });
    } else if (node.kind === "responseSlot" && where === "body" &&
               onlyKeys(node, ["kind", "name"]) && node.name === SLOT) {
      length += 5;
      result.push({ kind: "responseSlot", name: SLOT });
    } else return null;
    if (length > limit) return null;
  }
  return result;
}

/** Never parse localeAst.authoring. Fail closed if the compiled runtime projection is absent. */
export function readPreparedWrapper(localeAst: unknown, contentHash: string | null):
  { kind: "ok"; prepared: PreparedWrapper } | { kind: "missing" | "invalid" } {
  if (!object(localeAst) || localeAst.schemaVersion !== 1 || !object(localeAst.prepared)) {
    return { kind: "missing" };
  }
  const prepared = localeAst.prepared;
  if (!onlyKeys(prepared, ["schemaVersion", "family", "responseSlot", "header", "body", "footer", "conditionals"]) ||
      prepared.schemaVersion !== 1 || prepared.family !== "MODA_CONVERSATION_WRAPPER" ||
      prepared.responseSlot !== SLOT || !Array.isArray(prepared.conditionals) ||
      prepared.conditionals.length > 1) return { kind: "invalid" };
  const header = readTokens(prepared.header, "header");
  const body = readTokens(prepared.body, "body");
  const footer = readTokens(prepared.footer, "footer");
  if (!header || !body || !footer || body.filter((part) => part.kind === "responseSlot").length !== 1) {
    return { kind: "invalid" };
  }
  const conditionals: Array<{ when: "checkout.available"; tokens: PreparedToken[] }> = [];
  for (const conditional of prepared.conditionals) {
    if (!object(conditional) || !onlyKeys(conditional, ["when", "tokens"]) ||
        conditional.when !== "checkout.available") return { kind: "invalid" };
    const tokens = readTokens(conditional.tokens, "conditional");
    if (!tokens) return { kind: "invalid" };
    conditionals.push({ when: "checkout.available", tokens });
  }
  // Hash of the immutable Admin projection; never trust mutable JSONB unverified.
  if (!contentHash || !/^[a-f0-9]{64}$/.test(contentHash) ||
      digest(stableJson(prepared)) !== contentHash) return { kind: "invalid" };
  return { kind: "ok", prepared: {
    schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: SLOT,
    header, body, footer, conditionals,
  } };
}
