import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  CheckoutRecoveryLifetimePolicyUnavailableError,
  isCheckoutRecoveryWithinLifetime,
  PersistedCheckoutRecoveryLifetimeReader,
  type CheckoutRecoveryLifetimeReader,
} from "../recovery-lifetime/checkout-recovery-lifetime.js";
import type { VerifiedWrapperContext, WrapperReadPort, WrapperSlot, WrapperVariable } from "./contracts.js";

export type WrapperReadDatabase = Pick<PrismaClient,
  "conversation" | "whatsAppConversationWrapperActiveSlot" | "backgroundRuntimeConfig">;

const defaultLogger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

const SHOP_BRAND_FIELDS = [
  "brandName", "logoUrl", "logoAltText", "logoWidth", "logoHeight",
  "squareLogoUrl", "squareLogoAltText", "coverImageUrl",
] as const;

/** Reject all C0 and DEL controls in a stored URL. */
function hasUrlControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function trustedHttpsUrl(value: string | null | undefined, shopDomain?: string): string | null {
  if (!value || value.length > 2048 || hasUrlControl(value)) return null;
  if (!URL.canParse(value)) return null;
  const uri = new URL(value);
  if (uri.protocol !== "https:" || !uri.hostname.includes(".") ||
      uri.hostname.endsWith(".invalid") || uri.username || uri.password) return null;
  if (shopDomain) {
    const domainUrl = URL.canParse(shopDomain) ? shopDomain : `https://${shopDomain}`;
    if (!URL.canParse(domainUrl) || new URL(domainUrl).hostname.toLowerCase() !== uri.hostname.toLowerCase()) {
      // A valid URL is not by itself proof it is this merchant's checkout.
      return null;
    }
  }
  return uri.href;
}

/** Actual database relationships, not a caller-supplied customer/shop URL. */
export class PrismaConversationWrapperReadRepository implements WrapperReadPort {
  constructor(
    private readonly db: WrapperReadDatabase = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly lifetimeReader: CheckoutRecoveryLifetimeReader = new PersistedCheckoutRecoveryLifetimeReader(db),
    private readonly logger: StructuredLogger = defaultLogger,
  ) {}

  async loadContext(conversationId: string): Promise<VerifiedWrapperContext | "TENANT_MISMATCH" | null> {
    const shopFields = {
      id: true, domain: true, status: true, defaultLanguageTag: true,
      brand: { select: {
        brandName: true, logoUrl: true, logoAltText: true, logoWidth: true,
        logoHeight: true, squareLogoUrl: true, squareLogoAltText: true, coverImageUrl: true,
      } },
    } as const;
    const customerFields = { id: true, shopId: true, firstName: true } as const;
    const conversation = await this.db.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true, shopId: true, customerId: true, languageTag: true,
        shop: { select: shopFields }, customer: { select: customerFields },
        checkoutRecovery: { select: {
          id: true, shopId: true, customerId: true, checkoutUrl: true, status: true,
          expiredAt: true, lastExternalActivityAt: true,
          shop: { select: shopFields }, customer: { select: customerFields },
        } },
      },
    });
    if (!conversation) return null;
    const recovery = conversation.checkoutRecovery;
    const shop = conversation.shop ?? recovery?.shop;
    const customer = conversation.customer ?? recovery?.customer;
    if (!shop || shop.status !== "ACTIVE") return null;
    if ((conversation.shopId && conversation.shopId !== shop.id) ||
        (recovery && recovery.shopId !== shop.id) ||
        (conversation.customerId && conversation.customerId !== customer?.id) ||
        (customer && customer.shopId !== shop.id) ||
        (recovery?.customerId && recovery.customerId !== customer?.id) ||
        (conversation.customerId && recovery?.customerId && conversation.customerId !== recovery.customerId)) {
      return "TENANT_MISMATCH";
    }
    const variables: Partial<Record<WrapperVariable, string>> = {};
    if (customer?.firstName?.trim()) variables["customer.firstName"] = customer.firstName;
    const brand = shop.brand;
    // Merchant display name comes from this exact shop's Brand record.
    if (brand?.brandName?.trim()) variables["shop.name"] = brand.brandName;
    if (brand) for (const key of SHOP_BRAND_FIELDS) {
      const value = brand[key];
      if (value === null || value === undefined || String(value).trim() === "") continue;
      if (key.endsWith("Url") && !trustedHttpsUrl(String(value))) continue;
      variables[`shopBrand.${key}` as WrapperVariable] = String(value);
    }
    const current = this.now();
    const checkoutCandidate = Boolean(recovery && ["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(recovery.status) &&
      (!recovery.expiredAt || recovery.expiredAt > current) &&
      // A linked conversation is scoped to exactly this recovery; if both have
      // customer identity, they must match (checked above).
      (!conversation.customerId || conversation.customerId === recovery.customerId));
    let checkoutRecoveryLifetimeDays: number | null = null;
    if (checkoutCandidate) {
      try {
        checkoutRecoveryLifetimeDays = await this.lifetimeReader.read();
      } catch (error) {
        if (error instanceof CheckoutRecoveryLifetimePolicyUnavailableError) {
          this.logger.warn("conversation_wrapper.checkout_lifetime.unavailable", {
            conversationId, shopId: shop.id, recoveryId: recovery!.id, reason: error.reason,
          });
        } else {
          this.logger.error("conversation_wrapper.checkout_lifetime.read_failed", {
            conversationId, shopId: shop.id, recoveryId: recovery!.id,
            errorType: error instanceof Error ? error.name : "unknown", error,
          });
          throw error;
        }
      }
    }
    const checkoutActive = Boolean(checkoutCandidate && checkoutRecoveryLifetimeDays !== null &&
      isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: recovery!.lastExternalActivityAt,
        now: current, checkoutRecoveryLifetimeDays }));
    const checkoutUrl = checkoutActive ? trustedHttpsUrl(recovery?.checkoutUrl, shop.domain) : null;
    if (checkoutUrl) variables["checkout.url"] = checkoutUrl;
    return {
      conversationId, shopId: shop.id,
      conversationLanguageTag: conversation.languageTag,
      merchantLanguageTag: shop.defaultLanguageTag,
      variables, checkoutAvailable: checkoutUrl !== null,
    };
  }

  async loadSlots(): Promise<readonly WrapperSlot[]> {
    return this.db.whatsAppConversationWrapperActiveSlot.findMany({
      where: { audience: { in: ["SHARED", "AI", "HUMAN"] } },
      include: { definition: { include: { locales: true } } },
    });
  }
}
