import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { InitialOutreachCreditService } from "../../src/services/recovery-billing/initial-outreach-credit.service.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

suite("ARCH-056 initial outreach Shop parent-FK lock order (PostgreSQL)", () => {
  it("waits for Shop KEY SHARE before acquiring the confirmed message lock", async () => {
    const f = await createInitialOutreachCreditFixture();
    const settlementClient = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    const observer = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    let releaseShopLock!: () => void;
    let announceShopLock!: () => void;
    const held = new Promise<void>((resolve) => { releaseShopLock = resolve; });
    const acquired = new Promise<void>((resolve) => { announceShopLock = resolve; });
    const blocker = f.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${f.shopId} FOR UPDATE`;
      announceShopLock();
      await held;
    }, { timeout: 20_000 });
    try {
      await acquired;
      const service = new InitialOutreachCreditService(settlementClient);
      const settlement = service.settleConfirmedInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      });
      const deadline = Date.now() + 8_000;
      let waiting = false;
      while (Date.now() < deadline && !waiting) {
        const activity = await observer.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND state='active'
            AND wait_event_type='Lock'
            AND position('"commerce"."Shop"' in query) > 0`;
        waiting = activity.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await observer.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "whatsapp"."ConversationMessage" WHERE "id"=${f.messageId} FOR UPDATE NOWAIT`;
      });
      releaseShopLock();
      await blocker;
      await expect(settlement).resolves.toMatchObject({ kind: "settled", disposition: "committed" });
    } finally {
      releaseShopLock();
      await blocker;
      await observer.$disconnect();
      await settlementClient.$disconnect();
      await f.close();
    }
  });
});
