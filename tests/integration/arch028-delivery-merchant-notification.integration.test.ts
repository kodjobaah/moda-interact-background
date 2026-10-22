import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { RecoveryDeliveryMerchantNotificationService } from
  "../../src/services/recovery-delivery-merchant-notification.service.js";
import { RecoveryDeliverySupportMessageService } from
  "../../src/services/recovery-delivery-support-message.service.js";
import { recoveryDeliveryNoticeSourceKey } from
  "../../src/services/recovery-delivery-notification-content.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

suite("ARCH-028-BACKGROUND-008 durable merchant notice", () => {
  it("writes exactly one SYSTEM message across concurrent correction replays", async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    const id = randomUUID();
    const shopId = `arch028-notice-${id}`;
    const recoveryId = randomUUID();
    const messageId = randomUUID();
    try {
      await db.shop.create({ data: { id: shopId, domain: `${id}.example.test` } });
      await db.checkoutRecovery.create({ data: {
        id: recoveryId, shopId, checkoutToken: `checkout-${id}`,
        lastExternalActivityAt: new Date(), status: "MESSAGE_SENT",
      } });
      const conversation = await db.conversation.create({ data: {
        type: "RECOVERY", checkoutRecoveryId: recoveryId,
      } });
      await db.conversationMessage.create({ data: {
        id: messageId, conversationId: conversation.id,
        direction: "OUTBOUND", senderType: "AUTOMATION", status: "FAILED",
        providerFailureCode: "131026", failedAt: new Date(),
        content: "checkout recovery message",
      } });
      const service = new RecoveryDeliveryMerchantNotificationService(
        db, new RecoveryDeliverySupportMessageService(db),
      );
      const results = await Promise.all([
        service.notify({ messageId }, "restored-spendable", "suppressed"),
        service.notify({ messageId }, "restored-spendable", "unchanged"),
      ]);
      expect(results.sort()).toEqual(["created", "duplicate"]);
      const sourceKey = recoveryDeliveryNoticeSourceKey(shopId, recoveryId, messageId);
      const messages = await db.merchantSupportMessage.findMany({
        where: { sourceKey }, include: { thread: true },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        kind: "SYSTEM", state: "AVAILABLE", sourceLanguageTag: "en-GB",
        systemCode: "ARCH028_RECOVERY_DELIVERY_FAILED",
      });
      expect(messages[0]?.thread.shopId).toBe(shopId);
      expect(messages[0]?.originalBody).not.toContain("131026");
      expect(messages[0]?.originalBody).not.toContain("447700900001");
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);
});
