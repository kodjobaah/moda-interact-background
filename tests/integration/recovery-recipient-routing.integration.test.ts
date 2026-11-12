import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { WhatsAppInboundEvent } from "../../src/integration/whatsapp/types.js";
import { RecoveryRoutingService } from "../../src/services/recovery-routing.service.js";

const url = process.env.TEST_DATABASE_URL;
const integration = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const phone = "447400123456";
const otherPhone = "447400123457";
function event(contextMessageId: string | null = null, recipient = phone, providerMessageId = randomUUID()): WhatsAppInboundEvent {
  return { schemaVersion: 1, provider: "whatsapp", providerAccountId: "account", providerPhoneNumberId: "sender",
    providerMessageId, customerPhone: recipient, contextMessageId, occurredAt: new Date().toISOString(),
    content: { type: "text", text: "Can you tell me about this snowboard?" } };
}
function router(db: PrismaClient) {
  return new RecoveryRoutingService(db, { isShopExecutionActive: async () => true }, {
    resolveSender: async () => ({ providerAccountId: "account", providerPhoneNumberId: "sender" }),
  });
}
async function fixture(db: PrismaClient) {
  const shopId = randomUUID();
  const customer = await db.customer.create({ data: {
    shop: { create: { id: shopId, domain: `${shopId}.myshopify.com`, platform: "SHOPIFY", defaultCountryCode: "US" } },
    shopifyCustomerId: `${Date.now()}${Math.floor(Math.random() * 10000)}`,
  } });
  const currentPhone = await db.customerPhone.create({ data: {
    customerId: customer.id, phone: `+${phone}`, whatsappCanonicalPhone: phone,
  } });
  const recovery = await db.checkoutRecovery.create({ data: {
    shopId, customerId: customer.id, checkoutToken: randomUUID(), status: "MESSAGE_SENT", lastExternalActivityAt: new Date(),
  } });
  const conversation = await db.conversation.create({ data: { type: "RECOVERY", checkoutRecoveryId: recovery.id } });
  const outbound = await db.conversationMessage.create({ data: {
    conversationId: conversation.id, providerMessageId: randomUUID(), direction: "OUTBOUND", senderType: "AUTOMATION",
    content: "Your basket", status: "SENT", sentAt: new Date(),
  } });
  await db.recoveryOutreachAttempt.create({ data: {
    checkoutRecoveryId: recovery.id, recipient: phone, sequence: 1, trigger: "INITIAL", configuredOfferMode: "NONE",
    status: "WAITING_FOR_RESPONSE", outboundMessageId: outbound.id, sentAt: outbound.sentAt,
  } });
  return { shopId, customer, currentPhone, recovery, conversation, outbound };
}

integration("current recipient recovery reply routing", () => {
  it("routes quoted and ordinary replies with a null legacy phone, keeps multi-store replies ambiguous and pins replays", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shops: string[] = [];
    try {
      const a = await fixture(db); shops.push(a.shopId);
      const service = router(db);
      const first = event();
      await expect(service.resolveInboundMessage(first)).resolves.toMatchObject({ kind: "resolved",
        conversationId: a.conversation.id, checkoutRecoveryId: a.recovery.id, shopId: a.shopId });
      await expect(service.resolveInboundMessage(event(a.outbound.providerMessageId))).resolves.toMatchObject({
        kind: "resolved", conversationId: a.conversation.id,
      });
      await db.conversationMessage.create({ data: {
        conversationId: a.conversation.id, providerMessageId: first.providerMessageId,
        direction: "INBOUND", senderType: "CUSTOMER", content: "Snowboard question", status: "SENT",
      } });
      const b = await fixture(db); shops.push(b.shopId);
      await expect(service.resolveInboundMessage(event())).resolves.toEqual({ kind: "guidance", reason: "MULTIPLE_RECOVERIES" });
      await expect(service.resolveInboundMessage(event(b.outbound.providerMessageId))).resolves.toMatchObject({
        kind: "resolved", conversationId: b.conversation.id, shopId: b.shopId,
      });
      await expect(service.resolveInboundMessage({ ...first, contextMessageId: b.outbound.providerMessageId }))
        .resolves.toMatchObject({ kind: "resolved", conversationId: a.conversation.id, shopId: a.shopId });
    } finally { await db.shop.deleteMany({ where: { id: { in: shops } } }); await db.$disconnect(); }
  });

  it("never transfers old outreach to a changed current number or revives an ended phone through legacy data", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      const f = await fixture(db); shopId = f.shopId;
      await db.customer.update({ where: { id: f.customer.id }, data: { phone: `+${phone}` } });
      await db.customerPhone.update({ where: { id: f.currentPhone.id }, data: { endedAt: new Date() } });
      await db.customerPhone.create({ data: { customerId: f.customer.id, phone: `+${otherPhone}`, whatsappCanonicalPhone: otherPhone } });
      const service = router(db);
      for (const recipient of [phone, otherPhone]) {
        await expect(service.resolveInboundMessage(event(null, recipient))).resolves.toEqual({ kind: "guidance", reason: "NO_RECOVERY" });
        await expect(service.resolveInboundMessage(event(f.outbound.providerMessageId, recipient)))
          .resolves.toEqual({ kind: "guidance", reason: "INVALID_REFERENCE" });
      }
      await db.customerPhone.updateMany({ where: { customerId: f.customer.id }, data: { endedAt: new Date() } });
      await expect(service.resolveInboundMessage(event())).resolves.toEqual({ kind: "guidance", reason: "NO_RECOVERY" });
    } finally { if (shopId) await db.shop.delete({ where: { id: shopId } }); await db.$disconnect(); }
  });

  it("rejects STOP and ambiguous current phone rows without falling back to Customer.phone", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      const f = await fixture(db); shopId = f.shopId;
      const service = router(db);
      await db.customer.update({ where: { id: f.customer.id }, data: { phone: `+${phone}` } });
      await db.customerPhone.update({ where: { id: f.currentPhone.id }, data: {
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP", whatsappNoContactAt: new Date(),
        whatsappNoContactRevision: { increment: 1 },
      } });
      await expect(service.resolveInboundMessage(event())).resolves.toEqual({ kind: "guidance", reason: "NO_RECOVERY" });
      await expect(service.resolveInboundMessage(event(f.outbound.providerMessageId)))
        .resolves.toEqual({ kind: "guidance", reason: "INVALID_REFERENCE" });
      await db.customerPhone.create({ data: { customerId: f.customer.id, phone: `+${phone}` } });
      await expect(service.resolveInboundMessage(event())).resolves.toEqual({ kind: "guidance", reason: "NO_RECOVERY" });
    } finally { if (shopId) await db.shop.delete({ where: { id: shopId } }); await db.$disconnect(); }
  });
});
