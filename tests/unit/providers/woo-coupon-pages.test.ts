import { describe, expect, it, vi } from "vitest";
import { readAllWooCouponPages, type WooCouponPage } from "../../../src/providers/woo-coupon-pages.js";

function page(ids: number[], total: number, totalPages: number): WooCouponPage {
  return { coupons: ids.map((id) => ({ id, code: `SAVE${id}` })), total, totalPages };
}

describe("ARCH-036 full Woo coupon scan", () => {
  it("accepts a complete empty Woo catalogue", async () => {
    expect(await readAllWooCouponPages(async () => page([], 0, 0))).toEqual([]);
  });

  it("fetches all pages with bounded page parameters and ascending unique identities", async () => {
    const first = page(Array.from({ length: 100 }, (_, index) => index + 1), 102, 2);
    const second = page([101, 102], 102, 2);
    const fetchPage = vi.fn(async (number: number, _size: number) => number === 1 ? first : second);
    expect(await readAllWooCouponPages(fetchPage)).toHaveLength(102);
    expect(fetchPage.mock.calls.map(([number, size]) => [number, size])).toEqual([[1, 100], [2, 100]]);
  });

  it.each([
    ["page missing", async (n: number) => n === 1 ? page(Array.from({ length: 100 }, (_, i) => i + 1), 101, 2) : page([], 101, 2)],
    ["duplicate", async (n: number) => n === 1 ? page(Array.from({ length: 100 }, (_, i) => i + 1), 101, 2) : page([100], 101, 2)],
    ["changed totals", async (n: number) => n === 1 ? page(Array.from({ length: 100 }, (_, i) => i + 1), 101, 2) : page([101], 100, 1)],
    ["reversed order", async () => page([3, 1], 2, 1)],
    ["invalid id", async () => ({ coupons: [{ id: 0 }], total: 1, totalPages: 1 })],
    ["malformed pagination", async () => ({ coupons: [], total: 9000, totalPages: 90 })],
  ])("rejects %s instead of publishing partial results", async (_name, fetchPage) => {
    await expect(readAllWooCouponPages(fetchPage)).rejects.toThrow();
  });
});

describe("ARCH-036 configured page and scan limits", () => {
  it("rejects catalogues needing more than the validated page limit", async () => {
    const first = page(Array.from({ length: 100 }, (_, n) => n + 1), 101, 2);
    await expect(readAllWooCouponPages(async () => first, 1, 120000))
      .rejects.toThrow("invalid_page");
  });

  it("fails a scan after its elapsed-time limit rather than committing partial pages", async () => {
    const read = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return page([], 0, 0);
    });
    await expect(readAllWooCouponPages(read, 2, 1)).rejects.toThrow("provider_unavailable");
  });
});
