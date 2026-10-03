import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAbandonedCheckout } from "../../../../src/domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../../../src/domain/pending-recovery-candidate.js";
import { RecoverySnapshotBuilderService } from "../../../../src/services/checkout-recovery/recovery-snapshot-builder.service.js";
import { resolveRecoveryInternationalContext } from "../../../../src/services/checkout-recovery/recovery-mappers.js";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    shop: {
      findUnique: vi.fn(async () => ({
        settings: {
          defaultLanguageTag: "pt-BR",
          defaultCountryCode: "BR",
          defaultTimeZone: "America/Sao_Paulo",
        },
      })),
    },
  },
}));

vi.mock("../../../../src/lib/db.js", () => ({
  default: prismaMock,
}));

const candidate: PendingRecoveryCandidate = {
  shopId: "shop-1",
  shopDomain: "merchant.myshopify.com",
  checkoutToken: "checkout-correlation",
  cartToken: "cart-correlation",
  abandonedCheckoutUrl: "https://stale.example/recover",
  checkoutCreatedAt: "2026-09-01T09:00:00.000Z",
  lastActivityAt: "2026-09-03T09:00:00.000Z",
  internationalContext: {
    languageTag: "fr-CA",
    languageSource: "shopify",
    countryCode: "CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
  },
};

const checkout: NormalizedAbandonedCheckout = {
  shopifyAbandonedCheckoutId: "diagnostic-only-id",
  abandonedCheckoutUrl: "https://current.example/recover",
  createdAt: "2026-09-02T09:00:00.000Z",
  completedAt: null,
  currencyCode: "GBP",
  totalPrice: "42.50",
  internationalContext: {
    languageTag: "de-DE",
    languageSource: null,
    countryCode: "GB",
    currencyCode: "GBP",
    timeZone: "Europe/London",
  },
  customer: {
    shopifyCustomerId: "current-customer",
    email: "current@example.com",
    phone: "+442071838750",
    firstName: "Current",
    lastName: "Customer",
  },
  lineItems: [
    {
      productId: "product-current",
      variantId: "variant-current",
      title: "Current product",
      variantTitle: "Current variant",
      sku: "CURRENT-SKU",
      quantity: 2,
      price: "21.25",
    },
  ],
};

