import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { WooPendingCandidate } from "../../src/services/woocommerce-recovery/contracts.js";
import { createWooRecoveryConsentDeniedAdmissionNotifier } from
  "../../src/services/woocommerce-recovery/woo-recovery-consent-notice.adapter.js";
import { RecoveryConsentMerchantNoticeService } from
  "../../src/services/checkout-recovery/recovery-consent-merchant-notice.service.js";
import { createRecoveryConsentNoticeSourceKey } from
  "../../src/services/checkout-recovery/recovery-consent-merchant-notice.formatter.js";

const url = process.env.TEST_DATABASE_URL;
const withDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const when = new Date("2026-10-25T10:00:00.000Z");
const noopLogger = { info: vi.fn(), error: vi.fn() };

async function createShop(db: PrismaClient): Promise<string> {
  const id = randomUUID();
  await db.shop.create({ data: {
    id, platform: "WOOCOMMERCE", domain: `https://${id}.example.test`,
    status: "ACTIVE", defaultCountryCode: "GB",
  } });
  return id;
}

function accepted(shopId: string, checkoutToken: string): WooPendingCandidate {
  return {
    source: "woocommerce", shopId, checkoutToken, generation: 1,
    lastEventId: "accepted-woo-event-1", lastActivityAt: "2026-10-25T08:30:00.000Z",
    basket: { kind: "nonempty", checkout: {
      currency: "USD", total: "64.50",
      items: [{ quantity: 2, productId: "product", total: "64.50" }],
      contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: "+447400123456" },
    } },
  };
}

