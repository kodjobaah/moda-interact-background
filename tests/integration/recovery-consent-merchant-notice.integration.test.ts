import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { RecoveryConsentNoticeInput } from "../../src/services/checkout-recovery/recovery-consent-merchant-notice.contracts.js";
import { createRecoveryConsentNoticeSourceKey } from
  "../../src/services/checkout-recovery/recovery-consent-merchant-notice.formatter.js";
import { RecoveryConsentMerchantNoticeService } from
  "../../src/services/checkout-recovery/recovery-consent-merchant-notice.service.js";

const url = process.env.TEST_DATABASE_URL;
const withDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const log = { info: vi.fn(), error: vi.fn() };

async function shop(db: PrismaClient, platform: "SHOPIFY" | "WOOCOMMERCE") {
  const id = randomUUID();
  await db.shop.create({ data: {
    id, domain: `https://${id}.example.test`, platform, status: "ACTIVE", defaultCountryCode: "GB",
  } });
  return id;
}

function request(shopId: string, platform: "SHOPIFY" | "WOOCOMMERCE" = "SHOPIFY"):
  RecoveryConsentNoticeInput {
  return {
    shopId, platform, checkoutToken: "private-checkout-token",
    reason: "NO_VERIFIED_OPT_IN", blockedOperation: "CREATE_FIRST_RECOVERY",
    context: { customerName: "Ada", customerEmail: "ada@example.test" },
  };
}

