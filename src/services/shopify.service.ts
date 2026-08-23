import type { SearchProductsInput, ShopifyProduct } from "../integration/shopify/types.js";
import { getShopifyAccessToken } from "./shopify-session.service.js";

export async function searchProducts({
  shop,
  query,
  maxPrice,
}: SearchProductsInput): Promise<ShopifyProduct[]> {
  const accessToken =
    await getShopifyAccessToken(shop);

  const searchQuery = buildProductSearchQuery({
    query,
    maxPrice,
  });

  const response = await fetch(
    `https://${shop}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },

      body: JSON.stringify({
        query: `
          query SearchProducts($query: String!) {
            products(
              first: 10
              query: $query
            ) {
              nodes {
                id
                title
                handle
                description

                totalInventory

                priceRangeV2 {
                  minVariantPrice {
                    amount
                    currencyCode
                  }

                  maxVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        `,

        variables: {
          query: searchQuery,
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Shopify GraphQL request failed: ${response.status} ${body}`,
    );
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(result.errors)}`,
    );
  }

  return result.data.products.nodes.map(
    (product: any) => ({
      id: product.id,
      title: product.title,
      handle: product.handle,
      description: product.description,

      minPrice:
        product.priceRangeV2.minVariantPrice.amount,

      maxPrice:
        product.priceRangeV2.maxVariantPrice.amount,

      currencyCode:
        product.priceRangeV2.minVariantPrice.currencyCode,

      available:
        product.totalInventory > 0,
    }),
  );
}

function buildProductSearchQuery({
  query,
  maxPrice,
}: {
  query: string;
    maxPrice: number | undefined;
}) {
  const filters = [query];

  if (maxPrice !== undefined) {
    filters.push(`price:<=${maxPrice}`);
  }

  filters.push("status:active");

  return filters.join(" ");
}
