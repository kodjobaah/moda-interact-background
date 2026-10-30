import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { WhatsAppInboundEvent } from "../../src/integration/whatsapp/types.js";
import { RecoveryRoutingService } from "../../src/services/recovery-routing.service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const PHONE = "+447700900123";

const event = (providerMessageId: string, contextMessageId: string | null = null): WhatsAppInboundEvent => ({
  schemaVersion: 1, provider: "whatsapp", providerAccountId: "account", providerPhoneNumberId: "sender",
  providerMessageId, customerPhone: PHONE, contextMessageId, occurredAt: new Date().toISOString(),
  content: { type: "text", text: "help" },
});

integration("ARCH-048 BG010: PostgreSQL multi-generation inbound routing", () => {
  it("routes an unreferenced reply to the latest sent generation while explicit old context stays historical", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shopId = randomUUID();
    const token = `checkout-${randomUUID()}`;
    const customerId = randomUUID();
    const oldRecoveryId = randomUUID();
    const currentRecoveryId = randomUUID();
    const oldConversationId = randomUUID();
    const currentConversationId = randomUUID();
    const oldProviderId = `outbound-old-${randomUUID()}`;
    try {
      await db.shop.create({ data: {
        id: shopId, domain: `${shopId}.example.test`, platform: "WOOCOMMERCE", status: "ACTIVE",
      } });
      await db.customer.create({ data: { id: customerId, shopId, phone: PHONE } });
      await db.checkoutRecovery.createMany({ data: [
        { id: oldRecoveryId, shopId, checkoutToken: token, customerId, generation: 1,
          status: "CANCELLED", lastExternalActivityAt: new Date() },
        { id: currentRecoveryId, shopId, checkoutToken: token, customerId, generation: 2,
          status: "MESSAGE_SENT", lastExternalActivityAt: new Date() },
      ] });
      await db.conversation.createMany({ data: [
        { id: oldConversationId, type: "RECOVERY", checkoutRecoveryId: oldRecoveryId },
        { id: currentConversationId, type: "RECOVERY", checkoutRecoveryId: currentRecoveryId },
      ] });
      await db.conversationMessage.createMany({ data: [
        { conversationId: oldConversationId, providerMessageId: oldProviderId, direction: "OUTBOUND",
          senderType: "AUTOMATION", status: "SENT", content: "Old basket", sentAt: new Date() },
        { conversationId: currentConversationId, providerMessageId: `outbound-new-${randomUUID()}`, direction: "OUTBOUND",
          senderType: "AUTOMATION", status: "SENT", content: "Current basket", sentAt: new Date() },
      ] });

      const service = new RecoveryRoutingService(db, { isShopExecutionActive: async () => true }, {
        resolveSender: async () => ({ providerAccountId: "account", providerPhoneNumberId: "sender" }),
      });
      expect(await service.resolveInboundMessage(event(`inbound-${randomUUID()}`))).toMatchObject({
        kind: "resolved", conversationId: currentConversationId,
        checkoutRecoveryId: currentRecoveryId, mode: "active",
      });
      expect(await service.resolveInboundMessage(event(`inbound-${randomUUID()}`, oldProviderId))).toMatchObject({
        kind: "resolved", conversationId: oldConversationId,
        checkoutRecoveryId: oldRecoveryId, mode: "historical",
      });
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);

  it("keeps distinct eligible shop/checkout owners ambiguous and excludes an unsent latest generation", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shopIds = [randomUUID(), randomUUID()];
    const tokenA = `checkout-a-${randomUUID()}`;
    const tokenB = `checkout-b-${randomUUID()}`;
    const customerIds = [randomUUID(), randomUUID()];
    const recoveryIds = [randomUUID(), randomUUID()];
    const conversationIds = [randomUUID(), randomUUID()];
    const unsentRecoveryId = randomUUID();
    const unsentConversationId = randomUUID();
    try {
      await db.shop.createMany({ data: shopIds.map((id) => ({
        id, domain: `${id}.example.test`, platform: "WOOCOMMERCE", status: "ACTIVE",
      })) });
      await db.customer.createMany({ data: customerIds.map((id, i) => ({ id, shopId: shopIds[i]!, phone: PHONE })) });
      await db.checkoutRecovery.createMany({ data: recoveryIds.map((id, i) => ({
        id, shopId: shopIds[i]!, checkoutToken: i === 0 ? tokenA : tokenB,
        customerId: customerIds[i]!, generation: 1, status: "ENGAGED", lastExternalActivityAt: new Date(),
      })) });
      await db.conversation.createMany({ data: conversationIds.map((id, i) => ({
        id, type: "RECOVERY", checkoutRecoveryId: recoveryIds[i]!,
      })) });
      await db.conversationMessage.createMany({ data: conversationIds.map((conversationId) => ({
        conversationId, providerMessageId: `outbound-${randomUUID()}`, direction: "OUTBOUND",
        senderType: "AUTOMATION", status: "SENT", content: "Basket", sentAt: new Date(),
      })) });
      const service = new RecoveryRoutingService(db, { isShopExecutionActive: async () => true }, {
        resolveSender: async () => ({ providerAccountId: "account", providerPhoneNumberId: "sender" }),
      });
      expect(await service.resolveInboundMessage(event(`ambiguous-${randomUUID()}`))).toEqual({
        kind: "guidance", reason: "MULTIPLE_RECOVERIES",
      });

      await db.checkoutRecovery.updateMany({ where: { id: { in: recoveryIds } }, data: { status: "CANCELLED" } });
      await db.checkoutRecovery.create({ data: {
        id: unsentRecoveryId, shopId: shopIds[0]!, checkoutToken: tokenA,
        customerId: customerIds[0]!, generation: 2, status: "DETECTED", lastExternalActivityAt: new Date(),
      } });
      await db.conversation.create({ data: {
        id: unsentConversationId, type: "RECOVERY", checkoutRecoveryId: unsentRecoveryId,
      } });
      expect(await service.resolveInboundMessage(event(`unsent-latest-${randomUUID()}`))).toEqual({
        kind: "guidance", reason: "NO_RECOVERY",
      });
    } finally {
      await db.shop.deleteMany({ where: { id: { in: shopIds } } });
      await db.$disconnect();
    }
  }, 45_000);

  it("preserves Shopify ambiguity across older generations and terminal statuses", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const shopId = randomUUID();
    const customerId = randomUUID();
    const token = `shopify-checkout-${randomUUID()}`;
    const recoveryIds = [randomUUID(), randomUUID()];
    const conversationIds = [randomUUID(), randomUUID()];
    try {
      await db.shop.create({
        data: { id: shopId, domain: `${shopId}.example.test`, platform: "SHOPIFY", status: "ACTIVE" },
      });
      await db.customer.create({ data: { id: customerId, shopId, phone: PHONE } });
      await db.checkoutRecovery.createMany({ data: recoveryIds.map((id, i) => ({
        id, shopId, checkoutToken: token, customerId, generation: i + 1,
        status: i === 0 ? "CANCELLED" : "MESSAGE_SENT", lastExternalActivityAt: new Date(),
      })) });
      await db.conversation.createMany({ data: conversationIds.map((id, i) => ({
        id, type: "RECOVERY", checkoutRecoveryId: recoveryIds[i]!,
      })) });
      await db.conversationMessage.createMany({ data: conversationIds.map((conversationId) => ({
        conversationId, providerMessageId: `shopify-outbound-${randomUUID()}`, direction: "OUTBOUND",
        senderType: "AUTOMATION", status: "SENT", content: "Basket", sentAt: new Date(),
      })) });

      const service = new RecoveryRoutingService(db, { isShopExecutionActive: async () => true }, {
        resolveSender: async () => ({ providerAccountId: "account", providerPhoneNumberId: "sender" }),
      });
      expect(await service.resolveInboundMessage(event(`shopify-inbound-${randomUUID()}`))).toEqual({
        kind: "guidance", reason: "MULTIPLE_RECOVERIES",
      });
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);
});
