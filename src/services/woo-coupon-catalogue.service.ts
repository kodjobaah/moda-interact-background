import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import { normalizeWooCoupons, type NormalizedWooCoupon } from "../providers/woo-coupon-normalization.js";
import { WooCouponReadError } from "../providers/woo-coupon-transport.js";
import { WooCouponReaderService } from "./woo-coupon-reader.service.js";
import { loadWooCouponSyncConfig, type WooCouponSyncConfig } from "./woo-coupon-sync-config.js";

const ERROR_CODE_LENGTH = 128;
// A complete bounded scan may contain up to 5,000 coupons. Prisma's default
// five-second interactive transaction timeout is too short for the atomic write.
const WRITE_TRANSACTION_TIMEOUT_MS = 120_000;

type WooCatalogueDatabase = Pick<PrismaClient, "$transaction">;
type ScanResult = "current" | "unavailable" | "superseded" | "already-running";
type Claim = { token: string; generation: number };

/**
 * Per-shop catalogue reconciliation only. No scheduler, queue, or entrypoint wiring.
 * Provider I/O and normalisation finish before the fenced atomic write transaction.
 */
export class WooCouponCatalogueService {
  constructor(
    private readonly database: WooCatalogueDatabase = prisma,
    private readonly read: (shopId: string) => Promise<Record<string, unknown>[]> =
      (shopId) => new WooCouponReaderService().fetchAll(shopId),
    private readonly clock: () => Date = () => new Date(),
    private readonly settings: WooCouponSyncConfig = loadWooCouponSyncConfig(),
  ) {}

  async reconcile(shopId: string, requestedAt: Date): Promise<ScanResult> {
    if (!shopId || !(requestedAt instanceof Date) || !Number.isFinite(requestedAt.getTime())) {
      throw new RangeError("Invalid Woo coupon synchronisation request");
    }
    const claim = await this.database.$transaction(async (tx) => {
      const catalogue = await this.lock(tx, shopId);
      if (!catalogue) return null;
      if (!(await this.isEligible(tx, shopId))) return null;
      if (catalogue.syncRequestedAt && catalogue.syncRequestedAt > requestedAt) return null;
      if (catalogue.lastSuccessfulSyncAt && catalogue.lastSuccessfulSyncAt >= requestedAt) return null;
      const now = this.clock();
      if (catalogue.status === "SYNCING" && catalogue.syncStartedAt &&
          now.getTime() - catalogue.syncStartedAt.getTime() < this.settings.staleScanMinutes * 60_000) {
        return "already-running" as const;
      }
      const token = randomUUID();
      const generation = catalogue.syncGeneration + 1;
      await tx.shopifyDiscountCatalogue.update({
        where: { shopId },
        data: {
          status: "SYNCING", syncGeneration: generation, activeSyncToken: token,
          syncStartedAt: now, lastErrorAt: null, lastErrorCode: null,
        },
      });
      return { token, generation } satisfies Claim;
    });
    if (!claim) return "unavailable";
    if (claim === "already-running") return claim;

    try {
      // Reader requires a current grant before and after the entire paginated read.
      // Any incomplete page or invalid coupon prevents all catalogue writes.
      const observed = normalizeWooCoupons(await this.read(shopId), this.clock());
      return await this.database.$transaction(async (tx) => {
        const catalogue = await this.lock(tx, shopId);
        if (!catalogue || catalogue.activeSyncToken !== claim.token ||
            catalogue.syncGeneration !== claim.generation || catalogue.status !== "SYNCING") {
          return "superseded" as const;
        }
        if (!(await this.isEligible(tx, shopId))) {
          await this.markUnavailable(tx, shopId, this.clock(), "shop_unavailable");
          return "unavailable" as const;
        }
        // The credential grant may have been revoked after the Reader's post-read check.
        if (!(await this.hasCurrentReadGrant(tx, shopId))) {
          await this.markUnavailable(tx, shopId, this.clock(), "grant_missing");
          return "unavailable" as const;
        }
        const now = this.clock();
        await this.upsertObserved(tx, shopId, claim.generation, observed, now);
        // Confirm removal only after TWO consecutive verified complete scans
        // have missed the coupon. Both timestamps are written with the same
        // clock value on a successful observed generation; failed scans do not
        // advance lastSuccessfulSyncAt, even though they increment generation.
        // Therefore generation arithmetic alone would wrongly count failures.
        // On the first absence, retain status, FK/history and merchant selection.
        const previousSuccess = catalogue.lastSuccessfulSyncAt;
        if (previousSuccess !== null) {
          const confirmedMissing = {
            shopId,
            lastSeenSyncGeneration: { not: claim.generation },
            lastSyncedAt: { lt: previousSuccess },
          };
          await tx.shopifyDiscount.updateMany({
            where: confirmedMissing,
            data: { providerStatus: "REMOVED", fixedSelectable: false },
          });
          await tx.shopifyDiscount.updateMany({
            where: { ...confirmedMissing, unavailableAt: null },
            data: { unavailableAt: now },
          });
        }
        // isAvailable is deliberately never written during reconciliation:
        // on WooCommerce it records the merchant's saved checkbox selection.
        await tx.shopifyDiscountCatalogue.update({
          where: { shopId },
          data: {
            status: "CURRENT", activeSyncToken: null, syncStartedAt: null,
            lastSuccessfulSyncAt: now, lastErrorAt: null, lastErrorCode: null, unavailableAt: null,
          },
        });
        return "current" as const;
      }, { timeout: WRITE_TRANSACTION_TIMEOUT_MS });
    } catch (error) {
      // A stale worker must not change a new owner's error/current state.
      await this.database.$transaction(async (tx) => {
        const catalogue = await this.lock(tx, shopId);
        if (!catalogue || catalogue.activeSyncToken !== claim.token ||
            catalogue.syncGeneration !== claim.generation) return;
        const code = error instanceof WooCouponReadError ? error.code : "woo_coupon_sync_error";
        const denied = code === "grant_missing" || code === "shop_unavailable" ||
          code === "grant_unavailable" || code === "grant_changed";
        await tx.shopifyDiscountCatalogue.update({
          where: { shopId },
          data: {
            status: denied ? "UNAVAILABLE" : "ERROR", activeSyncToken: null,
            syncStartedAt: null, lastErrorAt: this.clock(), lastErrorCode: code.slice(0, ERROR_CODE_LENGTH),
            ...(denied ? { unavailableAt: this.clock() } : {}),
          },
        });
      });
      if (error instanceof WooCouponReadError &&
          ["grant_missing", "shop_unavailable", "grant_unavailable", "grant_changed"].includes(error.code)) {
        return "unavailable";
      }
      throw error;
    }
  }

