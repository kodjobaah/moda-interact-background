// src/tools/search-product.ts

import { tool } from "ai";
import { z } from "zod";

import { searchProducts } from "../services/shopify.service.js";

export function createSearchProductsTool(
  shop: string,
) {
  return tool({
    description:
      "Search the Shopify catalogue for products matching what the customer wants.",

    inputSchema: z.object({
      query: z.string(),

      maxPrice: z
        .number()
        .optional(),
    }),

    execute: async ({
      query,
      maxPrice,
    }) => {
      return searchProducts({
        shop,
        query,

        ...(maxPrice !== undefined
          ? { maxPrice }
          : {}),
      });
    },
  });
}