/** ARCH-049 BG004: read-only, tenant-scoped send-time derivative references. */
export const SHOP_BRAND_MEDIA_ROLES = ["LOGO", "SQUARE_LOGO", "COVER_IMAGE"] as const;
export type ShopBrandMediaRole = typeof SHOP_BRAND_MEDIA_ROLES[number];

export function isShopBrandMediaRole(value: unknown): value is ShopBrandMediaRole {
  return typeof value === "string" && SHOP_BRAND_MEDIA_ROLES.some((role) => role === value);
}

export type ShopBrandMediaRecord = Readonly<{
  shopId: string;
  domain: string;
  whatsAppMedia: unknown;
}>;

export interface ShopBrandMediaReader {
  readForShop(shopId: string): Promise<ShopBrandMediaRecord | null>;
}
