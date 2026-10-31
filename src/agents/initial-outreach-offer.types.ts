import { z } from "zod";
import {
  CommerceToolOutputs,
  CommerceDiscountDetailsSchema,
  CommerceOfferSchema,
  CommerceProductSchema,
  CurrencySchema,
  HashSchema,
  InitialOutreachCheckoutOfferSetSchema,
} from "@modainteract/moda-interact-shared/commerce";
import { CommerceEnvironmentSchema } from "@modainteract/moda-interact-shared/commerce/model";
import type { CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import type { CheckoutPriceReconciliation } from "../services/recovery-pricing/checkout-price-reconciliation.types.js";

const CheckoutLineSchema = z.strictObject({
  lineKey: z.string().min(1).max(128),
  productId: z.string().min(1).max(191).nullable(),
  variantId: z.string().min(1).max(191).nullable(),
  categoryIds: z.array(z.string().min(1).max(191)).max(128).nullable(),
  collectionIds: z.array(z.string().min(1).max(191)).max(128).nullable(),
  isSaleItem: z.boolean().nullable(),
  title: z.string().max(160),
  category: z.string().max(128).nullable(),
  quantity: z.number().int().positive().safe(),
  lineTotalMinor: z.number().int().nonnegative().safe().nullable(),
});

export const InitialOutreachAgentContextSchema = z.strictObject({
  shopId: z.string().min(1).max(191),
  checkoutRecoveryId: z.string().min(1).max(191),
  outreachAttemptId: z.string().min(1).max(191),
  environment: CommerceEnvironmentSchema,
  platform: z.enum(["SHOPIFY", "WOOCOMMERCE"]),
  mode: z.enum(["NONE", "FIXED", "AI_BEST_APPLICABLE"]),
  authorisedDiscountIds: z.array(z.string().min(1).max(191)).max(50),
  basket: z.strictObject({
    currency: CurrencySchema,
    subtotalMinor: z.number().int().nonnegative().safe().nullable(),
    totalMinor: z.number().int().nonnegative().safe().nullable(),
    fingerprint: HashSchema,
    generation: z.number().int().positive().safe(),
    items: z.array(CheckoutLineSchema).max(100),
  }),
  priceReconciliation: z.custom<CheckoutPriceReconciliation | null>((value) => {
    if (value === null) return true;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const report = value as Record<string, unknown>;
    return typeof report.shopId === "string" && typeof report.checkoutRecoveryId === "string" &&
      typeof report.outreachAttemptId === "string" && Number.isSafeInteger(report.generation) &&
      typeof report.basketFingerprint === "string" && typeof report.evaluatedAt === "string" &&
      Array.isArray(report.lines) && Array.isArray(report.reasonCodes) &&
      (report.completeness === "COMPLETE" || report.completeness === "PARTIAL") &&
      (report.currentMerchandiseSubtotal === null || typeof report.currentMerchandiseSubtotal === "object");
  }),
  platformInstructions: z.string().min(1).max(8_000),
  merchantInstructions: z.string().max(8_000).nullable(),
  platformInstructionRevisionId: z.string().min(1).max(191),
  merchantInstructionRevisionId: z.string().min(1).max(191).nullable(),
}).superRefine((context, issue) => {
  const lineKeys = context.basket.items.map((item) => item.lineKey);
  if (new Set(lineKeys).size !== lineKeys.length) {
    issue.addIssue({ code: "custom", path: ["basket", "items"], message: "Basket line keys must be unique" });
  }
  if (context.mode !== "FIXED" && context.authorisedDiscountIds.length > 0) {
    issue.addIssue({ code: "custom", path: ["authorisedDiscountIds"], message: "Only FIXED mode can authorize selected IDs" });
  }
  if (new Set(context.authorisedDiscountIds).size !== context.authorisedDiscountIds.length) {
    issue.addIssue({ code: "custom", path: ["authorisedDiscountIds"], message: "Authorized IDs must be unique" });
  }
});

export type InitialOutreachAgentContext = z.infer<typeof InitialOutreachAgentContextSchema> & {
  environment: CommerceEnvironment;
  priceReconciliation: CheckoutPriceReconciliation | null;
};

export type InitialOutreachCommerceOffer = z.infer<typeof CommerceOfferSchema>;
export type InitialOutreachCommerceDiscountDetails = z.infer<typeof CommerceDiscountDetailsSchema>;
export type InitialOutreachCommerceProduct = z.infer<typeof CommerceProductSchema>;

export type CheckoutEligibilityDecision = Readonly<{
  offerId: string;
  verdict: "SUPPORTED" | "NOT_APPLICABLE" | "UNVERIFIABLE";
  eligibleLineKeys: readonly string[];
  reasonCodes: readonly string[];
}>;

export type CheckoutOfferGroupDecision = Readonly<{
  verdict: "SUPPORTED" | "UNVERIFIABLE" | "INCOMPATIBLE";
  offerIds: readonly string[];
  reasonCodes: readonly string[];
}>;

export type ObservedCheckoutOffer = Readonly<{
  offer: InitialOutreachCommerceOffer;
  details: InitialOutreachCommerceDiscountDetails;
  eligibility: CheckoutEligibilityDecision;
}>;

export type SourceBoundOutreachProduct = Readonly<{
  shopId: string;
  product: InitialOutreachCommerceProduct;
}>;

export const InitialOutreachModelChoiceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("CHECKOUT_DISCOUNT"),
    offerIds: z.array(z.string().min(1).max(191)).min(1).max(3),
  }).superRefine((choice, issue) => {
    if (new Set(choice.offerIds).size !== choice.offerIds.length) {
      issue.addIssue({ code: "custom", path: ["offerIds"], message: "Offer IDs must be unique" });
    }
  }),
  z.strictObject({
    kind: z.literal("ALTERNATIVE_PRODUCT_PROMOTION"),
    offerId: z.string().min(1).max(191),
    productId: z.string().min(1).max(191),
    variantId: z.string().min(1).max(191).nullable(),
  }),
  z.strictObject({ kind: z.literal("NO_VERIFIED_OFFER") }),
]);

