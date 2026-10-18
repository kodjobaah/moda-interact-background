import type { PrismaClient } from "@prisma/client";

/** One SQL statement per operation; no audit table and no process cache. */
export type ConfigurationRow = Readonly<{ environment: string; key: string; version: number; value: unknown }>;
export type ConfigurationRepository = Readonly<{
  readRows(environment: string, keys: readonly string[]): Promise<readonly ConfigurationRow[]>;
}>;
export function createPrismaConfigurationRepository(db: Pick<PrismaClient, "platformConfiguration">): ConfigurationRepository {
  return {
    async readRows(environment, keys) {
      return db.platformConfiguration.findMany({
        where: { environment, key: { in: [...keys] } },
        select: { environment: true, key: true, version: true, value: true },
      });
    },
  };
}
