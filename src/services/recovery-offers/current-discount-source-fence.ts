import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import prisma from "../../lib/db.js";

const FENCE_PREFIX = "ARCH052_DISCOUNT_SOURCE_FENCE_V1\0";
const MAX_SNAPSHOT_BYTES = 1_048_576;
const MAX_FENCE_BYTES = 4_194_304;
const MAX_READ_MS = 10_000;

export type DiscountSourceFence = Readonly<{
  shopId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE";
  syncGeneration: number;
  selectedOfferIds: readonly string[];
  snapshotDigest: string;
}>;

export type DiscountSourceFenceResult =
  | Readonly<{ kind: "AVAILABLE"; fence: DiscountSourceFence }>
  | Readonly<{ kind: "UNAVAILABLE"; reasonCode: string }>;

type FenceDatabase = Pick<PrismaClient, "$transaction">;
type FenceDependencies = Readonly<{
  database?: FenceDatabase;
  clock?: () => number;
}>;

type FenceInput = Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  selectedOfferIds: readonly string[];
  signal: AbortSignal;
}>;

function dateValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return undefined;
  return value.toISOString();
}

function validSnapshotRow(row: Record<string, unknown>, shopId: string, ids: readonly string[], generation: number): boolean {
  return typeof row.id === "string" && ids.includes(row.id) && row.shopId === shopId &&
    typeof row.shopifyDiscountNodeId === "string" && row.shopifyDiscountNodeId.length > 0 &&
    (row.method === "CODE" || row.method === "AUTOMATIC") &&
    typeof row.providerStatus === "string" && row.providerStatus.length > 0 &&
    (row.singleRedeemCode === null || typeof row.singleRedeemCode === "string") &&
    (row.codeCount === null || Number.isSafeInteger(row.codeCount) && (row.codeCount as number) >= 0) &&
    typeof row.fixedSelectable === "boolean" && row.isAvailable === true &&
    row.unavailableAt === null && row.lastSeenSyncGeneration === generation &&
    row.shopId === shopId && row.providerSnapshot !== null && typeof row.providerSnapshot === "object" &&
    !Array.isArray(row.providerSnapshot);
}

function unavailable(reasonCode: string): DiscountSourceFenceResult {
  return { kind: "UNAVAILABLE", reasonCode };
}

