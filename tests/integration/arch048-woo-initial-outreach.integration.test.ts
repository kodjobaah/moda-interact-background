import "dotenv/config";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { outboundWhatsAppAdmissionService } from "../../src/services/outbound-whatsapp-admission.service.js";
import { whatsAppService } from "../../src/services/whatsapp.service.js";
import { platformConsumerConfiguration } from "../../src/services/platform-configuration/consumers.js";
import type { BackgroundReadableKey, ConfigurationSnapshot } from "../../src/services/platform-configuration/contracts.js";
import { createWooRecoveryOutreachService } from "../../src/services/woocommerce-recovery/woo-recovery-outreach.adapters.js";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { WOO_TEST_SENDER_WABA } from "./fixtures/woo-approved-initial-template.fixture.js";
import {
  createWooOutreachFixture,
  type WooOutreachIntegrationFixture,
} from "./fixtures/arch048-woo-outreach.fixture.js";

const integration = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

integration("ARCH-048-BACKGROUND-004 Woo initial outreach (disposable Postgres + Redis)", () => {
  let f: WooOutreachIntegrationFixture | undefined;

  beforeEach(async () => {
    const readConfiguration = platformConsumerConfiguration.read.bind(platformConsumerConfiguration);
    vi.spyOn(platformConsumerConfiguration, "read").mockImplementation(
      async <K extends BackgroundReadableKey>(key: K): Promise<ConfigurationSnapshot<K>> => {
        if (key === "messaging.sender") {
          return {
            key, version: 1,
            value: { accessToken: "integration-token", phoneNumberId: "123456789", businessAccountId: "987654321" },
          } as ConfigurationSnapshot<K>;
        }
        return readConfiguration(key);
      },
    );
    vi.spyOn(outboundWhatsAppAdmissionService, "getProviderAccountId")
      .mockResolvedValue(WOO_TEST_SENDER_WABA);
    vi.spyOn(whatsAppService, "getProviderAccountId")
      .mockResolvedValue(WOO_TEST_SENDER_WABA);
    // The frozen registration, approval, category and language are persisted
    // in the disposable DB; the provider transport is still controlled.

    f = await createWooOutreachFixture();
  });

  afterEach(async () => {
    try { if (f) await f.cleanup(); }
    finally { f = undefined; vi.restoreAllMocks(); }
  });

  it("creates only one durable sequence-1 attempt and one BullMQ job across concurrent DB-locked requests", async () => {
    const a = f!;
    const enqueued = await Promise.all([
      a.service.enqueueInitial(a.recoveryId),
      a.service.enqueueInitial(a.recoveryId),
    ]);
    expect(enqueued.map((r) => r.kind)).toEqual(["queued", "queued"]);
    expect(enqueued[0]).toEqual(enqueued[1]);
    const attempts = await a.db.recoveryOutreachAttempt.findMany({
      where: { checkoutRecoveryId: a.recoveryId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ sequence: 1, status: "PENDING", followUpDueAt: null });
    expect(await a.queue.getJobCounts("waiting", "active", "completed", "failed"))
      .toMatchObject({ waiting: 1, active: 0, completed: 0, failed: 0 });
    expect(await a.db.usageReservation.count({ where: { shopId: a.shopId } })).toBe(0);
    const job = await a.queue.getJob(`arch048-${attempts[0]!.id}`);
    expect(job?.data).toMatchObject({ recoveryId: a.recoveryId, attemptId: attempts[0]!.id });
  }, 90_000);

  it("persists exactly one confirmed send, Free credit charge and usage event under concurrent dispatch/replay", async () => {
    const a = f!;
    await a.service.enqueueInitial(a.recoveryId);
    const dispatched = await Promise.all([
      a.service.processInitial(a.recoveryId),
      a.service.processInitial(a.recoveryId),
    ]);
    expect(dispatched.map((r) => r.kind).sort()).toEqual(["already-initialized", "sent"]);
    expect(a.providerRequests).toBe(1);
    expect((await a.db.checkoutRecovery.findUniqueOrThrow({ where: { id: a.recoveryId } })).status)
      .toBe("MESSAGE_SENT");
    const attempts = await a.db.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: a.recoveryId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sequence: 1, status: "WAITING_FOR_RESPONSE", followUpDueAt: null,
    });
    expect(attempts[0]!.outboundMessageId).toBeTruthy();
    expect(await a.db.conversationMessage.count({ where: {
      id: attempts[0]!.outboundMessageId!, status: "SENT", direction: "OUTBOUND",
    } })).toBe(1);
    const admittedMessage = await a.db.conversationMessage.findUniqueOrThrow({
      where: { id: attempts[0]!.outboundMessageId! },
      select: { providerDispatchKey: true, providerDispatchAdmittedAt: true, providerDispatchControlRevision: true },
    });
    expect(admittedMessage.providerDispatchKey).toBe(`recovery-outreach:${attempts[0]!.id}`);
    expect(admittedMessage.providerDispatchAdmittedAt).not.toBeNull();
    expect(admittedMessage.providerDispatchControlRevision).toBe(0);
    const reservations = await a.db.usageReservation.findMany({ where: { shopId: a.shopId } });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ status: "COMMITTED", quantity: 1 });
    expect(await a.db.usageEvent.count({ where: {
      shopId: a.shopId, metric: "RECOVERY_CONVERSATION",
    } })).toBe(1);
    const counter = await a.db.shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: a.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    });
    expect(counter).toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
    await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({ kind: "already-initialized" });
    expect(a.providerRequests).toBe(1);
    expect(await a.db.usageEvent.count({ where: { shopId: a.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(1);
  }, 90_000);

  it.each(["placed", "paid", "cancelled"] as const)(
    "releases the reserved credit when %s arrives after the last preflight but before provider permit",
    async (kind) => {
      const a = f!;
      await a.service.enqueueInitial(a.recoveryId);
      a.setBeforePermit(async () => { await a.setObservedOrder(kind); });
      await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({
        kind: "suppressed", reason: "final-send-denied",
      });
      expect(a.providerRequests).toBe(0);
      const attempts = await a.db.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: a.recoveryId } });
      expect(attempts).toHaveLength(1);
      // No provider permit was committed. Releasing the credit must not
      // terminally fail sequence one: only a definitive provider failure does.
      expect(attempts[0]).toMatchObject({
        sequence: 1, status: "PENDING", sentAt: null, outboundMessageId: null,
      });
      // The retained attempt is not permission to contact an ordered checkout.
      // Replaying the job must observe the terminal order and remain charge-free.
      await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({
        kind: "suppressed", reason: "observed-order-terminal",
      });
      expect(a.providerRequests).toBe(0);
      expect(await a.db.conversationMessage.count({ where: {
        conversation: { checkoutRecoveryId: a.recoveryId }, direction: "OUTBOUND",
      } })).toBe(0);
      const reservations = await a.db.usageReservation.findMany({ where: { shopId: a.shopId } });
      expect(reservations).toHaveLength(1);
      expect(reservations[0]!.status).toBe("RELEASED");
      const counter = await a.db.shopEntitlementCounter.findUniqueOrThrow({
        where: { shopId_counter: { shopId: a.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
      });
      expect(counter).toMatchObject({ committedQuantity: 0, reservedQuantity: 0 });
      expect(await a.db.usageEvent.count({ where: { shopId: a.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(0);
    }, 90_000,
  );

  it("rechecks authoritative local STOP after reservation and refunds without sending", async () => {
    const a = f!;
    await a.service.enqueueInitial(a.recoveryId);
    a.setBeforePermit(async () => { await a.stop(); });
    await expect(a.service.processInitial(a.recoveryId)).resolves.toMatchObject({
      kind: "suppressed", reason: "final-send-denied",
    });
    expect(a.providerRequests).toBe(0);
    expect((await a.db.customerPhone.findUniqueOrThrow({ where: { id: a.phoneId } })).whatsappNoContact)
      .toBe(true);
    expect(await a.db.usageReservation.findFirst({ where: { shopId: a.shopId } }))
      .toMatchObject({ status: "RELEASED" });
    expect(await a.db.usageEvent.count({ where: { shopId: a.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(0);
  }, 90_000);

  it("keeps outbound default-off in production configuration and does not publish or reserve", async () => {
    const a = f!;
    const guarded = createWooRecoveryOutreachService({
      coordinator: { withCheckoutLock: async (_ref, run) => run() },
      orders: { read: async () => ({ kind: "none-observed" }) },
      guardedSender: {
        sendInitial: async () => { throw new Error("NO_PROVIDER_CALL_ALLOWED"); },
        findExistingAdmission: async () => null,
      },
      enqueue: { initial: async () => { throw new Error("NO_QUEUE_ALLOWED"); } },
      logger: createLogger({ serviceName: "moda-recovery-worker", environment: "test" }),
    });
    expect(await guarded.enqueueInitial(a.recoveryId))
      .toEqual({ kind: "suppressed", reason: "woo-outbound-disabled" });
    expect(await guarded.processInitial(a.recoveryId))
      .toEqual({ kind: "suppressed", reason: "woo-outbound-disabled" });
    expect(await a.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: a.recoveryId } })).toBe(0);
    expect(await a.db.usageReservation.count({ where: { shopId: a.shopId } })).toBe(0);
  }, 90_000);
});
