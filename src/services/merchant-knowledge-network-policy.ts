import { lookup as dnsLookup } from "node:dns/promises";
import type { RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

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

const GLOBAL_IPV4 = new BlockList();
GLOBAL_IPV4.addSubnet("0.0.0.0", 0, "ipv4");

const PUBLIC_IPV6_ALLOCATION_CIDRS: readonly [string, number][] = [
  ["2001:200::", 23],
  ["2001:400::", 23],
  ["2001:600::", 23],
  ["2001:800::", 22],
  ["2001:c00::", 23],
  ["2001:e00::", 23],
  ["2001:1200::", 23],
  ["2001:1400::", 22],
  ["2001:1800::", 23],
  ["2001:1a00::", 23],
  ["2001:1c00::", 22],
  ["2001:2000::", 19],
  ["2001:4000::", 23],
  ["2001:4200::", 23],
  ["2001:4400::", 23],
  ["2001:4600::", 23],
  ["2001:4800::", 23],
  ["2001:4a00::", 23],
  ["2001:4c00::", 23],
  ["2001:5000::", 20],
  ["2001:8000::", 19],
  ["2001:a000::", 20],
  ["2001:b000::", 20],
  ["2003::", 18],
  ["2400::", 12],
  ["2410::", 12],
  ["2600::", 12],
  ["2610::", 23],
  ["2620::", 23],
  ["2630::", 12],
  ["2800::", 12],
  ["2a00::", 12],
  ["2a10::", 12],
  ["2c00::", 12],
];
const PUBLIC_IPV6_ALLOCATIONS = new BlockList();
for (const [network, prefix] of PUBLIC_IPV6_ALLOCATION_CIDRS) {
  PUBLIC_IPV6_ALLOCATIONS.addSubnet(network, prefix, "ipv6");
}

const NON_PUBLIC_SPECIAL_USE_CIDRS: readonly [string, number, "ipv4" | "ipv6"][] = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.31.196.0", 24, "ipv4"],
  ["192.52.193.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["192.175.48.0", 24, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["2620:4f:8000::", 48, "ipv6"],
  ["3fff::", 20, "ipv6"],
  ["5f00::", 16, "ipv6"],
];
const NON_PUBLIC_SPECIAL_USE = new BlockList();
for (const [network, prefix, family] of NON_PUBLIC_SPECIAL_USE_CIDRS) {
  NON_PUBLIC_SPECIAL_USE.addSubnet(network, prefix, family);
}
const IPV4_MAPPED_IPV6 = new BlockList();
IPV4_MAPPED_IPV6.addSubnet("::ffff:0:0", 96, "ipv6");

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
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return null;

  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    if (!IPV4_MAPPED_IPV6.check(canonical, "ipv6")) return canonical;
    const groups = canonical.split(":");
    const first = Number.parseInt(groups.at(-2)!, 16);
    const second = Number.parseInt(groups.at(-1)!, 16);
    return [first >> 8, first & 255, second >> 8, second & 255].join(".");
  } catch {
    return null;
  }
}

export function isPublicIpAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6 && IPV4_MAPPED_IPV6.check(address, "ipv6")) {
    const normalized = normalizeIpAddress(address);
    return normalized !== null && isPublicIpAddress(normalized);
  }
  const allowed = family === 4
    ? GLOBAL_IPV4.check(address, "ipv4")
    : PUBLIC_IPV6_ALLOCATIONS.check(address, "ipv6");
  return allowed && !NON_PUBLIC_SPECIAL_USE.check(address, family === 4 ? "ipv4" : "ipv6");
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