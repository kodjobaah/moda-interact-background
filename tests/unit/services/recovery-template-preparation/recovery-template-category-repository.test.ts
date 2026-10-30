import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaRecoveryTemplateRepository } from "../../../../src/services/recovery-template-preparation/recovery-template-repository.js";

describe("active taxonomy category read for WhatsApp recovery templates", () => {
  it("scopes lookup to the sending shop and uses the selected published language", async () => {
    const findUnique = vi.fn(async () => ({
      activeCategory: {
        enabled: true,
        displayName: "Outdoor gear",
        translations: [{ displayName: "Équipement de plein air" }],
      },
    }));
    const db = { commerceShopProfile: { findUnique } } as unknown as Pick<PrismaClient,
      "shop" | "whatsAppTemplateVariant" | "shopBrand" | "commerceShopProfile">;
    const repo = new PrismaRecoveryTemplateRepository(db);
    expect(await repo.readShopCategory("shop-one", "fr")).toBe("Équipement de plein air");
    expect(findUnique).toHaveBeenCalledWith({
      where: { shopId: "shop-one" },
      select: { activeCategory: { select: {
        enabled: true, displayName: true,
        translations: { where: { locale: "fr" }, select: { displayName: true }, take: 1 },
      } } },
    });
    expect(await repo.readShopCategory("shop-one", "en")).toBe("Outdoor gear");
  });

  it("refuses inactive categories and untranslated non-English values", async () => {
    let active = false;
    const findUnique = vi.fn(async () => ({ activeCategory: {
      enabled: active, displayName: "Fashion", translations: [],
    } }));
    const db = { commerceShopProfile: { findUnique } } as unknown as Pick<PrismaClient,
      "shop" | "whatsAppTemplateVariant" | "shopBrand" | "commerceShopProfile">;
    const repo = new PrismaRecoveryTemplateRepository(db);
    expect(await repo.readShopCategory("shop-one", "en")).toBeNull();
    active = true;
    expect(await repo.readShopCategory("shop-one", "fr")).toBeNull();
  });
});
