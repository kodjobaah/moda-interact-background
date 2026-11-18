// Bounded Shopify Admin GraphQL abandoned-checkout lookup.
//
// ARCH-001-BACKGROUND-003: Shopify exposes no direct abandoned-checkout lookup
// by checkout/cart token, recovery URL or creation timestamp. The approved
// strategy is:
//
//   1. derive a narrow server-side `created_at` filter from the candidate's
//      checkoutCreatedAt through evaluation time (Shopify creates its abandoned
//      checkout record after the original checkout);
//   2. enforce a hard candidate bound (count pre-check) so no unbounded
//      pagination is ever possible;
//   3. fetch a bounded result set;
//   4. match exactly on abandonedCheckoutUrl.
//
// Provider/transport failures are kept distinct from "not-found" so that they
// remain retryable rather than silently discarding a potential recovery.

import prisma from "../lib/db.js";
import { createHash, randomUUID } from "node:crypto";
import {
  createLogger,
  sanitizeLogFields,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
const lookupLogger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});
const urlDigest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const CONSENT_ATTRIBUTE_KEY = "moda_wa_consent_v1";
const SYNTHETIC_DIAGNOSTIC_ENVIRONMENTS = new Set(["test", "development"]);
import {
  ABANDONED_CHECKOUT_API_VERSION,
  ABANDONED_CHECKOUT_LOOKUP_WINDOW_MS,
  ABANDONED_CHECKOUT_MAX_CANDIDATES,
  type AbandonedCheckoutLookupInput,
  type AbandonedCheckoutLookupOutcome,
  type NormalizedAbandonedCheckout,
} from "../domain/abandoned-checkout.js";
import { getShopifyAccessToken } from "./shopify-session.service.js";
import { readRecoveryExecutionPolicy } from "./platform-configuration/consumers.js";
import type { RecoveryExecutionPolicy } from "./platform-configuration/contracts.js";
import {
  canonicaliseLanguageTag,
  normalizeCountryCode,
  normalizeCurrencyCode,
  normalizeTimeZone,
  type InternationalContext,
} from "@modainteract/moda-interact-shared/internationalization";

const GRAPHQL_ENDPOINT = (shopDomain: string, version: string) =>
  `https://${shopDomain}/admin/api/${version}/graphql.json`;

type ShopifyMoney = {
  amount?: string | null;
  currencyCode?: string | null;
};

type ShopifyAbandonedCheckoutLineItem = {
  product?: { id?: string | null } | null;
  variant?: { id?: string | null } | null;
  sku?: string | null;
  title?: string | null;
  variantTitle?: string | null;
  quantity?: number | null;
  originalUnitPriceSet?: { presentmentMoney?: ShopifyMoney | null } | null;
};

type ShopifyAbandonedCheckoutNode = {
  id?: string | null;
  abandonedCheckoutUrl?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  totalPriceSet?: { presentmentMoney?: ShopifyMoney | null } | null;
  customer?: {
    id?: string | null;
    email?: string | null;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    locale?: string | null;
  } | null;
  billingAddress?: {
    phone?: string | null;
    countryCodeV2?: string | null;
    timeZone?: string | null;
  } | null;
  shippingAddress?: {
    phone?: string | null;
  } | null;
  customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
  lineItems?: {
    nodes?: ShopifyAbandonedCheckoutLineItem[] | null;
    pageInfo?: { hasNextPage?: boolean };
  } | null;
};

type AbandonedCheckoutGraphqlResponse = {
  data?: {
    shop?: { plan?: { shopifyPlus?: boolean | null } | null } | null;
    abandonedCheckoutsCount?: { count?: number | null } | null;
    abandonedCheckouts?: { nodes?: ShopifyAbandonedCheckoutNode[] | null } | null;
  } | null;
  errors?: unknown;
};

type GraphqlOperation = "AbandonedCheckoutsCount" | "AbandonedCheckouts";
type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type LookupLogger = Pick<StructuredLogger, "info" | "warn" | "error">;

interface LookupDiagnostics {
  logger?: LookupLogger;
  fetchImpl?: FetchPort;
  environment?: () => string;
  requestId?: () => string;
}

interface LookupCorrelation {
  shopId: string;
  checkoutDigest: string;
}

