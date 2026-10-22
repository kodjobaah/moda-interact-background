import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { RecipientReachabilityStore } from
  "../../src/services/recipient-reachability-store.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const DAY_MS = 86_400_000;

suite("ARCH-028 recipient reachability PostgreSQL CAS", () => {
  it("converges duplicate, stale, competing and newer evidence independently per Shop", async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    const store = new RecipientReachabilityStore(db);
    const suffix = randomUUID();
    const shop1 = `arch028-reach-1-${suffix}`;
    const shop2 = `arch028-reach-2-${suffix}`;
    const recipient = "447700900123";
    const before = new Date("2026-10-10T10:00:00.000Z");
    const failed = new Date("2026-10-12T10:00:00.000Z");
    const success = new Date("2026-10-13T10:00:00.000Z");
    const newerFailure = new Date("2026-10-14T10:00:00.000Z");
    try {
      await db.shop.create({ data: { id: shop1, domain: `${shop1}.example.test` } });
      await db.shop.create({ data: { id: shop2, domain: `${shop2}.example.test` } });
      const days = (await db.platformBillingPolicy.findUnique({
        where: { id: "default" }, select: { whatsappRecipientSuppressionDays: true },
      }))?.whatsappRecipientSuppressionDays ?? 7;
      const row = () => db.whatsAppRecipientReachability.findUniqueOrThrow({
        where: { shopId_recipient: { shopId: shop1, recipient } },
      });

      expect(await store.recordFailure(shop1, recipient, failed, "131026")).toBe("recorded");
      expect((await row()).suppressUntil).toEqual(new Date(failed.getTime() + days * DAY_MS));
      expect(await store.recordFailure(shop1, recipient, failed, "131026")).toBe("unchanged");
      expect(await store.recordFailure(shop1, recipient, before, "131026")).toBe("unchanged");
      expect((await row()).version).toBe(1);

      expect(await store.recordSuccess(shop1, recipient, success)).toBe("recorded");
      expect((await row()).suppressUntil).toBeNull();
      await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2
        ? store.recordFailure(shop1, recipient, failed, "131026")
        : store.recordSuccess(shop1, recipient, success)));
      const converged = await row();
      expect(converged.suppressUntil).toBeNull();
      expect(converged.lastSuccessfulAt).toEqual(success);
      expect(converged.lastProviderFailureCode).toBe("131026");
      expect(converged.version).toBe(2);

      expect(await store.recordFailure(shop1, recipient, newerFailure, "131026")).toBe("recorded");
      expect((await row()).suppressUntil).toEqual(new Date(newerFailure.getTime() + days * DAY_MS));
      // A prior success does not erase a chronologically newer failure.
      expect(await store.recordSuccess(shop1, recipient, success)).toBe("unchanged");
      expect(await store.recordFailure(shop2, recipient, failed, "131026")).toBe("recorded");
      expect((await row()).lastFailureAt).toEqual(newerFailure);
      expect((await db.whatsAppRecipientReachability.findUniqueOrThrow({
        where: { shopId_recipient: { shopId: shop2, recipient } },
      })).suppressUntil).toEqual(new Date(failed.getTime() + days * DAY_MS));

      // Success may be processed first on another recipient. Delayed failed
      // evidence cannot insert a suppression row over that durable positive.
      await store.recordSuccess(shop1, "447700900999", success);
      expect(await store.recordFailure(shop1, "447700900999", failed, "131026"))
        .toBe("unchanged");
      const positiveFirst = await db.whatsAppRecipientReachability.findUniqueOrThrow({
        where: { shopId_recipient: { shopId: shop1, recipient: "447700900999" } },
      });
      expect(positiveFirst.lastFailureAt).toBeNull();
      expect(positiveFirst.suppressUntil).toBeNull();
    } finally {
      await db.shop.deleteMany({ where: { id: { in: [shop1, shop2] } } });
      await db.$disconnect();
    }
  }, 45_000);
});
