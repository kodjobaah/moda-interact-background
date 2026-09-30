import { lookup as dnsLookup } from "node:dns/promises";
import type { RequestOptions } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export const MERCHANT_KNOWLEDGE_MAX_URL_LENGTH = 2048;
export const MERCHANT_KNOWLEDGE_MAX_REDIRECTS = 5;
export const MERCHANT_KNOWLEDGE_ACQUISITION_DEADLINE_MS = 10_000;
export const MERCHANT_KNOWLEDGE_MAX_DECOMPRESSED_BYTES = 1_048_576;

export const MERCHANT_KNOWLEDGE_ACQUISITION_ERROR_CODES = [
  "INVALID_URL",
  "DENIED_DESTINATION",
  "DNS_NO_ADDRESSES",
  "DNS_TEMPORARY_FAILURE",
  "DNS_FAILURE",
  "TOO_MANY_REDIRECTS",
  "INVALID_REDIRECT",
  "REQUEST_DEADLINE",
  "CONNECTION_PEER_MISMATCH",
  "HTTP_STATUS_TRANSIENT",
  "HTTP_STATUS_PERMANENT",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNSUPPORTED_CONTENT_ENCODING",
  "BODY_TOO_LARGE",
  "RESPONSE_READ_FAILED",
] as const;

export type MerchantKnowledgeAcquisitionErrorCode =
  (typeof MERCHANT_KNOWLEDGE_ACQUISITION_ERROR_CODES)[number];

export class MerchantKnowledgeAcquisitionError extends Error {
  constructor(
    readonly code: MerchantKnowledgeAcquisitionErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "MerchantKnowledgeAcquisitionError";
  }
}

export interface MerchantKnowledgeResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type MerchantKnowledgeResolver = (
  hostname: string,
) => Promise<readonly MerchantKnowledgeResolvedAddress[]>;

const NON_PUBLIC_SPECIAL_USE_CIDRS = [
  "0.0.0.0/8",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
].map((cidr) => ipaddr.parseCIDR(cidr));

const TEMPORARY_DNS_CODES = new Set(["EAI_AGAIN", "ETIMEOUT", "ETIMEDOUT"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function normalizeIpAddress(address: string): string | null {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().toString();
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isPublicIpAddress(address: string): boolean {
  if (address.includes("%")) return false;
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) {
        return isPublicIpAddress(ipv6.toIPv4Address().toString());
      }
    }
    const specialUse = NON_PUBLIC_SPECIAL_USE_CIDRS.some(([network, prefix]) => {
      if (parsed.kind() !== network.kind()) return false;
      if (parsed.kind() === "ipv4") {
        return (parsed as ipaddr.IPv4).match([network as ipaddr.IPv4, prefix]);
      }
      return (parsed as ipaddr.IPv6).match([network as ipaddr.IPv6, prefix]);
    });
    if (specialUse) return false;
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolveAllDnsAnswers(
  hostname: string,
): Promise<readonly MerchantKnowledgeResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 4 ? 4 : 6,
  }));
}

export async function resolveAndValidateDestination(
  hostnameInput: string,
  resolver: MerchantKnowledgeResolver = resolveAllDnsAnswers,
): Promise<MerchantKnowledgeResolvedAddress> {
  const hostname = hostnameWithoutBrackets(hostnameInput);
  const literalFamily = isIP(hostname);

  if (literalFamily !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw new MerchantKnowledgeAcquisitionError(
        "DENIED_DESTINATION",
        "The requested destination is not globally routable.",
      );
    }
    return {
      address: normalizeIpAddress(hostname) ?? hostname,
      family: literalFamily as 4 | 6,
    };
  }

  let answers: readonly MerchantKnowledgeResolvedAddress[];
  try {
    answers = await resolver(hostname);
  } catch (error) {
    const code = errorCode(error);
    if (code && TEMPORARY_DNS_CODES.has(code)) {
      throw new MerchantKnowledgeAcquisitionError(
        "DNS_TEMPORARY_FAILURE",
        "Temporary DNS resolution failure.",
        true,
      );
    }
    throw new MerchantKnowledgeAcquisitionError(
      "DNS_FAILURE",
      "DNS resolution failed.",
    );
  }

  if (answers.length === 0) {
    throw new MerchantKnowledgeAcquisitionError(
      "DNS_NO_ADDRESSES",
      "The destination has no DNS addresses.",
    );
  }

  const validated = answers.map(({ address, family }) => {
    const actualFamily = isIP(address);
    if (
      (family !== 4 && family !== 6) ||
      actualFamily !== family ||
      !isPublicIpAddress(address)
    ) {
      throw new MerchantKnowledgeAcquisitionError(
        "DENIED_DESTINATION",
        "The requested destination is not globally routable.",
      );
    }
    return {
      address,
      family,
    } satisfies MerchantKnowledgeResolvedAddress;
  });

  validated.sort(
    (left, right) =>
      left.family - right.family ||
      (left.address < right.address ? -1 : left.address > right.address ? 1 : 0),
  );
  return validated[0]!;
}

export function addressesMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeIpAddress(left);
  const normalizedRight = normalizeIpAddress(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

export function createPinnedLookup(
  address: MerchantKnowledgeResolvedAddress,
): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}