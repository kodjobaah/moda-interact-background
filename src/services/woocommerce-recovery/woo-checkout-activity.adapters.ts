import type { CheckoutRecoveryStatus, Prisma, PrismaClient } from "@prisma/client";

import prisma from "../../lib/db.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { WooCheckoutRef } from "./contracts.js";
import type {
  WooRecoveryLookupPort,
  WooShopEligibilityPort,
} from "./woo-checkout-activity.service.js";

export type WooLatestRecovery = Readonly<{
  id: string;
  generation: number;
  status: CheckoutRecoveryStatus;
  lastExternalActivityAt: Date;
  resumption: Readonly<{ eventId: string; nextGeneration: number }> | null;
  admissionEventId: string | null;
}>;

/** One indexed shop+checkout lookup, independent of BullMQ's index or job. */
export class WooExistingRecoveryRepository implements WooRecoveryLookupPort {
  constructor(private readonly database: Pick<PrismaClient, "checkoutRecovery" | "$transaction"> = prisma) {}

  async findExisting(ref: WooCheckoutRef): Promise<WooLatestRecovery | null> {
    const row = await this.database.checkoutRecovery.findFirst({
      where: { shopId: ref.shopId, checkoutToken: ref.checkoutToken },
      orderBy: [{ generation: "desc" }, { id: "desc" }],
      select: {
        id: true, generation: true, status: true, lastExternalActivityAt: true,
        statusHistory: {
          where: { OR: [
            { reason: "CHECKOUT_RESUMED", source: "woocommerce.checkout" },
            { toStatus: "DETECTED" },
          ] },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: 8,
          select: { reason: true, toStatus: true, metadata: true },
        },
      },
    });
    if (!row) return null;
    let resumption: WooLatestRecovery["resumption"] = null;
    let admissionEventId: string | null = null;
    for (const history of row.statusHistory) {
      const metadata = history.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
      const value = metadata as Record<string, unknown>;
      if (history.reason === "CHECKOUT_RESUMED" && resumption === null &&
        typeof value.eventId === "string" && Number.isSafeInteger(value.nextGeneration) &&
        value.nextGeneration === row.generation + 1) {
        resumption = { eventId: value.eventId, nextGeneration: value.nextGeneration as number };
      }
      if (history.toStatus === "DETECTED" && admissionEventId === null && typeof value.lastEventId === "string") {
        admissionEventId = value.lastEventId;
      }
    }
    const { statusHistory: _statusHistory, ...recovery } = row;
    return { ...recovery, resumption, admissionEventId };
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

  /** Atomic status CAS and history write; Redis publication is deliberately outside. */
  async closeForResumption(input: {
    ref: WooCheckoutRef;
    recovery: WooLatestRecovery;
    occurredAt: Date;
    eventId: string;
    nextGeneration: number;
  }): Promise<boolean> {
    const statuses: CheckoutRecoveryStatus[] = ["DETECTED", "MESSAGE_SENT", "ENGAGED"];
    return this.database.$transaction(async (tx: Prisma.TransactionClient) => {
      const changed = await tx.checkoutRecovery.updateMany({
        where: {
          id: input.recovery.id, shopId: input.ref.shopId,
          checkoutToken: input.ref.checkoutToken, generation: input.recovery.generation,
          status: { in: statuses }, lastExternalActivityAt: { lt: input.occurredAt },
        },
        data: { status: "CANCELLED", lastExternalActivityAt: input.occurredAt },
      });
      if (changed.count !== 1) return false;
      await tx.checkoutRecoveryStatusHistory.create({ data: {
        checkoutRecoveryId: input.recovery.id,
        fromStatus: input.recovery.status,
        toStatus: "CANCELLED",
        source: "woocommerce.checkout",
        reason: "CHECKOUT_RESUMED",
        metadata: { eventId: input.eventId, nextGeneration: input.nextGeneration },
      } });
      return true;
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
