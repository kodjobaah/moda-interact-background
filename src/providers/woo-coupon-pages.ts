import { WooCouponReadError } from "./woo-coupon-transport.js";

export interface WooCouponPage {
  coupons: unknown;
  total: number;
  totalPages: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_COUPONS = PAGE_SIZE * MAX_PAGES;

/** Fail the entire scan on partial, duplicate, reordered or inconsistent provider pages. */
export async function readAllWooCouponPages(
  readPage: (page: number, perPage: number) => Promise<WooCouponPage>,
): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  let expectedTotal: number | undefined;
  let expectedPages: number | undefined;
  let previousId = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await readPage(page, PAGE_SIZE);
    if (!Number.isSafeInteger(response.total) || response.total < 0 || response.total > MAX_COUPONS ||
        !Number.isSafeInteger(response.totalPages) || response.totalPages < 0 ||
        response.totalPages > MAX_PAGES || !Array.isArray(response.coupons)) {
      throw new WooCouponReadError("invalid_page");
    }
    const pages = Math.max(1, response.totalPages);
    if (pages !== Math.max(1, Math.ceil(response.total / PAGE_SIZE)) ||
        response.totalPages !== 0 && response.total === 0 ||
        expectedTotal !== undefined && response.total !== expectedTotal ||
        expectedPages !== undefined && pages !== expectedPages) {
      throw new WooCouponReadError("unstable_pages");
    }
    expectedTotal = response.total;
    expectedPages = pages;
    if (response.coupons.length > PAGE_SIZE ||
        response.coupons.length !== Math.min(PAGE_SIZE, response.total - result.length)) {
      throw new WooCouponReadError("incomplete_pages");
    }
    for (const item of response.coupons) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new WooCouponReadError("invalid_page");
      const coupon = item as Record<string, unknown>;
      const id = coupon.id;
      if (!Number.isSafeInteger(id) || typeof id !== "number" || id <= 0 || seen.has(id) || id <= previousId) {
        throw new WooCouponReadError("unstable_pages");
      }
      previousId = id;
      seen.add(id);
      result.push(coupon);
    }
    if (page === pages) {
      if (result.length !== response.total) throw new WooCouponReadError("incomplete_pages");
      return result;
    }
  }
  throw new WooCouponReadError("too_many_pages");
}
