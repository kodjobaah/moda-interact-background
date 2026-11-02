import type {
  BrandMediaResolver, BrandMediaRole, MediaApprovedHosts, RecoveryTemplatePreparationInput,
  RecoveryTemplateHeaderMediaRole,
  ShopBrandRow, SourceBoundPromotionalProduct, TemplateUnavailableReason,
} from "./recovery-template.types.js";
import { isIP } from "node:net";
import { isCheckoutRecoveryWithinLifetime } from "../recovery-lifetime/checkout-recovery-lifetime.js";
import { formatCheckoutItemsSummary } from "./recovery-template-items-summary.js";

export class BindingUnavailable extends Error {
  constructor(readonly reason: TemplateUnavailableReason) {
    super(reason);
    this.name = "BindingUnavailable";
  }
}

const BRAND_TEXT_KEYS = [
  "shopBrand.brandName", "shopBrand.logoAltText", "shopBrand.logoWidth",
  "shopBrand.logoHeight", "shopBrand.squareLogoAltText",
] as const;
const BRAND_URL_KEYS = [
  "shopBrand.logoUrl", "shopBrand.squareLogoUrl", "shopBrand.coverImageUrl",
] as const;
export const BRAND_KEYS = [...BRAND_TEXT_KEYS, ...BRAND_URL_KEYS] as const;

export type SemanticKey =
  | (typeof BRAND_KEYS)[number]
  | "customer.firstName" | "shop.name" | "shop.categoryName" | "checkout.url" | "checkout.itemsSummary"
  | "offer.code" | "offer.description" | "offer.codes"
  | "promotion.productName" | "promotion.productUrl" | "promotion.offerDescription" | "promotion.code";

export function isSemanticKey(value: unknown): value is SemanticKey {
  return typeof value === "string" && (
    BRAND_KEYS.some((key) => key === value) ||
    ["customer.firstName", "shop.name", "shop.categoryName", "checkout.url", "checkout.itemsSummary",
      "offer.code", "offer.codes", "offer.description", "promotion.productName", "promotion.productUrl",
      "promotion.offerDescription", "promotion.code"].includes(value)
  );
}

function checkoutLineItemsAreSafe(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  const safeTitle = (candidate: unknown) => {
    if (typeof candidate !== "string") return false;
    const text = candidate.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (!text || text.length > 160 || /[\p{Cc}\p{Cf}{}]/u.test(text)) return false;
    try { encodeURIComponent(text); return true; } catch { return false; }
  };
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return safeTitle(item.title) && typeof item.quantity === "number" &&
      Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 99999 &&
      (item.variantTitle == null || safeTitle(item.variantTitle));
  });
}

function hasForbiddenControls(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f ||
      codePoint === 0x2028 || codePoint === 0x2029);
  });
}

function boundedText(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit ||
      hasForbiddenControls(value) || value.includes("{{") || value.includes("}}")) {
    throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
  }
  return value.trim();
}

function validHttps(value: string, hosts: readonly string[]): URL | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      !url.hostname.includes(".") || !hosts.includes(url.hostname.toLowerCase()) ||
      url.href.length > 2048) return null;
  return url;
}

/**
 * Resolve only frozen semantic bindings. The caller supplies checkout and offer
 * evidence from read-only commerce state. Every ShopBrand read is scoped to
 * shopId, cached per preparation, and never shared between shops.
 */
export class RecoveryVariableResolver {
  private brandRead: Promise<ShopBrandRow | null> | undefined;
  private categoryRead: Promise<string | null> | undefined;
  private readonly mediaReads = new Map<BrandMediaRole, Promise<string>>();

  constructor(
    private readonly input: RecoveryTemplatePreparationInput,
    private readonly readBrand: (shopId: string) => Promise<ShopBrandRow | null>,
    private readonly resolveMedia: BrandMediaResolver,
    private readonly mediaApprovedHosts: MediaApprovedHosts,
    private readonly clock: () => Date,
    private readonly readCategory: (shopId: string, languageTag: string) => Promise<string | null>,
    private readonly languageTag: string,
    private readonly readyProductImageUrl?: string,
    private readonly validateProductImageBeforeBinding?: () => Promise<boolean>,
  ) {}

