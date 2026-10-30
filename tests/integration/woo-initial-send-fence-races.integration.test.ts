import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WooInitialSendFenceService } from
  "../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";
import { writeLocalStop } from "../../src/services/whatsapp-contact-opt-out/stop-writer.js";
import { DIGITS, seedWooInitialPermit } from "./fixtures/woo-initial-send-fence.fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDatabase = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

withDatabase("ARCH-046 Woo final permit: PostgreSQL lock and fault races", () => {
  const clients: PrismaClient[] = [];
  const client = () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    clients.push(db);
    return db;
  };
  afterAll(async () => { await Promise.all(clients.map((db) => db.$disconnect())); });
  const seed = seedWooInitialPermit;

  it("STOP holding the Shop lock wins the overlapping Woo final permit and leaves no dispatch", async () => {
    const stopClient = client();
    const sendClient = client();
    const { input, shopId } = await seed(stopClient);
    const stopLockedShop = deferred();
    const releaseStop = deferred();
    const sendAttemptedShopLock = deferred();
    const operations: Promise<unknown>[] = [];
    try {
      // Real STOP writer and real SQL permit use independent Prisma clients.
      // Instrument only the Shop lock to create a reproducible ordering.
      const pausedStopDatabase = {
        $transaction: (callback: (tx: unknown) => Promise<unknown>, options: never) =>
          stopClient.$transaction(async (tx) => callback({
            customerPhone: tx.customerPhone,
            $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
              const result = await tx.$queryRawUnsafe(sql, ...params);
              if (sql.includes('"commerce"."Shop"') && sql.includes("FOR UPDATE")) {
                stopLockedShop.resolve();
                await releaseStop.promise;
              }
              return result;
            },
          }), options),
      };
      const observingSendDatabase = {
        $transaction: (callback: (tx: unknown) => Promise<unknown>, options: never) =>
          sendClient.$transaction(async (tx) => callback({
            // Forward the tagged-query method used by the real Woo consent
            // checker, while observing the Shop FOR UPDATE lock below.
            $queryRaw: tx.$queryRaw.bind(tx),
            $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
              if (sql.includes('"commerce"."Shop"') && sql.includes("FOR UPDATE"))
                sendAttemptedShopLock.resolve();
              return tx.$queryRawUnsafe(sql, ...params);
            },
          }), options),
      };
      const stop = writeLocalStop(pausedStopDatabase as never, {
        canonical: DIGITS, shopId, eventId: randomUUID(), at: new Date(),
      });
      operations.push(stop);
      await stopLockedShop.promise;
      const permit = new WooInitialSendFenceService(observingSendDatabase as never).admitFinalSend(input);
      operations.push(permit);
      await sendAttemptedShopLock.promise;
      expect((await sendClient.conversationMessage.findUniqueOrThrow({
        where: { id: input.messageId },
      })).providerDispatchKey).toBeNull();
      releaseStop.resolve();
      expect((await stop).changed).toBe(1);
      expect((await permit).kind).toBe("suppressed");
      expect((await sendClient.conversationMessage.findUniqueOrThrow({
        where: { id: input.messageId },
      })).providerDispatchKey).toBeNull();
      expect(await sendClient.usageEvent.count({ where: { idempotencyKey: input.idempotencyKey } }))
        .toBe(1); // unadmitted usage is owned by the caller's compensation path
    } finally {
      releaseStop.resolve();
      await Promise.allSettled(operations);
    }
  }, 60_000);

  it("checkout resumption closing the recovery row first suppresses the waiting provider permit", async () => {
    const closeClient = client(); const sendClient = client();
    const { input } = await seed(closeClient);
    const recoveryLocked = deferred();
    const releaseClose = deferred();
    const permitAttemptedRecoveryLock = deferred();
    const operations: Promise<unknown>[] = [];
    try {
      const close = closeClient.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."CheckoutRecovery" WHERE "id"=$1 FOR UPDATE`, input.recoveryId);
        recoveryLocked.resolve();
        await releaseClose.promise;
        const changed = await tx.checkoutRecovery.updateMany({
          where: { id: input.recoveryId, shopId: input.shopId, checkoutToken: input.checkoutToken,
            status: "DETECTED" },
          data: { status: "CANCELLED" },
        });
        if (changed.count !== 1) throw new Error("ARCH048_CLOSE_RACE_CONFLICT");
        await tx.checkoutRecoveryStatusHistory.create({ data: {
          checkoutRecoveryId: input.recoveryId, fromStatus: "DETECTED", toStatus: "CANCELLED",
          reason: "CHECKOUT_RESUMED", source: "woocommerce.checkout",
          metadata: { eventId: randomUUID(), nextGeneration: 2 },
        } });
      });
      operations.push(close);
      await recoveryLocked.promise;
      const observingSendDatabase = {
        $transaction: (callback: (tx: unknown) => Promise<unknown>, options: never) =>
          sendClient.$transaction(async (tx) => callback({
            $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
              if (sql.includes('"commerce"."CheckoutRecovery"') && sql.includes("FOR UPDATE"))
                permitAttemptedRecoveryLock.resolve();
              return tx.$queryRawUnsafe(sql, ...params);
            },
          }), options),
      };
      const permit = new WooInitialSendFenceService(observingSendDatabase as never).admitFinalSend(input);
      operations.push(permit);
      await permitAttemptedRecoveryLock.promise;
      releaseClose.resolve();
      await close;
      expect(await permit).toEqual({ kind: "suppressed", reason: "woo-recovery-terminal-or-mismatched" });
      const message = await sendClient.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
      expect(message).toMatchObject({ status: "PENDING", providerDispatchKey: null,
        providerDispatchAdmittedAt: null });
    } finally {
      releaseClose.resolve();
      await Promise.allSettled(operations);
    }
  }, 60_000);

  it.each(["COMPLETED", "CANCELLED"] as const)(
    "already-observed Woo %s order committed before the waiting permit blocks dispatch",
    async (terminalStatus) => {
      const orderClient = client(); const sendClient = client();
      const { input, shopId } = await seed(orderClient);
      const orderLockedShop = deferred();
      const releaseOrder = deferred();
      const sendAttemptedShopLock = deferred();
      const operations: Promise<unknown>[] = [];
      try {
        const observedOrder = orderClient.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, shopId);
          orderLockedShop.resolve();
          await releaseOrder.promise;
          await tx.checkoutRecoveryStatusHistory.create({ data: {
            checkoutRecoveryId: input.recoveryId, fromStatus: "DETECTED", toStatus: terminalStatus,
            reason: "woo-order-observed", source: "woocommerce.order",
            metadata: { orderId: "order-from-race" },
          } });
        });
        operations.push(observedOrder);
        await orderLockedShop.promise;
        const observingSendDatabase = {
          $transaction: (callback: (tx: unknown) => Promise<unknown>, options: never) =>
            sendClient.$transaction(async (tx) => callback({
              $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
                if (sql.includes('"commerce"."Shop"') && sql.includes("FOR UPDATE"))
                  sendAttemptedShopLock.resolve();
                return tx.$queryRawUnsafe(sql, ...params);
              },
            }), options),
        };
        const permit = new WooInitialSendFenceService(observingSendDatabase as never).admitFinalSend(input);
        operations.push(permit);
        await sendAttemptedShopLock.promise;
        releaseOrder.resolve();
        await observedOrder;
        expect(await permit).toEqual({ kind: "suppressed", reason: "woo-observed-order-terminal" });
        expect((await sendClient.conversationMessage.findUniqueOrThrow({
          where: { id: input.messageId },
        })).providerDispatchKey).toBeNull();
      } finally {
        releaseOrder.resolve();
        await Promise.allSettled(operations);
      }
    }, 60_000,
  );

  it("rolls back the provider permit on a post-write database fault, logs and allows a safe retry", async () => {
    const db = client(); const { input } = await seed(db);
    const injected = new Error("simulated commit failure with sensitive customer payload");
    const error = vi.fn();
    // The real DB callback writes its dispatch key; a failure before commit
    // must roll back that key together with the transaction's other writes.
    const brokenDatabase = {
      $transaction: (callback: (tx: unknown) => Promise<unknown>, options: never) =>
        db.$transaction(async (tx) => {
          await callback(tx);
          throw injected;
        }, options),
    };
    const guarded = new WooInitialSendFenceService(
      brokenDatabase as never, undefined, undefined, { error } as never,
    );
    await expect(guarded.admitFinalSend(input)).rejects.toBe(injected);
    expect(error).toHaveBeenCalledWith("woocommerce.recovery.initial.sql_permit.failed", {
      shopId: input.shopId, recoveryId: input.recoveryId, attemptId: input.attemptId,
      errorName: "Error", error: new Error("PERSISTENCE_FAILURE"),
    });
    const loggedError = error.mock.calls[0]?.[1].error;
    expect(loggedError).toBeInstanceOf(Error);
    expect(loggedError.message).toBe("PERSISTENCE_FAILURE");
    expect(loggedError.message).not.toContain("simulated commit failure");
    const message = await db.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
    expect(message).toMatchObject({ status: "PENDING", providerDispatchKey: null,
      providerDispatchAdmittedAt: null });
    expect(await new WooInitialSendFenceService(db).admitFinalSend(input))
      .toEqual({ kind: "admitted" });
  }, 45_000);

});
