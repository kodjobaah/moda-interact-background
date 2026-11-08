import { describe, expect, it, vi } from "vitest";
import { runInitialOutreachOfferAgent } from "../../../src/agents/initial-outreach-offer.agent.js";
import { clock, outreachContext, exactProduct } from "../fixtures/outreach-context.js";
describe("Shared initial evaluation production agent facade", () => {
 it.each(["SHOPIFY", "WOOCOMMERCE"] as const)("verifies %s NONE products twice without model/offer calls and retains historical quantity/prices", async platform => {
  const context = outreachContext(platform), call = vi.fn(async (_name: string) => ({ contractVersion: "commerce.v1", status: "OK", data: { product: exactProduct(context) }, renderedText: "Fixture" }));
  const selector = { connect: vi.fn(), tools: vi.fn(), call, close: vi.fn() }; const createModelInvoker = vi.fn();
  const result = await runInitialOutreachOfferAgent(context, { signal: new AbortController().signal, now: () => clock, createSelector: () => selector as never, createModelInvoker });
  expect(result).toMatchObject({ kind: "NO_VERIFIED_OFFER", evaluation: { kind: "ready", currentMerchandiseSubtotal: { amountDecimal: "24.00", currency: "GBP" }, lines: [{ quantity: 2, checkoutUnitPrice: "12.50", comparison: "DIFFERENT", currentProduct: { unitPrice: "12.00", title: "Live shirt" } }] } });
  expect(call.mock.calls.map(args => args[0])).toEqual(["commerce_get_product", "commerce_get_product"]); expect(createModelInvoker).not.toHaveBeenCalled(); expect(selector.close).toHaveBeenCalledOnce();
 });
 it("refuses malformed native identities before provider/model IO", async () => { const context = outreachContext(); context.basket.items[0]!.productId = "invented"; const call = vi.fn(); const result = await runInitialOutreachOfferAgent(context, { signal: new AbortController().signal, now: () => clock, createSelector: () => ({ call, close: vi.fn() }) as never }); expect(result).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_INPUT_INVALID" }); expect(call).not.toHaveBeenCalled(); });
});

it("refuses changed product facts on the mandatory second exact read", async () => {
 const context = outreachContext(); let count = 0;
 const call = vi.fn(async (_name: string) => ({ contractVersion: "commerce.v1", status: "OK", data: { product: { ...exactProduct(context), unitPrice: ++count === 1 ? "12.00" : "13.00" } }, renderedText: "Fixture" }));
 const result = await runInitialOutreachOfferAgent(context, { signal: new AbortController().signal, now: () => clock, createSelector: () => ({ connect: vi.fn(), tools: vi.fn(), call, close: vi.fn() }) as never });
 expect(result).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_CURRENT_FACTS_CHANGED" }); expect(call).toHaveBeenCalledTimes(2);
});
it("refuses an alternative-product choice for initial outreach", async () => {
 const context = { ...outreachContext(), mode: "AI_BEST_APPLICABLE" };
 const call = vi.fn(async (_name: string) => ({ contractVersion: "commerce.v1", status: "OK", data: { product: exactProduct() }, renderedText: "Fixture" }));
 const result = await runInitialOutreachOfferAgent(context, { signal: new AbortController().signal, now: () => clock, createSelector: () => ({ connect: vi.fn(), tools: vi.fn(), call, close: vi.fn() }) as never,
  modelInvoker: { invoke: async () => ({ calls: [{ name: "submitInitialOutreachOffer", arguments: { kind: "ALTERNATIVE_PRODUCT_PROMOTION", productId: "gid://shopify/Product/999", variantId: null, offerId: "offer-other" } }], outputTokens: 10 }) } });
 expect(result).toMatchObject({ kind: "FAILURE", reasonCode: "OUTREACH_EVALUATION_OUTSIDE_CHECKOUT" }); expect(call.mock.calls.map(c => c[0])).toEqual(["commerce_get_product"]);
});
