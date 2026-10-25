import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import type { RecoveryConsentNoticeInput } from "../../../../src/services/checkout-recovery/recovery-consent-merchant-notice.contracts.js";
import {
  createRecoveryConsentNoticeSourceKey,
} from "../../../../src/services/checkout-recovery/recovery-consent-merchant-notice.formatter.js";
import { RecoveryConsentMerchantNoticeService } from
  "../../../../src/services/checkout-recovery/recovery-consent-merchant-notice.service.js";

const first: RecoveryConsentNoticeInput = {
  shopId: "shop-1", platform: "SHOPIFY", checkoutToken: "private-checkout-token-01",
  reason: "NO_VERIFIED_OPT_IN", blockedOperation: "CREATE_FIRST_RECOVERY",
  context: { customerName: "Ada", customerEmail: "customer@example.test" },
};

type Row = {
  sourceKey: string;
  originalBody: string;
  kind: string;
  state: string;
  threadId: string;
  systemCode: string;
  systemVersion: string;
  availableAt: Date;
};

function context() {
  const rows = new Map<string, Row>();
  let lastMessageAt: Date | null = null;
  const thread = { id: "thread-1", shopId: "shop-1" };
  const createThread = vi.fn(async () => ({ count: 1 }));
  const findThread = vi.fn(async () => ({ id: thread.id }));
  const createMany = vi.fn(async ({ data }: { data: Row[]; skipDuplicates: boolean }) => {
    const row = data[0]!;
    if (rows.has(row.sourceKey)) return { count: 0 };
    rows.set(row.sourceKey, row);
    return { count: 1 };
  });
  const findUnique = vi.fn(async ({ where }: { where: { sourceKey: string } }) => rows.get(where.sourceKey) ?? null);
  const updateMany = vi.fn(async ({ data, where }: { data: { lastMessageAt: Date }; where: object }) => {
    expect(where).toEqual({
      id: thread.id, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: data.lastMessageAt } }],
    });
    if (lastMessageAt === null || lastMessageAt < data.lastMessageAt) lastMessageAt = data.lastMessageAt;
    return { count: 1 };
  });
  const tx = {
    merchantSupportThread: { createMany: createThread, findUniqueOrThrow: findThread, updateMany },
    merchantSupportMessage: { createMany, findUnique },
  };
  const database = { $transaction: vi.fn(async (callback: (arg: typeof tx) => Promise<unknown>) => callback(tx)) };
  const logger = { info: vi.fn(), error: vi.fn() };
  const now = vi.fn(() => new Date("2026-10-24T10:00:00Z"));
  const service = new RecoveryConsentMerchantNoticeService(database as never, now, logger as never);
  return { service, database, logger, now, rows, tx, thread, createThread, findThread,
    createMany, findUnique, updateMany, getLastMessageAt: () => lastMessageAt };
}

