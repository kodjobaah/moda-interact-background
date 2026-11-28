import { describe, expect, it, vi } from "vitest";

import { resolveShopifyUsageEventMapping } from "../../../../src/services/billing-reconciliation/shopify-usage-event-mapping.js";

function transaction(
  catalogue: { usageEvents: Array<{ eventHandle: string }> } | null,
) {
  return {
    merchantPricingPlan: {
      findUnique: vi.fn().mockResolvedValue(catalogue),
    },
  };
}

describe("resolveShopifyUsageEventMapping", () => {
  it("maps exact provider handles and returns unmatched handles in deterministic order", async () => {
    const tx = transaction({
      usageEvents: [{ eventHandle: "event-b" }, { eventHandle: "event-a" }],
    });

    const result = await resolveShopifyUsageEventMapping(
      tx as never,
      "paid-2026",
      ["event-b", "unmapped-z", "event-a", "unmapped-a", "event-b"],
    );

    expect(tx.merchantPricingPlan.findUnique).toHaveBeenCalledWith({
      where: { shopifyPlanHandle: "paid-2026" },
      select: { usageEvents: { select: { eventHandle: true } } },
    });
    expect(result).toEqual({
      mappedProviderHandles: ["event-a", "event-b"],
      unmappedProviderHandles: ["unmapped-a", "unmapped-z"],
    });
  });

  it("treats every provider handle as unmapped when no exact catalogue plan exists", async () => {
    const tx = transaction(null);

    await expect(
      resolveShopifyUsageEventMapping(tx as never, "unknown-plan", [
        "event-b",
        "event-a",
      ]),
    ).resolves.toEqual({
      mappedProviderHandles: [],
      unmappedProviderHandles: ["event-a", "event-b"],
    });
  });

  it("does not query the catalogue for an empty provider handle list", async () => {
    const tx = transaction({ usageEvents: [{ eventHandle: "event-a" }] });

    await expect(
      resolveShopifyUsageEventMapping(tx as never, "paid-2026", []),
    ).resolves.toEqual({
      mappedProviderHandles: [],
      unmappedProviderHandles: [],
    });
    expect(tx.merchantPricingPlan.findUnique).not.toHaveBeenCalled();
  });

  it("returns no unmapped handles when every provider event has an exact catalogue match", async () => {
    const tx = transaction({
      usageEvents: [
        { eventHandle: "bronze" },
        { eventHandle: "silver" },
        { eventHandle: "gold" },
      ],
    });

    await expect(
      resolveShopifyUsageEventMapping(tx as never, "paid-2026", [
        "bronze",
        "silver",
        "gold",
      ]),
    ).resolves.toEqual({
      mappedProviderHandles: ["bronze", "gold", "silver"],
      unmappedProviderHandles: [],
    });
  });

  it("returns only provider-returned events that lack exact catalogue entries", async () => {
    const tx = transaction({
      usageEvents: [{ eventHandle: "bronze" }, { eventHandle: "silver" }],
    });

    await expect(
      resolveShopifyUsageEventMapping(tx as never, "paid-2026", [
        "bronze",
        "silver",
        "gold",
      ]),
    ).resolves.toEqual({
      mappedProviderHandles: ["bronze", "silver"],
      unmappedProviderHandles: ["gold"],
    });
  });

  it("ignores catalogue-only events that Shopify did not return", async () => {
    const tx = transaction({
      usageEvents: [
        { eventHandle: "bronze" },
        { eventHandle: "silver" },
        { eventHandle: "gold" },
      ],
    });

    await expect(
      resolveShopifyUsageEventMapping(tx as never, "paid-2026", ["bronze"]),
    ).resolves.toEqual({
      mappedProviderHandles: ["bronze"],
      unmappedProviderHandles: [],
    });
  });

  it("returns all provider handles as unmapped when a catalogue plan has no usage events", async () => {
    const tx = transaction({ usageEvents: [] });

    await expect(
      resolveShopifyUsageEventMapping(tx as never, "paid-2026", [
        "bronze",
        "silver",
      ]),
    ).resolves.toEqual({
      mappedProviderHandles: [],
      unmappedProviderHandles: ["bronze", "silver"],
    });
  });

  it("propagates the original catalogue database error without replacing its message", async () => {
    const originalError = new Error("Prisma MerchantPricingPlan lookup failed");
    const tx = transaction(null);
    tx.merchantPricingPlan.findUnique.mockRejectedValue(originalError);

    await expect(
      resolveShopifyUsageEventMapping(tx as never, "paid-2026", ["bronze"]),
    ).rejects.toBe(originalError);
  });

  it("does not normalize provider or catalogue handles", async () => {
    const tx = transaction({
      usageEvents: [{ eventHandle: "Recovery-Meter" }],
    });

    await expect(
      resolveShopifyUsageEventMapping(tx as never, "paid-2026", [
        "recovery-meter",
        " Recovery-Meter ",
      ]),
    ).resolves.toEqual({
      mappedProviderHandles: [],
      unmappedProviderHandles: [" Recovery-Meter ", "recovery-meter"],
    });
  });
});
