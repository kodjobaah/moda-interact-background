import type { PrismaClient } from "@prisma/client";

import prisma from "../../lib/db.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { WooCheckoutRef } from "./contracts.js";
import type {
  WooRecoveryLookupPort,
  WooShopEligibilityPort,
} from "./woo-checkout-activity.service.js";

/** One indexed shop+checkout lookup, independent of BullMQ's index or job. */
export class WooExistingRecoveryRepository implements WooRecoveryLookupPort {
  constructor(private readonly database: Pick<PrismaClient, "checkoutRecovery"> = prisma) {}

  async findExisting(ref: WooCheckoutRef): Promise<{ id: string } | null> {
    return this.database.checkoutRecovery.findFirst({
      where: { shopId: ref.shopId, checkoutToken: ref.checkoutToken },
      orderBy: { generation: "asc" },
      select: { id: true },
    });
  }

  /** Preserve recovery status/attempt/billing and only advance observed activity.
   * A stale event must never roll back the durable activity timestamp. */
  async recordExternalActivity(ref: WooCheckoutRef, recoveryId: string, occurredAt: Date): Promise<void> {
    await this.database.checkoutRecovery.updateMany({
      where: {
        id: recoveryId,
        shopId: ref.shopId,
        checkoutToken: ref.checkoutToken,
        lastExternalActivityAt: { lt: occurredAt },
      },
      data: { lastExternalActivityAt: occurredAt },
    });
  }
}

/** No event-supplied domain, installation ID or Woo URL is trusted here. */
export class WooShopEligibilityRepository implements WooShopEligibilityPort {
  constructor(private readonly database: Pick<PrismaClient, "shop"> = prisma) {}

  async evaluate(shopId: string): Promise<
    { allowed: true; shopDomain: string } | { allowed: false; reason: string }
  > {
    const shop = await this.database.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        domain: true,
        status: true,
        platform: true,
        shopifyShopId: true,
        onboardingCompleted: true,
        subscription: { select: { status: true, lastProviderLifecycleState: true } },
        wooCommerceInstallation: { select: { status: true, revokedAt: true } },
      },
    });
    if (!shop || shop.platform !== "WOOCOMMERCE" || shop.shopifyShopId !== null ||
      shop.status !== "ACTIVE" || !shop.onboardingCompleted) {
      return { allowed: false, reason: "woo_shop_unavailable" };
    }
    if (!shop.wooCommerceInstallation || shop.wooCommerceInstallation.status !== "ACTIVE" ||
      shop.wooCommerceInstallation.revokedAt !== null) {
      return { allowed: false, reason: "woo_installation_unavailable" };
    }
    const eligibility = shopExecutionEligibilityService.evaluateResolvedShop(shop, "recovery");
    return eligibility.allowed
      ? { allowed: true, shopDomain: shop.domain }
      : { allowed: false, reason: eligibility.reason };
  }
}
