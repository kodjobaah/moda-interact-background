import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import { renderInitialOutreachPreview } from "@modainteract/moda-interact-shared/commerce/outreach";
import { InitialOutreachAgentContextService } from "../../../../src/services/recovery-offers/initial-outreach-agent-context.service.js";
import { InitialOutreachOfferSelectionService } from "../../../../src/services/recovery-offers/initial-outreach-offer-selection.service.js";
import { CurrentOutreachOfferRevalidationService } from "../../../../src/services/recovery-offers/current-outreach-offer-revalidation.service.js";
import { RecoveryTemplatePreparer } from "../../../../src/services/recovery-template-preparation/recovery-template-preparer.service.js";
import { AutomatedRecoveryTemplateService } from "../../../../src/services/recovery-template-integration/automated-recovery-template.service.js";

const now = new Date("2026-11-08T12:00:00Z");
function productionFixture(platform: "SHOPIFY" | "WOOCOMMERCE") {
 const pair = platform === "SHOPIFY" ? { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2" } : { productId: "1", variantId: "2" };
 const line = { ...pair, title: "Historical shirt", variantTitle: "Old colour", quantity: 2, price: "12.50" };
 const recovery = { id: "recovery-1", shopId: "shop-1", generation: 1, status: "DETECTED", platform, currency: "GBP", totalPrice: "29.00",
  checkoutUrl: "https://shop.example/checkout", lineItems: [line, { ...line, quantity: 1 }],
  lastExternalActivityAt: new Date(now.getTime() - 60000), expiredAt: null,
  shop: { id: "shop-1", domain: "shop.example", platform, status: "ACTIVE", defaultLanguageTag: "en" },
  customer: { firstName: "Test customer" }, outreachAttempts: [] };
 const attempt = { id: "attempt-1", checkoutRecoveryId: recovery.id, sequence: 1, trigger: "INITIAL", status: "PENDING", initiatedBy: null };
 const db = { checkoutRecovery: { findFirst: vi.fn(async () => recovery), findUnique: vi.fn(async () => recovery) },
  recoveryOutreachAttempt: { findFirst: vi.fn(async () => attempt) }, shop: { findUnique: vi.fn(async () => recovery.shop) },
  commerceAgentConfiguration: { findMany: vi.fn(async () => [{ scope: "PLATFORM", shopId: null, activePromptRevisionId: "platform-1", activePromptRevision: { id: "platform-1", status: "PUBLISHED", promptText: "Checkout safety", prompt: { scope: "PLATFORM", shopId: null } } }]) },
  backgroundRuntimeConfig: { findUnique: vi.fn(async () => ({ checkoutRecoveryLifetimeDays: 21 })) },
 };
 const policy = { recoveryOfferMode: "NONE" as const, fixedShopifyDiscountId: null, offerSnapshot: null };
 const preflight = { reconcile: vi.fn() };
 const contextBuilder = new InitialOutreachAgentContextService({ db: db as never, environment: "TEST", now: () => now,
  policyService: { resolve: vi.fn(async () => policy) } as never, priceReconciliationService: preflight });
 const product = { ...pair, title: "Live shirt", url: "https://shop.example/item", available: true, unitPrice: "12.00", currency: "GBP", productType: null, vendor: null,
  observedAt: now.toISOString(), selectedOptions: [{ name: "Colour", value: "Blue" }], options: { status: "AVAILABLE", items: [{ name: "Colour", values: ["Blue"], usedForVariants: true }] } };
 const call = vi.fn(async (name: string, args: unknown, signal: AbortSignal) => {
  expect(name).toBe("commerce_get_product"); expect(args).toEqual(pair); expect(signal.aborted).toBe(false);
  return { contractVersion: "commerce.v1", status: "OK", data: { product: { ...product, observedAt: new Date().toISOString() } }, renderedText: "Synthetic current product" };
 });
 const selector = { connect: vi.fn(), tools: vi.fn(async () => [{ name: "commerce_get_product" }]), call, close: vi.fn() };
 const model = { invoke: vi.fn() }; const createSelector = () => selector as never;
 const revalidator = new CurrentOutreachOfferRevalidationService({ contextBuilder, createSelector, clock: () => now });
 const initialOffers = new InitialOutreachOfferSelectionService({ environment: "TEST", contextBuilder, createSelector, modelInvoker: model, revalidator });
 const components = [{ type: "BODY", text: "{{1}} saved {{2}} for {{3}}. Continue {{4}}" }];
 const bindings = { promotionTarget: "CHECKOUT", header: [], body: [ { position: 1, variable: "shop.name" }, { position: 2, variable: "checkout.itemsSummary" }, { position: 3, variable: "customer.firstName" }, { position: 4, variable: "checkout.url" } ], buttons: [] };
 const digest = createHash("sha256").update(canonicalJson({ schemaVersion: 1, family: "META_RECOVERY", category: "MARKETING", components, parameterBindings: bindings })).digest("hex");
 const registration = { id: "registration-1", wabaId: "waba-1", providerTemplateName: "approved_initial", providerTemplateId: "provider-1", providerLanguageCode: "en", category: "MARKETING", providerStatus: "APPROVED", submissionState: "SUBMITTED", failureCode: null,
  lastObservedContentHash: digest, lastObservedCategory: "MARKETING", driftDetectedAt: null, submittedContentHash: digest, componentsSnapshot: components, parameterBindingsSnapshot: bindings,
  locale: { id: "locale-1", languageTag: "en", providerLanguageCode: "en", status: "REVIEWED", contentHash: digest,
   definition: { id: "definition-1", kind: "META_RECOVERY", purpose: "INITIAL", offerType: "NO_OFFER", status: "PUBLISHED", category: "MARKETING", providerTemplateName: "approved_initial", publishedAt: now, retiredAt: null } } };
 const variant = { id: "variant-1", shopId: "shop-1", providerAccountId: "waba-1", purpose: "INITIAL_NO_OFFER", languageTag: "en", providerLanguageCode: "en", providerTemplateName: "approved_initial", providerTemplateId: "provider-1", status: "APPROVED", enabled: true, metaRegistrationId: registration.id, metaRegistration: registration };
 const repository = { readCatalogue: vi.fn(async () => ({ shop: recovery.shop, variants: [variant] })), readShopBrand: vi.fn(async () => ({ brandName: "Saved Merchant", logoAltText: null, logoWidth: null, logoHeight: null, squareLogoAltText: null, logoUrl: null, squareLogoUrl: null, coverImageUrl: null })), readShopCategory: vi.fn(async () => null) };
 const preparer = new RecoveryTemplatePreparer(repository as never, async () => "waba-1", async () => null, [], () => now);
 const prepare = vi.spyOn(preparer, "prepare");
 const fallback = { prepare: vi.fn() };
 const legacyOffers = { resolve: vi.fn() };
 const service = new AutomatedRecoveryTemplateService(legacyOffers as never, preparer, db as never, async () => "waba-1", () => now,
  { warn: vi.fn(), error: vi.fn() }, undefined, initialOffers, undefined, fallback as never);
 return { service, initialOffers, revalidator, recovery, pair, call, model, preflight, prepare, repository, fallback, legacyOffers, variant };
}

describe("ARCH066 real production NONE call chain", () => {
 it.each(["SHOPIFY", "WOOCOMMERCE"] as const)("runs %s context/selection/admission/preparer with exactly two reads per distinct pair and configured no-offer", async platform => {
  const f = productionFixture(platform);
  const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1", outreachAttemptId: "attempt-1", stage: "INITIAL", policy: { recoveryOfferMode: "NONE", fixedShopifyDiscountId: null, offerSnapshot: null } as never, conversationLanguageTag: null });
  expect(result.kind).toBe("prepared"); if(result.kind!=="prepared") throw Error(JSON.stringify(result));
  expect(f.call).toHaveBeenCalledTimes(2); expect(f.model.invoke).not.toHaveBeenCalled(); expect(f.preflight.reconcile).not.toHaveBeenCalled(); expect(f.fallback.prepare).not.toHaveBeenCalled(); expect(f.legacyOffers.resolve).not.toHaveBeenCalled();
  const input = f.prepare.mock.calls[0]![0]; expect(input.outreachEvaluation).toMatchObject({ currentMerchandiseSubtotal: { amountDecimal: "36.00", currency: "GBP" }, lines: [{ quantity: 2, checkoutUnitPrice: "12.50", currentProduct: { title: "Live shirt", unitPrice: "12.00" } }, { quantity: 1 }] });
  expect(result.prepared.renderedText).toBe("Saved Merchant saved 2 × Live shirt (Blue) and 1 × Live shirt (Blue) for Test customer. Continue https://shop.example/checkout");
  expect(await f.initialOffers.validateAdmission(result.admissionToken!, new AbortController().signal)).toBe(true);
  const expected = renderInitialOutreachPreview({ schemaVersion: 1, evaluation: input.outreachEvaluation!, preparedProjection: JSON.parse(JSON.stringify({ variant: f.variant, canonicalLanguageTag: "en", selectionSource: "merchant-fallback" })), variables: { shopName: "Saved Merchant", customerFirstName: "Test customer", checkoutUrl: f.recovery.checkoutUrl, shopCategory: null }, headerMedia: null,
   preparedBrand: { shopId: "shop-1", brandName: "Saved Merchant", logoAltText: null, logoWidth: null, logoHeight: null, squareLogoAltText: null }, preparedBrandMedia: { logo: null, squareLogo: null, coverImage: null } });
  expect(expected.kind).toBe("ready"); if(expected.kind!=="ready")throw Error(JSON.stringify(expected));
  expect(result.prepared.template.components).toEqual(expected.parameters); expect(Buffer.from(result.prepared.renderedText!)).toEqual(Buffer.from(expected.renderedText));
  expect({ variantId: result.prepared.variantId, registrationId: result.prepared.registrationId, definitionId: result.prepared.definitionId, providerTemplateId: result.prepared.providerTemplateId, providerTemplateName: result.prepared.providerTemplateName, providerLanguageCode: result.prepared.providerLanguageCode, submittedContentHash: result.prepared.submittedContentHash, bindingFingerprint: result.prepared.bindingFingerprint }).toEqual(expected.templateProvenance);
  f.recovery.generation++;
  expect(await f.initialOffers.validateAdmission(result.admissionToken!, new AbortController().signal)).toBe(false);
 });
});
