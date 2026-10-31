import { createHash } from "node:crypto";
import { BindingUnavailable, isSemanticKey, type SemanticKey, RecoveryVariableResolver } from "./recovery-template-brand.js";
import type {
  BrandMediaRole, PreparedMetaComponent, RegistrationRow, TextParameter,
} from "./recovery-template.types.js";

type JsonObject = Record<string, unknown>;
type TextBinding = { position: number; variable: SemanticKey };
type ButtonBinding = { index: number; subType: "url"; variable: "checkout.url" };
type FrozenBindings = {
  schemaVersion?: 1;
  headerMediaRole?: BrandMediaRole;
  header: TextBinding[];
  body: TextBinding[];
  buttons: ButtonBinding[];
};
const MEDIA_ROLES: readonly BrandMediaRole[] = ["LOGO", "SQUARE_LOGO", "COVER_IMAGE"];

const obj = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(): never { throw new BindingUnavailable("BINDINGS_INVALID"); }

function parseTextBindings(value: unknown, max: number): TextBinding[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  const result: TextBinding[] = [];
  for (const [index, entry] of value.entries()) {
    if (!obj(entry) || !Number.isSafeInteger(entry.position) || entry.position !== index + 1 ||
        !isSemanticKey(entry.variable) ||
        Object.keys(entry).some((k) => !["position", "variable"].includes(k))) return invalid();
    result.push({ position: index + 1, variable: entry.variable });
  }
  return result;
}

function parseFrozenBindings(raw: unknown): FrozenBindings {
  if (!obj(raw)) return invalid();
  // Admin owns the immutable projection. Keep optional schemaVersion in the
  // digest only when it was actually stored: older TEXT snapshots omit it.
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) return invalid();
  if (Object.keys(raw).some((key) =>
      !["schemaVersion", "headerMediaRole", "header", "body", "buttons"].includes(key))) return invalid();
  if (raw.headerMediaRole !== undefined &&
      (raw.schemaVersion !== 1 || !MEDIA_ROLES.includes(raw.headerMediaRole as BrandMediaRole) ||
       !Array.isArray(raw.header) || raw.header.length !== 0)) return invalid();
  if (!Array.isArray(raw.buttons) || raw.buttons.length > 1) return invalid();
  const buttons: ButtonBinding[] = [];
  for (const entry of raw.buttons) {
    if (!obj(entry) || entry.subType !== "url" || entry.variable !== "checkout.url" ||
        !Number.isSafeInteger(entry.index) || entry.index !== 0 ||
        Object.keys(entry).some((key) => !["index", "subType", "variable"].includes(key))) return invalid();
    buttons.push({ index: 0, subType: "url", variable: "checkout.url" });
  }
  return {
    ...(raw.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
    ...(raw.headerMediaRole !== undefined ? { headerMediaRole: raw.headerMediaRole as BrandMediaRole } : {}),
    header: parseTextBindings(raw.header ?? [], 1),
    body: parseTextBindings(raw.body, 10),
    buttons,
  };
}

/** Verify compiled position markers only. Never infer variable identity from text. */
function textMatchesFrozenBindings(text: unknown, slots: readonly TextBinding[], maxChars: number): boolean {
  if (typeof text !== "string" || !text.trim() || text.length > maxChars) return false;
  const tokens = text.match(/\{\{[^{}]*\}\}/g) ?? [];
  if (tokens.length !== slots.length) return false;
  if (tokens.some((token, index) => token !== `{{${index + 1}}}`)) return false;
  const withoutTokens = text.replace(/\{\{[^{}]*\}\}/g, "");
  return !/[{}]/.test(withoutTokens);
}

/**
 * Bit-for-bit compatible with the Admin authoring compiler's stableJson of
 * the frozen, version-one prepared projection. This local verifier does not
 * parse, transform or compile the Admin AST.
 */
