import type { CommerceDiscountCombinationFacts } from "@modainteract/moda-interact-shared/commerce";
import { getShopifyAccessToken } from "../services/shopify-session.service.js";

const API_VERSION = "2026-07";
const PAGE_SIZE = 10;
const MAX_DISCOUNT_PAGES = 1_000;
const TARGET_PAGE_SIZE = 20;
const MAX_COMBINATION_TAGS = 64;
const MAX_COMBINATION_TAG_LENGTH = 128;

const QUERY = `#graphql
query DiscountNodes($first: Int!, $after: String, $includeShopPlan: Boolean!) {
  shop @include(if: $includeShopPlan) { plan { shopifyPlus } }
  discountNodes(first: $first, after: $after) {
    nodes {
      id
      discount {
        __typename
        ... on DiscountAutomaticApp { title status startsAt endsAt }
        ... on DiscountCodeApp { title status startsAt endsAt codesCount { count precision } codes(first: 2) { nodes { code } pageInfo { hasNextPage } } }
        ... on DiscountAutomaticBasic {
          title summary status startsAt endsAt asyncUsageCount recurringCycleLimit
          discountClasses tags
          combinesWith {
            orderDiscounts productDiscounts shippingDiscounts
            productDiscountsWithTagsOnSameCartLine
          }
          customerGets {
            items {
              __typename
              ... on AllDiscountItems { __typename }
              ... on DiscountProducts {
                products(first: ${TARGET_PAGE_SIZE}) { nodes { id } pageInfo { hasNextPage } }
                productVariants(first: ${TARGET_PAGE_SIZE}) { nodes { id } pageInfo { hasNextPage } }
              }
              ... on DiscountCollections {
                collections(first: ${TARGET_PAGE_SIZE}) { nodes { id } pageInfo { hasNextPage } }
              }
            }
            value {
              __typename
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
              ... on DiscountOnQuantity {
                quantity { quantity }
                effect {
                  __typename
                  ... on DiscountPercentage { percentage }
                  ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
                }
              }
            }
          }
          minimumRequirement {
            __typename
            ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
            ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
          }
          context {
            __typename
            ... on DiscountBuyerSelectionAll { __typename }
            ... on DiscountCustomers { __typename }
            ... on DiscountCustomerSegments { __typename }
          }
        }
        ... on DiscountCodeBasic {
          title summary status startsAt endsAt codesCount { count precision }
          codes(first: 2) { nodes { code } pageInfo { hasNextPage } }
          asyncUsageCount usageLimit appliesOncePerCustomer recurringCycleLimit
          discountClasses tags
          combinesWith {
            orderDiscounts productDiscounts shippingDiscounts
            productDiscountsWithTagsOnSameCartLine
          }
          customerGets {
            items {
              __typename
              ... on AllDiscountItems { __typename }
              ... on DiscountProducts {
                products(first: ${TARGET_PAGE_SIZE}) { nodes { id } pageInfo { hasNextPage } }
                productVariants(first: ${TARGET_PAGE_SIZE}) { nodes { id } pageInfo { hasNextPage } }
              }
              ... on DiscountCollections {
                collections(first: ${TARGET_PAGE_SIZE}) { nodes { id } pageInfo { hasNextPage } }
              }
            }
            value {
              __typename
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
              ... on DiscountOnQuantity {
                quantity { quantity }
                effect {
                  __typename
                  ... on DiscountPercentage { percentage }
                  ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
                }
              }
            }
          }
          minimumRequirement {
            __typename
            ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
            ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
          }
          context {
            __typename
            ... on DiscountBuyerSelectionAll { __typename }
            ... on DiscountCustomers { __typename }
            ... on DiscountCustomerSegments { __typename }
          }
        }
        ... on DiscountAutomaticBxgy { title summary status startsAt endsAt }
        ... on DiscountCodeBxgy { title summary status startsAt endsAt codesCount { count precision } codes(first: 2) { nodes { code } pageInfo { hasNextPage } } }
        ... on DiscountAutomaticFreeShipping { title summary status startsAt endsAt }
        ... on DiscountCodeFreeShipping { title summary status startsAt endsAt codesCount { count precision } codes(first: 2) { nodes { code } pageInfo { hasNextPage } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export type ShopifyDiscountRecord = {
  shopifyDiscountNodeId: string;
  providerType: string;
  method: "AUTOMATIC" | "CODE";
  providerStatus: string;
  title: string;
  summary: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  codeCount: number | null;
  singleRedeemCode: string | null;
  fixedSelectable: boolean;
  providerSnapshot: Record<string, unknown>;
};

type DiscountNode = {
  id: string;
  discount: Record<string, unknown> | null;
};

type SafeShopifyProviderError = { message?: string; code?: string };

type ShopifyDiscountProviderFailure = {
  httpStatus: number;
  providerResponseFormat?: "json" | "non_json";
  providerRequestId?: string;
  providerErrors?: SafeShopifyProviderError[];
  redactionApplied: boolean;
  truncated: boolean;
};

const DIAGNOSTIC_MESSAGE_LIMIT = 1_024;
const DIAGNOSTIC_STACK_LIMIT = 2_048;
const DIAGNOSTIC_CAUSE_LIMIT = 3;
const DIAGNOSTIC_PROVIDER_ERROR_LIMIT = 5;

export class ShopifyDiscountProviderError extends Error {
  readonly failure: ShopifyDiscountProviderFailure;

  constructor(failure: ShopifyDiscountProviderFailure) {
    super("Shopify discount provider returned GraphQL errors");
    this.name = "ShopifyDiscountProviderError";
    this.failure = failure;
  }
}

export class ShopifyDiscountInternalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShopifyDiscountInternalError";
  }
}

export function isShopifyDiscountProviderError(
  error: unknown,
): error is ShopifyDiscountProviderError | ShopifyDiscountInternalError {
  return error instanceof ShopifyDiscountProviderError || error instanceof ShopifyDiscountInternalError;
}

export function getShopifyDiscountFailureLogFields(
  error: unknown,
  fallbackOrigin: "sdk_exception" | "internal" = "sdk_exception",
): Record<string, unknown> {
  const diagnostics = collectExceptionDiagnostics(error);
  const fields: Record<string, unknown> = {
    origin: fallbackOrigin,
    ...diagnostics.fields,
    redactionApplied: diagnostics.redactionApplied,
    truncated: diagnostics.truncated,
  };

  if (isShopifyDiscountProviderError(error)) {
    if (error instanceof ShopifyDiscountInternalError) {
      fields.origin = "internal";
    } else {
      fields.origin = "provider_response";
      fields.provider = "shopify";
      fields.operation = "DiscountNodes";
        fields.path = `/admin/api/${API_VERSION}/graphql.json`;
      fields.path = `/admin/api/${API_VERSION}/graphql.json`;
      fields.httpStatus = error.failure.httpStatus;
      if (error.failure.providerResponseFormat) fields.providerResponseFormat = error.failure.providerResponseFormat;
      if (error.failure.providerRequestId) fields.providerRequestId = error.failure.providerRequestId;
      if (error.failure.providerErrors?.length) fields.providerErrors = error.failure.providerErrors;
      fields.redactionApplied = diagnostics.redactionApplied || error.failure.redactionApplied;
      fields.truncated = diagnostics.truncated || error.failure.truncated;
    }
  }

  return fields;
}

function collectExceptionDiagnostics(error: unknown): {
  fields: Record<string, unknown>;
  redactionApplied: boolean;
  truncated: boolean;
} {
  const root = error instanceof Error ? error : null;
  const message = redactDiagnosticText(root?.message ?? (typeof error === "string" ? error : "Unknown failure"), DIAGNOSTIC_MESSAGE_LIMIT);
  const name = redactDiagnosticText(root?.name ?? "UnknownError", 64);
  const stack = root?.stack ? redactDiagnosticText(root.stack, DIAGNOSTIC_STACK_LIMIT) : null;
  let redactionApplied = name.redacted || message.redacted || Boolean(stack?.redacted);
  let truncated = name.truncated || message.truncated || Boolean(stack?.truncated);
  const causes: Array<{ name: string; message: string; stack?: string }> = [];
  let current: unknown = root?.cause;
  while (current !== undefined && current !== null && causes.length < DIAGNOSTIC_CAUSE_LIMIT) {
    const cause = current instanceof Error ? current : null;
    const causeMessageValue = cause?.message ?? (typeof current === "string" ? current : "Non-error cause");
    const causeName = redactDiagnosticText(cause?.name ?? "NonErrorCause", 64);
    const causeMessage = redactDiagnosticText(causeMessageValue, DIAGNOSTIC_MESSAGE_LIMIT);
    const causeStack = cause?.stack ? redactDiagnosticText(cause.stack, DIAGNOSTIC_STACK_LIMIT) : null;
    redactionApplied ||= causeName.redacted || causeMessage.redacted || Boolean(causeStack?.redacted);
    truncated ||= causeName.truncated || causeMessage.truncated || Boolean(causeStack?.truncated);
    causes.push({
      name: causeName.value,
      message: causeMessage.value,
      ...(causeStack ? { stack: causeStack.value } : {}),
    });
    current = cause?.cause;
  }
  const causesTruncated = current !== undefined && current !== null;
  truncated ||= causesTruncated;
  return {
    fields: {
      errorName: name.value,
      errorMessage: message.value,
      ...(stack ? { errorStack: stack.value } : {}),
      ...(causes.length ? { errorCause: causes } : {}),
    },
    redactionApplied,
    truncated,
  };
}

function redactDiagnosticText(value: string, maxLength: number): { value: string; redacted: boolean; truncated: boolean } {
  let safe = value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:shpat|shpca|shppa|shpss|shpua)_[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\b((?:access_token|refresh_token|verify_token|client_secret|api_key|token|password)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/([?&](?:discount_?)?code=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b((?:discount|customer|promo(?:tion)?)\s+code\s+)[A-Za-z0-9][A-Za-z0-9_-]{2,63}\b/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\+?\d(?:[\s().-]*\d){9,14}/g, "[REDACTED]");
  const redacted = safe !== value;
  const truncated = safe.length > maxLength;
  if (truncated) safe = `${safe.slice(0, maxLength)}…[TRUNCATED]`;
  return { value: safe, redacted, truncated };
}

function extractGraphqlErrors(value: unknown): {
  errors: SafeShopifyProviderError[];
  redactionApplied: boolean;
  truncated: boolean;
} {
  const entries = Array.isArray(value)
    ? value.slice(0, DIAGNOSTIC_PROVIDER_ERROR_LIMIT)
    : typeof value === "string" || asRecord(value)
      ? [value]
      : [];
  let redactionApplied = false;
  let truncated = Array.isArray(value) && value.length > DIAGNOSTIC_PROVIDER_ERROR_LIMIT;
  const errors = entries.flatMap((item) => {
    const error = asRecord(item);
    const extensions = asRecord(error?.extensions);
    const messageValue = typeof item === "string" ? item : stringValue(error?.message);
    const codeValue = stringValue(extensions?.code);
    if (messageValue === null && codeValue === null) return [];
    const safe: SafeShopifyProviderError = {};
    if (messageValue !== null) {
      const message = redactDiagnosticText(messageValue, DIAGNOSTIC_MESSAGE_LIMIT);
      safe.message = message.value;
      redactionApplied ||= message.redacted;
      truncated ||= message.truncated;
    }
    if (codeValue !== null) {
      const code = redactDiagnosticText(codeValue, 128);
      safe.code = code.value;
      redactionApplied ||= code.redacted;
      truncated ||= code.truncated;
    }
    return [safe];
  });
  return { errors, redactionApplied, truncated };
}

function hasGraphqlErrors(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

type TargetingFacts = {
  kind: "ALL" | "PRODUCTS" | "VARIANTS" | "COLLECTIONS" | "MIXED" | "UNKNOWN";
  includedProductIds: string[];
  includedVariantIds: string[];
  includedCategoryIds: string[];
  includedCollectionIds: string[];
  excludedProductIds: string[];
  excludedVariantIds: string[];
  excludedCategoryIds: string[];
  excludedCollectionIds: string[];
};

type DiscountConditionFacts = {
  provider: "SHOPIFY";
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  observedAt: string;
  providerStatus: string;
  unavailableAt: string | null;
  discountKind: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_SHIPPING" | "BUY_X_GET_Y" | "OTHER" | "UNKNOWN";
  discountValue: string | null;
  discountCurrency: string | null;
  targeting: TargetingFacts;
  minimumSubtotal: string | null;
  maximumSubtotal: string | null;
  minimumQuantity: number | null;
  usageLimit: number | null;
  usageCount: number | null;
  perCustomerLimit: number | null;
  customerScope: "ALL" | "RESTRICTED" | "UNKNOWN";
  excludesSaleItems: boolean | null;
  individualUse: boolean | null;
  combination: CommerceDiscountCombinationFacts;
  unrepresentedConditions: string[];
};

export class ShopifyDiscountProvider {
  async listDiscounts(shopDomain: string): Promise<ShopifyDiscountRecord[]> {
    const accessToken = await getShopifyAccessToken(shopDomain);
    const records: ShopifyDiscountRecord[] = [];
    let after: string | null = null;
    let hasNextPage = true;
    let pageCount = 0;
    let shopifyPlus: boolean | null = null;

    while (hasNextPage) {
      if (pageCount >= MAX_DISCOUNT_PAGES) {
        throw new ShopifyDiscountInternalError("Shopify discount pagination exceeded the bounded page limit");
      }
      pageCount += 1;
      const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query: QUERY, variables: { first: PAGE_SIZE, after, includeShopPlan: pageCount === 1 } }),
      });
      if (!response.ok) {
        let errorBody: { errors?: unknown } | null = null;
        let responseFormat: "json" | "non_json" = "json";
        try {
          errorBody = await response.json() as { errors?: unknown };
        } catch {
          // Keep only the HTTP status for unstructured error responses; bodies may contain sensitive data.
          responseFormat = "non_json";
        }
        throw createShopifyProviderResponseError(response, errorBody?.errors, responseFormat);
      }
      let body: {
        data?: {
          shop?: { plan?: { shopifyPlus?: unknown } | null } | null;
          discountNodes?: { nodes: DiscountNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        };
        errors?: unknown;
      };
      try {
        body = await response.json() as typeof body;
      } catch {
        // Parser diagnostics may include a response snippet, so retain only the safe classification.
        throw new ShopifyDiscountInternalError("Shopify discount GraphQL returned invalid JSON");
      }
      if (hasGraphqlErrors(body.errors)) throw createShopifyProviderResponseError(response, body.errors);
      const connection = body.data?.discountNodes;
      if (!connection || !Array.isArray(connection.nodes)) {
        throw new ShopifyDiscountInternalError("Shopify discount GraphQL returned an invalid response");
      }
      if (pageCount === 1) shopifyPlus = booleanValue(body.data?.shop?.plan?.shopifyPlus);
      for (const node of connection.nodes) {
        if (node.discount) records.push(normalizeDiscount(node, shopifyPlus));
      }
      hasNextPage = connection.pageInfo.hasNextPage;
      const nextCursor = connection.pageInfo.endCursor;
      if (hasNextPage && (!nextCursor || nextCursor === after)) {
        throw new ShopifyDiscountInternalError("Shopify discount GraphQL pagination returned no advancing cursor");
      }
      after = nextCursor;
    }
    return records;
  }
}

function createShopifyProviderResponseError(
  response: Response,
  rawErrors: unknown,
  providerResponseFormat: "json" | "non_json" = "json",
): ShopifyDiscountProviderError {
  const providerErrors = extractGraphqlErrors(rawErrors);
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-shopify-request-id");
  const safeRequestId = requestId ? redactDiagnosticText(requestId, 128) : null;
  return new ShopifyDiscountProviderError({
    httpStatus: response.status,
    providerResponseFormat,
    ...(safeRequestId ? { providerRequestId: safeRequestId.value } : {}),
    ...(providerErrors.errors.length ? { providerErrors: providerErrors.errors } : {}),
    redactionApplied: providerErrors.redactionApplied || Boolean(safeRequestId?.redacted),
    truncated: providerErrors.truncated || Boolean(safeRequestId?.truncated),
  });
}

function normalizeDiscount(node: DiscountNode, shopifyPlus: boolean | null): ShopifyDiscountRecord {
  const discount = node.discount!;
  const providerType = stringValue(discount.__typename) ?? "UNKNOWN";
  const method = providerType.startsWith("DiscountAutomatic") ? "AUTOMATIC" : "CODE";
  const codes = isCodeConnection(discount.codes) ? discount.codes : null;
  const codesCount = isCodesCount(discount.codesCount) ? discount.codesCount : null;
  const codeCount = method === "CODE" && codesCount?.precision === "EXACT" ? codesCount.count : null;
  const codeNodes = codes?.nodes ?? [];
  const singleRedeemCode = codeCount === 1
    && codeNodes.length === 1
    && codes?.pageInfo.hasNextPage === false
    && typeof codeNodes[0]?.code === "string"
    && codeNodes[0].code.length > 0
    ? codeNodes[0].code
    : null;
  const fixedSelectable = method === "AUTOMATIC"
    ? !providerType.includes("App")
    : !providerType.includes("App") && codeCount === 1 && singleRedeemCode !== null;
  const combinationProjection = normalizeCombinationPolicy(discount, shopifyPlus);
  const recurringCycleLimit = normalizeRecurringCycleLimit(discount.recurringCycleLimit, providerType);
  const conditionFacts = normalizeConditionFacts(discount, providerType, combinationProjection, recurringCycleLimit);

  return {
    shopifyDiscountNodeId: node.id,
    providerType,
    method,
    providerStatus: stringValue(discount.status) ?? "UNKNOWN",
    title: stringValue(discount.title) ?? "Untitled discount",
    summary: stringValue(discount.summary),
    startsAt: toDate(discount.startsAt),
    endsAt: toDate(discount.endsAt),
    codeCount,
    singleRedeemCode,
    fixedSelectable,
    providerSnapshot: {
      ...discount,
      id: node.id,
      codesCount,
      codes,
      recurringCycleLimit: recurringCycleLimit.value,
      discountClasses: combinationProjection.facts.discountClasses,
      tags: combinationProjection.facts.discountTags,
      combinesWith: combinationProjection.providerPolicy,
      conditionFacts,
    },
  };
}

type ProviderCombinationPolicy = {
  orderDiscounts: boolean | null;
  productDiscounts: boolean | null;
  shippingDiscounts: boolean | null;
  productDiscountsWithTagsOnSameCartLine: string[] | null;
};

type CombinationProjection = {
  facts: CommerceDiscountCombinationFacts;
  providerPolicy: ProviderCombinationPolicy | null;
  reasons: string[];
};

type RecurringCycleLimitProjection = {
  value: number | null;
  reason: string | null;
};

type NormalizedTags = { tags: string[] | null; issue: "UNAVAILABLE" | "INVALID" | "TRUNCATED" | null };

function normalizeCombinationPolicy(
  discount: Record<string, unknown>,
  shopifyPlus: boolean | null,
): CombinationProjection {
  const reasons = new Set<string>();
  const combinesWith = asRecord(discount.combinesWith);
  const combinationFlags = combinesWith ? {
    orderDiscounts: booleanValue(combinesWith.orderDiscounts),
    productDiscounts: booleanValue(combinesWith.productDiscounts),
    shippingDiscounts: booleanValue(combinesWith.shippingDiscounts),
  } : null;
  if (!combinationFlags || Object.values(combinationFlags).some((flag) => flag === null)) {
    reasons.add("COMBINATION_POLICY_UNAVAILABLE");
  }

  const sameLineTags = normalizeCombinationTags(combinesWith?.productDiscountsWithTagsOnSameCartLine);
  const discountTags = normalizeCombinationTags(discount.tags);
  const discountClasses = normalizeDiscountClasses(discount.discountClasses);
  if (sameLineTags.issue) reasons.add(`SAME_LINE_TAG_POLICY_${sameLineTags.issue}`);
  if (discountTags.issue) reasons.add(`DISCOUNT_TAGS_${discountTags.issue}`);
  if (discountClasses.issue) reasons.add(`DISCOUNT_CLASSES_${discountClasses.issue}`);
  if (shopifyPlus === null) reasons.add("SHOPIFY_PLAN_UNAVAILABLE");
  if (shopifyPlus === true && sameLineTags.tags === null) reasons.add("SAME_LINE_TAG_POLICY_UNAVAILABLE");

  const providerPolicy: ProviderCombinationPolicy | null = combinesWith ? {
    orderDiscounts: combinationFlags?.orderDiscounts ?? null,
    productDiscounts: combinationFlags?.productDiscounts ?? null,
    shippingDiscounts: combinationFlags?.shippingDiscounts ?? null,
    productDiscountsWithTagsOnSameCartLine: sameLineTags.tags,
  } : null;
  return {
    facts: {
      discountClasses: discountClasses.classes,
      shopifyPlus,
      combinesWith: combinationFlags,
      discountTags: discountTags.tags,
      allowedSameLineProductTags: sameLineTags.tags,
    },
    providerPolicy,
    reasons: [...reasons],
  };
}

function normalizeCombinationTags(value: unknown): NormalizedTags {
  if (!Array.isArray(value)) return { tags: null, issue: "UNAVAILABLE" };
  if (value.length > MAX_COMBINATION_TAGS) return { tags: null, issue: "TRUNCATED" };
  const valid = value.every((tag) => typeof tag === "string" && tag.length > 0 && tag.length <= MAX_COMBINATION_TAG_LENGTH);
  if (!valid) return { tags: null, issue: "INVALID" };
  return {
    tags: value as string[],
    issue: null,
  };
}

function normalizeDiscountClasses(value: unknown): {
  classes: Array<"ORDER" | "PRODUCT" | "SHIPPING"> | null;
  issue: "UNAVAILABLE" | "INVALID" | "TRUNCATED" | null;
} {
  if (!Array.isArray(value)) return { classes: null, issue: "UNAVAILABLE" };
  if (value.length > 3) return { classes: null, issue: "TRUNCATED" };
  const valid = value.every((item) => item === "ORDER" || item === "PRODUCT" || item === "SHIPPING");
  if (!valid) return { classes: null, issue: "INVALID" };
  return {
    classes: value as Array<"ORDER" | "PRODUCT" | "SHIPPING">,
    issue: null,
  };
}

function normalizeRecurringCycleLimit(value: unknown, providerType: string): RecurringCycleLimitProjection {
  const isAutomaticBasic = providerType === "DiscountAutomaticBasic";
  const isCodeBasic = providerType === "DiscountCodeBasic";
  if (!isAutomaticBasic && !isCodeBasic) return { value: null, reason: null };

  // Zero means the discount applies indefinitely. A missing/null value is
  // ambiguous for subscription eligibility and must not imply completeness.
  const limit = nonNegativeSafeInteger(value);
  if (limit === null) return { value: null, reason: "RECURRING_CYCLE_LIMIT_UNAVAILABLE" };
  if (limit > 0) return { value: limit, reason: "RECURRING_CYCLE_LIMIT_NOT_REPRESENTED_IN_SHARED_FACTS" };
  return { value: limit, reason: null };
}

function normalizeConditionFacts(
  discount: Record<string, unknown>,
  providerType: string,
  combination: CombinationProjection,
  recurringCycleLimit: RecurringCycleLimitProjection,
): DiscountConditionFacts {
  const reasons = new Set<string>();
  const supportedBasic = providerType === "DiscountAutomaticBasic" || providerType === "DiscountCodeBasic";
  const base: DiscountConditionFacts = {
    provider: "SHOPIFY",
    completeness: "PARTIAL",
    observedAt: new Date().toISOString(),
    providerStatus: stringValue(discount.status) ?? "UNKNOWN",
    unavailableAt: null,
    discountKind: kindForType(providerType),
    discountValue: null,
    discountCurrency: null,
    targeting: emptyTargeting(),
    minimumSubtotal: null,
    maximumSubtotal: null,
    minimumQuantity: null,
    usageLimit: positiveOrZeroInteger(discount.usageLimit),
    usageCount: positiveOrZeroInteger(discount.asyncUsageCount),
    perCustomerLimit: discount.appliesOncePerCustomer === true ? 1 : null,
    customerScope: "UNKNOWN",
    excludesSaleItems: null,
    individualUse: null,
    combination: {
      discountClasses: null,
      shopifyPlus: combination.facts.shopifyPlus,
      combinesWith: null,
      discountTags: null,
      allowedSameLineProductTags: null,
    },
    unrepresentedConditions: [],
  };
  if (!supportedBasic) {
    reasons.add(providerType.includes("Bxgy") ? "BUY_X_GET_Y_NOT_REPRESENTED" : "UNSUPPORTED_DISCOUNT_TYPE");
    return { ...base, unrepresentedConditions: [...reasons] };
  }

  base.combination = combination.facts;
  for (const reason of combination.reasons) {
    reasons.add(reason);
  }
  if (recurringCycleLimit.reason) {
    reasons.add(recurringCycleLimit.reason);
  }

  const gets = asRecord(discount.customerGets);
  const value = asRecord(gets?.value);
  const valueType = stringValue(value?.__typename);
  if (valueType === "DiscountPercentage") {
    const percentage = finiteNonNegative(value?.percentage);
    if (percentage === null) {
      reasons.add("DISCOUNT_VALUE_UNAVAILABLE");
    } else {
      base.discountKind = "PERCENTAGE";
      base.discountValue = decimalString(percentage);
    }
  } else if (valueType === "DiscountAmount") {
    const money = normalizeMoney(value?.amount);
    if (!money) {
      reasons.add("DISCOUNT_VALUE_UNAVAILABLE");
    } else {
      base.discountKind = "FIXED_AMOUNT";
      base.discountValue = money.amount;
      base.discountCurrency = money.currencyCode;
    }
  } else {
    reasons.add(valueType === "DiscountOnQuantity" ? "QUANTITY_DISCOUNT_VALUE_UNSUPPORTED" : "DISCOUNT_VALUE_UNKNOWN");
  }

  const target = normalizeTargeting(gets?.items);
  base.targeting = target.targeting;
  for (const reason of target.reasons) {
    reasons.add(reason);
  }

  const minimum = asRecord(discount.minimumRequirement);
  if (discount.minimumRequirement === undefined) {
    reasons.add("MINIMUM_REQUIREMENT_UNAVAILABLE");
  } else if (minimum === null && discount.minimumRequirement !== null) {
    reasons.add("MINIMUM_REQUIREMENT_UNKNOWN");
  } else if (minimum?.__typename === "DiscountMinimumSubtotal") {
    const money = normalizeMoney(minimum.greaterThanOrEqualToSubtotal);
    if (money) {
      base.minimumSubtotal = money.amount;
    } else {
      reasons.add("MINIMUM_SUBTOTAL_UNAVAILABLE");
    }
  } else if (minimum?.__typename === "DiscountMinimumQuantity") {
    const quantity = nonNegativeSafeInteger(minimum.greaterThanOrEqualToQuantity);
    if (quantity !== null) base.minimumQuantity = quantity;
    else {
      reasons.add("MINIMUM_QUANTITY_UNAVAILABLE");
    }
  } else if (minimum !== null) {
    reasons.add("MINIMUM_REQUIREMENT_UNKNOWN");
  }

  const context = asRecord(discount.context);
  if (context?.__typename === "DiscountBuyerSelectionAll") base.customerScope = "ALL";
  else if (context?.__typename === "DiscountCustomers" || context?.__typename === "DiscountCustomerSegments") {
    base.customerScope = "RESTRICTED";
    reasons.add("CUSTOMER_RESTRICTION_NOT_REPRESENTED");
  } else if (context?.__typename === "DiscountMarkets") {
    reasons.add("MARKET_RESTRICTION_NOT_REPRESENTED");
  } else {
    reasons.add("CUSTOMER_SCOPE_UNKNOWN");
  }

  reasons.add("COMBINATION_POLICY_NOT_REPRESENTED_IN_SHARED_FACTS");

  return {
    ...base,
    completeness: reasons.size === 0 ? "COMPLETE" : "PARTIAL",
    unrepresentedConditions: [...reasons].slice(0, 24),
  };
}

function normalizeTargeting(value: unknown): { targeting: TargetingFacts; reasons: string[] } {
  const items = asRecord(value);
  if (!items) return { targeting: emptyTargeting(), reasons: ["TARGETING_UNKNOWN"] };
  const kind = stringValue(items.__typename);
  if (kind === "AllDiscountItems") return {
    targeting: { ...emptyTargeting(), kind: "ALL" }, reasons: [],
  };
  if (kind === "DiscountProducts") {
    const products = readIdsConnection(items.products);
    const variants = readIdsConnection(items.productVariants);
    const reasons = [...products.reasons, ...variants.reasons];
    const hasProducts = products.ids.length > 0;
    const hasVariants = variants.ids.length > 0;
    return {
      targeting: {
        ...emptyTargeting(),
        kind: hasProducts && hasVariants ? "MIXED" : hasVariants ? "VARIANTS" : "PRODUCTS",
        includedProductIds: products.ids,
        includedVariantIds: variants.ids,
      },
      reasons,
    };
  }
  if (kind === "DiscountCollections") {
    const collections = readIdsConnection(items.collections);
    return {
      targeting: { ...emptyTargeting(), kind: "COLLECTIONS", includedCollectionIds: collections.ids },
      reasons: collections.reasons,
    };
  }
  return { targeting: emptyTargeting(), reasons: ["TARGETING_TYPE_UNSUPPORTED"] };
}

function readIdsConnection(value: unknown): { ids: string[]; reasons: string[] } {
  const connection = asRecord(value);
  const nodes = connection?.nodes;
  if (!Array.isArray(nodes)) return { ids: [], reasons: ["TARGET_ENUMERATION_UNAVAILABLE"] };
  const ids = nodes.map((node) => stringValue(asRecord(node)?.id)).filter((id): id is string => id !== null).slice(0, 128);
  const pageInfo = asRecord(connection?.pageInfo);
  const reasons: string[] = [];
  if (pageInfo?.hasNextPage === true) reasons.push("TARGET_ENUMERATION_TRUNCATED");
  else if (typeof pageInfo?.hasNextPage !== "boolean") reasons.push("TARGET_PAGINATION_UNKNOWN");
  if (ids.length !== nodes.length) reasons.push("TARGET_ID_INVALID");
  if (nodes.length > 128) reasons.push("TARGET_ID_LIMIT_EXCEEDED");
  return { ids, reasons };
}

function emptyTargeting(): TargetingFacts {
  return {
    kind: "UNKNOWN", includedProductIds: [], includedVariantIds: [], includedCollectionIds: [],
    includedCategoryIds: [], excludedProductIds: [], excludedVariantIds: [], excludedCategoryIds: [], excludedCollectionIds: [],
  };
}

function kindForType(providerType: string): DiscountConditionFacts["discountKind"] {
  if (providerType.includes("Bxgy")) return "BUY_X_GET_Y";
  if (providerType.includes("FreeShipping")) return "FREE_SHIPPING";
  if (providerType.includes("App")) return "UNKNOWN";
  return "OTHER";
}

function normalizeMoney(value: unknown): { amount: string; currencyCode: string } | null {
  const money = asRecord(value);
  const amount = stringValue(money?.amount);
  const currencyCode = stringValue(money?.currencyCode);
  if (!amount || !/^[0-9]{1,18}(?:\.[0-9]{1,6})?$/.test(amount)
    || !currencyCode || !/^[A-Z]{3}$/.test(currencyCode)) return null;
  return { amount, currencyCode };
}

function isCodesCount(value: unknown): value is { count: number; precision: string } {
  return typeof value === "object" && value !== null
    && typeof (value as { count?: unknown }).count === "number"
    && typeof (value as { precision?: unknown }).precision === "string";
}

function isCodeConnection(value: unknown): value is { nodes: Array<{ code?: string }>; pageInfo: { hasNextPage: boolean } } {
  return typeof value === "object" && value !== null
    && Array.isArray((value as { nodes?: unknown }).nodes)
    && typeof (value as { pageInfo?: { hasNextPage?: unknown } }).pageInfo?.hasNextPage === "boolean";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function positiveOrZeroInteger(value: unknown): number | null {
  return nonNegativeSafeInteger(value);
}

function decimalString(value: number): string {
  return String(value);
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const shopifyDiscountProvider = new ShopifyDiscountProvider();
