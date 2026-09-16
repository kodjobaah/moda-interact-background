import { getShopifyAccessToken } from "../services/shopify-session.service.js";

const API_VERSION = "2026-07";
const PAGE_SIZE = 100;

const QUERY = `#graphql
query DiscountNodes($first: Int!, $after: String) {
  discountNodes(first: $first, after: $after) {
    nodes {
      id
      discount {
        __typename
        ... on DiscountAutomaticApp { title summary status startsAt endsAt }
        ... on DiscountAutomaticBasic { title summary status startsAt endsAt }
        ... on DiscountAutomaticBxgy { title summary status startsAt endsAt }
        ... on DiscountAutomaticFreeShipping { title summary status startsAt endsAt }
        ... on DiscountCodeApp { title summary status startsAt endsAt }
        ... on DiscountCodeBasic { title summary status startsAt endsAt codes(first: 2) { nodes { code } pageInfo { hasNextPage } } }
        ... on DiscountCodeBxgy { title summary status startsAt endsAt codes(first: 2) { nodes { code } pageInfo { hasNextPage } } }
        ... on DiscountCodeFreeShipping { title summary status startsAt endsAt codes(first: 2) { nodes { code } pageInfo { hasNextPage } } }
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

export class ShopifyDiscountProvider {
  async listDiscounts(shopDomain: string): Promise<ShopifyDiscountRecord[]> {
    const accessToken = await getShopifyAccessToken(shopDomain);
    const records: ShopifyDiscountRecord[] = [];
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query: QUERY, variables: { first: PAGE_SIZE, after } }),
      });
      if (!response.ok) throw new Error(`Shopify discount GraphQL failed: ${response.status}`);
      const body = await response.json() as { data?: { discountNodes?: { nodes: DiscountNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }; errors?: unknown[] };
      if (body.errors?.length || !body.data?.discountNodes) throw new Error("Shopify discount GraphQL returned an invalid response");
      for (const node of body.data.discountNodes.nodes) {
        if (node.discount) records.push(normalizeDiscount(node));
      }
      hasNextPage = body.data.discountNodes.pageInfo.hasNextPage;
      after = body.data.discountNodes.pageInfo.endCursor;
    }
    return records;
  }
}

function normalizeDiscount(node: DiscountNode): ShopifyDiscountRecord {
  const discount = node.discount!;
  const providerType = String(discount.__typename ?? "UNKNOWN");
  const method = providerType.startsWith("DiscountAutomatic") ? "AUTOMATIC" : "CODE";
  const codes = Array.isArray(discount.codes) ? discount.codes : null;
  const codeNodes = codes && typeof codes === "object" ? (codes as { nodes?: Array<{ code?: string }> }).nodes ?? [] : [];
  const codeCount = method === "CODE" ? codeNodes.length : null;
  const singleRedeemCode = codeCount === 1 && codeNodes[0]?.code ? codeNodes[0].code : null;
  const fixedSelectable = method === "AUTOMATIC"
    ? !providerType.includes("App")
    : !providerType.includes("App") && codeCount === 1 && singleRedeemCode !== null;
  return {
    shopifyDiscountNodeId: node.id,
    providerType,
    method,
    providerStatus: String(discount.status ?? "UNKNOWN"),
    title: String(discount.title ?? "Untitled discount"),
    summary: typeof discount.summary === "string" ? discount.summary : null,
    startsAt: toDate(discount.startsAt),
    endsAt: toDate(discount.endsAt),
    codeCount,
    singleRedeemCode,
    fixedSelectable,
    providerSnapshot: { ...discount, id: node.id },
  };
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const shopifyDiscountProvider = new ShopifyDiscountProvider();