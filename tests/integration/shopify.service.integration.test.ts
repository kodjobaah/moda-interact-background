import "dotenv/config";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  searchProducts,
} from "../../src/services/shopify.service.js";


const shop =
  process.env.SHOPIFY_TEST_SHOP;

const productQuery =
  process.env.SHOPIFY_TEST_PRODUCT_QUERY;

const canRun =
  Boolean(
    process.env.DATABASE_URL &&
    shop &&
    productQuery,
  );

const describeWithShopify =
  canRun
    ? describe
    : describe.skip;


describeWithShopify(
  "Shopify service integration",
  () => {
    it(
      "searches real Shopify products",
      async () => {
        const products =
          await searchProducts({
            shop: shop!,
            query: productQuery!,
            maxPrice: undefined,
          });

        expect(
          Array.isArray(products),
        ).toBe(true);

        expect(
          products.length,
        ).toBeGreaterThan(0);

        const product =
          products[0];

        expect(product).toBeDefined();

        expect(product).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            title: expect.any(String),
            handle: expect.any(String),
            description:
              expect.any(String),
            minPrice:
              expect.any(String),
            maxPrice:
              expect.any(String),
            currencyCode:
              expect.any(String),
            available:
              expect.any(Boolean),
          }),
        );

        expect(
          product!.id,
        ).toMatch(
          /^gid:\/\/shopify\/Product\//,
        );
      },
      30_000,
    );


    it(
      "returns no products for a query that does not exist",
      async () => {
        const products =
          await searchProducts({
            shop: shop!,
            query:
              `moda-product-that-does-not-exist-${Date.now()}`,
            maxPrice: undefined,
          });

        expect(products).toEqual([]);
      },
      30_000,
    );
  },
);