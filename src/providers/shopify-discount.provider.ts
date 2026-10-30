import { getShopifyAccessToken } from "../services/shopify-session.service.js";

const API_VERSION = "2026-07";
const PAGE_SIZE = 10;
const MAX_DISCOUNT_PAGES = 1_000;
const TARGET_PAGE_SIZE = 20;

const QUERY = `#graphql
query DiscountNodes($first: Int!, $after: String) {
  discountNodes(first: $first, after: $after) {
    nodes {
      id
      discount {
        __typename
        ... on DiscountAutomaticApp { title status startsAt endsAt }
        ... on DiscountCodeApp { title status startsAt endsAt codesCount { count precision } codes(first: 2) { nodes { code } pageInfo { hasNextPage } } }
        ... on DiscountAutomaticBasic {
          title summary status startsAt endsAt asyncUsageCount
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
          asyncUsageCount usageLimit appliesOncePerCustomer
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
  unrepresentedConditions: string[];
};

export class ShopifyDiscountProvider {
  async listDiscounts(shopDomain: string): Promise<ShopifyDiscountRecord[]> {
    const accessToken = await getShopifyAccessToken(shopDomain);
    const records: ShopifyDiscountRecord[] = [];
    let after: string | null = null;
    let hasNextPage = true;
    let pageCount = 0;

    while (hasNextPage) {
      if (pageCount >= MAX_DISCOUNT_PAGES) {
        throw new Error("Shopify discount pagination exceeded the bounded page limit");
      }
      pageCount += 1;
      const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query: QUERY, variables: { first: PAGE_SIZE, after } }),
      });
      if (!response.ok) throw new Error(`Shopify discount GraphQL failed: ${response.status}`);
      const body = await response.json() as {
        data?: { discountNodes?: { nodes: DiscountNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
        errors?: unknown[];
      };
      const connection = body.data?.discountNodes;
      if (body.errors?.length || !connection || !Array.isArray(connection.nodes)) {
        throw new Error("Shopify discount GraphQL returned an invalid response");
      }
      for (const node of connection.nodes) {
        if (node.discount) records.push(normalizeDiscount(node));
      }
      hasNextPage = connection.pageInfo.hasNextPage;
      const nextCursor = connection.pageInfo.endCursor;
      if (hasNextPage && (!nextCursor || nextCursor === after)) {
        throw new Error("Shopify discount GraphQL pagination returned no advancing cursor");
      }
      after = nextCursor;
    }
    return records;
  }
}

function normalizeDiscount(node: DiscountNode): ShopifyDiscountRecord {
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
  const conditionFacts = normalizeConditionFacts(discount, providerType);

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
    providerSnapshot: { ...discount, id: node.id, codesCount, codes, conditionFacts },
  };
}

function normalizeConditionFacts(discount: Record<string, unknown>, providerType: string): DiscountConditionFacts {
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
    unrepresentedConditions: [],
  };
  if (!supportedBasic) {
    reasons.add(providerType.includes("Bxgy") ? "BUY_X_GET_Y_NOT_REPRESENTED" : "UNSUPPORTED_DISCOUNT_TYPE");
    return { ...base, unrepresentedConditions: [...reasons] };
  }

  let completeness = true;
  const gets = asRecord(discount.customerGets);
  const value = asRecord(gets?.value);
  const valueType = stringValue(value?.__typename);
  if (valueType === "DiscountPercentage") {
    const percentage = finiteNonNegative(value?.percentage);
    if (percentage === null) {
      completeness = false;
      reasons.add("DISCOUNT_VALUE_UNAVAILABLE");
    } else {
      base.discountKind = "PERCENTAGE";
      base.discountValue = decimalString(percentage);
    }
  } else if (valueType === "DiscountAmount") {
    const money = normalizeMoney(value?.amount);
    if (!money) {
      completeness = false;
      reasons.add("DISCOUNT_VALUE_UNAVAILABLE");
    } else {
      base.discountKind = "FIXED_AMOUNT";
      base.discountValue = money.amount;
      base.discountCurrency = money.currencyCode;
    }
  } else {
    completeness = false;
    reasons.add(valueType === "DiscountOnQuantity" ? "QUANTITY_DISCOUNT_VALUE_UNSUPPORTED" : "DISCOUNT_VALUE_UNKNOWN");
  }

  const target = normalizeTargeting(gets?.items);
  base.targeting = target.targeting;
  for (const reason of target.reasons) {
    completeness = false;
    reasons.add(reason);
  }

  const minimum = asRecord(discount.minimumRequirement);
  if (discount.minimumRequirement === undefined) {
    completeness = false;
    reasons.add("MINIMUM_REQUIREMENT_UNAVAILABLE");
  } else if (minimum === null && discount.minimumRequirement !== null) {
    completeness = false;
    reasons.add("MINIMUM_REQUIREMENT_UNKNOWN");
  } else if (minimum?.__typename === "DiscountMinimumSubtotal") {
    const money = normalizeMoney(minimum.greaterThanOrEqualToSubtotal);
    if (money) {
      base.minimumSubtotal = money.amount;
    } else {
      completeness = false;
      reasons.add("MINIMUM_SUBTOTAL_UNAVAILABLE");
    }
  } else if (minimum?.__typename === "DiscountMinimumQuantity") {
    const quantity = nonNegativeSafeInteger(minimum.greaterThanOrEqualToQuantity);
    if (quantity !== null) base.minimumQuantity = quantity;
    else {
      completeness = false;
      reasons.add("MINIMUM_QUANTITY_UNAVAILABLE");
    }
  } else if (minimum !== null) {
    completeness = false;
    reasons.add("MINIMUM_REQUIREMENT_UNKNOWN");
  }

  const context = asRecord(discount.context);
  if (context?.__typename === "DiscountBuyerSelectionAll") base.customerScope = "ALL";
  else if (context?.__typename === "DiscountCustomers" || context?.__typename === "DiscountCustomerSegments") {
    base.customerScope = "RESTRICTED";
  } else if (context?.__typename === "DiscountMarkets") {
    completeness = false;
    reasons.add("MARKET_RESTRICTION_NOT_REPRESENTED");
  } else {
    completeness = false;
    reasons.add("CUSTOMER_SCOPE_UNKNOWN");
  }

  return {
    ...base,
    completeness: completeness ? "COMPLETE" : "PARTIAL",
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
