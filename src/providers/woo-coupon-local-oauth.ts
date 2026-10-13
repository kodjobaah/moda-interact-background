import { createHmac, randomBytes } from "node:crypto";
import type { WooCouponCredential } from "../services/woo-coupon-grant.service.js";

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** API-007 compatible one-legged OAuth 1.0a, only for locally approved HTTP hosts. */
export function signLocalWooCouponPath(
  origin: string,
  path: string,
  credential: WooCouponCredential,
  values: { nonce: string; timestamp: number } = {
    nonce: randomBytes(16).toString("hex"), timestamp: Math.floor(Date.now() / 1000),
  },
): string {
  const url = new URL(path, origin);
  if (!path.startsWith("/") || path.startsWith("//") || url.origin !== origin ||
      !/^[A-Za-z0-9]{32}$/.test(values.nonce) ||
      !Number.isSafeInteger(values.timestamp) || values.timestamp < 1) throw new Error("invalid_local_oauth");
  const parameters: Array<[string, string]> = [...url.searchParams];
  if (parameters.some(([key]) => key.startsWith("oauth_") || key === "consumer_secret" || key === "consumer_key") ||
      new Set(parameters.map(([key]) => key)).size !== parameters.length) throw new Error("invalid_local_oauth");
  parameters.push(["oauth_consumer_key", credential.consumerKey], ["oauth_nonce", values.nonce],
    ["oauth_signature_method", "HMAC-SHA256"], ["oauth_timestamp", String(values.timestamp)]);
  parameters.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const normalized = parameters.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const base = `GET&${encode(`${url.origin}${url.pathname}`)}&${encode(normalized)}`;
  const signature = createHmac("sha256", `${credential.consumerSecret}&`).update(base).digest("base64");
  for (const [key, value] of parameters) url.searchParams.set(key, value);
  url.searchParams.set("oauth_signature", signature);
  return url.pathname + url.search;
}