  private brand(): Promise<ShopBrandRow | null> {
    this.brandRead ??= this.readBrand(this.input.shopId);
    return this.brandRead;
  }

  checkout(): string {
    const checkout = this.input.checkout;
    if (!checkout || checkout.shopId !== this.input.shopId ||
        !isCheckoutRecoveryWithinLifetime({
          lastExternalActivityAt: checkout.lastExternalActivityAt,
          now: this.clock(),
          checkoutRecoveryLifetimeDays: checkout.checkoutRecoveryLifetimeDays,
        })) throw new BindingUnavailable("CHECKOUT_UNAVAILABLE");
    return checkout.url;
  }

  /** URL-button prefix must come from immutable Meta components, never caller input. */
  encodeCheckoutButtonSuffix(_approvedPrefix: string): string {
    const fullUrl = this.checkout();
    return encodeURIComponent(fullUrl);
  }

  encodePromotionButtonSuffix(approvedPrefix: string): string {
    const product = this.promotionalProduct();
    if (!approvedPrefix || !/[/?=&]$/.test(approvedPrefix) || approvedPrefix.includes("{{") ||
        approvedPrefix.includes("}}") || approvedPrefix.length > 1900) {
      throw new BindingUnavailable("PROMOTION_PRODUCT_URL_UNAVAILABLE");
    }
    return encodeURIComponent(product.product.url!);
  }

  checkStaticButtonUrl(url: string): void {
    const checkout = this.input.checkout;
    // A static destination still needs to be owned by the authenticated shop.
    if (!checkout || checkout.shopId !== this.input.shopId ||
        !validHttps(url, checkout.approvedHosts)) {
      throw new BindingUnavailable("CHECKOUT_UNTRUSTED");
    }
  }

  private async readyMedia(role: BrandMediaRole): Promise<string> {
    let promise = this.mediaReads.get(role);
    if (!promise) {
      promise = (async () => {
        const media = await this.resolveMedia(this.input.shopId, role);
        const approvedHosts = typeof this.mediaApprovedHosts === "function"
          ? await this.mediaApprovedHosts() : this.mediaApprovedHosts;
        if (!media || media.status !== "READY" || media.kind !== "R2_DERIVATIVE" ||
            media.shopId !== this.input.shopId || media.role !== role ||
            !validHttps(media.httpsUrl, approvedHosts)) {
          throw new BindingUnavailable("MEDIA_NOT_READY");
        }
        return media.httpsUrl;
      })();
      this.mediaReads.set(role, promise);
    }
    return promise;
  }

  async imageHeader(role: RecoveryTemplateHeaderMediaRole): Promise<string> {
    // The role is frozen by Admin in parameterBindingsSnapshot, not guessed
    // from an original merchant URL, another field or caller preference.
    if (role === "CHECKOUT_PRODUCT") {
      if (!this.readyProductImageUrl || !this.validateProductImageBeforeBinding ||
          !(await this.validateProductImageBeforeBinding())) {
        throw new BindingUnavailable("MEDIA_NOT_READY");
      }
      return this.readyProductImageUrl;
    }
    return this.readyMedia(role);
  }

