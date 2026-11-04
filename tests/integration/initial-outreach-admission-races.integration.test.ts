import { afterAll, describe, expect, it } from "vitest";
import { WooInitialSendFenceService } from "../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";
import { barrier, connect, enabled, observeTransactions, seed } from "./fixtures/initial-outreach-admission.fixture.js";

describe.runIf(enabled)("initial outreach permit lock races", () => {
  const a = connect();
  const b = connect();
  afterAll(async () => { await Promise.all([a.$disconnect(), b.$disconnect()]); });

  it("cleanup cannot remove usage from an overlapping permit winner", async () => {
    const { input, service } = await seed(a);
    const admitted = barrier();
    const commit = barrier();
    const permitDatabase = observeTransactions(a, (tx) => ({
      ...tx, $queryRaw: tx.$queryRaw.bind(tx),
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        const result = await tx.$queryRawUnsafe(sql, ...args);
        if (sql.includes('SET "providerDispatchKey"')) {
          admitted.release();
          await commit.wait;
        }
        return result;
      },
    }) as typeof tx);
    const permit = new WooInitialSendFenceService(permitDatabase).admitFinalSend(input);
    let cleanup: Promise<void> | undefined;
    try {
      await Promise.race([admitted.wait, permit.then(() => { throw new Error("Permit did not reach its CAS"); })]);
      const attempted = barrier();
      const cleaner = observeTransactions(b, (tx) => ({
        ...tx, $queryRaw: (...args: Parameters<typeof tx.$queryRaw>) => {
          if (String(args[0]).includes('FROM "commerce"."Shop"')) attempted.release();
          return tx.$queryRaw(...args);
        },
      }) as typeof tx);
      cleanup = service(cleaner).failPrepared(input.messageId);
      await Promise.race([attempted.wait, cleanup.then(() => { throw new Error("Cleanup did not request Shop lock"); })]);
      commit.release();
      expect(await permit).toEqual({ kind: "admitted" });
      await cleanup;
      expect(await b.usageEvent.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
      expect(await b.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } }))
        .toMatchObject({ status: "PENDING", providerDispatchKey: expect.any(String) });
    } finally {
      commit.release();
      await Promise.allSettled([permit, cleanup]);
    }
  }, 45_000);

  it("does not grant a permit after cleanup wins", async () => {
    const { input, service } = await seed(a);
    await service(a).failPrepared(input.messageId);
    expect((await new WooInitialSendFenceService(b).admitFinalSend(input)).kind).toBe("suppressed");
    expect(await b.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } }))
      .toMatchObject({ status: "FAILED", providerDispatchKey: null });
  }, 45_000);

  it("observes a released credit after a concurrent owner transaction", async () => {
    const { input } = await seed(a);
    const locked = barrier();
    const release = barrier();
    const counterparty = a.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${input.shopId} FOR KEY SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "whatsapp"."ConversationMessage" WHERE "id"=${input.messageId} FOR UPDATE`;
      locked.release();
      await release.wait;
      await tx.shopEntitlementCounter.update({
        where: { shopId_counter: { shopId: input.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
        data: { reservedQuantity: { decrement: 1 } },
      });
      await tx.usageReservation.update({
        where: { sourceKey: input.recoveryCreditSourceKey }, data: { status: "RELEASED" },
      });
    }, { timeout: 20_000 });
    let permit: ReturnType<WooInitialSendFenceService["admitFinalSend"]> | undefined;
    try {
      await Promise.race([locked.wait, counterparty]);
      const attempted = barrier();
      const sender = observeTransactions(b, (tx) => ({
        ...tx, $queryRaw: tx.$queryRaw.bind(tx),
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          if (sql.includes('FROM "commerce"."Shop"') && sql.includes("FOR UPDATE")) attempted.release();
          return tx.$queryRawUnsafe(sql, ...args);
        },
      }) as typeof tx);
      permit = new WooInitialSendFenceService(sender).admitFinalSend(input);
      await Promise.race([attempted.wait, permit.then(() => { throw new Error("Permit did not request Shop lock"); })]);
      release.release();
      await counterparty;
      expect(await permit).toEqual({ kind: "suppressed", reason: "woo-recovery-credit-not-reserved" });
      expect(await b.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } }))
        .toMatchObject({ status: "PENDING", providerDispatchKey: null });
    } finally {
      release.release();
      await Promise.allSettled([counterparty, permit]);
    }
  }, 45_000);

  it("persists the receipt and parent timestamp while a competing fence waits", async () => {
    const fixture = await seed(a);
    const { input } = fixture;
    const locked = barrier();
    const release = barrier();
    const receiptClient = observeTransactions(a, (tx) => new Proxy(tx, {
      get(target, key) {
        if (key === "conversation") return new Proxy(target.conversation, {
          get(conversation, operation) {
            if (operation === "update") return async (args: Parameters<typeof conversation.update>[0]) => {
              const result = await conversation.update(args);
              locked.release();
              await release.wait;
              return result;
            };
            return Reflect.get(conversation, operation);
          },
        });
        return Reflect.get(target, key);
      },
    }));
    const send = fixture.sender(receiptClient).sendInitial(fixture.sendInput);
    let permit: ReturnType<WooInitialSendFenceService["admitFinalSend"]> | undefined;
    try {
      await Promise.race([locked.wait, send.then(() => { throw new Error("Receipt did not lock Conversation"); })]);
      const attempted = barrier();
      const competing = observeTransactions(b, (tx) => ({
        ...tx, $queryRaw: tx.$queryRaw.bind(tx),
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          if (sql.includes('FROM "whatsapp"."Conversation"') && sql.includes("FOR UPDATE")) attempted.release();
          return tx.$queryRawUnsafe(sql, ...args);
        },
      }) as typeof tx);
      permit = new WooInitialSendFenceService(competing).admitFinalSend(input);
      await Promise.race([attempted.wait, permit.then(() => { throw new Error("Permit did not request Conversation lock"); })]);
      const before = await b.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
      expect(before.status).toBe("PENDING");
      release.release();
      expect(await send).toEqual({ kind: "admitted" });
      expect((await permit).kind).toBe("suppressed");
      const message = await b.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
      const conversation = await b.conversation.findUniqueOrThrow({ where: { id: input.conversationId } });
      expect(message.status).toBe("SENT");
      expect(message.sentAt).toEqual(conversation.lastMessageAt);
      expect(fixture.requests).toHaveBeenCalledTimes(1);
    } finally {
      release.release();
      await Promise.allSettled([send, permit]);
    }
  }, 45_000);
});
