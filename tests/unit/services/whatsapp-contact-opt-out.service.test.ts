import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppContactOptOutService } from "../../../src/services/whatsapp-contact-opt-out.service.js";
import { hasLocalNoContact } from "../../../src/services/whatsapp-contact-opt-out/local-no-contact.js";
import { isExplicitWhatsAppStop } from "../../../src/services/whatsapp-contact-opt-out/phone.js";
import type { WhatsAppInboundEvent } from "../../../src/integration/whatsapp/types.js";

const number = "+447400123456";
const other = "+447400123457";
const event = (patch: Record<string, unknown> = {}): WhatsAppInboundEvent => ({
  schemaVersion: 1, provider: "whatsapp", providerAccountId: "waba-1",
  providerPhoneNumberId: "phone-1", providerMessageId: "wamid-stop-1",
  customerPhone: "447400123456", contextMessageId: null,
  occurredAt: "2026-10-22T17:00:00Z", content: { type: "text", text: " STOP " },
  ...patch,
} as WhatsAppInboundEvent);

type Phone = {
  id: string; phone: string; whatsappCanonicalPhone: string | null;
  whatsappNoContact: boolean; whatsappNoContactReason: string | null;
  whatsappNoContactAt: Date | null; whatsappNoContactRevision: bigint;
  customer: { shopId: string; shop: { defaultCountryCode: string | null } };
};
const row = (id: string, shopId: string, phone = number, canonical: string | null = phone.slice(1)): Phone => ({
  id, phone, whatsappCanonicalPhone: canonical,
  whatsappNoContact: false, whatsappNoContactReason: null,
  whatsappNoContactAt: null, whatsappNoContactRevision: 0n,
  customer: { shopId, shop: { defaultCountryCode: "GB" } },
});

function setup(phones: Phone[], quoted?: { shopId: string; recipient?: string } | null) {
  const notices = new Map<string, { shopId: string; body: string; sourceKey: string }>();
  const threads = new Map<string, { id: string; lastMessageAt: Date | null }>();
  let unavailableShop: string | null = null;
  const tx = {
    customerPhone: {
      findMany: vi.fn(async ({ where }: { where: { customer?: { shopId: string } } }) =>
        phones.filter((phone) => !where.customer || phone.customer.shopId === where.customer.shopId)),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; whatsappNoContactRevision: bigint }; data: { whatsappNoContactAt: Date } }) => {
        const phone = phones.find((p) => p.id === where.id && p.whatsappNoContactRevision === where.whatsappNoContactRevision);
        if (!phone) return { count: 0 };
        phone.whatsappNoContact = true;
        phone.whatsappNoContactReason = "CUSTOMER_STOP";
        phone.whatsappNoContactAt = data.whatsappNoContactAt;
        phone.whatsappNoContactRevision++;
        return { count: 1 };
      }),
    },
    merchantSupportThread: {
      upsert: vi.fn(async ({ where }: { where: { shopId: string } }) => {
        if (!threads.has(where.shopId)) threads.set(where.shopId, { id: where.shopId, lastMessageAt: null });
        return threads.get(where.shopId)!;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { lastMessageAt: Date } }) => {
        threads.get(where.id)!.lastMessageAt = data.lastMessageAt;
      }),
    },
    merchantSupportMessage: {
      createMany: vi.fn(async ({ data }: { data: Array<{ threadId: string; originalBody: string; sourceKey: string }> }) => {
        const message = data[0]!;
        if (unavailableShop === message.threadId) throw new Error("support unavailable");
        if (notices.has(message.sourceKey)) return { count: 0 };
        notices.set(message.sourceKey, { shopId: message.threadId, body: message.originalBody, sourceKey: message.sourceKey });
        return { count: 1 };
      }),
    },
    $queryRawUnsafe: vi.fn(async () => []),
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (cb: (transaction: typeof tx) => Promise<unknown>) => cb(tx)),
    conversationMessage: {
      findUnique: vi.fn(async () => quoted ? {
        direction: "OUTBOUND", sentAt: new Date("2026-10-22T16:00:00Z"),
        merchantSendCommand: { shopId: quoted.shopId, recipientSnapshot: quoted.recipient ?? number },
        recoveryOutreachAttempt: null,
        conversation: {
          shopId: null,
          checkoutRecovery: {
            shopId: quoted.shopId, customer: { phone: number },
            shop: { defaultCountryCode: "GB" },
          },
        },
      } : null),
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sender = vi.fn(async () => ({ providerAccountId: "waba-1", providerPhoneNumberId: "phone-1" }));
  const service = new WhatsAppContactOptOutService(db as never, sender, logger as never, () => new Date("2026-10-22T17:10:00Z"));
  return { service, db, tx, notices, threads, logger, sender,
    failNoticeFor: (shopId: string | null) => { unavailableShop = shopId; } };
}