  private async lock(tx: Prisma.TransactionClient, shopId: string) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "shopify"."ShopifyDiscountCatalogue"
      WHERE "shopId" = ${shopId} FOR UPDATE
    `);
    return tx.shopifyDiscountCatalogue.findUnique({ where: { shopId } });
  }

  private async isEligible(tx: Prisma.TransactionClient, shopId: string): Promise<boolean> {
    const shop = await tx.shop.findUnique({
      where: { id: shopId }, select: { status: true, platform: true, shopifyShopId: true },
    });
    const installation = await tx.wooCommerceInstallation.findUnique({
      where: { shopId }, select: { status: true, revokedAt: true },
    });
    return shop?.status === "ACTIVE" && shop.platform === "WOOCOMMERCE" &&
      shop.shopifyShopId === null && installation?.status === "ACTIVE" &&
      installation.revokedAt === null;
  }

  private async hasCurrentReadGrant(tx: Prisma.TransactionClient, shopId: string): Promise<boolean> {
    const installation = await tx.wooCommerceInstallation.findUnique({
      where: { shopId }, select: {
        id: true, credentialVersion: true,
        restReadGrant: { select: {
          shopId: true, installationId: true, status: true, revokedAt: true, invalidatedAt: true,
          authorizedScope: true, credentialVersionSnapshot: true,
        } },
      },
    });
    const grant = installation?.restReadGrant;
    return !!grant && grant.shopId === shopId && grant.installationId === installation.id &&
      grant.status === "ACTIVE" && grant.revokedAt === null && grant.invalidatedAt === null &&
      grant.authorizedScope === "read" && grant.credentialVersionSnapshot === installation.credentialVersion;
  }

  private async markUnavailable(tx: Prisma.TransactionClient, shopId: string, now: Date, reason: string) {
    await tx.shopifyDiscountCatalogue.update({
      where: { shopId },
      data: {
        status: "UNAVAILABLE", activeSyncToken: null, syncStartedAt: null,
        unavailableAt: now, lastErrorAt: now, lastErrorCode: reason,
      },
    });
  }

  private async upsertObserved(
    tx: Prisma.TransactionClient, shopId: string, generation: number,
    observed: NormalizedWooCoupon[], now: Date,
  ): Promise<void> {
    for (const coupon of observed) {
      const { providerSnapshot, ...fields } = coupon;
      await tx.shopifyDiscount.upsert({
        where: { shopId_shopifyDiscountNodeId: { shopId, shopifyDiscountNodeId: coupon.shopifyDiscountNodeId } },
        create: {
          shopId, ...fields, providerSnapshot: providerSnapshot as Prisma.InputJsonValue,
          isAvailable: false, unavailableAt: null, lastSeenSyncGeneration: generation, lastSyncedAt: now,
        },
        update: {
          ...fields, providerSnapshot: providerSnapshot as Prisma.InputJsonValue,
          unavailableAt: null, lastSeenSyncGeneration: generation, lastSyncedAt: now,
          // isAvailable intentionally omitted: preserve merchant selection.
        },
      });
    }
  }
}
