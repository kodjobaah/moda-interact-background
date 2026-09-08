import prisma from "../lib/db.js";

export const closeBillingResources = [
  () => prisma.$disconnect(),
] as const;