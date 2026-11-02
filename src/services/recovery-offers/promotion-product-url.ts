import { isIP } from "node:net";

export function isSafePromotionProductUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2048 || value.includes("#")) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return false;
  }

  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (!authority || authority.includes("@") || authority.includes(":")) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return url.protocol === "https:" && url.username === "" && url.password === "" &&
    url.port === "" && url.hash === "" && hostname !== "" &&
    hostname !== "localhost" && !hostname.endsWith(".localhost") && isIP(hostname) === 0;
}