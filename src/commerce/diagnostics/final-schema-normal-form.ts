import { canonicalJson, finalResponseToolSchema, type CommerceResponseContract } from "@modainteract/moda-interact-shared/commerce";
type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const keys = (value: Schema, permitted: string[]) => Object.keys(value).every(key => permitted.includes(key));
function fail(): never { throw new Error("UNSUPPORTED_DIAGNOSTIC_SCHEMA"); }

/** Only conjunction fragments emitted by the known runner selection constraint. */
function overlay(base: Schema, fragment: Schema): Schema[] {
  if (!keys(fragment, ["type", "minItems", "const", "enum", "properties", "required", "anyOf"])) fail();
  if (fragment.anyOf !== undefined) {
    if (!Array.isArray(fragment.anyOf) || !fragment.anyOf.length || fragment.anyOf.length > 20) fail();
    const { anyOf, ...rest } = fragment;
    return (anyOf as unknown[]).flatMap(branch => {
      if (!object(branch)) fail();
      return overlay(base, rest).flatMap(row => overlay(row, branch));
    });
  }
  const out = clone(base);
  if (fragment.type !== undefined && !equal(fragment.type, base.type)) fail();
  if (fragment.minItems !== undefined) {
    if (base.type !== "array" || !Number.isSafeInteger(fragment.minItems) || Number(fragment.minItems) < 0) fail();
    out.minItems = Math.max(Number(base.minItems ?? 0), Number(fragment.minItems));
    if (Number(out.minItems) > Number(base.maxItems ?? Infinity)) fail();
  }
  if (Object.hasOwn(fragment, "const")) {
    if (Object.hasOwn(base, "const") && !equal(base.const, fragment.const)) fail();
    if (Array.isArray(base.enum) && !base.enum.some(value => equal(value, fragment.const))) fail();
    out.const = fragment.const;
  }
  if (fragment.enum !== undefined) {
    if (!Array.isArray(fragment.enum) || !Array.isArray(base.enum)) fail();
    out.enum = base.enum.filter(value => (fragment.enum as unknown[]).some(candidate => equal(value, candidate)));
    if (!(out.enum as unknown[]).length) fail();
  }
  let rows = [out];
  if (fragment.required !== undefined) {
    if (!Array.isArray(fragment.required) || !fragment.required.every(key => typeof key === "string") || base.type !== "object") fail();
    out.required = [...new Set([...(Array.isArray(base.required) ? base.required : []), ...fragment.required])];
    if (!object(base.properties) || (out.required as string[]).some(key => !Object.hasOwn(base.properties as Schema, key))) fail();
  }
  if (fragment.properties !== undefined) {
    if (base.type !== "object" || !object(base.properties) || !object(fragment.properties)) fail();
    for (const [key, patch] of Object.entries(fragment.properties)) {
      const original = (base.properties as Schema)[key];
      if (!object(original) || !object(patch)) fail();
      rows = rows.flatMap(row => overlay(original, patch).map(property => ({ ...row, properties: { ...(row.properties as Schema), [key]: property } })));
      if (rows.length > 32) fail();
    }
  }
  return rows;
}
function containsLogic(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsLogic);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) => ["allOf", "anyOf", "oneOf", "not", "if", "then", "else", "$ref"].includes(key) || containsLogic(child));
}

/** Diagnostic-only known finalResponse envelope; no production caller or validator replacement. */
export function diagnosticFinalSchemaNormalForm(raw: unknown, contract: CommerceResponseContract): Schema | null {
  try {
    if (!object(raw) || !Array.isArray(raw.allOf) || raw.allOf.length !== 3) fail();
    const generated = finalResponseToolSchema(contract) as unknown as Schema;
    if (!equal({ ...raw, allOf: raw.allOf.slice(0, 2) }, generated)) fail();
    const rootProperties = generated.properties as Record<string, Schema>;
    const baseLogic = generated.allOf as { oneOf: { properties: Record<string, Schema> }[] }[];
    const answer = baseLogic[0]?.oneOf[0]?.properties, referral = baseLogic[0]?.oneOf[1]?.properties;
    const languages = baseLogic[1]?.oneOf;
    if (!answer || !referral || !languages || languages.length !== 2 || answer.answerKind?.const !== "ANSWER" || referral.answerKind?.const !== "REFER_TO_STORE" || languages[0]?.properties.detectedLanguageTag?.type !== "null" || languages[1]?.properties.detectedLanguageTag?.type !== "string") fail();
    const selection = raw.allOf[2];
    if (!object(selection) || !keys(selection, ["anyOf"]) || !Array.isArray(selection.anyOf) || selection.anyOf.length !== 2 || !equal(selection.anyOf[0], { properties: { answerKind: { const: "REFER_TO_STORE" } } })) fail();
    const selected = selection.anyOf[1];
    if (!object(selected) || !keys(selected, ["properties"]) || !object(selected.properties) || !keys(selected.properties, ["details"]) || !object(selected.properties.details) || !keys(selected.properties.details, ["anyOf"]) || !Array.isArray(selected.properties.details.anyOf)) fail();
    const clauses = selected.properties.details.anyOf as unknown[];
    if (!clauses.length || clauses.length > 8 || containsLogic(contract.detailsSchema)) fail();
    // Every selection alternative requires a pinned details key, hence cannot match referral {}.
    for (const clause of clauses) if (!object(clause) || !keys(clause, ["required", "properties"]) || !Array.isArray(clause.required) || !clause.required.length) fail();
    const details = { ...clone(answer.details!), additionalProperties: false };
    const answerDetails = clauses.flatMap(clause => overlay(details, clause as Schema));
    const branches: Schema[] = [];
    for (const language of languages) {
      const common = clone(rootProperties);
      for (const [key, patch] of Object.entries(language.properties)) common[key] = { ...common[key], ...patch };
      const ref = clone(common);
      for (const [key, patch] of Object.entries(referral)) ref[key] = key === "details" ? clone(patch) : { ...ref[key], ...patch };
      branches.push({ type: "object", additionalProperties: false, required: clone(generated.required), properties: ref });
      for (const selectedDetails of answerDetails) {
        const props = clone(common);
        for (const [key, patch] of Object.entries(answer)) props[key] = key === "details" ? selectedDetails : { ...props[key], ...patch };
        branches.push({ type: "object", additionalProperties: false, required: clone(generated.required), properties: props });
      }
    }
    const { allOf: _allOf, ...root } = generated;
    const result = { ...root, anyOf: branches };
    if (branches.length > 32 || Buffer.byteLength(canonicalJson(result)) > 262144 || branches.some(containsLogic)) fail();
    return result;
  } catch { return null; }
}
