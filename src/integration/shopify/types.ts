export interface SearchProductsInput {
  shop: string;
  query: string;
  maxPrice?: number;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  description: string;
  minPrice: string;
  maxPrice: string;
  currencyCode: string;
  available: boolean;
}
