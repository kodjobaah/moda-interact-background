import type {
  BrandMediaResolver, BrandMediaRole, MediaApprovedHosts, RecoveryTemplatePreparationInput,
  ShopBrandRow, TemplateUnavailableReason,
} from "./recovery-template.types.js";
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
  | "offer.code" | "offer.description";

export function isSemanticKey(value: unknown): value is SemanticKey {
  return typeof value === "string" && (
    BRAND_KEYS.some((key) => key === value) ||
    ["customer.firstName", "shop.name", "shop.categoryName", "checkout.url", "checkout.itemsSummary", "offer.code", "offer.description"].includes(value)
  );
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
  ) {}

  private brand(): Promise<ShopBrandRow | null> {
    this.brandRead ??= this.readBrand(this.input.shopId);
    return this.brandRead;
  }

  checkout(): string {
    const checkout = this.input.checkout;
    const now = this.clock();
    if (!checkout || !checkout.url || checkout.shopId !== this.input.shopId ||
        !isCheckoutRecoveryWithinLifetime({
          lastExternalActivityAt: checkout.lastExternalActivityAt,
          now,
          checkoutRecoveryLifetimeDays: checkout.checkoutRecoveryLifetimeDays,
        }) ||
        (checkout.expiresAt !== null &&
          (!(checkout.expiresAt instanceof Date) || checkout.expiresAt.getTime() <= now.getTime()))) {
      throw new BindingUnavailable("CHECKOUT_UNAVAILABLE");
    }
    const allowed = checkout.approvedHosts;
    if (!Array.isArray(allowed) || !allowed.length ||
        !allowed.every((host) => typeof host === "string" && host === host.toLowerCase()) ||
        !validHttps(checkout.url, allowed)) {
      throw new BindingUnavailable("CHECKOUT_UNTRUSTED");
    }
    return checkout.url;
  }

  /** URL-button prefix must come from immutable Meta components, never caller input. */
  encodeCheckoutButtonSuffix(approvedPrefix: string): string {
    const fullUrl = this.checkout();
    const approvedHosts = this.input.checkout!.approvedHosts;
    if (!approvedPrefix || !/[/?=&]$/.test(approvedPrefix) ||
        !validHttps(approvedPrefix, approvedHosts) ||
        approvedPrefix.includes("{{") || approvedPrefix.includes("}}") ||
        approvedPrefix.includes(encodeURIComponent(fullUrl)) ||
        approvedPrefix.length > 1900) {
      throw new BindingUnavailable("CHECKOUT_UNTRUSTED");
    }
    const suffix = encodeURIComponent(fullUrl);
    // Check the fully reconstructed provider URL without exposing it in logs.
    if (!validHttps(approvedPrefix + suffix, approvedHosts)) {
      throw new BindingUnavailable("CHECKOUT_UNTRUSTED");
    }
    return suffix;
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

  async imageHeader(role: BrandMediaRole): Promise<string> {
    // The role is frozen by Admin in parameterBindingsSnapshot, not guessed
    // from an original merchant URL, another field or caller preference.
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
      case "checkout.itemsSummary": {
        const items = this.input.checkoutItems;
        if (!items || items.shopId !== this.input.shopId) {
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
}
