import type { Prisma } from "@prisma/client";

export type RecoveryUsageProvider = "SHOPIFY" | "WOOCOMMERCE";

export async function resolveRecoveryUsageProvider(
  transaction: Pick<Prisma.TransactionClient, "shop">,
  shopId: string,
): Promise<RecoveryUsageProvider> {
  const shop = await transaction.shop.findUnique({
    where: { id: shopId },
    select: { platform: true },
  });
  if (!shop) throw new Error(`Shop ${shopId} does not exist`);
  return shop.platform;
}