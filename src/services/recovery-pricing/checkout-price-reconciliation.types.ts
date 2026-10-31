import type { CommerceOutreachToolContext } from "@modainteract/moda-interact-shared/commerce";

export type LinePriceObservation = Readonly<{
  lineKey: string;
  productId: string | null;
  variantId: string | null;
  quantity: number | null;
  checkoutUnitPrice: string | null;
  checkoutCurrency: string | null;
  catalogueUnitPrice: string | null;
  catalogueCurrency: string | null;
  catalogueObservedAt: string | null;
  catalogueComparison: "EQUAL" | "DIFFERENT" | "INCOMPARABLE";
  checkoutPriceChange: "CONFIRMED_UNCHANGED" | "CONFIRMED_CHANGED" | "UNVERIFIABLE";
  reasonCodes: readonly string[];
}>;

export type CheckoutPriceReconciliation = Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  outreachAttemptId: string;
  generation: number;
  basketFingerprint: string;
  evaluatedAt: string;
  lines: readonly LinePriceObservation[];
  reasonCodes: readonly string[];
  currentMerchandiseSubtotal: Readonly<{ amountDecimal: string; currency: string }> | null;
  completeness: "COMPLETE" | "PARTIAL";
}>;

export type PriceReconciliationInput = Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  outreachAttemptId: string;
  expectedGeneration: number;
  expectedBasketFingerprint: string;
  signal: AbortSignal;
}>;

export type RecoveryPricingState = Readonly<{
  recovery: Readonly<{
    id: string;
    shopId: string;
    generation: number;
    currency: string | null;
    lineItems: unknown;
    platform: string;
    status: string;
  }>;
  attempt: Readonly<{
    id: string;
    checkoutRecoveryId: string;
    sequence: number;
    trigger: string;
    status: string;
    initiatedBy: string | null;
  }> | null;
}>;

export interface TrustedRecoveryAttemptReader {
  read(input: Readonly<{
    shopId: string;
    checkoutRecoveryId: string;
    outreachAttemptId: string;
  }>): Promise<RecoveryPricingState | null>;
}

export interface ExactProductReader {
  read(input: Readonly<{
    shopId: string;
    productId: string;
    variantId: string | null;
    toolContext: CommerceOutreachToolContext;
    signal: AbortSignal;
  }>): Promise<unknown>;
}