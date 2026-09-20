import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";

export type PromotionSelectionExpiryReconciliationResult = {
  selected: number;
  released: number;
  raced: number;
};

export class PromotionSelectionExpiryReconciliationService {
  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileOnce(
    runtimeConfig: Pick<
      BackgroundRuntimeConfigSnapshot,
      "billingReconciliationShopBatchSize"
    >,
  ): Promise<PromotionSelectionExpiryReconciliationResult> {
    const cutoff = this.now();
    const candidates = await this.database.merchantPromotionSelection.findMany({
      where: {
        promotionalCreditGrant: {
          campaign: {
            expiresAt: { lte: cutoff },
          },
        },
      },
      orderBy: [
        { updatedAt: "asc" },
        { id: "asc" },
      ],
      take: runtimeConfig.billingReconciliationShopBatchSize,
      select: {
        id: true,
        shopId: true,
        promotionalCreditGrantId: true,
      },
    });

    let released = 0;
    let raced = 0;
    for (const candidate of candidates) {
      const deletion = await this.database.merchantPromotionSelection.deleteMany({
        where: {
          id: candidate.id,
          shopId: candidate.shopId,
          promotionalCreditGrantId: candidate.promotionalCreditGrantId,
          promotionalCreditGrant: {
            campaign: {
              expiresAt: { lte: cutoff },
            },
          },
        },
      });

      if (deletion.count === 1) released += 1;
      else raced += 1;
    }

    return {
      selected: candidates.length,
      released,
      raced,
    };
  }
}