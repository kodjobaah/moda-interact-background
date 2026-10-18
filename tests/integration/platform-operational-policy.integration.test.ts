import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PlatformOperationalPolicyReader } from "../../src/services/platform-operational-policy.js";

const url = process.env.TEST_DATABASE_URL;
const withPostgres = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const woo = {
  dispatchBatchSize: 500, refreshIntervalMinutes: 30, dispatchCooldownMinutes: 5,
  unavailableRecheckMinutes: 30, staleScanMinutes: 15, maxPages: 50,
  requestTimeoutMs: 8000, maxResponseBytes: 1048576, maxScanDurationMs: 120000,
  workerConcurrency: 4,
};
withPostgres("ARCH-043 Background policy real PostgreSQL", () => {
  it("observes committed revisions, isolates environments, rejects invalid/disabled and missing policy safely", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const id = randomUUID();
    const reader = new PlatformOperationalPolicyReader(db, "test");
    try {
      expect((await reader.wooCouponSync()).dispatchBatchSize).toBe(500);
      await db.platformConfiguration.create({ data: {
        id, environment: "test", key: "woo.couponSync", value: { ...woo, dispatchBatchSize: 1 }, version: 1,
      }});
      expect((await reader.wooCouponSync()).dispatchBatchSize).toBe(1);
      await db.platformConfiguration.update({ where: { id }, data: { value: { ...woo, dispatchBatchSize: 2 }, version: 2 } });
      expect((await reader.wooCouponSync()).dispatchBatchSize).toBe(2);
      expect((await new PlatformOperationalPolicyReader(db, "production").wooCouponSync()).dispatchBatchSize).toBe(500);
      await db.platformConfiguration.update({ where: { id }, data: { value: { ...woo, maxPages: 10000 }, version: 3 } });
      await expect(reader.wooCouponSync()).rejects.toThrow();
      await db.platformConfiguration.update({ where: { id }, data: { value: { kind: "disabled", schemaVersion: 1 }, version: 4 } });
      await expect(reader.wooCouponSync()).rejects.toMatchObject({ code: "disabled_policy" });
    } finally {
      await db.platformConfiguration.deleteMany({ where: { id } });
      await db.$disconnect();
    }
  });
});
