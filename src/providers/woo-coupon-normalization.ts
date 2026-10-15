/**
 * WooCommerce owns coupon eligibility and redemption. Only verify provider
 * identity and whether a code is safe to transmit; optional attributes are
 * descriptive and cannot invalidate an otherwise complete catalogue scan.
 * Never copy provider customer data, metadata or entire response bodies.
 */
import { WooCouponReadError } from "./woo-coupon-transport.js";

export interface NormalizedWooCoupon {
  shopifyDiscountNodeId: string;
  providerType: string;
  method: "CODE";
  providerStatus: "ACTIVE" | "UNDELIVERABLE";
  title: string;
  summary: string;
  startsAt: null;
  endsAt: Date | null;
  codeCount: 0 | 1;
  singleRedeemCode: string | null;
  fixedSelectable: boolean;
  providerSnapshot: Record<string, unknown>;
}

export type WooCouponIssueReason = "code_not_deliverable" | "optional_field_ignored";
export interface WooCouponIssue {
  couponId: number;
  field: string;
  reason: WooCouponIssueReason;
}

const MAX_RESTRICTION_IDS = 1000;
const MAX_ATTRIBUTE_LENGTH = 1024;
const MAX_REPORTED_ISSUES = 20;

function identityInvalid(): never {
  throw new WooCouponReadError("provider_identity_invalid");
}

function providerId(coupon: Record<string, unknown>): number {
  const id = coupon.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) identityInvalid();
  return id;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 0x1f || point === 0x7f);
  });
}

/** Codes are deliberately not truncated or constrained to 255 characters. */
export function deliverableWooCode(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !containsControlCharacter(value);
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string" && value.length <= MAX_ATTRIBUTE_LENGTH &&
      !containsControlCharacter(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > MAX_RESTRICTION_IDS ||
      value.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) return null;
  return value;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Never infer Woo's store timezone from the local-time date_expires field. */
function utcExpiry(value: unknown): Date | null {
  if (typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) return null;
  const utc = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  const date = new Date(utc);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalise(
  coupon: Record<string, unknown>, now: Date, report: (field: string, reason: WooCouponIssueReason) => void,
): NormalizedWooCoupon {
  const id = providerId(coupon);
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid Woo coupon scan time");

  const code = deliverableWooCode(coupon.code) ? coupon.code : null;
  if (code === null) report("code", "code_not_deliverable");
  const optional = <T>(field: string, convert: (raw: unknown) => T | null): T | null => {
    const raw = coupon[field];
    if (raw === null || raw === undefined || raw === "") return null;
    const result = convert(raw);
    if (result === null) report(field, "optional_field_ignored");
    return result;
  };
  const discountType = optional("discount_type", optionalString);
  const value = optional("amount", optionalString);
  const freeShipping = optional("free_shipping", optionalBoolean);
  const endsAt = optional("date_expires_gmt", utcExpiry);
  const usageLimit = optional("usage_limit", optionalCount);
  const usageCount = optional("usage_count", optionalCount);
  const usageLimitPerUser = optional("usage_limit_per_user", optionalCount);
  const maximumUsageItems = optional("limit_usage_to_x_items", optionalCount);
  const minimumAmount = optional("minimum_amount", optionalString);
  const maximumAmount = optional("maximum_amount", optionalString);
  const productIds = optional("product_ids", optionalIds);
  const excludedProductIds = optional("excluded_product_ids", optionalIds);
  const productCategories = optional("product_categories", optionalIds);
  const excludedProductCategories = optional("excluded_product_categories", optionalIds);
  const individualUse = optional("individual_use", optionalBoolean);
  const excludeSaleItems = optional("exclude_sale_items", optionalBoolean);

  // Fixed internal marker fits VARCHAR(128). Retain the real provider-defined
  // discount type in the bounded, explicit snapshot instead of an allowlist.
  const snapshot: Record<string, unknown> = {
    provider: "WOOCOMMERCE", couponId: id,
    discountType, amount: value, freeShipping,
    usageLimit, usageCount, usageLimitPerUser, maximumUsageItems,
    productIds, excludedProductIds, productCategories, excludedProductCategories,
    individualUse, excludeSaleItems, minimumAmount, maximumAmount,
    dateExpiresGmt: endsAt?.toISOString() ?? null,
    expiryUnverified: endsAt === null && (coupon.date_expires_gmt != null || coupon.date_expires != null),
    codeDeliverable: code !== null,
  };
  if (code !== null) snapshot.code = code;

  return {
    shopifyDiscountNodeId: `woo:coupon:${id}`,
    providerType: "WooCoupon:code",
    method: "CODE",
    providerStatus: code === null ? "UNDELIVERABLE" : "ACTIVE",
    title: code ?? `WooCommerce coupon #${id}`,
    summary: code === null ? "Coupon code unavailable" :
      `${discountType ?? "WooCommerce coupon"}: ${value ?? "amount unspecified"}${freeShipping ? "; free shipping" : ""}`.slice(0, 256),
    startsAt: null,
    endsAt,
    codeCount: code === null ? 0 : 1,
    singleRedeemCode: code,
    fixedSelectable: code !== null,
    providerSnapshot: snapshot,
  };
}

export function normalizeWooCoupon(coupon: Record<string, unknown>, now: Date): NormalizedWooCoupon {
  return normalise(coupon, now, () => {});
}

export interface WooCouponNormalizationBatch {
  observed: NormalizedWooCoupon[];
  issueCount: number;
  codeUnavailableCount: number;
  issues: WooCouponIssue[];
}

export function normalizeWooCouponBatch(
  coupons: readonly Record<string, unknown>[], now: Date,
): WooCouponNormalizationBatch {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid Woo coupon scan time");
  const seen = new Set<number>();
  // Validate ALL provider identities before accepting any per-item projections.
  // Duplicates/ambiguous IDs make absence accounting untrustworthy.
  for (const coupon of coupons) {
    if (!coupon || typeof coupon !== "object" || Array.isArray(coupon)) identityInvalid();
    const id = providerId(coupon);
    if (seen.has(id)) identityInvalid();
    seen.add(id);
  }
  const result: WooCouponNormalizationBatch = {
    observed: [], issueCount: 0, codeUnavailableCount: 0, issues: [],
  };
  for (const coupon of coupons) {
    const id = providerId(coupon);
    const item = normalise(coupon, now, (field, reason) => {
      result.issueCount++;
      if (result.issues.length < MAX_REPORTED_ISSUES) result.issues.push({ couponId: id, field, reason });
    });
    result.observed.push(item);
    if (item.singleRedeemCode === null) result.codeUnavailableCount++;
  }
  return result;
}

export function normalizeWooCoupons(
  coupons: readonly Record<string, unknown>[], now: Date,
): NormalizedWooCoupon[] {
  return normalizeWooCouponBatch(coupons, now).observed;
}
