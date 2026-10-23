import "dotenv/config";
import { randomInt, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppInboundEvent } from "../../src/integration/whatsapp/types.js";
import { sendRoutingGuidance } from "../../src/services/routing-guidance.service.js";
import { writeLocalStop } from "../../src/services/whatsapp-contact-opt-out/stop-writer.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
function recipientFor(group: number) {
  const phone = `+447400${group}${randomInt(1000, 10_000)}`;
  return { phone, canonical: phone.slice(1) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}
async function untilSignalled(promise: Promise<void>, description: string): Promise<void> {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 4_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
function fakeGuidance(canonical: string) {
  const provider = {
    resolveSender: vi.fn(async () => ({ providerAccountId: "waba", providerPhoneNumberId: "phone" })),
    sendWhatsAppText: vi.fn(async () => ({ providerMessageId: randomUUID() })),
  };
  const cache = { set: vi.fn(async () => "OK") };
  const event: WhatsAppInboundEvent = {
    schemaVersion: 1, provider: "whatsapp", providerAccountId: "waba", providerPhoneNumberId: "phone",
    providerMessageId: `wamid-${randomUUID()}`, customerPhone: canonical,
    contextMessageId: null, occurredAt: "2026-10-23T00:00:00Z",
    content: { type: "text", text: "Help" },
  } as WhatsAppInboundEvent;
  return { provider, cache, event };
}

describeWithDatabase("ARCH-045 platform guidance and STOP recipient-lock ordering", () => {
  it("STOP that acquires the recipient lock first prevents a later platform provider call", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const { phone, canonical } = recipientFor(41);
    const shopId = `guidance-stop-${suffix}`;
    const holdingStop = deferred();
    const releaseStop = deferred();
    const attemptedGuidanceLock = deferred();
    const pending: Array<Promise<unknown>> = [];
    try {
      await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.com`, defaultCountryCode: "GB" } });
      const customer = await db.customer.create({ data: { shopId } });
      const registered = await db.customerPhone.create({ data: {
        customerId: customer.id, phone, whatsappCanonicalPhone: canonical,
      } });
      const stopDatabase = {
        $transaction: (fn: (tx: unknown) => Promise<unknown>, options: never) =>
          db.$transaction(async (tx) => fn({
            customerPhone: tx.customerPhone,
            $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
              const value = await tx.$queryRawUnsafe(sql, ...args);
              if (sql.includes("pg_advisory_xact_lock")) {
                holdingStop.resolve();
                await releaseStop.promise;
              }
              return value;
            },
          }), options),
      };
      const guidanceDatabase = {
        $transaction: (fn: (tx: unknown) => Promise<unknown>, options: never) =>
          db.$transaction(async (tx) => fn({
            $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
              if (sql.includes("pg_advisory_xact_lock")) attemptedGuidanceLock.resolve();
              return tx.$queryRawUnsafe(sql, ...args);
            },
          }), options),
      };
      const { event, provider, cache } = fakeGuidance(canonical);
      const stop = writeLocalStop(stopDatabase as never, {
        canonical, shopId, eventId: `stop-${suffix}`, at: new Date(),
      });
      pending.push(stop);
      await untilSignalled(holdingStop.promise, "STOP to acquire recipient lock");

      const guidance = sendRoutingGuidance(event, "NO_RECOVERY", {
        database: guidanceDatabase as never, cache: cache as never, provider: provider as never,
      });
      pending.push(guidance);
      await untilSignalled(attemptedGuidanceLock.promise, "guidance to attempt recipient lock");
      // STOP still holds the exact recipient advisory lock; the provider must
      // not be called merely because the earlier Redis NX guard succeeded.
      expect(cache.set).toHaveBeenCalledOnce();
      expect(provider.sendWhatsAppText).not.toHaveBeenCalled();
      releaseStop.resolve();
      expect((await stop).changed).toBe(1);
      await guidance;
      expect(provider.sendWhatsAppText).not.toHaveBeenCalled();
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: registered.id } })).whatsappNoContact)
        .toBe(true);
    } finally {
      releaseStop.resolve();
      await Promise.allSettled(pending);
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 15_000);

  it("guidance admitted before STOP can finish, but future guidance is suppressed", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const { phone, canonical } = recipientFor(42);
    const shopId = `guidance-first-${suffix}`;
    const admissionRead = deferred();
    const releaseGuidance = deferred();
    const stopAttemptedLock = deferred();
    const pending: Array<Promise<unknown>> = [];
    try {
      await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.com`, defaultCountryCode: "GB" } });
      const customer = await db.customer.create({ data: { shopId } });
      await db.customerPhone.create({ data: { customerId: customer.id, phone, whatsappCanonicalPhone: canonical } });
      const guidanceDatabase = {
        $transaction: (fn: (tx: unknown) => Promise<unknown>, options: never) =>
          db.$transaction(async (tx) => fn({
            $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
              const value = await tx.$queryRawUnsafe(sql, ...args);
              if (sql.includes('FROM "commerce"."CustomerPhone" cp')) {
                admissionRead.resolve();
                await releaseGuidance.promise;
              }
              return value;
            },
          }), options),
      };
      const stopDatabase = {
        $transaction: (fn: (tx: unknown) => Promise<unknown>, options: never) =>
          db.$transaction(async (tx) => fn({
            customerPhone: tx.customerPhone,
            $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
              if (sql.includes("pg_advisory_xact_lock")) stopAttemptedLock.resolve();
              return tx.$queryRawUnsafe(sql, ...args);
            },
          }), options),
      };
      const { event, provider, cache } = fakeGuidance(canonical);
      const first = sendRoutingGuidance(event, "NO_RECOVERY", {
        database: guidanceDatabase as never, cache: cache as never, provider: provider as never,
      });
      pending.push(first);
      await untilSignalled(admissionRead.promise, "guidance pre-admission read");
      const stop = writeLocalStop(stopDatabase as never, {
        canonical, shopId, eventId: `stop-${suffix}`, at: new Date(),
      });
      pending.push(stop);
      await untilSignalled(stopAttemptedLock.promise, "STOP to attempt recipient lock");
      expect(provider.sendWhatsAppText).not.toHaveBeenCalled();
      releaseGuidance.resolve();
      await first;
      expect(provider.sendWhatsAppText).toHaveBeenCalledOnce();
      expect((await stop).changed).toBe(1);

      const later = fakeGuidance(canonical);
      await sendRoutingGuidance(later.event, "NO_RECOVERY", {
        database: db, cache: later.cache as never, provider: later.provider as never,
      });
      expect(later.provider.sendWhatsAppText).not.toHaveBeenCalled();
    } finally {
      releaseGuidance.resolve();
      await Promise.allSettled(pending);
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 15_000);
});
