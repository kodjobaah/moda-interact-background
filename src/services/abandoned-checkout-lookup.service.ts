// Bounded Shopify Admin GraphQL abandoned-checkout lookup.
//
// ARCH-001-BACKGROUND-003: Shopify exposes no direct abandoned-checkout lookup
// by checkout/cart token, recovery URL or creation timestamp. The approved
// strategy is:
//
//   1. derive a narrow server-side `created_at` filter from the candidate's
//      checkoutCreatedAt;
//   2. enforce a hard candidate bound (count pre-check) so no unbounded
//      pagination is ever possible;
//   3. fetch a bounded result set;
//   4. match exactly on abandonedCheckoutUrl.
//
// Provider/transport failures are kept distinct from "not-found" so that they
// remain retryable rather than silently discarding a potential recovery.

import prisma from "../lib/db.js";
import {
  ABANDONED_CHECKOUT_API_VERSION,
  ABANDONED_CHECKOUT_LOOKUP_WINDOW_MS,
  ABANDONED_CHECKOUT_MAX_CANDIDATES,
  type AbandonedCheckoutLookupInput,
  type AbandonedCheckoutLookupOutcome,
  type NormalizedAbandonedCheckout,
} from "../domain/abandoned-checkout.js";
import { getShopifyAccessToken } from "./shopify-session.service.js";

const GRAPHQL_ENDPOINT = (shopDomain: string, version: string) =>
  `https://${shopDomain}/admin/api/${version}/graphql.json`;

export class AbandonedCheckoutLookupService {
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

  async lookup(input: AbandonedCheckoutLookupInput): Promise<AbandonedCheckoutLookupOutcome> {
    // Exact URL matching is the recovery identity. Without it the lookup cannot
    // be completed deterministically.
    if (!input.abandonedCheckoutUrl) {
      return { kind: "not-found" };
    }

    // The time scope is required to keep the query narrow and bounded.
    const timeRange = this.buildCreatedAtFilter(input.checkoutCreatedAt);
    if (!timeRange) {
      return { kind: "not-found" };
    }

    const accessToken = await getShopifyAccessToken(input.shopDomain);

    const count = await this.fetchBoundedCount(
      input.shopDomain,
      accessToken,
      timeRange,
    );

    if (count === null) {
      return {
        kind: "provider-error",
        message: "abandonedCheckoutsCount returned null count",
      };
    }

    if (count > ABANDONED_CHECKOUT_MAX_CANDIDATES) {
      return {
        kind: "bounded-limit-exceeded",
        candidateCount: count,
      };
    }

    if (count === 0) {
      // No abandoned checkout in the bounded window, so there cannot be a match.
      return { kind: "not-found" };
    }

    const candidates = await this.fetchAbandonedCheckouts(
      input.shopDomain,
      accessToken,
      timeRange,
    );

    if (candidates === null) {
      return {
        kind: "provider-error",
        message: "abandonedCheckouts query returned no data",
      };
    }

    const matches = candidates.filter(
      (c) => c.abandonedCheckoutUrl === input.abandonedCheckoutUrl,
    );

    if (matches.length === 0) {
      return { kind: "not-found" };
    }

    if (matches.length > 1) {
      return { kind: "ambiguous", matched: matches.length };
    }

    // Exactly one exact URL match remains (0 and >1 are handled above).
    const match = matches[0] as NormalizedAbandonedCheckout;
    return { kind: "found", checkout: match };
  }

  private buildCreatedAtFilter(
    checkoutCreatedAt: string | null,
  ): { fromIso: string; toIso: string } | null {
    if (!checkoutCreatedAt) {
      return null;
    }

    const created = new Date(checkoutCreatedAt);
    if (Number.isNaN(created.getTime())) {
      return null;
    }

    const from = new Date(created.getTime() - ABANDONED_CHECKOUT_LOOKUP_WINDOW_MS);
    const to = new Date(created.getTime() + ABANDONED_CHECKOUT_LOOKUP_WINDOW_MS);

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
  ): Promise<number | null> {
    const query = this.buildFilterQuery(timeRange);

    const body = {
      query: `
        query AbandonedCheckoutsCount($query: String!, $maximum: Int!) {
          abandonedCheckoutsCount(query: $query, maximum: $maximum) {
            count
          }
        }
      `,
      variables: {
        query,
        maximum: ABANDONED_CHECKOUT_MAX_CANDIDATES,
      },
    };

    const result = await this.postGraphql(shopDomain, accessToken, body);
    if (!result) {
      return null;
    }

    return result?.data?.abandonedCheckoutsCount?.count ?? null;
  }

  private async fetchAbandonedCheckouts(
    shopDomain: string,
    accessToken: string,
    timeRange: { fromIso: string; toIso: string },
  ): Promise<NormalizedAbandonedCheckout[] | null> {
    const query = this.buildFilterQuery(timeRange);

    const body = {
      query: `
        query AbandonedCheckouts($query: String!, $first: Int!) {
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
              currencyCode
              totalPrice {
                amount
                currencyCode
              }
              customer {
                id
                email
                phone
                firstName
                lastName
              }
              lineItems {
                nodes {
                  id
                  product {
                    id
                  }
                  variant {
                    id
                    sku
                  }
                  title
                  variantTitle
                  quantity
                  originalUnitPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        query,
        first: ABANDONED_CHECKOUT_MAX_CANDIDATES,
      },
    };

    const result = await this.postGraphql(shopDomain, accessToken, body);
    if (!result) {
      return null;
    }

    const nodes = result?.data?.abandonedCheckouts?.nodes;
    if (!Array.isArray(nodes)) {
      return null;
    }

    return nodes.map((node: any) => this.normalize(node));
  }

  private normalize(node: any): NormalizedAbandonedCheckout {
    return {
      shopifyAbandonedCheckoutId: node?.id ?? null,
      abandonedCheckoutUrl: node?.abandonedCheckoutUrl ?? "",
      createdAt: node?.createdAt ?? "",
      completedAt: node?.completedAt ?? null,
      currencyCode: node?.currencyCode ?? node?.totalPrice?.currencyCode ?? null,
      totalPrice: node?.totalPrice?.amount ?? null,
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
        ? node.lineItems.nodes.map((li: any) => ({
            productId: li?.product?.id ?? null,
            variantId: li?.variant?.id ?? null,
            title: li?.title ?? null,
            variantTitle: li?.variantTitle ?? null,
            sku: li?.variant?.sku ?? null,
            quantity: li?.quantity ?? 0,
            price: li?.originalUnitPrice?.amount ?? null,
          }))
        : [],
    };
  }

  private async postGraphql(
    shopDomain: string,
    accessToken: string,
    body: { query: string; variables: Record<string, unknown> },
  ): Promise<any | null> {
    let response: Response;
    try {
      response = await fetch(
        GRAPHQL_ENDPOINT(shopDomain, ABANDONED_CHECKOUT_API_VERSION),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      throw new Error(
        `Shopify abandoned-checkout transport error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Shopify abandoned-checkout GraphQL request failed: ${response.status} ${await response.text()}`,
      );
    }

    let parsed: any;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new Error(
        `Shopify abandoned-checkout GraphQL returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (parsed?.errors) {
      throw new Error(
        `Shopify abandoned-checkout GraphQL error: ${JSON.stringify(parsed.errors)}`,
      );
    }

    return parsed;
  }
}

export const abandonedCheckoutLookupService = new AbandonedCheckoutLookupService();