export class AbandonedCheckoutLookupService {
  constructor(
    private readonly readPolicy?: () => Promise<RecoveryExecutionPolicy>,
    private readonly now: () => number = Date.now,
    private readonly diagnostics: LookupDiagnostics = {},
  ) {}
  async resolveShopDomain(shopId: string): Promise<string> {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { domain: true },
    });

    if (!shop) {
      throw new Error(`Shop not found for id: ${shopId}`);
    }

    return shop.domain;
  }

  async lookup(
    input: AbandonedCheckoutLookupInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AbandonedCheckoutLookupOutcome> {
    const policy = this.readPolicy ? await this.readPolicy() : null;
    const maxCandidates = policy?.abandonedCheckoutMaxCandidates ?? ABANDONED_CHECKOUT_MAX_CANDIDATES;
    const lookupWindowMs = policy?.abandonedCheckoutLookupWindowMs ?? ABANDONED_CHECKOUT_LOOKUP_WINDOW_MS;
    const correlation = {
      shopId: input.shopId,
      checkoutDigest: urlDigest(input.checkoutToken),
    };
    // Exact URL matching is the recovery identity. Without it the lookup cannot
    // be completed deterministically.
    if (!input.abandonedCheckoutUrl) {
      this.log("info", "shopify.abandoned_checkout.lookup_outcome", {
        ...correlation,
        outcome: "not-found", reason: "missing-recovery-url",
      });
      return { kind: "not-found" };
    }

    // The time scope is required to keep the query narrow and bounded.
    const timeRange = this.buildCreatedAtFilter(input.checkoutCreatedAt, lookupWindowMs);
    if (!timeRange) {
      this.log("info", "shopify.abandoned_checkout.lookup_outcome", {
        ...correlation,
        outcome: "not-found", reason: "invalid-checkout-created-at",
      });
      return { kind: "not-found" };
    }

    const accessToken = await getShopifyAccessToken(input.shopId, options);

    const count = await this.fetchBoundedCount(
      input.shopDomain,
      accessToken,
      timeRange,
      correlation,
      options.signal,
      maxCandidates,
    );

    if (count === null) {
      this.log("warn", "shopify.abandoned_checkout.lookup_decision", {
        ...correlation,
        operation: "AbandonedCheckoutsCount",
        outcome: "provider-error",
        reasonCode: "COUNT_MISSING",
        queryBounds: timeRange,
      });
      return {
        kind: "provider-error",
        message: "abandonedCheckoutsCount returned null count",
      };
    }

    if (count > maxCandidates) {
      this.log("info", "shopify.abandoned_checkout.lookup_decision", {
        ...correlation,
        operation: "AbandonedCheckoutsCount",
        outcome: "bounded-limit-exceeded",
        candidateCount: count,
        maxCandidates,
        queryBounds: timeRange,
      });
      return {
        kind: "bounded-limit-exceeded",
        candidateCount: count,
      };
    }

    if (count === 0) {
      this.log("info", "shopify.abandoned_checkout.lookup_outcome", {
        ...correlation,
        outcome: "not-found", reason: "zero-candidates", candidateCount: 0,
        windowFrom: timeRange.fromIso, windowTo: timeRange.toIso,
      });
      return { kind: "not-found" };
    }

    const candidates = await this.fetchAbandonedCheckouts(
      input.shopDomain,
      accessToken,
      timeRange,
      correlation,
      options.signal,
      maxCandidates,
    );

    if (candidates === null) {
      this.log("warn", "shopify.abandoned_checkout.lookup_decision", {
        ...correlation,
        operation: "AbandonedCheckouts",
        outcome: "provider-error",
        reasonCode: "DETAIL_NODES_MISSING",
        queryBounds: timeRange,
      });
      return {
        kind: "provider-error",
        message: "abandonedCheckouts query returned no data",
      };
    }

    const matches = candidates.filter(
      (c) => c.abandonedCheckoutUrl === input.abandonedCheckoutUrl,
    );

    if (matches.length === 0) {
      this.log("info", "shopify.abandoned_checkout.lookup_outcome", {
        ...correlation,
        outcome: "not-found", reason: "url-mismatch", candidateCount: candidates.length,
        windowFrom: timeRange.fromIso, windowTo: timeRange.toIso,
        expectedUrlDigest: urlDigest(input.abandonedCheckoutUrl),
        returnedUrlDigests: candidates.map(c => urlDigest(c.abandonedCheckoutUrl)),
      });
      return { kind: "not-found" };
    }

    if (matches.length > 1) {
      this.log("warn", "shopify.abandoned_checkout.lookup_decision", {
        ...correlation,
        operation: "AbandonedCheckouts",
        outcome: "ambiguous",
        candidateCount: candidates.length,
        matched: matches.length,
      });
      return { kind: "ambiguous", matched: matches.length };
    }

    // Exactly one exact URL match remains (0 and >1 are handled above).
    const match = matches[0] as NormalizedAbandonedCheckout;
    this.log("info", "shopify.abandoned_checkout.lookup_outcome", {
      ...correlation,
      outcome: "found", candidateCount: candidates.length,
    });
    this.log("info", "shopify.abandoned_checkout.lookup_decision", {
      ...correlation,
      operation: "AbandonedCheckouts",
      outcome: "exact-match",
      candidateCount: candidates.length,
      matched: 1,
      matchedCheckoutDigest: urlDigest(match.abandonedCheckoutUrl),
    });
    return { kind: "found", checkout: match };
  }

  private buildCreatedAtFilter(
    checkoutCreatedAt: string | null,
    lookupWindowMs: number,
  ): { fromIso: string; toIso: string } | null {
    if (!checkoutCreatedAt) {
      return null;
    }

    const created = new Date(checkoutCreatedAt);
    if (Number.isNaN(created.getTime())) {
      return null;
    }

    const from = new Date(created.getTime() - lookupWindowMs);
    // AbandonedCheckout.createdAt is when Shopify records the abandonment,
    // which can be later than the checkout/create webhook by many minutes.
    // Keep the original lower bound and include the elapsed checkout lifetime.
    // The count pre-check still prevents enumerating more than maxCandidates.
    const to = new Date(Math.max(created.getTime(), this.now()) + lookupWindowMs);

    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
    };
  }

  private buildFilterQuery(timeRange: { fromIso: string; toIso: string }): string {
    const from = timeRange.fromIso;
    const to = timeRange.toIso;
    return `created_at:>="${from}" AND created_at:<="${to}"`;
  }

  private async fetchBoundedCount(
    shopDomain: string,
    accessToken: string,
    timeRange: { fromIso: string; toIso: string },
    correlation: LookupCorrelation,
    signal?: AbortSignal,
    maxCandidates = ABANDONED_CHECKOUT_MAX_CANDIDATES,
  ): Promise<number | null> {
    const query = this.buildFilterQuery(timeRange);

    const body = {
      query: `
        query AbandonedCheckoutsCount($query: String!, $limit: Int!) {
          abandonedCheckoutsCount(query: $query, limit: $limit) {
            count
          }
        }
      `,
      variables: {
        query,
        limit: maxCandidates + 1,
      },
    };

    const result = await this.postGraphql(
      shopDomain,
      accessToken,
      body,
      "AbandonedCheckoutsCount",
      correlation,
      signal,
    );
    if (!result) {
      return null;
    }

    return result?.data?.abandonedCheckoutsCount?.count ?? null;
  }

  private async fetchAbandonedCheckouts(
    shopDomain: string,
    accessToken: string,
    timeRange: { fromIso: string; toIso: string },
    correlation: LookupCorrelation,
    signal?: AbortSignal,
    maxCandidates = ABANDONED_CHECKOUT_MAX_CANDIDATES,
  ): Promise<NormalizedAbandonedCheckout[] | null> {
    const query = this.buildFilterQuery(timeRange);

    const body = {
      query: `
        query AbandonedCheckouts($query: String!, $first: Int!) {
          shop {
            plan {
              shopifyPlus
            }
          }
          abandonedCheckouts(
            first: $first
            query: $query
            sortKey: CREATED_AT
          ) {
            nodes {
              id
              abandonedCheckoutUrl
              createdAt
              completedAt
              customAttributes {
                key
                value
              }
              billingAddress {
                phone
                countryCodeV2
                timeZone
              }
              shippingAddress {
                phone
              }
              totalPriceSet {
                presentmentMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                id
                email
                phone
                firstName
                lastName
                locale
              }
              lineItems(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  id
                  product {
                    id
                  }
                  variant {
                    id
                  }
                  sku
                  title
                  variantTitle
                  quantity
                  originalUnitPriceSet {
                    presentmentMoney {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        query,
        first: maxCandidates,
      },
    };

    const result = await this.postGraphql(
      shopDomain,
      accessToken,
      body,
      "AbandonedCheckouts",
      correlation,
      signal,
    );
    if (!result) {
      return null;
    }

    const nodes = result?.data?.abandonedCheckouts?.nodes;
    if (!Array.isArray(nodes)) {
      return null;
    }

    // Never send a recovery with a silently truncated basket snapshot.
    if (nodes.some((node) => node.lineItems?.pageInfo?.hasNextPage)) {
      throw new Error("Shopify abandoned checkout exceeds the 100 line-item lookup bound");
    }
    const shopifyPlus = result.data?.shop?.plan?.shopifyPlus;
    return nodes.map((node) => this.normalize(
      node,
      typeof shopifyPlus === "boolean" ? shopifyPlus : null,
    ));
  }

  private normalize(
    node: ShopifyAbandonedCheckoutNode,
    shopifyPlus: boolean | null,
  ): NormalizedAbandonedCheckout {
    const presentmentMoney = node?.totalPriceSet?.presentmentMoney;
    return {
      shopifyAbandonedCheckoutId: node?.id ?? null,
      abandonedCheckoutUrl: node?.abandonedCheckoutUrl ?? "",
      createdAt: node?.createdAt ?? "",
      completedAt: node?.completedAt ?? null,
      shopifyPlus,
      consentReceiptAttribute: this.normalizeConsentReceiptAttribute(node?.customAttributes),
      billingPhone: node?.billingAddress?.phone ?? null,
      shippingPhone: node?.shippingAddress?.phone ?? null,
      currencyCode: presentmentMoney?.currencyCode ?? null,
      totalPrice: presentmentMoney?.amount ?? null,
      internationalContext: normalizeInternationalContext(node),
      customer: node?.customer
        ? {
            shopifyCustomerId: node.customer.id ?? null,
            email: node.customer.email ?? null,
            phone: node.customer.phone ?? null,
            firstName: node.customer.firstName ?? null,
            lastName: node.customer.lastName ?? null,
          }
        : null,
      lineItems: Array.isArray(node?.lineItems?.nodes)
        ? node.lineItems.nodes.map((li) => ({
            productId: li?.product?.id ?? null,
            variantId: li?.variant?.id ?? null,
            title: li?.title ?? null,
            variantTitle: li?.variantTitle ?? null,
            sku: li?.sku ?? null,
            quantity: li?.quantity ?? 0,
            price: li?.originalUnitPriceSet?.presentmentMoney?.amount ?? null,
          }))
        : [],
    };
  }

  private normalizeConsentReceiptAttribute(
    attributes: ShopifyAbandonedCheckoutNode["customAttributes"],
  ): NormalizedAbandonedCheckout["consentReceiptAttribute"] {
    if (attributes == null) return { kind: "MISSING" };
    if (!Array.isArray(attributes)) return { kind: "INVALID" };
    if (attributes.some((attribute) =>
      typeof attribute !== "object" || attribute === null ||
      typeof attribute.key !== "string" || typeof attribute.value !== "string")) {
      return { kind: "INVALID" };
    }
    const matching = attributes.filter((attribute) =>
      attribute.key === "moda_wa_consent_v1");
    if (matching.length === 0) return { kind: "MISSING" };
    if (matching.length !== 1 || typeof matching[0]?.value !== "string") {
      return { kind: "INVALID" };
    }
    return { kind: "VALUE", value: matching[0].value };
  }

  private async postGraphql(
    shopDomain: string,
    accessToken: string,
    body: { query: string; variables: Record<string, unknown> },
    operation: GraphqlOperation,
    correlation: LookupCorrelation,
    signal?: AbortSignal,
  ): Promise<AbandonedCheckoutGraphqlResponse | null> {
    const requestId = this.diagnostics.requestId?.() ?? randomUUID();
    const requestStartedAt = performance.now();
    const queryBounds = getQueryBounds(body.variables);
    const requestFields = {
      requestId,
      ...correlation,
      operation,
      queryBounds,
    };
    this.log("info", "shopify.abandoned_checkout.graphql.request_started", requestFields);

    let response: Response;
    try {
      response = await (this.diagnostics.fetchImpl ?? fetch)(
        GRAPHQL_ENDPOINT(shopDomain, ABANDONED_CHECKOUT_API_VERSION),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      this.log("warn", "shopify.abandoned_checkout.graphql.provider_failure", {
        ...requestFields,
        provider: "shopify",
        origin: "sdk_exception",
        ...safeException(error),
      });
      this.log("info", "shopify.abandoned_checkout.graphql.request_completed", {
        ...requestFields,
        httpStatus: null,
        outcome: "transport_error",
        durationMs: elapsedMilliseconds(requestStartedAt),
      });
      throw new Error(
        `Shopify abandoned-checkout transport error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    let responseText: string;
    try {
      // Consume the provider response exactly once. Diagnostics and parsing use
      // this same text so logged fields cannot diverge from the data we process.
      responseText = await response.text();
    } catch (error) {
      this.log("warn", "shopify.abandoned_checkout.graphql.provider_failure", {
        ...requestFields,
        provider: "shopify",
        origin: "sdk_exception",
        httpStatus: response.status,
        ...safeException(error),
      });
      this.log("info", "shopify.abandoned_checkout.graphql.request_completed", {
        ...requestFields,
        httpStatus: response.status,
        outcome: "response_read_error",
        durationMs: elapsedMilliseconds(requestStartedAt),
      });
      throw new Error(
        `Shopify abandoned-checkout GraphQL returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    this.logSyntheticResponse(requestFields, response.status, responseText);

    if (!response.ok) {
      this.log("warn", "shopify.abandoned_checkout.graphql.provider_failure", {
        ...requestFields,
        provider: "shopify",
        origin: "provider_response",
        httpStatus: response.status,
        ...safeHttpErrorBody(responseText),
      });
      this.log("info", "shopify.abandoned_checkout.graphql.request_completed", {
        ...requestFields,
        httpStatus: response.status,
        outcome: "http_error",
        durationMs: elapsedMilliseconds(requestStartedAt),
      });
      throw new Error(
        `Shopify abandoned-checkout GraphQL request failed: ${response.status} ${responseText}`,
      );
    }

    let parsed: AbandonedCheckoutGraphqlResponse;
    try {
      parsed = JSON.parse(responseText) as AbandonedCheckoutGraphqlResponse;
    } catch (error) {
      this.log("warn", "shopify.abandoned_checkout.graphql.provider_failure", {
        ...requestFields,
        provider: "shopify",
        origin: "provider_response",
        httpStatus: response.status,
        reasonCode: "INVALID_JSON",
        ...safeException(error),
      });
      this.log("info", "shopify.abandoned_checkout.graphql.request_completed", {
        ...requestFields,
        httpStatus: response.status,
        outcome: "invalid_json",
        durationMs: elapsedMilliseconds(requestStartedAt),
      });
      throw new Error(
        `Shopify abandoned-checkout GraphQL returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    if (parsed?.errors) {
      this.log("warn", "shopify.abandoned_checkout.graphql.provider_failure", {
        ...requestFields,
        provider: "shopify",
        origin: "provider_response",
        httpStatus: response.status,
        ...safeProviderErrors(parsed.errors),
      });
      this.log("info", "shopify.abandoned_checkout.graphql.request_completed", {
        ...requestFields,
        httpStatus: response.status,
        outcome: "graphql_error",
        durationMs: elapsedMilliseconds(requestStartedAt),
      });
      throw new Error(
        `Shopify abandoned-checkout GraphQL error: ${JSON.stringify(parsed.errors)}`,
      );
    }

    if (operation === "AbandonedCheckoutsCount") {
      const count = parsed?.data?.abandonedCheckoutsCount?.count ?? null;
      this.log("info", "shopify.abandoned_checkout.graphql.count_parsed", {
        ...requestFields,
        httpStatus: response.status,
        candidateCount: count,
      });
    } else {
      const nodes = parsed?.data?.abandonedCheckouts?.nodes;
      this.log("info", "shopify.abandoned_checkout.graphql.details_parsed", {
        ...requestFields,
        httpStatus: response.status,
        nodeCount: Array.isArray(nodes) ? nodes.length : null,
      });
      this.log("info", "shopify.abandoned_checkout.graphql.receipt_attributes", {
        ...requestFields,
        httpStatus: response.status,
        ...summarizeConsentAttributes(nodes),
      });
    }
    this.log("info", "shopify.abandoned_checkout.graphql.request_completed", {
      ...requestFields,
      httpStatus: response.status,
      outcome: "parsed",
      durationMs: elapsedMilliseconds(requestStartedAt),
    });

    return parsed;
  }

  private logSyntheticResponse(
    requestFields: Record<string, unknown>,
    httpStatus: number,
    responseText: string,
  ): void {
    const environment = this.diagnostics.environment?.() ?? resolveDeploymentEnvironmentName();
    if (!SYNTHETIC_DIAGNOSTIC_ENVIRONMENTS.has(environment)) return;

    const codePoints = Array.from(responseText);
    const chunks: string[] = [];
    if (codePoints.length === 0) {
      chunks.push("");
    } else {
      for (let offset = 0; offset < codePoints.length; offset += 1024) {
        chunks.push(codePoints.slice(offset, offset + 1024).join(""));
      }
    }

    chunks.forEach((responseChunk, chunkIndex) => {
      const sanitized = sanitizeLogFields({ responseChunk }).responseChunk;
      this.log("info", "shopify.abandoned_checkout.graphql.synthetic_response_chunk", {
        ...requestFields,
        httpStatus,
        responseChunk,
        chunkIndex,
        chunkCount: chunks.length,
        syntheticTestData: true,
        redactionApplied: sanitized !== responseChunk,
      });
    });
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    try {
      (this.diagnostics.logger ?? lookupLogger)[level](event, fields);
    } catch {
      // Shared logging is best-effort and must not affect lookup/retry behavior.
    }
  }
}

function getQueryBounds(variables: Record<string, unknown>): Record<string, unknown> {
  const query = typeof variables.query === "string" ? variables.query : "";
  const bounds = [...query.matchAll(/created_at:>="([^"]+)"|created_at:<="([^"]+)"/g)];
  return {
    from: bounds.find((match) => match[1])?.[1] ?? null,
    to: bounds.find((match) => match[2])?.[2] ?? null,
    limit: typeof variables.limit === "number" ? variables.limit : null,
    first: typeof variables.first === "number" ? variables.first : null,
  };
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function summarizeConsentAttributes(nodes: unknown): Record<string, number> {
  const summary = { present: 0, missing: 0, duplicate: 0, invalid: 0 };
  if (!Array.isArray(nodes)) return summary;
  for (const rawNode of nodes) {
    if (rawNode === null || typeof rawNode !== "object") {
      summary.invalid += 1;
      continue;
    }
    const attributes = (rawNode as ShopifyAbandonedCheckoutNode).customAttributes;
    if (attributes == null) {
      summary.missing += 1;
      continue;
    }
    if (!Array.isArray(attributes) || attributes.some((attribute) =>
      attribute === null || typeof attribute !== "object" ||
      typeof attribute.key !== "string" || typeof attribute.value !== "string")) {
      summary.invalid += 1;
      continue;
    }
    const matches = attributes.filter((attribute) => attribute.key === CONSENT_ATTRIBUTE_KEY);
    if (matches.length === 0) summary.missing += 1;
    else if (matches.length > 1) summary.duplicate += 1;
    else summary.present += 1;
  }
  return summary;
}

function safeProviderText(value: string): {
  value: string;
  redactionApplied: boolean;
  truncated: boolean;
} {
  const unsafe = /https?:\/\/|@|Bearer\s|shp[a-z]*_|(?:\d[\s()+.-]*){9,}|(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]/i.test(value);
  return {
    value: unsafe ? "[REDACTED]" : value.slice(0, 1024),
    redactionApplied: unsafe,
    truncated: value.length > 1024,
  };
}

function safeException(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    const safe = safeProviderText(String(error));
    return {
      error: { name: "NonErrorThrownValue", message: safe.value },
      redactionApplied: safe.redactionApplied,
      truncated: safe.truncated,
    };
  }
  const safe = safeProviderText(error.message);
  const errorRecord: Record<string, unknown> = {
    name: error.name.slice(0, 64),
    message: safe.value,
  };
  if ("code" in error && (typeof error.code === "string" || typeof error.code === "number")) {
    errorRecord.code = error.code;
  }
  const cause = error.cause;
  const safeCause = cause === undefined ? null : safeCauseRecord(cause);
  if (safeCause) errorRecord.cause = safeCause.value;
  return {
    error: errorRecord,
    redactionApplied: safe.redactionApplied || (safeCause?.redactionApplied ?? false),
    truncated: safe.truncated || (safeCause?.truncated ?? false),
  };
}

function safeCauseRecord(error: unknown, depth = 0): {
  value: Record<string, unknown>;
  redactionApplied: boolean;
  truncated: boolean;
} {
  if (depth >= 3) {
    return {
      value: { cause: "[Truncated]" },
      redactionApplied: false,
      truncated: true,
    };
  }
  if (!(error instanceof Error)) {
    const safe = safeProviderText(String(error));
    return {
      value: { name: "NonErrorThrownValue", message: safe.value },
      redactionApplied: safe.redactionApplied,
      truncated: safe.truncated,
    };
  }
  const safe = safeProviderText(error.message);
  const value: Record<string, unknown> = {
    name: error.name.slice(0, 64),
    message: safe.value,
  };
  if ("code" in error && (typeof error.code === "string" || typeof error.code === "number")) {
    value.code = error.code;
  }
  const nestedCause = error.cause;
  const nested = nestedCause === undefined ? null : safeCauseRecord(nestedCause, depth + 1);
  if (nested) value.cause = nested.value;
  return {
    value,
    redactionApplied: safe.redactionApplied || (nested?.redactionApplied ?? false),
    truncated: safe.truncated || (nested?.truncated ?? false),
  };
}

function safeProviderErrors(errors: unknown): Record<string, unknown> {
  if (!Array.isArray(errors)) {
    return {
      providerErrorBody: "[REDACTED]",
      redactionApplied: true,
      truncated: false,
    };
  }
  let redactionApplied = false;
  let truncated = errors.length > 50;
  const providerErrors = errors.slice(0, 50).map((rawError) => {
    if (rawError === null || typeof rawError !== "object" || Array.isArray(rawError)) {
      redactionApplied = true;
      return { message: "[REDACTED]" };
    }
    const source = rawError as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    if (typeof source.message === "string") {
      const safe = safeProviderText(source.message);
      output.message = safe.value;
      redactionApplied ||= safe.redactionApplied;
      truncated ||= safe.truncated;
    }
    if ("path" in source) output.path = safeProviderValue(source.path, () => {
      redactionApplied = true;
    }, () => {
      truncated = true;
    });
    if ("locations" in source) output.locations = safeProviderValue(source.locations, () => {
      redactionApplied = true;
    }, () => {
      truncated = true;
    });
    if ("extensions" in source) output.extensions = safeProviderValue(source.extensions, () => {
      redactionApplied = true;
    }, () => {
      truncated = true;
    });
    return output;
  });
  return { providerErrors, redactionApplied, truncated };
}

function safeProviderValue(
  value: unknown,
  markRedacted: () => void,
  markTruncated: () => void,
  depth = 0,
): unknown {
  if (depth > 5) {
    markTruncated();
    return "[Truncated]";
  }
  if (typeof value === "string") {
    const safe = safeProviderText(value);
    if (safe.redactionApplied) markRedacted();
    if (safe.truncated) markTruncated();
    return safe.value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > 50) markTruncated();
    return value.slice(0, 50).map((entry) =>
      safeProviderValue(entry, markRedacted, markTruncated, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 50) markTruncated();
    return Object.fromEntries(entries.slice(0, 50).map(([key, entry]) => [
      key,
      safeProviderValue(entry, markRedacted, markTruncated, depth + 1),
    ]));
  }
  return String(value);
}

function safeHttpErrorBody(responseText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (parsed !== null && typeof parsed === "object" && "errors" in parsed) {
      return safeProviderErrors((parsed as { errors?: unknown }).errors);
    }
  } catch {
    // Keep an unsafe or malformed HTTP body out of ordinary production logs.
  }
  const safe = safeProviderText(responseText);
  return {
    providerErrorBody: safe.value,
    redactionApplied: safe.redactionApplied,
    truncated: safe.truncated,
  };
}

export const abandonedCheckoutLookupService = new AbandonedCheckoutLookupService(readRecoveryExecutionPolicy);
function normalizeInternationalContext(node: ShopifyAbandonedCheckoutNode): InternationalContext {
  const presentmentMoney = node?.totalPriceSet?.presentmentMoney;
  const billingAddress = node?.billingAddress;

  return {
    languageTag: safelyNormalize(node?.customer?.locale, canonicaliseLanguageTag),
    languageSource: null,
    countryCode: safelyNormalize(billingAddress?.countryCodeV2, normalizeCountryCode),
    currencyCode: safelyNormalize(
      presentmentMoney?.currencyCode,
      normalizeCurrencyCode,
    ),
    timeZone: safelyNormalize(billingAddress?.timeZone, normalizeTimeZone),
  };
}

function safelyNormalize(
  value: unknown,
  normalizer: (value: string) => string,
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    return normalizer(value);
  } catch {
    return null;
  }
}
