import { Prisma } from "@prisma/client";

export async function lockShopSettings(transaction: Prisma.TransactionClient, shopId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
      SELECT "shopId"
      FROM "shopify"."ShopSettings"
      WHERE "shopId" = ${shopId}
      FOR UPDATE
    `);
}

export async function lockShop(transaction: Prisma.TransactionClient, shopId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "shopify"."Shop"
      WHERE "id" = ${shopId}
      FOR UPDATE
    `);
}

export async function lockSubscription(transaction: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "billing"."Subscription"
      WHERE "id" = ${subscriptionId}
      FOR UPDATE
    `);
}