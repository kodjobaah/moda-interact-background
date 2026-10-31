import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { WooInitialSendFenceService } from
  "../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";
import { writeLocalStop } from "../../src/services/whatsapp-contact-opt-out/stop-writer.js";
import { DIGITS, recordWooDecision, seedWooInitialPermit } from
  "./fixtures/woo-initial-send-fence.fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDatabase = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

withDatabase("ARCH-046 Woo initial permit: real PostgreSQL", () => {
  const clients: PrismaClient[] = [];
  const client = () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    clients.push(db);
    return db;
  };
  // Woo consent evidence is immutable and referenced by RESTRICT foreign keys.
  // Tests run only on the disposable integration database; don't mutate or
  // delete immutable consent history to clean up individual cases.
  afterAll(async () => {
    await Promise.all(clients.map((db) => db.$disconnect()));
  });
  const seed = seedWooInitialPermit;

  it("two independent SQL clients admit only one provider dispatch, with no provider network call", async () => {
    const a = client(); const b = client();
    const { input } = await seed(a);
    const results = await Promise.all([
      new WooInitialSendFenceService(a).admitFinalSend(input),
      new WooInitialSendFenceService(b).admitFinalSend(input),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["admitted", "suppressed"]);
    const message = await a.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
    expect(message.providerDispatchKey).toMatch(/^arch046-woo-initial-[0-9a-f]{64}$/);
    expect(message.providerDispatchAdmittedAt).toBeTruthy();
    expect(message.status).toBe("PENDING"); // no fake provider confirmation
    expect(await a.usageEvent.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
    // A separate connection must see the committed permit and exact funding
    // source. No second reservation, message or charge may be invented on replay.
    const afterCommit = await b.conversationMessage.findUniqueOrThrow({
      where: { id: input.messageId },
      select: { providerDispatchKey: true, providerDispatchAdmittedAt: true },
    });
    expect(afterCommit.providerDispatchKey).toBe(message.providerDispatchKey);
    expect(afterCommit.providerDispatchAdmittedAt).toEqual(message.providerDispatchAdmittedAt);
    const usage = await b.usageEvent.findUniqueOrThrow({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(usage).toMatchObject({ shopId: input.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE",
      sourceId: input.messageId });
    const reservation = await b.usageReservation.findUniqueOrThrow({
      where: { sourceKey: input.recoveryCreditSourceKey },
    });
    const counter = await b.shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: input.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    });
    expect(reservation).toMatchObject({ shopId: input.shopId, counterId: counter.id,
      quantity: 1, status: "RESERVED" });
    expect(counter).toMatchObject({ grantedQuantity: 1, reservedQuantity: 1, committedQuantity: 0 });
  }, 45_000);

  it("suppresses a recovery at the configured inactivity cutoff without an expiry sweep", async () => {
    const db = client();
    const { input } = await seed(db);
    const config = await db.backgroundRuntimeConfig.findUniqueOrThrow({
      where: { id: "default" }, select: { checkoutRecoveryLifetimeDays: true },
    });
    expect(config.checkoutRecoveryLifetimeDays).toBe(21);
    const now = new Date();
    await db.checkoutRecovery.update({ where: { id: input.recoveryId }, data: {
      lastExternalActivityAt: new Date(now.getTime() - config.checkoutRecoveryLifetimeDays * 86_400_000),
    } });

    const result = await new WooInitialSendFenceService(db, undefined, undefined, undefined, undefined,
      () => now).admitFinalSend(input);
    expect(result).toEqual({ kind: "suppressed", reason: "woo-recovery-lifetime-elapsed" });
    const recovery = await db.checkoutRecovery.findUniqueOrThrow({ where: { id: input.recoveryId },
      select: { status: true, expiredAt: true } });
    expect(recovery).toEqual({ status: "DETECTED", expiredAt: null });
    const message = await db.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId },
      select: { providerDispatchKey: true } });
    expect(message.providerDispatchKey).toBeNull();
  }, 45_000);

  it("a previously committed STOP blocks the permit, including a later local grant", async () => {
    const db = client();
    const { input, shopId } = await seed(db);
    await writeLocalStop(db, { canonical: DIGITS, shopId, eventId: randomUUID(), at: new Date() });
    const stopped = await new WooInitialSendFenceService(db).admitFinalSend(input);
    expect(stopped.kind).toBe("suppressed");
    const granted = await recordWooDecision(db, {
      shopId, installationId: input.consent.installationId,
      customerId: input.customerId, customerPhoneId: input.consent.customerPhoneId,
    }, "GRANT");
    // A fresh legitimate Woo GRANT must not override the authoritative STOP.
    expect((await new WooInitialSendFenceService(db).admitFinalSend({
      ...input, consent: { ...input.consent,
        consentRevision: granted.whatsappConsentRevision,
        consentDecisionSequence: granted.whatsappConsentDecisionSequence,
        noContactRevision: granted.whatsappNoContactRevision },
    })).kind).toBe("suppressed");
    const message = await db.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
    expect(message.providerDispatchKey).toBeNull();
  }, 45_000);

  it("an observed order suppresses the final permit even without a candidate or BullMQ job", async () => {
    const db = client(); const { input } = await seed(db);
    await db.checkoutRecoveryStatusHistory.create({ data: {
      checkoutRecoveryId: input.recoveryId, fromStatus: "DETECTED", toStatus: "CANCELLED",
      reason: "woo-order-cancelled", source: "woocommerce.order",
      metadata: { orderId: "order-1" },
    } });
    expect(await new WooInitialSendFenceService(db).admitFinalSend(input))
      .toEqual({ kind: "suppressed", reason: "woo-observed-order-terminal" });
    expect((await db.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } })).providerDispatchKey)
      .toBeNull();
  });

  it("changed consent or recipient, revoked installation, and terminal recovery all deny", async () => {
    const db = client();
    const fence = new WooInitialSendFenceService(db);

    // A real Woo REVOKE increments both revisions with corresponding immutable
    // evidence; direct database edits without that evidence are not legal.
    const revoked = await seed(db);
    const identity = {
      shopId: revoked.shopId, installationId: revoked.input.consent.installationId,
      customerId: revoked.input.customerId,
      customerPhoneId: revoked.input.consent.customerPhoneId,
    };
    await recordWooDecision(db, identity, "REVOKE");
    expect((await fence.admitFinalSend(revoked.input)).kind).toBe("suppressed");

    // Rotation requires a withdrawal followed by a new, evidenced opt-in;
    // changing an already GRANTED canonical number in place is forbidden.
    const rotated = await seed(db);
    const rotationIdentity = {
      shopId: rotated.shopId, installationId: rotated.input.consent.installationId,
      customerId: rotated.input.customerId,
      customerPhoneId: rotated.input.consent.customerPhoneId,
    };
    await recordWooDecision(db, rotationIdentity, "REVOKE");
    await recordWooDecision(db, rotationIdentity, "GRANT", "447400555555");
    expect((await fence.admitFinalSend(rotated.input)).kind).toBe("suppressed");

    const disconnected = await seed(db);
    await db.wooCommerceInstallation.update({ where: { id: disconnected.input.consent.installationId },
      data: { status: "REVOKED", revokedAt: new Date() } });
    expect((await fence.admitFinalSend(disconnected.input)).kind).toBe("suppressed");

    const terminal = await seed(db);
    await db.checkoutRecovery.update({ where: { id: terminal.input.recoveryId }, data: {
      status: "COMPLETED", completedAt: new Date(),
    } });
    expect((await fence.admitFinalSend(terminal.input)).kind).toBe("suppressed");
    for (const context of [revoked, rotated, disconnected, terminal]) {
      const message = await db.conversationMessage.findUniqueOrThrow({ where: { id: context.input.messageId } });
      expect(message.providerDispatchKey).toBeNull();
    }
  });

  it("STOP after committed admission cannot retroactively retract the provider permit", async () => {
    const db = client(); const { input, shopId } = await seed(db);
    expect(await new WooInitialSendFenceService(db).admitFinalSend(input)).toEqual({ kind: "admitted" });
    await writeLocalStop(db, { canonical: DIGITS, shopId, eventId: randomUUID(), at: new Date() });
    const message = await db.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
    expect(message.providerDispatchKey).toBeTruthy();
    expect((await new WooInitialSendFenceService(db).admitFinalSend(input)).kind).toBe("suppressed");
  });

});