function adminFrozenDigest(value: unknown): string {
  function canonical(item: unknown, depth: number): string {
    if (depth > 16) return invalid();
    if (item === null || typeof item !== "object") {
      const text = JSON.stringify(item);
      return text === undefined ? invalid() : text;
    }
    if (Array.isArray(item)) return `[${item.map((member) => canonical(member, depth + 1)).join(",")}]`;
    if (!obj(item)) return invalid();
    return `{${Object.keys(item).sort((a, b) => a.localeCompare(b, "en"))
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key], depth + 1)}`).join(",")}}`;
  }
  return createHash("sha256").update(canonical(value, 0), "utf8").digest("hex");
}

function strictComponents(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4 ||
      !value.every(obj)) return invalid();
  if (JSON.stringify(value).length > 32_768) return invalid();
  const sequence = value.map((component) => component.type);
  if (sequence.filter((type) => type === "BODY").length !== 1 ||
      sequence.some((type) => !["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(String(type))) ||
      new Set(sequence).size !== sequence.length ||
      sequence.indexOf("BODY") < 0 ||
      (sequence.includes("HEADER") && sequence[0] !== "HEADER") ||
      (sequence.includes("BUTTONS") && sequence.at(-1) !== "BUTTONS") ||
      (sequence.includes("FOOTER") && sequence.indexOf("FOOTER") < sequence.indexOf("BODY"))) {
    return invalid();
  }
  return value;
}

export async function prepareFrozenComponents(input: {
  registration: RegistrationRow;
  variables: RecoveryVariableResolver;
}): Promise<{ components: readonly PreparedMetaComponent[]; bindingFingerprint: string }> {
  const { registration, variables } = input;
  const approved = strictComponents(registration.componentsSnapshot);
  const frozen = parseFrozenBindings(registration.parameterBindingsSnapshot);
  const header = approved.find((component) => component.type === "HEADER");
  // Structural mismatches (including legacy headerImage with no frozen role)
  // fail before hashing, without inferring a role from text or image URLs.
  if (header?.format === "IMAGE") {
    if (!frozen.headerMediaRole || frozen.header.length !== 0) return invalid();
  } else if (frozen.headerMediaRole) return invalid();
  // A missing/mismatched stored digest is a hard integrity failure; do not
  // reconstruct a new projection from the AST or assume content is intact.
  const compiled = {
    schemaVersion: 1,
    family: "META_RECOVERY",
    category: "MARKETING",
    components: approved,
    parameterBindings: frozen,
  };
  const fingerprint = adminFrozenDigest(compiled);
  if (!/^[0-9a-f]{64}$/.test(registration.submittedContentHash) ||
      !registration.locale.contentHash ||
      registration.locale.contentHash !== registration.submittedContentHash ||
      fingerprint !== registration.submittedContentHash) {
    throw new BindingUnavailable("BINDING_FINGERPRINT_MISMATCH");
  }
  if (registration.category !== "MARKETING") return invalid();

  const result: PreparedMetaComponent[] = [];
  let matchedHeader = false;
  let matchedBody = false;
  let matchedButtons = false;
  for (const component of approved) {
    if (component.type === "HEADER") {
      matchedHeader = true;
      if (component.format === "TEXT") {
        if (!textMatchesFrozenBindings(component.text, frozen.header, 60)) return invalid();
        if (frozen.header.length) {
          const text = await variables.resolve(frozen.header[0]!.variable);
          result.push({ type: "header", parameters: [{ type: "text", text }] });
        }
      } else if (component.format === "IMAGE") {
        if (frozen.header.length || !frozen.headerMediaRole) return invalid();
        const url = await variables.imageHeader(frozen.headerMediaRole);
        result.push({ type: "header", parameters: [{ type: "image", image: { link: url } }] });
      } else return invalid();
    } else if (component.type === "BODY") {
      matchedBody = true;
      if (!textMatchesFrozenBindings(component.text, frozen.body, 1024)) return invalid();
      const parameters: TextParameter[] = [];
      for (const binding of frozen.body) {
        parameters.push({ type: "text", text: await variables.resolve(binding.variable) });
      }
      if (parameters.length) result.push({ type: "body", parameters });
    } else if (component.type === "FOOTER") {
      if (typeof component.text !== "string" || !component.text.trim() ||
          component.text.length > 60 || /[{}]/.test(component.text)) return invalid();
    } else if (component.type === "BUTTONS") {
      matchedButtons = true;
      if (!Array.isArray(component.buttons) || component.buttons.length > 1) return invalid();
      for (const [index, candidate] of component.buttons.entries()) {
        if (!obj(candidate) || candidate.type !== "URL" ||
            typeof candidate.text !== "string" || !candidate.text.trim() ||
            candidate.text.length > 25 || typeof candidate.url !== "string") return invalid();
        const binding = frozen.buttons.find((item) => item.index === index);
        if (binding) {
          if (!candidate.url.endsWith("{{1}}") ||
              candidate.url.slice(0, -5).includes("{{") ||
              candidate.url.slice(0, -5).includes("}}")) return invalid();
          const prefix = candidate.url.slice(0, -5);
          const suffix = variables.encodeCheckoutButtonSuffix(prefix);
          result.push({ type: "button", sub_type: "url", index: String(index),
            parameters: [{ type: "text", text: suffix }] });
        } else {
          if (candidate.url.includes("{{") || candidate.url.includes("}}")) return invalid();
          variables.checkStaticButtonUrl(candidate.url);
        }
      }
    }
  }
  if (!matchedBody || (frozen.header.length > 0 && !matchedHeader) ||
      (frozen.buttons.length > 0 && !matchedButtons)) return invalid();
  return { components: result, bindingFingerprint: fingerprint };
}