describe("shared recovery consent merchant Support notifier", () => {
  it("persists one canonical SYSTEM message atomically, then verifies duplicates and leaves the first body untouched", async () => {
    const f = context();
    expect(await f.service.notify(first)).toBe("created");
    expect(f.database.$transaction).toHaveBeenCalledOnce();
    expect(f.createThread).toHaveBeenCalledWith({
      data: [{ shopId: first.shopId }], skipDuplicates: true,
    });
    expect(f.findThread).toHaveBeenCalledWith({
      where: { shopId: first.shopId }, select: { id: true },
    });
    expect(f.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [{
        threadId: "thread-1", kind: "SYSTEM", state: "AVAILABLE",
        originalBody: expect.stringContaining("Customer: Ada"),
        sourceLanguageTag: "en-GB", systemCode: "RECOVERY_CONSENT_ADMISSION",
        systemVersion: "1", sourceKey: createRecoveryConsentNoticeSourceKey(first),
        availableAt: new Date("2026-10-24T10:00:00Z"),
      }],
    });
    const initialBody = [...f.rows.values()][0]!.originalBody;
    expect(await f.service.notify({ ...first, context: { customerName: "Changed on retry" } })).toBe("duplicate");
    expect(await f.service.notify({
      ...first, blockedOperation: "SEND_INITIAL_RECOVERY",
      context: { customerName: "Changed on send re-entry" },
    })).toBe("duplicate");
    expect(f.findUnique).toHaveBeenCalledWith({ where: { sourceKey: createRecoveryConsentNoticeSourceKey(first) } });
    expect(f.rows.size).toBe(1);
    expect([...f.rows.values()][0]!.originalBody).toBe(initialBody);
    expect(f.updateMany).toHaveBeenCalledOnce();
    expect(f.getLastMessageAt()).toEqual(new Date("2026-10-24T10:00:00Z"));
    expect(f.logger.info).toHaveBeenCalledWith("recovery.consent_notice.created", expect.objectContaining({
      shopId: first.shopId, platform: "SHOPIFY", reasonCode: first.reason,
      blockedOperation: "CREATE_FIRST_RECOVERY", result: "created",
    }));
    expect(f.logger.info).toHaveBeenCalledWith("recovery.consent_notice.duplicate", expect.objectContaining({
      shopId: first.shopId, result: "duplicate",
    }));
    const logged = JSON.stringify(f.logger.info.mock.calls);
    expect(logged).not.toContain(first.checkoutToken);
    expect(logged).not.toContain("customer@example.test");
    expect(logged).not.toContain("Ada");
    expect(logged).not.toContain(initialBody);
  });

  it("deduplicates across blocked operations while separating reasons, platforms, shops and checkouts", async () => {
    const f = context();
    const inputs: RecoveryConsentNoticeInput[] = [
      first, { ...first, blockedOperation: "SEND_INITIAL_RECOVERY" },
      { ...first, reason: "RECIPIENT_AMBIGUOUS" },
      { ...first, shopId: "shop-2" }, { ...first, platform: "WOOCOMMERCE" },
      { ...first, checkoutToken: "private-checkout-token-02" },
    ];
    const results: string[] = [];
    for (const input of inputs) results.push(await f.service.notify(input));
    expect(results).toEqual(["created", "duplicate", "created", "created", "created", "created"]);
    expect(f.rows.size).toBe(5);
    expect(new Set([...f.rows.keys()]).size).toBe(5);
    expect(f.rows.get(createRecoveryConsentNoticeSourceKey(inputs[4]!))!.originalBody)
      .toContain("Platform: WooCommerce"); // Synthetic Woo caller uses the same notifier.
  });

  it("retains the initial-send outcome when it is committed before first-recovery re-entry", async () => {
    const f = context();
    const sendFirst = { ...first, blockedOperation: "SEND_INITIAL_RECOVERY" as const };
    expect(await f.service.notify(sendFirst)).toBe("created");
    const key = createRecoveryConsentNoticeSourceKey(first);
    const initialBody = f.rows.get(key)!.originalBody;
    expect(initialBody).toContain("Outcome: The initial WhatsApp recovery message was not sent");
    expect(initialBody).not.toContain("No checkout recovery was created");
    expect(await f.service.notify(first)).toBe("duplicate");
    expect(f.rows.size).toBe(1);
    expect(f.rows.get(key)!.originalBody).toBe(initialBody);
    expect(f.updateMany).toHaveBeenCalledOnce();
  });

  it("handles an already-created merchant thread and fails if the thread cannot be resolved", async () => {
    const existing = context();
    existing.createThread.mockResolvedValue({ count: 0 });
    expect(await existing.service.notify(first)).toBe("created");
    expect(existing.findThread).toHaveBeenCalledOnce();

    const missing = context();
    missing.createThread.mockResolvedValue({ count: 0 });
    const dbFailure = new Error("Support thread not found after insert conflict");
    missing.findThread.mockRejectedValueOnce(dbFailure);
    await expect(missing.service.notify(first)).rejects.toBe(dbFailure);
    expect(missing.createMany).not.toHaveBeenCalled();
    expect(missing.logger.error).toHaveBeenCalledWith("recovery.consent_notice.failed",
      expect.objectContaining({ errorCategory: "PERSISTENCE_FAILURE" }));
  });

  it("refuses count-zero without an authentic same-thread SYSTEM notice", async () => {
    for (const wrong of [
      null,
      { kind: "MERCHANT" }, { threadId: "thread-other-shop" },
      { systemCode: "OTHER" }, { systemVersion: "2" },
    ]) {
      const f = context();
      f.createMany.mockResolvedValue({ count: 0 });
      if (wrong) {
        f.findUnique.mockResolvedValue({
          sourceKey: createRecoveryConsentNoticeSourceKey(first), threadId: "thread-1",
          kind: "SYSTEM", systemCode: "RECOVERY_CONSENT_ADMISSION", systemVersion: "1",
          originalBody: "first", state: "AVAILABLE", availableAt: new Date(), ...wrong,
        });
      }
      await expect(f.service.notify(first)).rejects.toThrow("deduplication invariant");
      expect(f.updateMany).not.toHaveBeenCalled();
      expect(f.logger.error).toHaveBeenCalledWith("recovery.consent_notice.failed",
        expect.objectContaining({ result: "failed", errorCategory: "PERSISTENCE_FAILURE" }));
    }
  });

  it("rejects impossible insert counts and propagates database and transaction errors", async () => {
    for (const operation of ["createThread", "findThread", "createMany", "updateMany", "findUnique", "transaction"] as const) {
      const f = context();
      const dbFailure = new Error("db error with private-checkout-token-01 in message");
      if (operation === "createThread") f.createThread.mockRejectedValueOnce(dbFailure);
      if (operation === "findThread") f.findThread.mockRejectedValueOnce(dbFailure);
      if (operation === "createMany") f.createMany.mockRejectedValueOnce(dbFailure);
      if (operation === "updateMany") f.updateMany.mockRejectedValueOnce(dbFailure);
      if (operation === "findUnique") {
        f.createMany.mockResolvedValue({ count: 0 });
        f.findUnique.mockRejectedValueOnce(dbFailure);
      }
      if (operation === "transaction") f.database.$transaction.mockRejectedValueOnce(dbFailure);
      await expect(f.service.notify(first)).rejects.toBe(dbFailure);
      expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(first.checkoutToken);
      expect(f.logger.error).toHaveBeenCalledWith("recovery.consent_notice.failed",
        expect.objectContaining({ errorCategory: "PERSISTENCE_FAILURE" }));
    }
    const f = context();
    f.createMany.mockResolvedValue({ count: 2 });
    await expect(f.service.notify(first)).rejects.toThrow("insert count");
    expect(f.findUnique).not.toHaveBeenCalled();
  });

  it("rejects invalid required input/clock before starting a transaction", async () => {
    const f = context();
    f.now.mockReturnValueOnce(new Date("bad date"));
    await expect(f.service.notify(first)).rejects.toThrow("now() date");
    expect(f.database.$transaction).not.toHaveBeenCalled();
    await expect(f.service.notify({ ...first, shopId: " " })).rejects.toThrow("shopId");
    expect(f.database.$transaction).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledWith("recovery.consent_notice.failed", {
      result: "failed", errorCategory: "INVALID_INPUT_OR_FORMAT",
    });
  });

  it("does not let an injected logging sink failure invalidate a committed notice or hide an original DB failure", async () => {
    const f = context();
    f.logger.info.mockImplementation(() => { throw new Error("observability sink unavailable"); });
    f.logger.error.mockImplementation(() => { throw new Error("observability sink unavailable"); });
    await expect(f.service.notify(first)).resolves.toBe("created");
    expect(f.rows.size).toBe(1);
    expect(f.getLastMessageAt()).not.toBeNull();
    const dbFailure = new Error("Postgres down");
    f.createMany.mockRejectedValueOnce(dbFailure);
    await expect(f.service.notify({ ...first, reason: "RECIPIENT_UNVERIFIED" })).rejects.toBe(dbFailure);
  });
});