withDatabase("recovery consent merchant Support notices — real PostgreSQL", () => {
  it("deduplicates across clients and blocked operations, scopes shops and preserves timestamp ordering", async () => {
    const a = new PrismaClient({ datasourceUrl: url! });
    const b = new PrismaClient({ datasourceUrl: url! });
    const shops: string[] = [];
    try {
      const shopA = await shop(a, "SHOPIFY"); shops.push(shopA);
      const shopB = await shop(a, "WOOCOMMERCE"); shops.push(shopB);
      const input = request(shopA);
      const writers = [a, b].map((client) => new RecoveryConsentMerchantNoticeService(
        client, () => new Date("2026-10-24T09:00:00Z"), log,
      ));
      const calls = await Promise.all(Array.from({ length: 10 }, (_, i) => writers[i % 2]!.notify({
        ...input,
        blockedOperation: i % 2 === 0 ? "CREATE_FIRST_RECOVERY" : "SEND_INITIAL_RECOVERY",
      })));
      expect(calls.filter((c) => c === "created")).toHaveLength(1);
      expect(calls.filter((c) => c === "duplicate")).toHaveLength(9);
      const threadA = await a.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shopA } });
      expect(await a.merchantSupportThread.count({ where: { shopId: shopA } })).toBe(1);
      expect(await a.merchantSupportMessage.count({ where: { threadId: threadA.id,
        systemCode: "RECOVERY_CONSENT_ADMISSION" } })).toBe(1);
      expect(threadA.lastMessageAt).toEqual(new Date("2026-10-24T09:00:00Z"));
      const firstRow = await a.merchantSupportMessage.findUniqueOrThrow({
        where: { sourceKey: createRecoveryConsentNoticeSourceKey(input) },
      });
      expect(firstRow.originalBody).toContain("Customer: Ada");
      expect(firstRow.originalBody).not.toContain("private-checkout-token");
      expect(firstRow.originalBody).toMatch(/Outcome: (No checkout recovery was created|The initial WhatsApp recovery message was not sent)/);

      const later = new RecoveryConsentMerchantNoticeService(a, () => new Date("2026-10-24T15:00:00Z"), log);
      const older = new RecoveryConsentMerchantNoticeService(b, () => new Date("2026-10-24T08:00:00Z"), log);
      // The same checkout/reason from either entrypoint is a duplicate; no new timestamp.
      expect(await later.notify({ ...input, blockedOperation: "SEND_INITIAL_RECOVERY" })).toBe("duplicate");
      expect((await a.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shopA } })).lastMessageAt)
        .toEqual(new Date("2026-10-24T09:00:00Z"));
      // A distinct reason is a new notice and can advance the thread timestamp.
      expect(await later.notify({ ...input, reason: "RECIPIENT_UNVERIFIED" })).toBe("created");
      expect((await a.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shopA } })).lastMessageAt)
        .toEqual(new Date("2026-10-24T15:00:00Z"));
      expect(await older.notify({
        ...input, reason: "RECIPIENT_UNVERIFIED", blockedOperation: "SEND_INITIAL_RECOVERY",
      })).toBe("duplicate");
      expect(await older.notify({ ...input, context: { customerName: "Changed" } })).toBe("duplicate");
      expect((await a.merchantSupportMessage.findUniqueOrThrow({
        where: { sourceKey: createRecoveryConsentNoticeSourceKey(input) },
      })).originalBody).toBe(firstRow.originalBody);
      expect((await a.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shopA } })).lastMessageAt)
        .toEqual(new Date("2026-10-24T15:00:00Z"));

      // Reverse entrypoint order: send notice wins and a later create entry cannot rewrite it.
      const sendFirst = {
        ...input, checkoutToken: "private-checkout-token-2",
        blockedOperation: "SEND_INITIAL_RECOVERY" as const,
      };
      expect(await later.notify(sendFirst)).toBe("created");
      const sendKey = createRecoveryConsentNoticeSourceKey(sendFirst);
      const sendRow = await a.merchantSupportMessage.findUniqueOrThrow({ where: { sourceKey: sendKey } });
      expect(sendRow.originalBody).toContain("Outcome: The initial WhatsApp recovery message was not sent");
      expect(await older.notify({ ...sendFirst, blockedOperation: "CREATE_FIRST_RECOVERY" })).toBe("duplicate");
      expect((await a.merchantSupportMessage.findUniqueOrThrow({ where: { sourceKey: sendKey } })).originalBody)
        .toBe(sendRow.originalBody);
      expect((await a.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shopA } })).lastMessageAt)
        .toEqual(new Date("2026-10-24T15:00:00Z"));

      // Synthetic Woo caller uses identical service, isolated by actual shop/thread.
      const wooInput = request(shopB, "WOOCOMMERCE");
      expect(await later.notify(wooInput)).toBe("created");
      const wooRow = await b.merchantSupportMessage.findUniqueOrThrow({
        where: { sourceKey: createRecoveryConsentNoticeSourceKey(wooInput) },
      });
      const threadB = await b.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shopB } });
      expect(wooRow.threadId).toBe(threadB.id);
      expect(wooRow.threadId).not.toBe(threadA.id);
      expect(wooRow.originalBody).toContain("Platform: WooCommerce");
      expect(wooRow.sourceKey).not.toContain(wooInput.checkoutToken);
    } finally {
      await a.shop.deleteMany({ where: { id: { in: shops } } });
      await Promise.all([a.$disconnect(), b.$disconnect()]);
    }
  }, 45_000);

  it("treats a colliding noncanonical sourceKey row as invariant failure rather than a duplicate", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      shopId = await shop(db, "SHOPIFY");
      const input = request(shopId);
      const thread = await db.merchantSupportThread.create({ data: { shopId } });
      const key = createRecoveryConsentNoticeSourceKey(input);
      await db.merchantSupportMessage.create({ data: {
        threadId: thread.id, kind: "SYSTEM", state: "AVAILABLE",
        originalBody: "wrong code", sourceLanguageTag: "en-GB", sourceKey: key,
        systemCode: "UNRELATED_SYSTEM", systemVersion: "1", availableAt: new Date(),
      } });
      const service = new RecoveryConsentMerchantNoticeService(db, () => new Date(), log);
      await expect(service.notify(input)).rejects.toThrow("deduplication invariant");
      expect(await db.merchantSupportMessage.count({ where: { sourceKey: key } })).toBe(1);
      expect((await db.merchantSupportThread.findUniqueOrThrow({ where: { shopId } })).lastMessageAt).toBeNull();
    } finally {
      if (shopId) await db.shop.delete({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);

  it("rolls back both thread and message when the post-insert metadata update fails", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      shopId = await shop(db, "SHOPIFY");
      const input = request(shopId);
      const injected = {
        $transaction: (callback: (tx: unknown) => Promise<unknown>) => db.$transaction(async (tx) => callback({
          merchantSupportThread: {
            createMany: tx.merchantSupportThread.createMany.bind(tx.merchantSupportThread),
            findUniqueOrThrow: tx.merchantSupportThread.findUniqueOrThrow.bind(tx.merchantSupportThread),
            updateMany: async () => { throw new Error("injected metadata update failure"); },
          },
          merchantSupportMessage: tx.merchantSupportMessage,
        })),
      };
      const service = new RecoveryConsentMerchantNoticeService(injected as never, () => new Date(), log);
      await expect(service.notify(input)).rejects.toThrow("injected metadata update failure");
      expect(await db.merchantSupportThread.count({ where: { shopId } })).toBe(0);
      expect(await db.merchantSupportMessage.count({
        where: { sourceKey: createRecoveryConsentNoticeSourceKey(input) },
      })).toBe(0);
      expect(await new RecoveryConsentMerchantNoticeService(db, () => new Date(), log).notify(input))
        .toBe("created");
    } finally {
      if (shopId) await db.shop.delete({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);
});