  async resolve(key: SemanticKey): Promise<string> {
    switch (key) {
      case "customer.firstName":
        return boundedText(this.input.customerFirstName, 200);
      case "shop.name":
        if (this.input.shopName?.shopId !== this.input.shopId) {
          throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        }
        // Prefer the sending shop's configured display name. The authenticated
        // shop domain remains a safe, tenant-scoped fallback (including Woo).
        try {
          const configuredName = (await this.brand())?.brandName;
          if (configuredName !== null && configuredName !== undefined) return boundedText(configuredName, 200);
        } catch (error) {
          if (!(error instanceof BindingUnavailable)) throw error;
        }
        return boundedText(this.input.shopName.value, 200);
      case "shop.categoryName":
        // Only the active category for this shop, resolved for the selected
        // provider-template language, is eligible. Missing data fails closed.
        this.categoryRead ??= this.readCategory(this.input.shopId, this.languageTag);
        return boundedText(await this.categoryRead, 200);
      case "checkout.url":
        return this.checkout();
      case "offer.codes": {
        const offer = this.input.verifiedOffer;
        if (this.input.offerPresentation !== "CODE_OFFER" || !offer?.verified ||
            offer.shopId !== this.input.shopId || !Array.isArray(offer.codes) ||
            offer.codes.length < 1 || offer.codes.length > 3) {
          throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        }
        return offer.codes.map((code) => boundedText(code, 100)).join(", ");
      }
      case "promotion.productName":
        return boundedText(this.promotionalProduct().product.title, 200);
      case "promotion.productUrl":
        return this.promotionalProduct().product.url!;
      case "promotion.offerDescription":
        return boundedText(this.input.verifiedOffer?.description, 200);
      case "promotion.code": {
        const offer = this.input.verifiedOffer;
        if (!offer?.verified || offer.shopId !== this.input.shopId || offer.kind !== "CODE_OFFER") {
          throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        }
        return boundedText(offer.code, 100);
      }
      case "checkout.itemsSummary": {
        const items = this.input.checkoutItems;
        if (!items || items.shopId !== this.input.shopId) {
          throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        }
        if (!checkoutLineItemsAreSafe(items.lineItems)) {
          throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        }
        return boundedText(formatCheckoutItemsSummary(items.lineItems, this.languageTag), 500);
      }
      case "offer.code":
      case "offer.description": {
        const offer = this.input.verifiedOffer;
        const now = this.clock().getTime();
        if (this.input.offerPresentation === "NO_OFFER" || !offer?.verified ||
            offer.shopId !== this.input.shopId ||
            offer.kind !== this.input.offerPresentation ||
            !(offer.verifiedAt instanceof Date) || offer.verifiedAt.getTime() > now ||
            (offer.expiresAt !== null &&
              (!(offer.expiresAt instanceof Date) || offer.expiresAt.getTime() <= now))) {
          throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        }
        if (key === "offer.code" && offer.kind !== "CODE_OFFER") {
          throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        }
        return boundedText(key === "offer.code" ? offer.code : offer.description, 200);
      }
      default: {
        if (BRAND_URL_KEYS.some((candidate) => candidate === key)) {
          // A text binding requesting a logo URL receives the verified derivative,
          // never the original ShopBrand URL. This is not an IMAGE header.
          const role: BrandMediaRole = key === "shopBrand.logoUrl" ? "LOGO" :
            key === "shopBrand.squareLogoUrl" ? "SQUARE_LOGO" : "COVER_IMAGE";
          return this.readyMedia(role);
        }
        const brand = await this.brand();
        if (!brand) throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
        const brandField = key.slice("shopBrand.".length) as keyof ShopBrandRow;
        const value = brand[brandField];
        if (key === "shopBrand.logoWidth" || key === "shopBrand.logoHeight") {
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 10000) {
            throw new BindingUnavailable("BINDING_VALUE_UNAVAILABLE");
          }
          return String(value);
        }
        return boundedText(value, 200);
      }
    }
  }

  private promotionalProduct(): SourceBoundPromotionalProduct {
    const source = this.input.promotionalProduct;
    if (this.input.promotionTarget !== "ALTERNATIVE_PRODUCT" || !source ||
        source.sourceTool !== "commerce_get_product" ||
        source.authenticatedShopId !== this.input.shopId || source.product.productId.trim() === "" ||
      (source.product.variantId !== null && source.product.variantId.trim() === "") ||
      !isSafePromotionalUrl(source.product.url)) {
      throw new BindingUnavailable("PROMOTION_PRODUCT_URL_UNAVAILABLE");
    }
    return source;
  }
}

function isSafePromotionalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 ||
  Array.from(value).some((character) => character.trim().length === 0 || hasForbiddenControls(character))) return false;
  try {
    const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
    if (!authority || authority.includes("@") || /:\d+$/.test(authority)) return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      !isIP(url.hostname) && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost") &&
      url.hostname.includes(".");
  } catch {
    return false;
  }
}
