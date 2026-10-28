import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyWhatsAppConsentServicePort } from "../../../src/services/shopify-whatsapp-consent.service.js";
import {
  processShopifyWhatsAppConsentSyncJob,
  ShopifyConsentSyncRetryableError,
} from "../../../src/services/shopify-whatsapp-consent-sync-job.service.js";

const job = {
  schemaVersion: 1,
  shopId: "shop-a",
  // Numeric Shopify customer IDs must be preserved beyond Number.MAX_SAFE_INTEGER.
  shopifyCustomerId: "9007199254740995",
  deliveryId: "webhook-delivery-1",
  triggeredAt: "2026-10-20T11:00:00.000Z",
};
const syncCustomer = vi.fn<ShopifyWhatsAppConsentServicePort["syncCustomer"]>();
const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Shopify consent sync job processing", () => {
  it("refreshes current Shopify state for the canonical shop/customer, not an asserted webhook grant", async () => {
    syncCustomer.mockResolvedValueOnce({ status: "UPDATED", customerPhoneId: "phone-a" });

    expect(await processShopifyWhatsAppConsentSyncJob(job, { syncCustomer }, logger)).toBe("updated");
    expect(syncCustomer).toHaveBeenCalledExactlyOnceWith({
      shopId: "shop-a", shopifyCustomerId: "9007199254740995",
    });
    expect(logger.info).toHaveBeenCalledWith("shopify.whatsapp_consent.sync_job", {
      shopId: "shop-a", outcome: "updated",
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("webhook-delivery-1");
  });

  it("replays and reordered events by re-reading live state; never treats triggeredAt as consent chronology", async () => {
    syncCustomer.mockResolvedValueOnce({ status: "UPDATED", customerPhoneId: "phone-a" })
      .mockResolvedValueOnce({ status: "UNCHANGED", customerPhoneId: "phone-a" })
      .mockResolvedValueOnce({ status: "UPDATED", customerPhoneId: "phone-a" });

    expect(await processShopifyWhatsAppConsentSyncJob(job, { syncCustomer }, logger)).toBe("updated");
    expect(await processShopifyWhatsAppConsentSyncJob(job, { syncCustomer }, logger)).toBe("unchanged");
    expect(await processShopifyWhatsAppConsentSyncJob({
      ...job, deliveryId: "older-delivery", triggeredAt: "2026-10-19T00:00:00.000Z",
    }, { syncCustomer }, logger)).toBe("updated");
    expect(syncCustomer).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ status: "NOT_AUTHORISED", reason: "SHOP_NOT_ELIGIBLE" }, "skipped"],
    [{ status: "NOT_AUTHORISED", reason: "CUSTOMER_IDENTITY_NOT_LINKED" }, "skipped"],
    [{ status: "NOT_AUTHORISED", reason: "SHOPIFY_CUSTOMER_OR_PHONE_NOT_FOUND" }, "skipped"],
    [{ status: "AMBIGUOUS", reason: "DUPLICATE_SHOPIFY_IDENTITY" }, "skipped"],
    [{ status: "UNAVAILABLE", reason: "STALE_OR_CONFLICTING_OBSERVATION" }, "stale"],
  ] as const)("fails closed and acknowledges deterministic %s", async (result, outcome) => {
    syncCustomer.mockResolvedValueOnce(result);
    expect(await processShopifyWhatsAppConsentSyncJob(job, { syncCustomer }, logger)).toBe(outcome);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    "SHOPIFY_TIMEOUT", "SHOPIFY_HTTP", "SHOPIFY_GRAPHQL", "SHOPIFY_ACCESS_DENIED",
    "CONSENT_WRITE_FAILURE", "SHOPIFY_IDENTITY_MISMATCH",
  ])("lets BullMQ retry bounded transient provider/write failure %s", async (reason) => {
    syncCustomer.mockResolvedValueOnce({ status: "UNAVAILABLE", reason });
    await expect(processShopifyWhatsAppConsentSyncJob(job, { syncCustomer }, logger))
      .rejects.toBeInstanceOf(ShopifyConsentSyncRetryableError);
    expect(logger.warn).toHaveBeenCalledWith("shopify.whatsapp_consent.sync_job", {
      shopId: "shop-a", outcome: "retry", reasonCode: reason,
    });
  });

  it("logs unexpected provider error messages for development diagnostics", async () => {
    syncCustomer.mockRejectedValueOnce(new Error("secret customer phone +447400123456"));
    await expect(processShopifyWhatsAppConsentSyncJob(job, { syncCustomer }, logger))
      .rejects.toThrow("SYNC_EXCEPTION");
    expect(logger.warn.mock.lastCall?.[1].errorMessage).toContain("447400123456");
  });

  it.each([
    { ...job, schemaVersion: 2 },
    { ...job, shopifyCustomerId: "gid://shopify/Customer/9007199254740995" },
    { ...job, shopifyCustomerId: "9007199254740995", consent: "SUBSCRIBED" },
    { ...job, shopifyCustomerId: "+447400123456" },
    { ...job, shopId: "" },
    { ...job, triggeredAt: "yesterday" },
    { ...job, deliveryId: "" },
  ])("rejects invalid/smuggled schema before any sync or side effect: %s", async (invalid) => {
    await expect(processShopifyWhatsAppConsentSyncJob(invalid, { syncCustomer }, logger))
      .rejects.toThrow("Invalid Shopify WhatsApp consent-sync job schema");
    expect(syncCustomer).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