describe("ARCH-045 WhatsApp STOP", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only detects deterministic commands (case and surrounding whitespace are allowed)", () => {
    expect(isExplicitWhatsAppStop({ type: "text", text: " Unsubscribe! " })).toBe(true);
    expect(isExplicitWhatsAppStop({ type: "text", text: "STOP" })).toBe(true);
    for (const text of ["Stop sending me messages", "Please unsubscribe", "STOP please", "Stop by today"]) {
      expect(isExplicitWhatsAppStop({ type: "text", text })).toBe(false);
    }
    expect(isExplicitWhatsAppStop({ type: "audio" })).toBe(false);
  });

  it("scopes a reliably quoted STOP to its original merchant and all same-shop customers", async () => {
    const phones = [row("a-1", "shop-a"), row("a-2", "shop-a"), row("b-1", "shop-b")];
    const f = setup(phones, { shopId: "shop-a" });
    expect(await f.service.handleInbound(event({ contextMessageId: "outbound-a" }))).toBe(true);
    expect(phones.map((p) => p.whatsappNoContact)).toEqual([true, true, false]);
    expect([...f.notices.values()]).toHaveLength(1);
    expect([...f.notices.values()][0]!.body).toMatch(/replied STOP to this shop/);
    expect([...f.notices.keys()][0]).not.toContain(number.slice(1));
    expect(f.logger.info.mock.calls.flat().join(" ")).not.toContain(number.slice(1));
  });

  it("standalone STOP blocks all currently registered shops, not a guessed recent shop", async () => {
    const phones = [row("a-1", "shop-a"), row("a-2", "shop-a", "07400 123456", null),
      row("b-1", "woo-b"), row("different", "woo-b", other)];
    const f = setup(phones);
    expect(await f.service.handleInbound(event())).toBe(true);
    expect(phones.map((p) => p.whatsappNoContact)).toEqual([true, true, true, false]);
    expect([...f.notices.values()].map((n) => n.shopId).sort()).toEqual(["shop-a", "woo-b"]);
    expect([...f.notices.values()].every((n) => n.body.includes("standalone"))).toBe(true);
    await f.service.handleInbound(event());
    expect(phones.map((p) => p.whatsappNoContactRevision)).toEqual([1n, 1n, 1n, 0n]);
    expect(f.notices.size).toBe(2);
    expect(f.tx.merchantSupportThread.update).toHaveBeenCalledTimes(2);
  });

  it("unresolvable or mismatched quoted message falls back to all registered merchants", async () => {
    const f = setup([row("a-1", "shop-a"), row("b-1", "shop-b")],
      { shopId: "shop-a", recipient: other });
    expect(await f.service.handleInbound(event({ contextMessageId: "unverifiable" }))).toBe(true);
    expect(f.notices.size).toBe(2);
    expect(f.logger.info).toHaveBeenCalledWith("whatsapp.stop.recorded", expect.objectContaining({ scope: "ALL_REGISTERED_SHOPS" }));
  });

  it("persists STOP before notice publication; retry repairs partial notice without revising STOP", async () => {
    const phones = [row("a-1", "shop-a"), row("b-1", "shop-b")];
    const f = setup(phones);
    f.failNoticeFor("shop-b");
    await expect(f.service.handleInbound(event())).rejects.toThrow("support unavailable");
    expect(phones.every((p) => p.whatsappNoContact)).toBe(true);
    expect(f.notices.size).toBe(1);
    const dates = phones.map((p) => p.whatsappNoContactAt);
    f.failNoticeFor(null);
    await expect(f.service.handleInbound(event())).resolves.toBe(true);
    expect(f.notices.size).toBe(2);
    expect(phones.map((p) => p.whatsappNoContactRevision)).toEqual([1n, 1n]);
    expect(phones.map((p) => p.whatsappNoContactAt)).toEqual(dates);
    expect(f.tx.merchantSupportThread.update).toHaveBeenCalledTimes(2);
  });

  it("upgrades a merchant preference block to permanent CUSTOMER_STOP exactly once", async () => {
    const phone = row("a", "shop-a");
    phone.whatsappNoContact = true;
    phone.whatsappNoContactReason = "MERCHANT_OPT_OUT";
    phone.whatsappNoContactRevision = 3n;
    phone.whatsappNoContactAt = new Date("2026-10-21T09:00:00Z");
    const f = setup([phone]);
    await f.service.handleInbound(event());
    expect(phone.whatsappNoContactReason).toBe("CUSTOMER_STOP");
    expect(phone.whatsappNoContactRevision).toBe(4n);
    await f.service.handleInbound(event());
    expect(phone.whatsappNoContactRevision).toBe(4n);
  });

  it("never resets a prior STOP or sends Meta/Shopify mutation", async () => {
    const phone = row("a", "shop-a");
    phone.whatsappNoContact = true;
    phone.whatsappNoContactReason = "CUSTOMER_STOP";
    phone.whatsappNoContactRevision = 7n;
    phone.whatsappNoContactAt = new Date("2026-10-01T00:00:00Z");
    const f = setup([phone]);
    await f.service.handleInbound(event());
    expect(phone.whatsappNoContactRevision).toBe(7n);
    expect(phone.whatsappNoContactAt).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(f.tx.customerPhone.updateMany).not.toHaveBeenCalled();
  });

  it("reports unmatched or invalid canonical sender without writing unrelated phones", async () => {
    const f = setup([row("a", "shop-a")]);
    expect(await f.service.handleInbound(event({ customerPhone: "not-a-number" }))).toBe(true);
    expect(await f.service.handleInbound(event({ customerPhone: "447400123458" }))).toBe(true);
    expect(f.tx.customerPhone.updateMany).not.toHaveBeenCalled();
    expect(f.notices.size).toBe(0);
    expect(f.logger.warn).toHaveBeenCalledWith("whatsapp.stop.unmatched", expect.objectContaining({ reasonCode: "NO_ACTIVE_CUSTOMER_PHONE" }));
  });

  it("refuses foreign provider identities before database work", async () => {
    const f = setup([row("a", "shop-a")]);
    expect(await f.service.handleInbound(event({ providerPhoneNumberId: "foreign" }))).toBe(true);
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it("suppresses all outbound modes for stopped shop/number, but not different numbers or shops", async () => {
    const query = vi.fn(async () => [{
      phone: "07400 123456", whatsappCanonicalPhone: null, defaultCountryCode: "GB",
    }]);
    expect(await hasLocalNoContact({ $queryRawUnsafe: query } as never,
      { shopId: "shop-a", recipient: number })).toBe(true);
    expect(await hasLocalNoContact({ $queryRawUnsafe: query } as never,
      { shopId: "shop-a", recipient: other })).toBe(false);
    expect(query.mock.calls[0]![2]).toBe("shop-a");
  });
});
