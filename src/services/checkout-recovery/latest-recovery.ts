import prisma from "../../lib/db.js";

export function findLatestRecovery(shopId: string, checkoutToken: string) {
  return prisma.checkoutRecovery.findFirst({
    where: { shopId, checkoutToken },
    orderBy: [{ generation: "desc" }, { id: "desc" }],
  });
}