import "dotenv/config";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it } from "vitest";
import { WhatsAppProviderStatusService } from "../../src/services/whatsapp-provider-status.service.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-040 HUMAN provider receipts, status ordering and credit compensation", () => {
  it("reconciles HUMAN command receipts and keeps duplicate/out-of-order status monotonic", async () => {
    const f = await humanDispatchFixture("human-provider-receipts");
    try {
      const commandIds = [await f.addCommand(), await f.addCommand()];
      const claims = await f.commands.claimDueHumanCommands({ limit: 2, now: new Date() });
      const dispatcher = f.dispatcher();
      for (const claim of claims) await dispatcher.processClaim(claim.id, claim.leaseToken);
      await dispatcher.close();

      const commands = await Promise.all(commandIds.map((id) =>
        f.db.merchantConversationSendCommand.findUniqueOrThrow({
          where: { id }, select: { state: true, outboundMessageId: true },
        })));
      // The two prior HUMAN_TEXT sends occurred during a verified service window.
      // Advance the customer's recorded inbound evidence beyond 24 hours before
      // opening a deliberate template follow-up; cached lastInboundAt alone is
      // not sufficient to close a newly verified window.
      const postWindowInboundAt = new Date(Date.now() - 25 * 60 * 60_000);
      await f.db.conversationMessage.updateMany({
        where: { conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER" },
        data: { createdAt: postWindowInboundAt },
      });
      await f.db.conversation.update({ where: { id: f.conversationId },
        data: { lastInboundAt: postWindowInboundAt } });
      const followUp = await f.addMerchantFollowUpCommand();
      const followUpDispatcher = f.dispatcher();
      await followUpDispatcher.poll();
      await followUpDispatcher.close();
      const followUpCommand = await f.db.merchantConversationSendCommand.findUniqueOrThrow({
        where: { id: followUp.commandId }, select: { state: true, outboundMessageId: true },
      });
      const messages = await Promise.all(commands.map((command) =>
        f.db.conversationMessage.findUniqueOrThrow({
          where: { id: command.outboundMessageId! }, select: { id: true, providerMessageId: true },
        })));
      const followUpMessage = await f.db.conversationMessage.findUniqueOrThrow({
        where: { id: followUpCommand.outboundMessageId! },
        select: { id: true, providerMessageId: true },
      });
      // The dispatcher deliberately uses a billing mock. Seed the *committed*
      // source that real billing would persist after Meta accepted the template,
      // so ARCH-028 provider-status compensation has verifiable original lineage.
      const followUpSourceKey = createRecoveryIdempotencyKey(
        f.shopId, `recovery-outreach:${followUp.attemptId}`,
      );
      const followUpCounter = await f.db.shopEntitlementCounter.create({ data: {
        shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
        grantedQuantity: 1, committedQuantity: 1,
      } });
      const followUpReservation = await f.db.usageReservation.create({ data: {
        shopId: f.shopId, counterId: followUpCounter.id,
        sourceKey: followUpSourceKey, quantity: 1, status: "COMMITTED",
      } });
      const originalUsage = await f.db.usageEvent.create({ data: {
        shopId: f.shopId, provider: "SHOPIFY", metric: "RECOVERY_CONVERSATION", quantity: 1,
        idempotencyKey: createRecoveryIdempotencyKey(f.shopId, followUpSourceKey),
        sourceType: "FREE_RECOVERY_RESERVATION", sourceId: followUpReservation.id,
        shopifyReportState: "NOT_APPLICABLE",
      } });
      await f.db.usageReservation.update({
        where: { id: followUpReservation.id },
        data: { committedUsageEventId: originalUsage.id },
      });
      const statuses = new WhatsAppProviderStatusService(f.db as never, {
        debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({}),
      } as never);
      const event = {
        schemaVersion: 2 as const,
        providerAccountId: "receipt-account",
        providerPhoneNumberId: "receipt-phone",
        providerMessageId: messages[0]!.providerMessageId!,
        status: "READ" as const,
        occurredAt: new Date().toISOString(),
      };

      await expect(statuses.process(event)).resolves.toBe("applied");
      await expect(statuses.process(event)).resolves.toBe("ignored");
      await statuses.process({ ...event, status: "DELIVERED" });
      await statuses.process({ ...event, status: "FAILED" });

      const failedEvent = {
        ...event,
        providerMessageId: messages[1]!.providerMessageId!,
        schemaVersion: 3 as const,
        status: "FAILED" as const,
        failure: { providerCode: "131026" },
      };
      await expect(statuses.process(failedEvent)).resolves.toBe("applied");
      await expect(statuses.process(failedEvent)).resolves.toBe("ignored");

      const failedFollowUpEvent = {
        ...failedEvent,
        providerMessageId: followUpMessage.providerMessageId!,
        schemaVersion: 3 as const,
      };
      await expect(statuses.process(failedFollowUpEvent)).resolves.toBe("applied");
      // A repeated FAILED receipt must not credit the same recovery twice.
      await expect(statuses.process(failedFollowUpEvent)).resolves.toBe("ignored");
      expect(await f.db.usageReservation.findUniqueOrThrow({
        where: { id: followUpReservation.id },
        select: { status: true, compensationDisposition: true, compensationUsageEventId: true },
      })).toEqual({
        status: "COMMITTED", compensationDisposition: "RESTORED_SPENDABLE",
        compensationUsageEventId: expect.any(String),
      });
      expect((await f.db.shopEntitlementCounter.findUniqueOrThrow({
        where: { id: followUpCounter.id },
      })).committedQuantity).toBe(0);
      expect(await f.db.usageEvent.count({
        where: { correctionOfUsageEventId: originalUsage.id },
      })).toBe(1);
      expect(await f.db.recoveryOutreachAttempt.findUnique({
        where: { id: followUp.attemptId }, select: { status: true, failureCode: true },
      })).toEqual({ status: "FAILED", failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE" });
      expect(await f.db.usageReservation.findUniqueOrThrow({
        where: { sourceKey: followUpSourceKey },
        select: { status: true, compensationReason: true, compensationDisposition: true },
      })).toEqual({ status: "COMMITTED", compensationReason: "WHATSAPP_RECIPIENT_UNDELIVERABLE",
        compensationDisposition: "RESTORED_SPENDABLE" });

      expect(await f.db.conversationMessage.findUnique({
        where: { id: messages[0]!.id }, select: { status: true, readAt: true },
      })).toEqual(expect.objectContaining({ status: "READ", readAt: expect.any(Date) }));
      expect(await f.db.merchantConversationSendCommand.findUnique({
        where: { id: commandIds[0] }, select: { state: true },
      })).toEqual({ state: "SENT" });
      expect(await f.db.conversationMessage.findUnique({
        where: { id: messages[1]!.id }, select: { status: true, providerFailureCode: true },
      })).toEqual({ status: "FAILED", providerFailureCode: "131026" });
      expect(await f.db.merchantConversationSendCommand.findUnique({
        where: { id: commandIds[1] }, select: { state: true, failureCode: true },
      })).toEqual({ state: "SENT", failureCode: null });
      expect(await f.db.usageEvent.count({
        where: { shopId: f.shopId, metric: "DELIVERED_WHATSAPP_MESSAGE" },
      })).toBe(1);
      expect(f.providerHttpRequests).toEqual([{ type: "text" }, { type: "text" }, { type: "template" }]);
    } finally { await f.close(); }
  }, 60_000);
});
