export const clock = new Date("2026-11-08T12:00:00Z");
export function outreachContext(platform: "SHOPIFY" | "WOOCOMMERCE" = "SHOPIFY") {
 return { shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1", checkoutUrl: "https://shop.example/checkout", environment: "TEST", platform, mode: "NONE", authorisedDiscountIds: [],
 basket: { currency: "GBP", subtotalMinor: null, totalMinor: 2500, fingerprint: "a".repeat(64), generation: 1, items: [{ lineKey: "line-0001", productId: platform === "SHOPIFY" ? "gid://shopify/Product/1" : "1", variantId: platform === "SHOPIFY" ? "gid://shopify/ProductVariant/2" : null, checkoutUnitPrice: "12.50", categoryIds: null, collectionIds: null, isSaleItem: null, title: "Saved title", category: null, quantity: 2, lineTotalMinor: 2500 }] }, priceReconciliation: null,
 platformInstructions: "Use current facts", platformInstructionRevisionId: "platform-1", merchantInstructions: null, merchantInstructionRevisionId: null };
}
export function exactProduct(context = outreachContext()) { const line = context.basket.items[0]!; return { productId: line.productId, variantId: line.variantId, title: "Live shirt", url: "https://shop.example/item", available: true, unitPrice: "12.00", currency: "GBP", productType: null, vendor: null, categories: [], categoryIds: [], collectionIds: [], saleEvidence: null, observedAt: clock.toISOString() }; }
export const ok = (data: unknown) => ({ contractVersion: "commerce.v1", status: "OK", data, renderedText: "Fixture" });
