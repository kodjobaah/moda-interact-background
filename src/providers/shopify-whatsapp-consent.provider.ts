import { toShopifyCustomerGid } from "@modainteract/moda-interact-shared/identity";
import { getShopifySession } from "../services/shopify-session.service.js";

const API_VERSION = "2026-07";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const CONSENT_PATH = `/admin/api/${API_VERSION}/graphql.json`;
type ConsentSession = Pick<Awaited<ReturnType<typeof getShopifySession>>, "shop" | "accessToken">;

const CUSTOMER_WHATSAPP_CONSENT_QUERY = `
  query CustomerWhatsAppConsent($id: ID!) {
    customer(id: $id) {
      id
      defaultPhoneNumber {
        phoneNumber
        whatsAppMarketingConsent { state updatedAt }
      }
    }
  }
`;

export type ShopifyWhatsAppConsentObservation =
  | {
      kind: "OBSERVED";
      customerGid: string;
      phoneNumber: string;
      state: "SUBSCRIBED" | "UNSUBSCRIBED" | "PENDING" | "NEVER_SUBSCRIBED" | "REDACTED";
      updatedAt: string | null;
    }
  | { kind: "NOT_FOUND" }
  | { kind: "UNAVAILABLE"; reason: "TIMEOUT" | "HTTP" | "GRAPHQL" | "ACCESS_DENIED" | "INVALID_RESPONSE" };

export interface ShopifyWhatsAppConsentReader {
  readCurrent(input: {
    shopId: string;
    customerGid: string;
  }): Promise<ShopifyWhatsAppConsentObservation>;
}

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ProviderDependencies = {
  fetchImpl?: FetchPort;
  session?: (shopId: string, options?: { signal?: AbortSignal }) => Promise<ConsentSession>;
  timeoutMs?: number;
};

/** Read-only Shopify boundary. All identity/recipient/persistence policy stays in the service. */
export class ShopifyWhatsAppConsentProvider implements ShopifyWhatsAppConsentReader {
  private readonly fetchImpl: FetchPort;
  private readonly session: (shopId: string, options?: { signal?: AbortSignal }) => Promise<ConsentSession>;
  private readonly timeoutMs: number;

  constructor(dependencies: ProviderDependencies = {}) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.session = dependencies.session ?? getShopifySession;
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error("Invalid Shopify consent read timeout");
    }
  }

  async readCurrent(input: {
    shopId: string;
    customerGid: string;
  }): Promise<ShopifyWhatsAppConsentObservation> {
    let customerGid: string;
    try {
      customerGid = toShopifyCustomerGid(input.customerGid);
      if (customerGid !== input.customerGid) {
        return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
      }
    } catch {
      return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("SHOPIFY_CONSENT_TIMEOUT"));
      }, this.timeoutMs);
    });
    try {
      // Bound offline-token retrieval as well as HTTP/body transfer.
      let session: ConsentSession;
      try {
        session = await Promise.race([this.session(input.shopId, { signal: controller.signal }), deadline]);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return { kind: "UNAVAILABLE", reason: "ACCESS_DENIED" };
      }
      if (!session?.accessToken) return { kind: "UNAVAILABLE", reason: "ACCESS_DENIED" };
      const endpoint = buildConsentEndpoint(session.shop);
      if (!endpoint) return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
      const requestBody = JSON.stringify({
        query: CUSTOMER_WHATSAPP_CONSENT_QUERY,
        variables: { id: customerGid },
      });
      if (Buffer.byteLength(requestBody, "utf8") > MAX_REQUEST_BYTES) {
        return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
      }
      const response = await Promise.race([
        this.fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: requestBody,
          signal: controller.signal,
        }),
        deadline,
      ]);

      if (response.status === 401 || response.status === 403) {
        return { kind: "UNAVAILABLE", reason: "ACCESS_DENIED" };
      }
      if (!response.ok) return { kind: "UNAVAILABLE", reason: "HTTP" };
      const declaredLength = Number(response.headers.get("content-length"));
      if (declaredLength > MAX_RESPONSE_BYTES) {
        return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
      }
      const body = await Promise.race([response.text(), deadline]);
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
      }
      return decodeObservation(decoded, customerGid);
    } catch (error) {
      // Never log API bodies, phone numbers, Shopify access tokens or raw errors.
      if (controller.signal.aborted || (error instanceof Error && error.message === "SHOPIFY_CONSENT_TIMEOUT")) {
        return { kind: "UNAVAILABLE", reason: "TIMEOUT" };
      }
      return { kind: "UNAVAILABLE", reason: "HTTP" };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function buildConsentEndpoint(shop: string): URL | undefined {
  if (!shop || shop.length > 255 || /[\u0000-\u0020\u007f]/.test(shop)) return undefined;
  try {
    const endpoint = new URL(`https://${shop}${CONSENT_PATH}`);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port ||
        endpoint.pathname !== CONSENT_PATH || endpoint.search || endpoint.hash ||
        endpoint.hostname !== shop || endpoint.origin !== `https://${shop}`) {
      return undefined;
    }
    return endpoint;
  } catch {
    return undefined;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function decodeObservation(response: unknown, requestedGid: string): ShopifyWhatsAppConsentObservation {
  if (!isRecord(response)) return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    const denied = response.errors.some((item) => {
      if (!isRecord(item)) return false;
      const message = typeof item.message === "string" ? item.message : "";
      const code = isRecord(item.extensions) && typeof item.extensions.code === "string"
        ? item.extensions.code : "";
      return /ACCESS_DENIED|FORBIDDEN/i.test(code) || /access denied|protected customer data|not authorized|forbidden/i.test(message);
    });
    return { kind: "UNAVAILABLE", reason: denied ? "ACCESS_DENIED" : "GRAPHQL" };
  }
  // An `errors` envelope is not a valid success even when the errors payload is malformed.
  if (response.errors !== undefined) return { kind: "UNAVAILABLE", reason: "GRAPHQL" };
  if (!isRecord(response.data) || !("customer" in response.data)) {
    return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  }
  const customer = response.data.customer;
  if (customer === null) return { kind: "NOT_FOUND" };
  if (!isRecord(customer) || customer.id !== requestedGid) {
    return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  }
  // A customer with no default number cannot grant permission to an older recipient.
  if (customer.defaultPhoneNumber === null) return { kind: "NOT_FOUND" };
  if (!isRecord(customer.defaultPhoneNumber)) {
    return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  }
  const phone = customer.defaultPhoneNumber;
  if (typeof phone.phoneNumber !== "string" || !isRecord(phone.whatsAppMarketingConsent)) {
    return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  }
  const consent = phone.whatsAppMarketingConsent;
  if (!["SUBSCRIBED", "UNSUBSCRIBED", "PENDING", "NEVER_SUBSCRIBED", "REDACTED"].includes(String(consent.state))) {
    return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  }
  if (consent.updatedAt !== null &&
      (typeof consent.updatedAt !== "string" || !Number.isFinite(Date.parse(consent.updatedAt)))) {
    return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  }
  if (consent.updatedAt === undefined) return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  return {
    kind: "OBSERVED",
    customerGid: requestedGid,
    phoneNumber: phone.phoneNumber,
    state: consent.state as Extract<ShopifyWhatsAppConsentObservation, { kind: "OBSERVED" }>["state"],
    updatedAt: consent.updatedAt as string | null,
  };
}
