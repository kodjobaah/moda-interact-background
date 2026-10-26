import "dotenv/config";
import { describe, expect, it, vi } from "vitest";
import { allowModerationFixture } from "./fixtures/arch040-allow-moderation.fixture.js";
import { PlatformConfigurationFailure } from "../../src/services/platform-configuration/errors.js";
import { humanDispatchFixture } from "./fixtures/recovery-human-dispatch.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("ARCH-040 HUMAN dispatcher: admission, concurrency and delivery", () => {
  it("missing sender config defers before permit and records a safe operational incident", async () => {
    const f = await humanDispatchFixture("sender-preflight-incident");
    try {
      const commandId = await f.addCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const incidents = { record: vi.fn(async () => {}) };
      const preflight = vi.fn(async () => { throw new PlatformConfigurationFailure("MISSING", "messaging.sender"); });
      const service = f.dispatcher(undefined, allowModerationFixture(), incidents, preflight);
      await service.processClaim(commandId, claim.leaseToken);
      expect(preflight).toHaveBeenCalledOnce();
      expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
        state: "FAILED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect(incidents.record).toHaveBeenCalledWith(expect.objectContaining({
        commandId, shopId: f.shopId, error: expect.any(PlatformConfigurationFailure), outcome: "pre_dispatch",
      }));
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      await service.close();
    } finally { await f.close(); }
  }, 60_000);

  it("incident reporter observes original sender-config exception after a durable UNKNOWN", async () => {
    const f = await humanDispatchFixture("sender-missing-incident");
    try {
      const commandId = await f.addCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const incidents = { record: vi.fn(async () => {}) };
      const original = f.provider.sendWhatsAppText;
      f.provider.sendWhatsAppText = vi.fn(async () => { throw new PlatformConfigurationFailure("MISSING", "messaging.sender"); });
      try {
        const service = f.dispatcher(undefined, allowModerationFixture(), incidents);
        await service.processClaim(commandId, claim.leaseToken);
        expect((await f.commandState(commandId))?.state).toBe("UNKNOWN");
        expect(incidents.record).toHaveBeenCalledWith(expect.objectContaining({
          commandId, shopId: f.shopId, error: expect.any(PlatformConfigurationFailure), outcome: "unknown",
        }));
        await service.close();
      } finally { f.provider.sendWhatsAppText = original; }
    } finally { await f.close(); }
  }, 60_000);

  it("blocks Meta after a shop suspension commits between screening and final admission", async () => {
    const f = await humanDispatchFixture("suspension-admission");
    try {
      const id = await f.addCommand();
      const claim = (await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      expect(claim.id).toBe(id);
      // The command has passed the Redis gate and was already leased; suspension
      // commits while the worker runs its subsequent execution eligibility check.
      f.execution.evaluate.mockImplementationOnce(async () => {
        await f.suspendShop();
        return { allowed: true } as const;
      });
      const service = f.dispatcher();
      await service.processClaim(id, claim.leaseToken);
      expect(await f.commandState(id)).toEqual(expect.objectContaining({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect(f.durableEligibility).not.toHaveBeenCalled();
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(0);
      await service.close();
    } finally { await f.close(); }
  }, 60_000);

  it("two real dispatcher replicas lease a single command and submit exactly one Meta request", async () => {
    const f = await humanDispatchFixture("two-replicas");
    try {
      const id = await f.addCommand();
      const replicaA = f.dispatcher();
      const replicaB = f.dispatcher();
      // Hold the HTTP request at the real WhatsApp transport boundary, not
      // in a fake sendWhatsAppText implementation. Replica B must not emit a
      // second request to the Background-owned emulator while A is in flight.
      const pendingHttp = f.holdNextProviderHttp();
      try {
        await replicaA.poll();
        await pendingHttp.entered;
        await replicaB.poll();
      } finally {
        pendingHttp.release();
        await Promise.all([replicaA.close(), replicaB.close()]);
      }
      await f.whatsapp.waitForMessageCount(1);
      expect(f.whatsapp.messages).toHaveLength(1);
      expect(f.whatsapp.messages[0]?.body.type).toBe("text");
      expect(f.providerHttpRequests).toEqual([{ type: "text" }]);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(f.durableEligibility).toHaveBeenCalledTimes(1);
      expect(await f.commandState(id)).toEqual(expect.objectContaining({
        state: "SENT", dispatchAttemptCount: 1,
        outboundMessageId: expect.any(String), providerDispatchKey: expect.any(String),
      }));
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(1);
      // Merchant replies must not consume the automated-message usage ledger.
      expect(await f.db.usageEvent.count({ where: {
        shopId: f.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE",
      } })).toBe(0);
      expect(await f.commands.claimDueHumanCommands({
        limit: 5, now: new Date(Date.now() + 120_000),
      })).toEqual([]);
    } finally { await f.close(); }
  }, 60_000);

  it("Redis rate denial stops final durable admission and prevents a second Meta submission", async () => {
    const f = await humanDispatchFixture("screening-rate");
    try {
      const firstId = await f.addCommand();
      const secondId = await f.addCommand();
      const leases = await f.commands.claimDueHumanCommands({ limit: 2, now: new Date() });
      const first = leases.find((lease) => lease.id === firstId)!;
      const second = leases.find((lease) => lease.id === secondId)!;
      const service = f.dispatcher({
        maxTextCharacters: 4000, shopPerMinute: 1,
        recipientPerHour: 100, repeatedIdenticalPerTenMinutes: 100,
      });
      await service.processClaim(first.id, first.leaseToken);
      await service.processClaim(second.id, second.leaseToken);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
      await f.whatsapp.waitForMessageCount(1);
      expect(f.whatsapp.messages).toHaveLength(1);
      expect(f.providerHttpRequests).toHaveLength(1);
      expect(f.durableEligibility).toHaveBeenCalledTimes(1);
      expect(f.billing.admitAndRevalidate).not.toHaveBeenCalled();
      expect(await f.commandState(secondId)).toEqual(expect.objectContaining({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      }));
      await service.close();
    } finally { await f.close(); }
  }, 60_000);

  it("denies queued HUMAN text after the verified customer window expires without template substitution", async () => {
    const f = await humanDispatchFixture("expired-human-window");
    try {
      const commandId = await f.addCommand({ seedVerifiedInbound: false });
      const expiredInboundAt = new Date(Date.now() - 25 * 60 * 60_000);
      await f.db.conversationMessage.create({ data: {
        conversationId: f.conversationId, direction: "INBOUND", senderType: "CUSTOMER",
        status: "DELIVERED", providerMessageId: `arch040-expired-${commandId}`,
        content: "Earlier customer reply", createdAt: expiredInboundAt,
      } });
      await f.db.conversation.update({ where: { id: f.conversationId },
        data: { lastInboundAt: expiredInboundAt } });
      const [claim] = await f.commands.claimDueHumanCommands({ limit: 1, now: new Date() });
      const service = f.dispatcher();
      await service.processClaim(commandId, claim!.leaseToken);
      await service.close();

      expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
        state: "CANCELLED", providerDispatchKey: null, outboundMessageId: null,
      }));
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(f.providerHttpRequests).toHaveLength(0);
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(0);
    } finally { await f.close(); }
  }, 60_000);

  it("dispatches producer-neutral commands identically with one HUMAN message per command", async () => {
    const f = await humanDispatchFixture("producer-neutral-parity");
    try {
      const commandIds = [await f.addCommand(), await f.addCommand()];
      const service = f.dispatcher();
      await service.poll();
      await service.close();

      await f.whatsapp.waitForMessageCount(2);
      expect(f.providerHttpRequests).toEqual([{ type: "text" }, { type: "text" }]);
      expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(2);
      expect(f.provider.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(await f.db.conversationMessage.count({
        where: { conversationId: f.conversationId, senderType: "HUMAN" },
      })).toBe(2);
      for (const commandId of commandIds) {
        expect(await f.commandState(commandId)).toEqual(expect.objectContaining({
          state: "SENT", dispatchAttemptCount: 1,
          outboundMessageId: expect.any(String), providerDispatchKey: expect.any(String),
        }));
      }
    } finally { await f.close(); }
  }, 60_000);
});