export type InitialOutreachModelChoice = z.infer<typeof InitialOutreachModelChoiceSchema>;

export const InitialOutreachAgentResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("CHECKOUT_DISCOUNT"),
    offerSet: InitialOutreachCheckoutOfferSetSchema,
    members: z.array(z.strictObject({
      offerId: z.string().min(1),
      providerDiscountId: z.string().min(1),
      eligibility: z.custom<CheckoutEligibilityDecision>(),
    })).min(1).max(3),
    group: z.custom<CheckoutOfferGroupDecision>(),
    shopId: z.string().min(1),
    checkoutRecoveryId: z.string().min(1),
    outreachAttemptId: z.string().min(1),
    generation: z.number().int().positive(),
    fingerprint: HashSchema,
    priceReconciliation: z.custom<CheckoutPriceReconciliation | null>(),
    discoveryIncomplete: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("ALTERNATIVE_PRODUCT_PROMOTION"),
    offerId: z.string().min(1),
    providerDiscountId: z.string().min(1),
    productId: z.string().min(1),
    variantId: z.string().min(1).nullable(),
    product: z.custom<SourceBoundOutreachProduct>(),
    shopId: z.string().min(1),
    checkoutRecoveryId: z.string().min(1),
    outreachAttemptId: z.string().min(1),
    generation: z.number().int().positive(),
    fingerprint: HashSchema,
    discoveryIncomplete: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("NO_VERIFIED_OFFER"),
    reason: z.string().min(1).max(96),
    discoveryIncomplete: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("FAILURE"),
    code: z.enum(["UNAVAILABLE", "DENIED", "CANCELLED", "DEADLINE", "BUDGET_EXHAUSTED", "INVALID_RESULT"]),
    reasonCode: z.string().min(1).max(96),
    retryable: z.boolean(),
  }),
]);

export type InitialOutreachAgentResult = z.infer<typeof InitialOutreachAgentResultSchema>;
export type DiscountOptionsOutput = z.infer<typeof CommerceToolOutputs.commerce_get_discount_options>;
export type DiscountDetailsOutput = z.infer<typeof CommerceToolOutputs.commerce_get_discount_details>;
export type ProductSearchOutput = z.infer<typeof CommerceToolOutputs.commerce_search_products>;
export type ProductOutput = z.infer<typeof CommerceToolOutputs.commerce_get_product>;