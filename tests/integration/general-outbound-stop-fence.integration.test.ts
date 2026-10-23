import { randomInt, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { OutboundMessageDeliveryService } from "../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { GeneralOutboundSendFenceService } from "../../src/services/outbound-whatsapp-admission/general-outbound-send-fence.service.js";
import { writeLocalStop } from "../../src/services/whatsapp-contact-opt-out/stop-writer.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
// Disjoint from STOP-suite fixtures; the same recipient stays shared within
// each single scenario when testing Shop-lock ordering.
function recipientFor(group: number) {
  const phone = `+447400${group}${randomInt(1000, 10_000)}`;
  return { phone, canonical: phone.slice(1) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

describeWithDatabase("ARCH-045 general WhatsApp send / STOP Shop-lock ordering", () => {
  it.each(["text", "template"])(
    "does not dispatch a general %s after STOP commits first",
    async (kind) => {
      const db = new PrismaClient({ datasourceUrl: url! });
      const suffix = randomUUID().replaceAll("-", "");
      const { phone, canonical } = recipientFor(kind === "text" ? 21 : 22);
      const shopId = `general-stop-${suffix}`;
      const stopLockedShop = deferred();
      const releaseStop = deferred();
      const sendAttemptedShopLock = deferred();
      const operations: Array<Promise<unknown>> = [];
      try {
        await db.shop.create({ data: {
          id: shopId, domain: `${shopId}.example.com`, defaultCountryCode: "GB",
        } });
        const customer = await db.customer.create({ data: { shopId } });
        const registered = await db.customerPhone.create({ data: {
          customerId: customer.id, phone, whatsappCanonicalPhone: canonical,
        } });
        const conversation = await db.conversation.create({ data: {
          shopId, customerId: customer.id, type: "PRODUCT_SUPPORT",
        } });
        const message = await db.conversationMessage.create({ data: {
          conversationId: conversation.id, senderType: "AGENT", direction: "OUTBOUND",
          content: "Prepared support reply", status: "PENDING",
        } });

        // Instrument ONLY the Shop-row lock. STOP holds its real PostgreSQL lock
        // until the send has tried to acquire the same lock in its own transaction.
        const pausedStopDatabase = {
          $transaction: (fn: (tx: unknown) => Promise<unknown>, options: never) =>
            db.$transaction(async (tx) => fn({
              customerPhone: tx.customerPhone,
              $queryRawUnsafe: async (statement: string, ...args: unknown[]) => {
                const result = await tx.$queryRawUnsafe(statement, ...args);
                if (statement.includes('"commerce"."Shop"') && statement.includes("FOR UPDATE")) {
                  stopLockedShop.resolve();
                  await releaseStop.promise;
                }
                return result;
              },
            }), options),
        };
        const observingSendDatabase = {
          $transaction: (fn: (tx: unknown) => Promise<unknown>, options: never) =>
            db.$transaction(async (tx) => fn({
              $queryRawUnsafe: async (statement: string, ...args: unknown[]) => {
                if (statement.includes('"commerce"."Shop"') && statement.includes("FOR UPDATE"))
                  sendAttemptedShopLock.resolve();
                return tx.$queryRawUnsafe(statement, ...args);
              },
            }), options),
        };
        const provider = {
          sendWhatsAppText: vi.fn(async () => ({ providerMessageId: "unexpected-text" })),
          sendWhatsAppTemplate: vi.fn(async () => ({ providerMessageId: "unexpected-template" })),
        };
        const delivery = new OutboundMessageDeliveryService(
          db, provider as never,
          { evaluate: vi.fn(async () => ({ allowed: true, shopId })) } as never,
          { readTurnOwnership: vi.fn(async () => null) } as never,
          undefined,
          { assessText: vi.fn(async () => ({ kind: "allow" })),
            requireCurrentAllowance: vi.fn(async () => true) } as never,
          undefined, // providerFailure: use default adapter
          new GeneralOutboundSendFenceService(observingSendDatabase as never),
        );
        const stop = writeLocalStop(pausedStopDatabase as never, {
          canonical, shopId, eventId: `wamid-${suffix}`, at: new Date(),
        });
        operations.push(stop);
        await stopLockedShop.promise;

        const admission = {
          kind: "admitted" as const, shopId, conversationId: conversation.id,
          messageId: message.id, executionScope: "general" as const, terminal: false,
        };
        const send = kind === "text"
          ? delivery.sendPreparedText({ ...admission, to: phone, text: "Reply" })
          : delivery.sendPreparedTemplate(admission, {
            to: phone, templateName: "support", languageCode: "en",
          });
        operations.push(send);
        await sendAttemptedShopLock.promise;
        // The provider is not called while STOP still holds the Shop row.
        expect(provider.sendWhatsAppText).not.toHaveBeenCalled();
        expect(provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
        releaseStop.resolve();
        expect((await stop).changed).toBe(1);
        expect(await send).toEqual({ kind: "suppressed", reason: "conversation-invalid" });
        expect(provider.sendWhatsAppText).not.toHaveBeenCalled();
        expect(provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
        expect((await db.customerPhone.findUniqueOrThrow({ where: { id: registered.id } })).whatsappNoContact)
          .toBe(true);
        const final = await db.conversationMessage.findUniqueOrThrow({ where: { id: message.id } });
        expect(final.status).toBe("FAILED");
        expect(final.providerDispatchKey).toBeNull();
      } finally {
        releaseStop.resolve();
        await Promise.allSettled(operations);
        await db.shop.deleteMany({ where: { id: shopId } });
        await db.$disconnect();
      }
    },
    15_000,
  );

  it("permits an already-committed general dispatch before STOP, but not a replay", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const { phone, canonical } = recipientFor(23);
    const shopId = `general-admitted-${suffix}`;
    try {
      await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.com`, defaultCountryCode: "GB" } });
      const customer = await db.customer.create({ data: { shopId } });
      const record = await db.customerPhone.create({ data: {
        customerId: customer.id, phone, whatsappCanonicalPhone: canonical,
      } });
      const conversation = await db.conversation.create({ data: {
        shopId, customerId: customer.id, type: "PRODUCT_SUPPORT",
      } });
      const message = await db.conversationMessage.create({ data: {
        conversationId: conversation.id, senderType: "AGENT", direction: "OUTBOUND",
        content: "Prepared message", status: "PENDING",
      } });
      const fence = new GeneralOutboundSendFenceService(db);
      const input = {
        shopId, conversationId: conversation.id, messageId: message.id,
        recipient: phone, expectedContent: "Prepared message",
      };
      expect(await fence.admitFinalSend({ ...input, expectedContent: "Other text" })).toEqual({
        kind: "suppressed", reason: "invalid-scope",
      });
      expect((await db.conversationMessage.findUniqueOrThrow({ where: { id: message.id } })).providerDispatchKey)
        .toBeNull();
      expect(await fence.admitFinalSend(input)).toEqual({ kind: "admitted" });
      const admitted = await db.conversationMessage.findUniqueOrThrow({ where: { id: message.id } });
      expect(admitted.providerDispatchKey).toMatch(/^arch045-general-/);
      expect(admitted.providerDispatchAdmittedAt).not.toBeNull();

      expect((await writeLocalStop(db, { canonical, shopId, eventId: `wamid-${suffix}`,
        at: new Date() })).changed).toBe(1);
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: record.id } })).whatsappNoContact)
        .toBe(true);
      expect(await fence.admitFinalSend(input)).toEqual({
        kind: "suppressed", reason: "already-admitted-or-sent",
      });

      // A transport retry cannot overwrite the immutable content or release
      // usage after dispatch admission, even if STOP commits in the meantime.
      const provider = { sendWhatsAppText: vi.fn(), sendWhatsAppTemplate: vi.fn() };
      const delivery = new OutboundMessageDeliveryService(
        db, provider as never,
        { evaluate: vi.fn(async () => ({ allowed: true, shopId })) } as never,
      );
      expect(await delivery.sendPreparedText({
        kind: "admitted", shopId, conversationId: conversation.id, messageId: message.id,
        executionScope: "general", terminal: false, to: phone, text: "Unapproved retry body",
      })).toEqual({ kind: "suppressed", reason: "duplicate" });
      expect(provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect(provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect((await db.conversationMessage.findUniqueOrThrow({ where: { id: message.id } })).content)
        .toBe("Prepared message");
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  });
});
