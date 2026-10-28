import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type {
  BrandClaim, BrandDocument, BrandOutcome, BrandRole, SourceObservation,
} from "./contracts.js";
import { BrandStateError } from "./contracts.js";
import { claimRole, completeClaim, failClaim, parseBrandDocument, updateObservedSource } from "./state.js";

export type ScannedBrandRow = { shopId: string; whatsAppMedia: unknown };
export type ShopBrandMediaDatabase = Pick<PrismaClient, "$transaction" | "shopBrand">;

/**
 * Atomic ShopBrand JSONB role updates. The only transaction spans one row-lock and one JSON write.
 * No fetch, image processing, R2 call, Redis publication or other external I/O is allowed in it.
 */
export class ShopBrandMediaRepository {
  constructor(
    private readonly database: ShopBrandMediaDatabase,
    private readonly logger: Pick<StructuredLogger, "warn" | "error">,
  ) {}

  async observeSource(observation: SourceObservation): Promise<{ changed: boolean; generation: number }> {
    return this.editLocked(observation.shopId, true, (current) => {
      const outcome = updateObservedSource(current, observation);
      return { document: outcome.document, value: {
        changed: outcome.changed, generation: outcome.document.roles[observation.role]!.source.generation,
      } };
    }).then((value) => {
      if (!value) throw new Error("SHOP_BRAND_SOURCE_ROW_MISSING");
      return value;
    });
  }

  async claim(shopId: string, role: BrandRole, at: Date = new Date()): Promise<BrandClaim | null> {
    const owner = randomUUID();
    return this.editLocked(shopId, false, (current) => {
      const { document, claim } = claimRole(current, shopId, role, owner, at);
      return { document, value: claim };
    });
  }

  async complete(claim: BrandClaim, result: BrandOutcome, at: Date = new Date()): Promise<boolean> {
    const outcome = await this.editLocked(claim.shopId, false, (current) => {
      const { document, applied } = completeClaim(current, claim, result, at);
      return { document, value: applied };
    });
    return outcome ?? false;
  }

  async fail(claim: BrandClaim, failureCode: string, retryable: boolean, at: Date = new Date()): Promise<boolean> {
    const outcome = await this.editLocked(claim.shopId, false, (current) => {
      const { document, applied } = failClaim(current, claim, failureCode, retryable, at);
      return { document, value: applied };
    });
    return outcome ?? false;
  }

  /** Keyset traversal over the existing unique shopId index; no full-table lock or OFFSET scan. */
  async listPage(afterShopId: string | null, limit: number): Promise<ScannedBrandRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("INVALID_MEDIA_SCAN_LIMIT");
    const rows = await this.database.shopBrand.findMany({
      where: afterShopId ? { shopId: { gt: afterShopId } } : {},
      orderBy: { shopId: "asc" }, take: limit,
      select: { shopId: true, whatsAppMedia: true },
    });
    return rows;
  }

  private async editLocked<T>(
    shopId: string, create: boolean,
    edit: (current: BrandDocument) => { document: BrandDocument; value: T },
  ): Promise<T | null> {
    // A competing first observation may race INSERT. Retry aborted SERIALIZABLE/deadlock/unique
    // transactions, never swallowing other DB errors or synthesising a row for a missing shop.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.database.$transaction(async (tx) => {
          if (create) {
            await tx.shopBrand.upsert({ where: { shopId }, create: { shopId }, update: {} });
          }
          const locked = await tx.$queryRaw<Array<{ whatsAppMedia: Prisma.JsonValue }>>(Prisma.sql`
            SELECT "whatsAppMedia" FROM "commerce"."ShopBrand"
            WHERE "shopId" = ${shopId}
            FOR UPDATE
          `);
          const row = locked[0];
          if (!row) return null;
          const current = parseBrandDocument(row.whatsAppMedia);
          const outcome = edit(current);
          if (outcome.document !== current) {
            await tx.shopBrand.update({ where: { shopId },
              data: { whatsAppMedia: outcome.document as unknown as Prisma.InputJsonValue } });
          }
          return outcome.value;
        }, { timeout: 10_000, maxWait: 5_000 });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? error.code : undefined;
        const retryable = code === "P2002" || code === "P2034";
        // Preserve the original Prisma failure message for development diagnosis.
        const fields = {
          shopId: /^[A-Za-z0-9_-]{1,128}$/.test(shopId) ? shopId : "INVALID_SHOP_ID",
          operation: create ? "observe_source" : "update_role",
          attempt, reasonCode: error instanceof BrandStateError ? error.code :
            retryable ? code : "PERSISTENCE_FAILURE",
          exceptionType: error instanceof BrandStateError ? "BrandStateError" :
            error instanceof Error ? "Error" : "NonErrorThrownValue",
          errorMessage: error instanceof Error ? error.message : String(error),
          error,
        };
        if (retryable && attempt < 3) {
          this.logger.warn("shop_brand.media.transaction_retry", fields);
          continue;
        }
        this.logger.error("shop_brand.media.transaction_failed", fields);
        throw error;
      }
    }
    throw new Error("SHOP_BRAND_TRANSACTION_RETRIES_EXHAUSTED");
  }
}
