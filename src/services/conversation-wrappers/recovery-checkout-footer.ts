import type { VerifiedWrapperContext, WrapperRefusal, WrapperSource } from "./contracts.js";
import { MAX_WHATSAPP_TEXT_LENGTH } from "./render.js";

export function validRecoveryCheckoutFooterUrl(value: unknown): value is string {
  // Stored URLs may not contain whitespace or control characters.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.hostname.includes(".") && !url.hostname.endsWith(".invalid") && url.href === value;
  } catch { return false; }
}

/** Transform only standalone exact raw links, never embedded Markdown or other URLs. */
function mapCheckoutUrlTokens(body: string, checkoutUrl: string, replace: (url: string) => string): string {
  return body.replace(/https?:\/\/[^\s<>]+/g, (token, offset: number) => {
    if (offset > 0 && !/\s/.test(body[offset - 1]!)) return token;
    if (!token.startsWith(checkoutUrl)) return token;
    const suffix = token.slice(checkoutUrl.length);
    return !suffix || /^[.,;:!?)*_`\]}。！，；：？]+$/.test(suffix) ? replace(checkoutUrl) + suffix : token;
  });
}

export function withoutRecoveryCheckoutUrl(body: string, checkoutUrl: string): string {
  return mapCheckoutUrlTokens(body, checkoutUrl, () => "").split("\n").map(line => line.trimEnd()).join("\n").trim();
}

/** Preserve localized link labels and other prose by moving complete link lines to the footer. */
export function withRecoveryCheckoutFooter(body: string, checkoutUrl: string): string {
  const lines = body.split("\n");
  const linkLines = lines.filter(line => mapCheckoutUrlTokens(line, checkoutUrl, () => "") !== line);
  if (!linkLines.length) return `${body.trim()}\n\n${checkoutUrl}`;
  const labelled = linkLines.filter(line => withoutRecoveryCheckoutUrl(line, checkoutUrl).trim());
  const selected = labelled.at(-1);
  const selectedIndex = selected === undefined ? -1 : lines.lastIndexOf(selected);
  const footerLines: string[] = [];
  if (selected) {
    // Keep the last exact URL within the selected line; preserve every other word.
    let remaining = 0;
    mapCheckoutUrlTokens(selected, checkoutUrl, value => { remaining++; return value; });
    footerLines.push(mapCheckoutUrlTokens(selected, checkoutUrl, value => --remaining === 0 ? value : "").trim());
  } else footerLines.push(checkoutUrl);
  const content = lines.flatMap((line, index) => {
    if (index === selectedIndex) return [];
    const stripped = mapCheckoutUrlTokens(line, checkoutUrl, () => "");
    return stripped !== line && !stripped.trim() ? [] : [stripped.trimEnd()];
  }).join("\n").trim();
  return [content, footerLines.join("\n")].filter(Boolean).join("\n\n");
}

export function recoveryReplyContentPreserved(original: string, rendered: string, checkoutUrl: string): boolean {
  const content = withoutRecoveryCheckoutUrl(rendered, checkoutUrl);
  return withoutRecoveryCheckoutUrl(original, checkoutUrl).split("\n")
    .map(line => line.trim()).filter(Boolean).every(line => content.includes(line));
}

export function appendRecoveryCheckoutFooter(input: {
  body: string; source: WrapperSource; context: VerifiedWrapperContext;
}): {kind: "ready"; body: string; recoveryCheckoutUrl?: string} | {kind: "rejected"; reason: WrapperRefusal} {
  if (input.source !== "AI" || !input.context.checkoutAvailable) return {kind: "ready", body: input.body};
  const url = input.context.variables["checkout.url"];
  if (!validRecoveryCheckoutFooterUrl(url)) return {kind: "rejected", reason: "VARIABLE_UNAVAILABLE"};
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body)) return {kind: "rejected", reason: "INVALID_INPUT"};
  const body = withRecoveryCheckoutFooter(input.body, url);
  if (body.length > MAX_WHATSAPP_TEXT_LENGTH) return {kind: "rejected", reason: "OUTPUT_TOO_LONG"};
  return {kind: "ready", body, recoveryCheckoutUrl: url};
}
