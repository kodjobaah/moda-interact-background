import { isIP } from "node:net";

const MAX_INPUT_BYTES = 512;
const MAX_RESULT_BYTES = 512;
const MAX_PATH_SEGMENT_BYTES = 200;
const INVALID_HOST_SUFFIX = /\.(?:test|local|localhost|invalid|example|internal)$/i;
const BAD_PERCENT = /%(?![0-9a-f]{2})/i;
const PUBLIC_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

function publicHostname(hostname: string): boolean {
  const address = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1) : hostname;
  return isIP(address) === 0 && PUBLIC_HOST.test(hostname) &&
    !INVALID_HOST_SUFFIX.test(hostname) && hostname !== "localhost";
}

function encodePathSegment(value: string): string {
  return [...Buffer.from(value, "utf8")].map((byte) => {
    const allowed = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x5f;
    return allowed ? String.fromCharCode(byte) : `~${byte.toString(16).padStart(2, "0").toUpperCase()}`;
  }).join("");
}

/** Canonical, injective merchant-readable namespace for a trusted stored site identity. */
export function normalizeOutreachMerchantSite(site: string): string | null {
  if (typeof site !== "string" || site.length === 0 ||
      Buffer.byteLength(site, "utf8") > MAX_INPUT_BYTES || site.trim() !== site ||
      hasControlCharacters(site) || BAD_PERCENT.test(site) || site.includes("\\")) return null;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(site)?.[1]?.toLowerCase();
  if (scheme && scheme !== "https") return null;
  if (!scheme && site.startsWith("//")) return null;
  const candidate = scheme ? site : `https://${site}`;
  let rawPath = "";
  const authorityStart = candidate.indexOf("://");
  if (authorityStart < 0) return null;
  const suffixStart = authorityStart + 3;
  const suffix = candidate.slice(suffixStart);
  const pathStart = suffix.indexOf("/");
  const queryStart = suffix.indexOf("?");
  const hashStart = suffix.indexOf("#");
  const firstDelimiter = [pathStart, queryStart, hashStart]
    .filter((value) => value >= 0).reduce((left, right) => Math.min(left, right), Number.POSITIVE_INFINITY);
  const authority = Number.isFinite(firstDelimiter) ? suffix.slice(0, firstDelimiter) : suffix;
  if (!authority || authority.includes("@")) return null;
  if (pathStart >= 0 && pathStart === firstDelimiter) {
    const pathEnd = [queryStart, hashStart].filter((value) => value > pathStart)
      .reduce((left, right) => Math.min(left, right), suffix.length);
    rawPath = suffix.slice(pathStart, pathEnd);
  }

  let url: URL;
  try { url = new URL(candidate); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !publicHostname(hostname)) return null;

  const encodedSegments: string[] = [];
  if (rawPath) {
    const rawSegments = rawPath.slice(1).split("/");
    while (rawSegments.length && rawSegments.at(-1) === "") rawSegments.pop();
    for (const rawSegment of rawSegments) {
      if (!rawSegment) return null;
      let decoded: string;
      try { decoded = decodeURIComponent(rawSegment); } catch { return null; }
      if (!decoded || decoded === "." || decoded === ".." || decoded.includes("\\") ||
          decoded.includes("/") || hasControlCharacters(decoded)) return null;
      if (Buffer.byteLength(decoded, "utf8") > MAX_PATH_SEGMENT_BYTES) return null;
      encodedSegments.push(encodePathSegment(decoded));
    }
  }
  const result = encodedSegments.length ? `${hostname}-${encodedSegments.join("-")}` : hostname;
  return Buffer.byteLength(result, "ascii") <= MAX_RESULT_BYTES ? result : null;
}

/** Used by strict object-key validation; this validates the canonical slug alphabet and bounds. */
export function isOutreachMerchantSiteSegment(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RESULT_BYTES ||
      !/^[A-Za-z0-9._~-]+$/.test(value)) return false;
  if (publicHostname(value)) return true;

  // The normalized hostname is lowercase ASCII; the suffix consists of encoded
  // path segments, whose case and final ~XX token must be preserved verbatim.
  for (let separator = value.indexOf("-"); separator >= 0;
    separator = value.indexOf("-", separator + 1)) {
    const hostname = value.slice(0, separator);
    const encodedPath = value.slice(separator + 1);
    if (publicHostname(hostname) && isCanonicalEncodedPath(encodedPath)) return true;
  }
  return false;
}

function isCanonicalEncodedPath(value: string): boolean {
  if (!value) return false;
  return value.split("-").every((segment) => {
    if (!segment) return false;
    const bytes: number[] = [];
    for (let index = 0; index < segment.length; index += 1) {
      const character = segment[index]!;
      if (character === "~") {
        const escape = segment.slice(index + 1, index + 3);
        if (!/^[A-F0-9]{2}$/.test(escape)) return false;
        const byte = Number.parseInt(escape, 16);
        const isLiteralByte = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
          (byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x5f;
        if (isLiteralByte) return false;
        bytes.push(byte);
        index += 2;
      } else {
        const byte = character.charCodeAt(0);
        const allowed = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
          (byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x5f;
        if (!allowed) return false;
        bytes.push(byte);
      }
    }
    if (bytes.length > MAX_PATH_SEGMENT_BYTES) return false;
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)); }
    catch { return false; }
    return decoded !== "." && decoded !== ".." && !decoded.includes("/") &&
      !decoded.includes("\\") && !hasControlCharacters(decoded);
  });
}
