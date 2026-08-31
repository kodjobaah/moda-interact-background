import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";

export const closeWorkerResources = [
  () => connectionRedis.quit(),
  () => prisma.$disconnect(),
] as const;