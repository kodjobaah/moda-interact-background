import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RecoverySenderPoolService } from "../../src/services/recovery-sender-pool/sender-pool.service.js";
import { lockRecoverySenderRecipient } from "../../src/services/recovery-sender-pool/recipient-lock.js";

const suite = process.env.MODA_DISPOSABLE_INTEGRATION === "1" && process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("ARCH076 actual sender allocation and lifecycle", () => {
  const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const now = new Date();
  let accountRowId: string;
  const accountVersion = 1;
  const account = async () => ({ accountId: "9001", rowId: accountRowId, version: accountVersion, environment: "test" });
  const svc = new RecoverySenderPoolService(db, () => now, account);
  const prefix = `arch076-${randomUUID()}`;
  const phones = ["111" + Date.now(), "222" + Date.now(), "333" + Date.now()];
  const shops: string[] = [];
  const recipients = new Set<string>();
  let nextRecipient = 100;
  async function fixture(shopId?: string) {
    const shop = shopId ?? `${prefix}-${randomUUID()}`;
    if (!shopId) { await db.shop.create({ data: { id: shop, domain: `${shop}.fixture.test` } }); shops.push(shop); }
    const recovery = await db.checkoutRecovery.create({ data: { shopId: shop, checkoutToken: randomUUID(), lastExternalActivityAt: now, status: "MESSAGE_SENT" } });
    const conversation = await db.conversation.create({ data: { shopId: shop, checkoutRecoveryId: recovery.id, type: "RECOVERY" } });
    return { shop, recovery, conversation };
  }
  function recipient() { const value = `447700900${nextRecipient++}`; recipients.add(value); return value; }
  const allocate = (f: Awaited<ReturnType<typeof fixture>>, canonicalRecipient: string) => svc.allocate({ conversationId: f.conversation.id, canonicalRecipient });
  async function assigned(f: Awaited<ReturnType<typeof fixture>>, canonicalRecipient: string) {
    const result = await allocate(f, canonicalRecipient); expect(result.kind).toBe("assigned");
    if (result.kind !== "assigned") throw new Error("fixture assignment failed"); return result.sender;
  }
  beforeAll(async () => {
    const row = await db.platformConfiguration.upsert({ where: { environment_key: { environment: "test", key: "messaging.sender" } }, create: { environment: "test", key: "messaging.sender", value: { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: "fixture", nonce: "AA==", ciphertext: "AA==", authTag: "AA==" }, version: 1 }, update: { value: { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: "fixture", nonce: "AA==", ciphertext: "AA==", authTag: "AA==" }, version: 1 } });
    accountRowId = row.id;
    await db.backgroundRuntimeConfig.upsert({ where: { id: "default" }, create: { id: "default", checkoutRecoveryLifetimeDays: 30 }, update: { checkoutRecoveryLifetimeDays: 30 } });
    for (const [i, phone] of phones.entries()) await db.whatsAppPoolSender.create({ data: { providerPhoneNumberId: phone, providerAccountId: "9001", verifiedAt: new Date(now.getTime() - 1000), allocationEnabled: true, priority: i } });
  });
  afterAll(async () => {
    for (const shopId of shops) await db.shop.delete({ where: { id: shopId } });
    await db.recoverySenderThread.deleteMany({ where: { canonicalRecipient: { in: [...recipients] } } });
    await db.whatsAppPoolSender.deleteMany({ where: { providerPhoneNumberId: { in: phones } } });
    await db.$disconnect();
  });
  it("serializes concurrent same-shop checkouts and preserves exact assignment across restart/drain", async () => {
    const f = await fixture(), g = await fixture(f.shop), to = recipient();
    const results = await Promise.all([assigned(f, to), assigned(g, to), assigned(f, to)]);
    expect(new Set(results.map(r => r.routeId)).size).toBe(1);
    expect(new Set(results.map(r => r.providerPhoneNumberId))).toEqual(new Set([phones[0]]));
    await db.whatsAppPoolSender.update({ where: { providerPhoneNumberId: phones[0]! }, data: { allocationEnabled: false } });
    const h = await fixture(f.shop); expect((await assigned(h, to)).routeId).toBe(results[0]!.routeId);
    const restarted = new RecoverySenderPoolService(db, () => now, account);
    expect(await restarted.allocate({ conversationId: f.conversation.id, canonicalRecipient: to })).toEqual({ kind: "assigned", sender: results[0] });
    const other = recipient(); await expect(allocate(f, other)).rejects.toThrow("SENDER_ASSIGNMENT_RECIPIENT_MISMATCH");
    await db.whatsAppPoolSender.update({ where: { providerPhoneNumberId: phones[0]! }, data: { allocationEnabled: true } });
    expect(await db.conversation.count({ where: { checkoutRecoveryId: f.recovery.id } })).toBe(1);
  });
  it("reuses existing ownership during a credential configuration outage without allocating a new route", async () => {
    const f = await fixture(), to = recipient(); const old = await assigned(f, to);
    const unavailable = new RecoverySenderPoolService(db, () => now, async () => { throw new Error("fixture credential unavailable"); });
    expect(await unavailable.allocate({ conversationId: f.conversation.id, canonicalRecipient: to })).toEqual({ kind: "assigned", sender: old });
    const sibling = await fixture(f.shop);
    const next = await unavailable.allocate({ conversationId: sibling.conversation.id, canonicalRecipient: to });
    expect(next.kind === "assigned" && next.sender.routeId).toBe(old.routeId);
    await expect(unavailable.allocate({ conversationId: (await fixture()).conversation.id, canonicalRecipient: to })).rejects.toThrow("fixture credential unavailable");
    expect((await assigned(f, to)).routeId).toBe(old.routeId);
  });
  it("ranks distinct live shops, priority and C phone ID; a new recipient starts independently", async () => {
    const to = recipient(); const fs = await Promise.all([fixture(), fixture(), fixture(), fixture()]);
    const result = [];
    for (const f of fs) result.push(await assigned(f, to));
    expect(result.map(r => r.providerPhoneNumberId)).toEqual([phones[0], phones[1], phones[2], phones[0]]);
    expect(result[0]!.threadId).toBe(result[3]!.threadId);
    expect((await assigned(await fixture(), recipient())).providerPhoneNumberId).toBe(phones[0]);
    await db.whatsAppPoolSender.updateMany({ where: { providerPhoneNumberId: { in: phones } }, data: { priority: 0 } });
    expect((await assigned(await fixture(), recipient())).providerPhoneNumberId).toBe(phones[0]);
  });
  it("races actual last-member release against same-shop allocation without reopening generations", async () => {
    const f = await fixture(), to = recipient(); const old = await assigned(f, to);
    await db.checkoutRecovery.update({ where: { id: f.recovery.id }, data: { status: "COMPLETED", completedAt: now } });
    const g = await fixture(f.shop);
    await Promise.all([svc.release(f.conversation.id), assigned(g, to)]);
    const fresh = await assigned(g, to);
    expect(fresh.routeId).not.toBe(old.routeId); expect(fresh.threadId).not.toBe(old.threadId);
    expect((await db.recoverySenderRoute.findUniqueOrThrow({ where: { id: old.routeId } })).closedAt).toEqual(now);
    expect((await db.recoverySenderThread.findUniqueOrThrow({ where: { id: old.threadId } })).closedAt).toEqual(now);
    expect(await allocate(f, to)).toEqual({ kind: "unavailable", reason: "recovery-terminal" });
  });
  it("races actual last-member release against another shop and frees the old sender", async () => {
    const f = await fixture(), to = recipient(); const old = await assigned(f, to);
    await db.checkoutRecovery.update({ where: { id: f.recovery.id }, data: { status: "CANCELLED" } });
    const g = await fixture(); const [, fresh] = await Promise.all([svc.release(f.conversation.id), assigned(g, to)]);
    expect(fresh.providerPhoneNumberId).toBe(phones[0]); expect(fresh.threadId).not.toBe(old.threadId);
    expect(await db.recoverySenderAssignment.count({ where: { conversationId: f.conversation.id } })).toBe(1);
  });
  it("keeps live sibling routes and service-window/message-cap independent ownership", async () => {
    const f = await fixture(), g = await fixture(f.shop), to = recipient(); const old = await assigned(f, to); await assigned(g, to);
    await db.checkoutRecovery.update({ where: { id: f.recovery.id }, data: { status: "EXPIRED", expiredAt: now } });
    await svc.release(f.conversation.id);
    expect((await db.recoverySenderRoute.findUniqueOrThrow({ where: { id: old.routeId } })).closedAt).toBeNull();
    await db.checkoutRecovery.update({ where: { id: g.recovery.id }, data: { lastExternalActivityAt: new Date(now.getTime() + 60000) } });
    expect(await svc.release(g.conversation.id)).toBe("retained");
    expect((await assigned(g, to)).routeId).toBe(old.routeId);
  });
  it("uses inclusive lifetime boundary and reconciles terminal assignments after restart", async () => {
    const f = await fixture(), to = recipient(); const old = await assigned(f, to);
    await db.checkoutRecovery.update({ where: { id: f.recovery.id }, data: { lastExternalActivityAt: new Date(now.getTime() - 30 * 86400000) } });
    expect(await svc.release(f.conversation.id)).toBe("released");
    expect((await db.recoverySenderRoute.findUniqueOrThrow({ where: { id: old.routeId } })).closedAt).toEqual(now);
    const g = await fixture(); await assigned(g, recipient()); await db.checkoutRecovery.update({ where: { id: g.recovery.id }, data: { status: "COMPLETED" } });
    expect(await new RecoverySenderPoolService(db, () => now, account).releaseTerminalAssignments(100)).toBeGreaterThan(0);
    expect((await db.recoverySenderAssignment.findUniqueOrThrow({ where: { conversationId: g.conversation.id } })).releasedAt).toEqual(now);
  });
  it("holds the same unsent initial identity with zero inventory, and retries without duplicate recovery", async () => {
    const f = await fixture(), to = recipient(); await db.checkoutRecovery.update({ where: { id: f.recovery.id }, data: { status: "DETECTED" } });
    const attempt = await db.recoveryOutreachAttempt.create({ data: { checkoutRecoveryId: f.recovery.id, sequence: 1, trigger: "INITIAL", recipient: to, configuredOfferMode: "NONE" } });
    await db.whatsAppPoolSender.updateMany({ where: { providerPhoneNumberId: { in: phones } }, data: { allocationEnabled: false } });
    const input = { conversationId: f.conversation.id, canonicalRecipient: to, initialAttemptId: attempt.id };
    expect(await svc.allocate(input)).toEqual({ kind: "held", reason: "sender-inventory-unavailable" });
    expect(await svc.allocate(input)).toEqual({ kind: "held", reason: "sender-inventory-unavailable" });
    expect((await db.checkoutRecovery.findUniqueOrThrow({ where: { id: f.recovery.id } })).admissionBlockReason).toBe("RECOVERY_CAPACITY_EXHAUSTED");
    expect((await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).failureCode).toBe("SENDER_INVENTORY_UNAVAILABLE");
    expect(await db.recoverySenderAssignment.count({ where: { conversationId: f.conversation.id } })).toBe(0);
    await db.whatsAppPoolSender.updateMany({ where: { providerPhoneNumberId: { in: phones } }, data: { allocationEnabled: true } });
    expect((await svc.allocate(input)).kind).toBe("assigned");
    expect((await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).failureCode).toBeNull();
    expect((await db.checkoutRecovery.findUniqueOrThrow({ where: { id: f.recovery.id } })).admissionBlockReason).toBeNull();
    expect(await db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recovery.id } })).toBe(1);
    expect(await db.conversationMessage.count({ where: { conversationId: f.conversation.id } })).toBe(0);
    expect(await db.usageReservation.count({ where: { shopId: f.shop } })).toBe(0);
  });
  it("excludes enabled inventory from another WABA and fences configuration rotation", async () => {
    const foreign = "444" + Date.now();
    await db.whatsAppPoolSender.create({ data: { providerPhoneNumberId: foreign, providerAccountId: "9999", priority: 0, verifiedAt: now, allocationEnabled: true } });
    try {
      await db.whatsAppPoolSender.updateMany({ where: { providerPhoneNumberId: { in: phones } }, data: { allocationEnabled: false } });
      expect(await allocate(await fixture(), recipient())).toEqual({ kind: "held", reason: "sender-inventory-unavailable" });
      const stale = new RecoverySenderPoolService(db, () => now, async () => ({ ...(await account()), version: accountVersion + 1 }));
      await expect(stale.allocate({ conversationId: (await fixture()).conversation.id, canonicalRecipient: recipient() })).rejects.toThrow("SENDER_ACCOUNT_CONFIGURATION_CHANGED");
    } finally {
      await db.whatsAppPoolSender.delete({ where: { providerPhoneNumberId: foreign } });
      await db.whatsAppPoolSender.updateMany({ where: { providerPhoneNumberId: { in: phones } }, data: { allocationEnabled: true } });
    }
  });
  it("a current-account CAS switch and allocation cannot race past the row fence", async () => {
    const f = await fixture(), to = recipient();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const locked = new Promise<void>(r => { entered = r; });
    const holder = db.$transaction(async tx => {
      await tx.platformConfiguration.update({ where: { id: accountRowId }, data: { version: 2 } });
      entered(); await gate;
    }, { timeout: 15000 });
    await locked;
    let settled = false; const pending = allocate(f, to).finally(() => { settled = true; });
    // The actual allocation transaction waits for the configuration updater.
    // Poll PostgreSQL's lock state instead of treating an arbitrary delay as proof.
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const rows = await db.$queryRawUnsafe<Array<{ found: boolean }>>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%PlatformConfiguration%' AND pid<>pg_backend_pid()) AS found`);
      if (rows[0]?.found) { blocked = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    expect(blocked).toBe(true); expect(settled).toBe(false); release(); await holder;
    await expect(pending).rejects.toThrow("SENDER_ACCOUNT_CONFIGURATION_CHANGED");
    expect(await db.recoverySenderAssignment.count({ where: { conversationId: f.conversation.id } })).toBe(0);
    await db.platformConfiguration.update({ where: { id: accountRowId }, data: { version: 1 } });
  });
  it("an occupied recipient lock blocks actual allocation, but another recipient proceeds", async () => {
    const f = await fixture(), g = await fixture(), to = recipient(), other = recipient();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const locked = new Promise<void>(r => { entered = r; });
    const holder = db.$transaction(async tx => { await lockRecoverySenderRecipient(tx, to); entered(); await gate; });
    await locked;
    let finished = false; const pending = assigned(f, to).then(r => { finished = true; return r; });
    await assigned(g, other); expect(finished).toBe(false); release(); await holder; await pending;
  });
  it("rejects invalid canonical recipient before any provider/owner call", async () => {
    const query = vi.fn(); await expect(lockRecoverySenderRecipient({ $queryRawUnsafe: query } as never, "+44123")).rejects.toThrow("INVALID_SENDER_POOL_RECIPIENT"); expect(query).not.toHaveBeenCalled();
  });
});
