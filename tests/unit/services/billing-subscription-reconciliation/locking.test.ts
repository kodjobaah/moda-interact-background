import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { lockShop, lockShopSettings, lockSubscription } from "../../../../src/services/billing-subscription-reconciliation/locking.js";

describe("billing reconciliation row locks", () => {
  it("issues the exact settings, shop, and subscription lock SQL in call order", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const transaction = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    await lockShopSettings(transaction, "shop-1");
    await lockShop(transaction, "shop-1");
    await lockSubscription(transaction, "subscription-1");

    const queries = queryRaw.mock.calls.map(([query]) => query as { sql: string; values: unknown[] });
    expect(queries.map(({ sql }) => sql.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringMatching(/^SELECT "shopId" FROM "shopify"\."ShopSettings" WHERE "shopId" = .* FOR UPDATE$/),
      expect.stringMatching(/^SELECT "id" FROM "shopify"\."Shop" WHERE "id" = .* FOR UPDATE$/),
      expect.stringMatching(/^SELECT "id" FROM "billing"\."Subscription" WHERE "id" = .* FOR UPDATE$/),
    ]);
    expect(queries.map(({ values }) => values)).toEqual([
      ["shop-1"],
      ["shop-1"],
      ["subscription-1"],
    ]);
  });
});