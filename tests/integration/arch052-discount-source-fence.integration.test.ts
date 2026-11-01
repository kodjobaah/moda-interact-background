import "dotenv/config";

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { readCurrentDiscountSourceFence } from "../../src/services/recovery-offers/current-discount-source-fence.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

describeWithDatabase("ARCH-052 discount source fence", () => {
  it.each(["SHOPIFY", "WOOCOMMERCE"] as const)(
    "reads current persisted source facts for %s shops",
    async (platform) => {
      const db = new PrismaClient({ datasourceUrl: url! });
      const id = randomUUID();
      const shopId = `arch052-fence-${id}`;
      const checkoutRecoveryId = `arch052-recovery-${id}`;
      const discountId = `arch052-discount-${id}`;
      const now = new Date();

      try {
        await db.shop.create({ data: {
          id: shopId,
          domain: `${id}-${platform.toLowerCase()}.example.test`,
          platform,
          status: "ACTIVE",
          onboardingCompleted: true,
        } });
        await db.checkoutRecovery.create({ data: {
          id: checkoutRecoveryId,
          shopId,
          checkoutToken: `checkout-${id}`,
          lastExternalActivityAt: now,
        } });
        await db.shopifyDiscountCatalogue.create({ data: {
          shopId,
          status: "CURRENT",
          syncGeneration: 3,
          lastSuccessfulSyncAt: now,
        } });
        await db.shopifyDiscount.create({ data: {
          id: discountId,
          shopId,
          shopifyDiscountNodeId: `gid://shopify/DiscountCodeNode/${id}`,
          providerType: "DiscountCodeBasic",
          method: "CODE",
          providerStatus: "ACTIVE",
          title: "ARCH-052 source-fence fixture",
          singleRedeemCode: "SAVE10",
          codeCount: 1,
          fixedSelectable: true,
          providerSnapshot: { id, status: "ACTIVE" },
          isAvailable: true,
          lastSeenSyncGeneration: 3,
          lastSyncedAt: now,
        } });

        const input = {
          shopId,
          checkoutRecoveryId,
          selectedOfferIds: [discountId],
          signal: new AbortController().signal,
        };
        const first = await readCurrentDiscountSourceFence(input, { database: db });
        expect(first.kind).toBe("AVAILABLE");
        if (first.kind !== "AVAILABLE") return;
        expect(first.fence).toMatchObject({ shopId, platform, syncGeneration: 3 });

        await db.shopifyDiscount.update({ where: { id: discountId }, data: { singleRedeemCode: "SAVE11" } });
        const changed = await readCurrentDiscountSourceFence(input, { database: db });
        expect(changed.kind).toBe("AVAILABLE");
        if (changed.kind !== "AVAILABLE") return;
        expect(changed.fence.snapshotDigest).not.toBe(first.fence.snapshotDigest);

        await db.shopifyDiscount.update({ where: { id: discountId }, data: { lastSeenSyncGeneration: 2 } });
        expect(await readCurrentDiscountSourceFence(input, { database: db })).toEqual({
          kind: "UNAVAILABLE",
          reasonCode: "SOURCE_ROW_UNAVAILABLE",
        });
      } finally {
        await db.shop.deleteMany({ where: { id: shopId } });
        await db.$disconnect();
      }
    },
  );
});