export async function readCurrentDiscountSourceFence(
  input: FenceInput,
  dependencies: FenceDependencies = {},
): Promise<DiscountSourceFenceResult> {
  const ids = input?.selectedOfferIds;
  if (!input || typeof input.shopId !== "string" || !input.shopId.trim() ||
      typeof input.checkoutRecoveryId !== "string" || !input.checkoutRecoveryId.trim() ||
      !Array.isArray(ids) || ids.length < 1 || ids.length > 3 ||
      ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 191) ||
      new Set(ids).size !== ids.length || !input.signal) return unavailable("INVALID_INPUT");
  if (input.signal.aborted) return unavailable("CANCELLED");

  const database = dependencies.database ?? prisma;
  const clock = dependencies.clock ?? Date.now;
  const startedAt = clock();
  try {
    const fence = await database.$transaction(async (tx) => {
      const [shop, recovery, catalogue, rows] = await Promise.all([
        tx.shop.findUnique({ where: { id: input.shopId }, select: { id: true, platform: true } }),
        tx.checkoutRecovery.findFirst({
          where: { id: input.checkoutRecoveryId, shopId: input.shopId },
          select: { id: true, shopId: true },
        }),
        tx.shopifyDiscountCatalogue.findUnique({
          where: { shopId: input.shopId },
          select: { status: true, syncGeneration: true, activeSyncToken: true,
            lastSuccessfulSyncAt: true, unavailableAt: true },
        }),
        tx.shopifyDiscount.findMany({
          where: { shopId: input.shopId, id: { in: [...ids] } },
          select: {
            id: true, shopId: true, shopifyDiscountNodeId: true, method: true,
            providerStatus: true, startsAt: true, endsAt: true, singleRedeemCode: true,
            codeCount: true, fixedSelectable: true, isAvailable: true, unavailableAt: true,
            lastSeenSyncGeneration: true, lastSyncedAt: true, updatedAt: true,
            providerSnapshot: true,
          },
          orderBy: { id: "asc" },
        }),
      ]);
      if (input.signal.aborted) throw new Error("CANCELLED");
      if (!shop || shop.id !== input.shopId || !recovery || recovery.shopId !== input.shopId ||
          recovery.id !== input.checkoutRecoveryId ||
          (shop.platform !== "SHOPIFY" && shop.platform !== "WOOCOMMERCE")) {
        throw new Error("CONTEXT_UNAVAILABLE");
      }
      if (!catalogue || catalogue.status !== "CURRENT" ||
          !Number.isSafeInteger(catalogue.syncGeneration) || catalogue.syncGeneration <= 0 ||
          catalogue.activeSyncToken !== null || catalogue.unavailableAt !== null ||
          !(catalogue.lastSuccessfulSyncAt instanceof Date) ||
          !Number.isFinite(catalogue.lastSuccessfulSyncAt.getTime())) {
        throw new Error("CATALOGUE_UNAVAILABLE");
      }
      if (rows.length !== ids.length || rows.some((row) =>
          !validSnapshotRow(row as unknown as Record<string, unknown>, input.shopId, ids, catalogue.syncGeneration))) {
        throw new Error("SOURCE_ROW_UNAVAILABLE");
      }

      const catalogueProjection = {
        status: catalogue.status,
        syncGeneration: catalogue.syncGeneration,
        activeSyncToken: catalogue.activeSyncToken,
        lastSuccessfulSyncAt: dateValue(catalogue.lastSuccessfulSyncAt),
        unavailableAt: dateValue(catalogue.unavailableAt),
      };
      const discounts = rows.map((row) => ({
        id: row.id,
        shopId: row.shopId,
        shopifyDiscountNodeId: row.shopifyDiscountNodeId,
        method: row.method,
        providerStatus: row.providerStatus,
        startsAt: dateValue(row.startsAt),
        endsAt: dateValue(row.endsAt),
        singleRedeemCode: row.singleRedeemCode,
        codeCount: row.codeCount,
        fixedSelectable: row.fixedSelectable,
        isAvailable: row.isAvailable,
        unavailableAt: dateValue(row.unavailableAt),
        lastSeenSyncGeneration: row.lastSeenSyncGeneration,
        lastSyncedAt: dateValue(row.lastSyncedAt),
        updatedAt: dateValue(row.updatedAt),
        providerSnapshot: row.providerSnapshot,
      }));
      if (Object.values(catalogueProjection).some((value) => value === undefined) ||
          discounts.some((discount) => Object.values(discount).some((value) => value === undefined))) {
        throw new Error("SOURCE_DATA_INVALID");
      }
      for (const discount of discounts) {
        if (Buffer.byteLength(canonicalJson(discount.providerSnapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
          throw new Error("SOURCE_TOO_LARGE");
        }
      }
      const serialized = canonicalJson({
        shopId: input.shopId, platform: shop.platform, catalogue: catalogueProjection, discounts,
      });
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_FENCE_BYTES) throw new Error("SOURCE_TOO_LARGE");
      const snapshotDigest = createHash("sha256")
        .update(FENCE_PREFIX, "utf8")
        .update(serialized, "utf8")
        .digest("hex");
      return Object.freeze({
        shopId: input.shopId,
        platform: shop.platform,
        syncGeneration: catalogue.syncGeneration,
        selectedOfferIds: Object.freeze([...ids]),
        snapshotDigest,
      }) satisfies DiscountSourceFence;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 2_000,
      timeout: MAX_READ_MS,
    });
    if (input.signal.aborted) return unavailable("CANCELLED");
    if (clock() - startedAt > MAX_READ_MS) return unavailable("READ_DEADLINE_EXCEEDED");
    return { kind: "AVAILABLE", fence };
  } catch (error) {
    if (input.signal.aborted || error instanceof Error && error.message === "CANCELLED") {
      return unavailable("CANCELLED");
    }
    if (error instanceof Error && ["CONTEXT_UNAVAILABLE", "CATALOGUE_UNAVAILABLE",
      "SOURCE_ROW_UNAVAILABLE", "SOURCE_DATA_INVALID", "SOURCE_TOO_LARGE"].includes(error.message)) {
      return unavailable(error.message);
    }
    if (clock() - startedAt > MAX_READ_MS) return unavailable("READ_DEADLINE_EXCEEDED");
    return unavailable("READ_FAILED");
  }
}