withDatabase("Woo first-recovery denial — real merchant Support persistence", () => {
  it("deduplicates concurrent Woo callbacks, isolates shops and preserves the first committed body", async () => {
    const a = new PrismaClient({ datasourceUrl: url! });
    const b = new PrismaClient({ datasourceUrl: url! });
    const shops: string[] = [];
    try {
      const shopA = await createShop(a); shops.push(shopA);
      const shopB = await createShop(a); shops.push(shopB);
      const token = "private-woo-checkout-token";
      const admission = { shopId: shopA, checkoutToken: token, reason: "CONSENT_NOT_GRANTED" as const };
      const snapshot = accepted(shopA, token);
      const reader = { getPending: vi.fn(async () => snapshot) };
      const adapterA = createWooRecoveryConsentDeniedAdmissionNotifier({
        candidates: reader,
        notifier: new RecoveryConsentMerchantNoticeService(a, () => when, noopLogger),
        logger: noopLogger,
      });
      const adapterB = createWooRecoveryConsentDeniedAdmissionNotifier({
        candidates: reader,
        notifier: new RecoveryConsentMerchantNoticeService(b, () => when, noopLogger),
        logger: noopLogger,
      });

      await Promise.all([adapterA(admission), adapterB(admission)]);
      const input = {
        ...admission, reason: "NO_VERIFIED_OPT_IN" as const,
        platform: "WOOCOMMERCE" as const, blockedOperation: "CREATE_FIRST_RECOVERY" as const,
      };
      const key = createRecoveryConsentNoticeSourceKey(input);
      const stored = await a.merchantSupportMessage.findUniqueOrThrow({ where: { sourceKey: key } });
      const threadA = await a.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shopA } });
      expect(stored.threadId).toBe(threadA.id);
      expect(stored.kind).toBe("SYSTEM");
      expect(stored.state).toBe("AVAILABLE");
      expect(stored.originalBody).toContain("Platform: WooCommerce");
      expect(stored.originalBody).toContain("Customer: Ada Lovelace");
      expect(stored.originalBody).toContain("Checkout total: USD 64.50");
      expect(stored.originalBody).toContain("Items: 2");
      expect(stored.originalBody).toContain("No checkout recovery was created");
      expect(stored.originalBody).not.toContain(token);
      expect(stored.originalBody).not.toContain("+447400123456");
      expect(key).not.toContain(token);
      expect(await a.merchantSupportMessage.count({ where: { threadId: threadA.id } })).toBe(1);

      // The notifier's canonical source key does not include blockedOperation.
      const alternate = new RecoveryConsentMerchantNoticeService(b, () => new Date(when.getTime() + 3600_000), noopLogger);
      expect(await alternate.notify({ ...input, blockedOperation: "SEND_INITIAL_RECOVERY",
        context: { customerName: "Later snapshot" } })).toBe("duplicate");
      expect((await a.merchantSupportMessage.findUniqueOrThrow({ where: { sourceKey: key } })).originalBody)
        .toBe(stored.originalBody);

      // Identical checkout token in a different tenant must yield a DIFFERENT thread/key.
      const shopBCallback = createWooRecoveryConsentDeniedAdmissionNotifier({
        candidates: { getPending: vi.fn(async () => accepted(shopB, token)) },
        notifier: new RecoveryConsentMerchantNoticeService(b, () => when, noopLogger),
        logger: noopLogger,
      });
      await shopBCallback({ shopId: shopB, checkoutToken: token, reason: "CONSENT_NOT_GRANTED" });
      const keyB = createRecoveryConsentNoticeSourceKey({ ...input, shopId: shopB });
      const storedB = await a.merchantSupportMessage.findUniqueOrThrow({ where: { sourceKey: keyB } });
      const threadB = await a.merchantSupportThread.findUniqueOrThrow({ where: { shopId: shopB } });
      expect(storedB.threadId).toBe(threadB.id);
      expect(storedB.threadId).not.toBe(threadA.id);
      expect(await a.merchantSupportThread.count({ where: { shopId: shopB } })).toBe(1);
      expect(await a.checkoutRecovery.count({ where: { shopId: { in: shops } } })).toBe(0);
    } finally {
      await a.shop.deleteMany({ where: { id: { in: shops } } });
      await Promise.all([a.$disconnect(), b.$disconnect()]);
    }
  }, 45_000);

  it("propagates transactional writer failure without leaving a committed Support thread", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      shopId = await createShop(db);
      const token = "private-woo-atomicity-token";
      const candidate = accepted(shopId, token);
      const broken = new RecoveryConsentMerchantNoticeService({
        $transaction: (run: (tx: unknown) => Promise<unknown>) => db.$transaction(async (tx) => run({
          merchantSupportThread: {
            createMany: tx.merchantSupportThread.createMany.bind(tx.merchantSupportThread),
            findUniqueOrThrow: tx.merchantSupportThread.findUniqueOrThrow.bind(tx.merchantSupportThread),
            updateMany: async () => { throw new Error("injected thread update failure"); },
          },
          merchantSupportMessage: tx.merchantSupportMessage,
        })),
      } as never, () => when, noopLogger);
      const adapter = createWooRecoveryConsentDeniedAdmissionNotifier({
        candidates: { getPending: async () => candidate }, notifier: broken, logger: noopLogger,
      });
      const denial = { shopId, checkoutToken: token, reason: "CONSENT_NOT_GRANTED" as const };
      await expect(adapter(denial)).rejects.toThrow("injected thread update failure");
      expect(await db.merchantSupportThread.count({ where: { shopId } })).toBe(0);
      expect(await db.merchantSupportMessage.count({ where: {
        sourceKey: createRecoveryConsentNoticeSourceKey({ ...denial, reason: "NO_VERIFIED_OPT_IN",
          platform: "WOOCOMMERCE", blockedOperation: "CREATE_FIRST_RECOVERY" }),
      } })).toBe(0);

      // A subsequent retry can persist exactly one canonical notice.
      const repaired = createWooRecoveryConsentDeniedAdmissionNotifier({
        candidates: { getPending: async () => candidate },
        notifier: new RecoveryConsentMerchantNoticeService(db, () => when, noopLogger),
        logger: noopLogger,
      });
      await repaired(denial);
      expect(await db.merchantSupportMessage.count({ where: { thread: { shopId } } })).toBe(1);
      expect(await db.checkoutRecovery.count({ where: { shopId } })).toBe(0);
    } finally {
      if (shopId) await db.shop.delete({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);
});
