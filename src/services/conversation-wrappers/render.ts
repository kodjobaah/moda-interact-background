import type { PreparedToken, PreparedWrapper, VerifiedWrapperContext, WrapperRefusal } from "./contracts.js";

/** WhatsApp plain-text message maximum; reject before moderation and provider calls. */
export const MAX_WHATSAPP_TEXT_LENGTH = 4096;
const MAX_VARIABLE_LENGTH = 2048;

/** Reject C0 controls other than tab, LF and CR, which WhatsApp text permits. */
function hasDisallowedTextControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

function valueFor(token: PreparedToken, context: VerifiedWrapperContext): string | null {
  if (token.kind !== "variable") return null;
  const value = context.variables[token.name];
  if (typeof value !== "string" || !value.trim() || value.length > MAX_VARIABLE_LENGTH ||
      hasDisallowedTextControl(value)) return null;
  return value;
}
function renderTokens(tokens: readonly PreparedToken[], context: VerifiedWrapperContext, response: string):
  string | null {
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.kind === "text") parts.push(token.value);
    else if (token.kind === "responseSlot") parts.push(response);
    else {
      const variable = valueFor(token, context);
      if (variable === null) return null;
      parts.push(variable);
    }
  }
  return parts.join("");
}

function renderSections(prepared: PreparedWrapper, context: VerifiedWrapperContext, response: string):
  string | null {
  const header = renderTokens(prepared.header, context, response);
  const body = renderTokens(prepared.body, context, response);
  const footer = renderTokens(prepared.footer, context, response);
  if (header === null || body === null || footer === null) return null;
  const parts = [header, body];
  if (context.checkoutAvailable) {
    for (const conditional of prepared.conditionals) {
      const content = renderTokens(conditional.tokens, context, response);
      // Optional checkout section: omit whole section on missing/stale values.
      if (content !== null) parts.push(content);
    }
  }
  parts.push(footer);
  return parts.filter((part) => part.length > 0).join("\n");
}

/** No AST reads, external dependencies, side effects, network, billing or sending. */
export function renderPreparedWrapper(input: {
  prepared: PreparedWrapper;
  context: VerifiedWrapperContext;
  responseBody: string;
}): { kind: "rendered"; body: string } | { kind: "rejected"; reason: WrapperRefusal } {
  const { prepared, context, responseBody } = input;
  if (typeof responseBody !== "string" || !responseBody.trim() ||
      hasDisallowedTextControl(responseBody)) {
    return { kind: "rejected", reason: "INVALID_INPUT" };
  }
  if (responseBody.length > MAX_WHATSAPP_TEXT_LENGTH) {
    return { kind: "rejected", reason: "OUTPUT_TOO_LONG" };
  }
  // Detect a previous application of this *same* prepared envelope. An independent
  // caller-owned previousApplication handles retries after the active slot changes.
  const probe = "\u0000__MODA_RESPONSE_SLOT__\u0000";
  const envelope = renderSections(prepared, context, probe);
  if (envelope === null) return { kind: "rejected", reason: "VARIABLE_UNAVAILABLE" };
  const position = envelope.indexOf(probe);
  const prefix = envelope.slice(0, position);
  const suffix = envelope.slice(position + probe.length);
  if ((prefix || suffix) && responseBody.length > prefix.length + suffix.length &&
      responseBody.startsWith(prefix) && responseBody.endsWith(suffix)) {
    return { kind: "rejected", reason: "ALREADY_WRAPPED" };
  }
  const rendered = renderSections(prepared, context, responseBody);
  if (rendered === null) return { kind: "rejected", reason: "VARIABLE_UNAVAILABLE" };
  if (rendered.length > MAX_WHATSAPP_TEXT_LENGTH) {
    return { kind: "rejected", reason: "OUTPUT_TOO_LONG" };
  }
  return { kind: "rendered", body: rendered };
}
