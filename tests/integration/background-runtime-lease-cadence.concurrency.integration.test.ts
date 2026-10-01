import "dotenv/config";

import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { BackgroundRuntimeLeaseService } from "../../src/runtime/background-runtime-lease.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

describeWithDatabase("background runtime lease cadence PostgreSQL concurrency", () => {
  it("fences generations and gates reacquisition on the persisted cadence", async () => {
    const database = new PrismaClient();
    const originalConfig = await database.backgroundRuntimeConfig.findUnique({
      where: { id: "default" },
    });
    if (!originalConfig) throw new Error("Background runtime configuration is missing.");

    try {
      await database.backgroundRuntimeConfig.update({
        where: { id: "default" },
        data: { billingReconciliationIntervalSeconds: 10 },
      });
      await database.backgroundRuntimeLease.deleteMany({
        where: { name: "BILLING_RECONCILIATION" },
      });

      const first = new BackgroundRuntimeLeaseService(database, "integration-owner-1");
      const second = new BackgroundRuntimeLeaseService(database, "integration-owner-2");
      const firstRace = await Promise.all([
        first.tryAcquire("BILLING_RECONCILIATION"),
        second.tryAcquire("BILLING_RECONCILIATION"),
      ]);
      const firstHandles = firstRace.filter(
        (handle): handle is NonNullable<typeof handle> => handle !== null,
      );
      expect(firstHandles).toHaveLength(1);
      expect(firstHandles[0]?.generation).toBe(1);
      const winner = firstHandles[0]!;
      const winnerService = winner.ownerToken === "integration-owner-1" ? first : second;
      const staleService = winnerService === first ? second : first;

      expect(await winnerService.release(winner)).toBe(true);
      const retained = await database.backgroundRuntimeLease.findUnique({
        where: { name: "BILLING_RECONCILIATION" },
      });
      expect(retained).not.toBeNull();
      expect(retained?.lastFinishedAt).not.toBeNull();

      const insideCadence = await Promise.all([
        first.tryAcquire("BILLING_RECONCILIATION"),
        second.tryAcquire("BILLING_RECONCILIATION"),
      ]);
      expect(insideCadence.every((handle) => handle === null)).toBe(true);

      await database.$executeRaw(Prisma.sql`
        UPDATE "public"."BackgroundRuntimeLease"
        SET "lastFinishedAt" = NOW() - INTERVAL '11 seconds'
        WHERE "name" = 'BILLING_RECONCILIATION'::"BackgroundRuntimeLeaseName"
      `);
      const secondRace = await Promise.all([
        first.tryAcquire("BILLING_RECONCILIATION"),
        second.tryAcquire("BILLING_RECONCILIATION"),
      ]);
      const secondHandles = secondRace.filter(
        (handle): handle is NonNullable<typeof handle> => handle !== null,
      );
      expect(secondHandles).toHaveLength(1);
      expect(secondHandles[0]?.generation).toBe(2);

      expect(await staleService.heartbeat(winner)).toBe(false);
      expect(await staleService.release(winner)).toBe(false);
      const secondWinnerService =
        secondHandles[0]?.ownerToken === "integration-owner-1" ? first : second;
      await secondWinnerService.release(secondHandles[0]!);
    } finally {
      await database.backgroundRuntimeLease.deleteMany({
        where: { name: "BILLING_RECONCILIATION" },
      });
      await database.backgroundRuntimeConfig.update({
        where: { id: "default" },
        data: {
          billingReconciliationIntervalSeconds:
            originalConfig.billingReconciliationIntervalSeconds,
        },
      });
      await database.$disconnect();
    }
  }, 30_000);

  it.each([
    ["MERCHANT_KNOWLEDGE_PENDING_RECONCILIATION", 61],
    ["MERCHANT_KNOWLEDGE_UPLOAD_CLEANUP", 3601],
    ["MERCHANT_KNOWLEDGE_ENTITLEMENT_RECONCILIATION", 301],
  ] as const)("gates %s reacquisition on its fixed cadence and fences stale owners", async (name, elapsedSeconds) => {
    const database = new PrismaClient();
    const first = new BackgroundRuntimeLeaseService(database, "integration-owner-1");
    const second = new BackgroundRuntimeLeaseService(database, "integration-owner-2");

    try {
      await database.backgroundRuntimeLease.deleteMany({ where: { name } });

      const initial = await first.tryAcquire(name);
      expect(initial?.generation).toBe(1);
      expect(await first.release(initial!)).toBe(true);

      const retained = await database.backgroundRuntimeLease.findUnique({ where: { name } });
      expect(retained?.lastFinishedAt).not.toBeNull();

      const insideCadence = await Promise.all([first.tryAcquire(name), second.tryAcquire(name)]);
      expect(insideCadence.every((handle) => handle === null)).toBe(true);

      await database.$executeRaw(Prisma.sql`
        UPDATE "public"."BackgroundRuntimeLease"
        SET "lastFinishedAt" = NOW() - (${elapsedSeconds} * INTERVAL '1 second')
        WHERE "name" = ${name}::"BackgroundRuntimeLeaseName"
      `);
      const competing = await Promise.all([first.tryAcquire(name), second.tryAcquire(name)]);
      const acquired = competing.filter((handle): handle is NonNullable<typeof handle> => handle !== null);
      expect(acquired).toHaveLength(1);
      expect(acquired[0]?.generation).toBe(2);

      const staleOwner = acquired[0]?.ownerToken === "integration-owner-1" ? second : first;
      expect(await staleOwner.heartbeat(initial!)).toBe(false);
      expect(await staleOwner.release(initial!)).toBe(false);

      const winningService = acquired[0]?.ownerToken === "integration-owner-1" ? first : second;
      expect(await winningService.release(acquired[0]!)).toBe(true);
    } finally {
      await database.backgroundRuntimeLease.deleteMany({ where: { name } });
      await database.$disconnect();
    }
  }, 30_000);
});