describe("RecoverySnapshotBuilderService", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockClear();
    prismaMock.shop.findUnique.mockResolvedValue({
      settings: {
        defaultLanguageTag: "pt-BR",
        defaultCountryCode: "BR",
        defaultTimeZone: "America/Sao_Paulo",
      },
    });
  });

  it("builds the durable seed from current Shopify data and reads merchant defaults once", async () => {
    const builder = new RecoverySnapshotBuilderService();
    const staleCandidate = Object.assign({}, candidate, {
      currencyCode: "XXX",
      customer: {
        shopifyCustomerId: "stale-customer",
        email: "stale@example.com",
      },
      lineItems: [{ title: "Stale basket", quantity: 99 }],
      totalPrice: "999.00",
    });

    const seed = await builder.build(staleCandidate, candidate.shopDomain, checkout);

    expect(prismaMock.shop.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: candidate.shopId },
      select: {
        settings: {
          select: {
            defaultLanguageTag: true,
            defaultCountryCode: true,
            defaultTimeZone: true,
          },
        },
      },
    });
    expect(seed).toEqual({
      shop: candidate.shopDomain,
      checkoutToken: candidate.checkoutToken,
      cartToken: candidate.cartToken,
      detectedAt: checkout.createdAt,
      lastExternalActivityAt: candidate.lastActivityAt,
      currency: checkout.currencyCode,
      totalPrice: checkout.totalPrice,
      checkoutUrl: checkout.abandonedCheckoutUrl,
      completedAt: checkout.completedAt,
      internationalContext: {
        languageTag: "pt-BR",
        languageSource: "merchant-default",
        countryCode: "GB",
        currencyCode: "GBP",
        timeZone: "Europe/London",
      },
      customer: checkout.customer,
      lineItems: [
        {
          productId: "product-current",
          variantId: "variant-current",
          title: "Current product",
          variantTitle: "Current variant",
          sku: "CURRENT-SKU",
          quantity: 2,
          price: "21.25",
        },
      ],
    });
  });

  it("preserves event-before-merchant fallbacks and merchant-only language", () => {
    const resolved = resolveRecoveryInternationalContext(
      candidate,
      {
        ...checkout,
        internationalContext: {
          languageTag: "it-IT",
          languageSource: "shopify",
          countryCode: null,
          currencyCode: null,
          timeZone: null,
        },
      },
      {
        defaultLanguageTag: "en-GB",
        defaultCountryCode: "BR",
        defaultTimeZone: "America/Sao_Paulo",
      },
    );

    expect(resolved).toEqual({
      languageTag: "en-GB",
      languageSource: "merchant-default",
      countryCode: "CA",
      currencyCode: "CAD",
      timeZone: "America/Toronto",
    });
  });

  it("uses normalized merchant defaults only after current and event context", () => {
    const resolved = resolveRecoveryInternationalContext(
      { ...candidate, internationalContext: undefined },
      {
        ...checkout,
        internationalContext: {
          languageTag: null,
          languageSource: null,
          countryCode: null,
          currencyCode: null,
          timeZone: null,
        },
      },
      {
        defaultLanguageTag: "es-MX",
        defaultCountryCode: "MX",
        defaultTimeZone: "America/Mexico_City",
      },
    );

    expect(resolved).toEqual({
      languageTag: "es-MX",
      languageSource: "merchant-default",
      countryCode: "MX",
      currencyCode: null,
      timeZone: "America/Mexico_City",
    });
  });

  it("normalizes invalid merchant defaults to null without throwing", () => {
    const resolved = resolveRecoveryInternationalContext(
      { ...candidate, internationalContext: undefined },
      { ...checkout, internationalContext: null as unknown as NormalizedAbandonedCheckout["internationalContext"] },
      {
        defaultLanguageTag: "not a language tag",
        defaultCountryCode: "not-a-country",
        defaultTimeZone: "not/a-time-zone",
      },
    );

    expect(resolved).toEqual({
      languageTag: null,
      languageSource: null,
      countryCode: null,
      currencyCode: null,
      timeZone: null,
    });
  });

  it("preserves the candidate timestamp fallback and omits absent external activity", async () => {
    const builder = new RecoverySnapshotBuilderService();
    const noCurrentTimestamp = { ...checkout, createdAt: "" };
    const candidateTimestamp = {
      ...candidate,
      checkoutCreatedAt: "2026-09-01T09:00:00.000Z",
      lastActivityAt: undefined,
    };

    const seed = await builder.build(candidateTimestamp, candidate.shopDomain, noCurrentTimestamp);

    expect(seed.detectedAt).toBe(candidateTimestamp.checkoutCreatedAt);
    expect(seed).not.toHaveProperty("lastExternalActivityAt");
  });

  it("uses the current ISO timestamp only when both source timestamps are empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00.000Z"));
    const builder = new RecoverySnapshotBuilderService();

    try {
      const seed = await builder.build(
        { ...candidate, checkoutCreatedAt: null, lastActivityAt: undefined },
        candidate.shopDomain,
        { ...checkout, createdAt: "" },
      );

      expect(seed.detectedAt).toBe("2026-10-03T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes only the durable line-item fields", () => {
    const builder = new RecoverySnapshotBuilderService();

    expect(builder.serializeLineItems(checkout.lineItems)).toEqual([
      {
        productId: "product-current",
        variantId: "variant-current",
        title: "Current product",
        variantTitle: "Current variant",
        sku: "CURRENT-SKU",
        quantity: 2,
        price: "21.25",
      },
    ]);
  });
});