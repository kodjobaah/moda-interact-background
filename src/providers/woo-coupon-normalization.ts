/**
 * Maps a completed Woo REST scan into the existing, provider-neutral discount columns.
 * This module neither accesses the database nor modifies merchant selection state.
 */
import { WooCouponReadError } from "./woo-coupon-transport.js";

export interface NormalizedWooCoupon {
  shopifyDiscountNodeId: string;
  providerType: string;
  method: "CODE";
  providerStatus: "ACTIVE" | "EXPIRED" | "EXHAUSTED" | "UNSUPPORTED";
  title: string;
  summary: string;
  startsAt: null;
  endsAt: Date | null;
  codeCount: 1;
  singleRedeemCode: string;
  fixedSelectable: boolean;
  providerSnapshot: Record<string, unknown>;
}

const MAX_CODE_LENGTH = 255;
const MAX_LIST_ENTRIES = 1000;
const TYPES = new Set(["percent", "fixed_cart", "fixed_product"]);

function invalid(): never { throw new WooCouponReadError("invalid_coupon"); }

function optionalCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) invalid();
  return value;
}

function ids(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES ||
      value.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) invalid();
  return value;
}

function bool(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") invalid();
  return value;
}

function amount(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") invalid();
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(text) || !Number.isFinite(Number(text))) invalid();
  return text;
}

/** Prefer the explicitly UTC Woo field; do not guess the store timezone from date_expires. */
function expiry(coupon: Record<string, unknown>): { date: Date | null; uncertain: boolean } {
  const raw = coupon.date_expires_gmt;
  if (raw === null || raw === undefined || raw === "") {
    return { date: null, uncertain: typeof coupon.date_expires === "string" && coupon.date_expires.length > 0 };
  }
  if (typeof raw !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/.test(raw)) invalid();
  // date_expires_gmt without an offset is documented as GMT/UTC, not local time.
  const value = /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) invalid();
  return { date: parsed, uncertain: false };
}

function optionalMoney(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return amount(value);
}

/** Do not persist email_restrictions, used_by, meta_data or other customer PII. */
export function normalizeWooCoupon(coupon: Record<string, unknown>, now: Date): NormalizedWooCoupon {
  const id = coupon.id;
  const code = coupon.code;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 ||
      typeof code !== "string" || !code.trim() || code.length > MAX_CODE_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(code) || !Number.isFinite(now.getTime())) invalid();

  const discountType = coupon.discount_type;
  if (typeof discountType !== "string" || discountType.length > 64) invalid();
  const value = amount(coupon.amount);
  const freeShipping = bool(coupon.free_shipping);
  const { date: endsAt, uncertain } = expiry(coupon);
  const usageLimit = optionalCount(coupon.usage_limit);
  const usageCount = optionalCount(coupon.usage_count) ?? 0;
  const usageLimitPerUser = optionalCount(coupon.usage_limit_per_user);
  const maximumUsageItems = optionalCount(coupon.limit_usage_to_x_items);
  const minimumAmount = optionalMoney(coupon.minimum_amount);
  const maximumAmount = optionalMoney(coupon.maximum_amount);
  const productIds = ids(coupon.product_ids);
  const excludedProductIds = ids(coupon.excluded_product_ids);
  const productCategories = ids(coupon.product_categories);
  const excludedProductCategories = ids(coupon.excluded_product_categories);
  const individualUse = bool(coupon.individual_use);
  const excludeSaleItems = bool(coupon.exclude_sale_items);
  const expired = endsAt !== null && endsAt.getTime() <= now.getTime();
  const exhausted = usageLimit !== null && usageLimit > 0 && usageCount >= usageLimit;
  const supported = TYPES.has(discountType) && (Number(value) > 0 || freeShipping) &&
    !(discountType === "percent" && Number(value) > 100) && !uncertain;
  const providerStatus = expired ? "EXPIRED" : exhausted ? "EXHAUSTED" : supported ? "ACTIVE" : "UNSUPPORTED";
  const snapshot: Record<string, unknown> = {
    provider: "WOOCOMMERCE", couponId: id, code,
    discountType, amount: value, freeShipping,
    usageLimit, usageCount, usageLimitPerUser, maximumUsageItems,
    productIds, excludedProductIds, productCategories, excludedProductCategories,
    individualUse, excludeSaleItems, minimumAmount, maximumAmount,
    dateExpiresGmt: endsAt?.toISOString() ?? null,
    expiryUnverified: uncertain,
  };
  return {
    shopifyDiscountNodeId: `woo:coupon:${id}`,
    providerType: `WooCoupon:${discountType}`,
    method: "CODE",
    providerStatus,
    title: code,
    summary: `${discountType}: ${value}${freeShipping ? "; free shipping" : ""}`,
    startsAt: null,
    endsAt,
    codeCount: 1,
    singleRedeemCode: code,
    fixedSelectable: providerStatus === "ACTIVE",
    providerSnapshot: snapshot,
  };
}

export function normalizeWooCoupons(
  coupons: readonly Record<string, unknown>[], now: Date,
): NormalizedWooCoupon[] {
  const result = coupons.map((coupon) => normalizeWooCoupon(coupon, now));
  const keys = new Set(result.map((coupon) => coupon.shopifyDiscountNodeId));
  if (keys.size !== result.length) invalid();
  return result;
}
