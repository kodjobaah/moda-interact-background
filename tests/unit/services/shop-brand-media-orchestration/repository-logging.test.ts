import { describe, expect, it, vi } from "vitest";
import type { ShopBrandMediaDatabase } from "../../../../src/services/shop-brand-media-orchestration/repository.js";
import { ShopBrandMediaRepository } from "../../../../src/services/shop-brand-media-orchestration/repository.js";

function fixture() {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const transaction = vi.fn();
  const database = { $transaction: transaction,
    shop: { findUnique: vi.fn(async () => ({ domain: "merchant.myshopify.com" })) },
  } as unknown as ShopBrandMediaDatabase;
  return { logger, transaction, repository: new ShopBrandMediaRepository(database, logger) };
}

const transient = (code: "P2002" | "P2034") =>
  Object.assign(new Error("https://private.example/?secret=never-log-me"), { code });

describe("ARCH-049 row-locked repository exception logging", () => {
  it("warns on every transient transaction exception while retrying and returns the eventual result", async () => {
    const { repository, transaction, logger } = fixture();
    transaction.mockRejectedValueOnce(transient("P2034"))
      .mockRejectedValueOnce(transient("P2002"))
      .mockResolvedValueOnce(null);
    expect(await repository.claim("shop_001", "LOGO")).toBeNull();
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(1, "shop_brand.media.transaction_retry",
      expect.objectContaining({ shopId: "shop_001", attempt: 1, reasonCode: "P2034" }));
    expect(logger.warn).toHaveBeenNthCalledWith(2, "shop_brand.media.transaction_retry",
      expect.objectContaining({ shopId: "shop_001", attempt: 2, reasonCode: "P2002" }));
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]?.[1]?.errorMessage).toContain("private.example");
    expect(logger.warn.mock.calls[1]?.[1]?.errorMessage).toContain("never-log-me");
  });

  it("reports the terminal exception with a bounded safe code and does not swallow it", async () => {
    const { repository, transaction, logger } = fixture();
    const error = new Error("postgres dsn: https://private.example/?secret=never-log-me");
    transaction.mockRejectedValue(error);
    await expect(repository.claim("shop_001", "LOGO")).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("shop_brand.media.transaction_failed",
      expect.objectContaining({ shopId: "shop_001", attempt: 1,
        reasonCode: "PERSISTENCE_FAILURE", exceptionType: "Error" }));
    expect(logger.error.mock.lastCall?.[1]?.errorMessage).toBe(error.message);
  });

  it("reports the final retry exhaustion rather than silently discarding it", async () => {
    const { repository, transaction, logger } = fixture();
    const error = transient("P2034");
    transaction.mockRejectedValue(error);
    await expect(repository.claim("shop_001", "LOGO")).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith("shop_brand.media.transaction_failed",
      expect.objectContaining({ attempt: 3, reasonCode: "P2034" }));
    expect(logger.error.mock.lastCall?.[1]?.errorMessage).toBe(error.message);
  });
});
