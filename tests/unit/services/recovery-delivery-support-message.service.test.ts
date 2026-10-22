import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("@prisma/client", () => ({
  MerchantSupportMessageKind: { SYSTEM: "SYSTEM" },
  MerchantSupportMessageState: { AVAILABLE: "AVAILABLE" },
}));

import { RecoveryDeliverySupportMessageService } from
  "../../../src/services/recovery-delivery-support-message.service.js";

function harness() {
  const rows = new Map<string, { id: string; data: Record<string, unknown> }>();
  const thread = { id: "support-thread-1" };
  const tx = {
    merchantSupportThread: {
      upsert: vi.fn().mockResolvedValue(thread),
      update: vi.fn().mockResolvedValue(thread),
    },
    merchantSupportMessage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const key = data.sourceKey as string;
        if (rows.has(key)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
        rows.set(key, { id: `msg-${rows.size + 1}`, data });
      }),
    },
  };
  const database = {
    $transaction: vi.fn(async (fn: (dbTx: typeof tx) => Promise<unknown>) => fn(tx)),
    merchantSupportMessage: {
      findUnique: vi.fn(async ({ where }: { where: { sourceKey: string } }) =>
        rows.get(where.sourceKey) ?? null),
    },
  };
  const service = new RecoveryDeliverySupportMessageService(
    database as never, () => new Date("2026-10-22T18:00:00.000Z"),
  );
  return { rows, tx, database, service };
}

const input = {
  shopId: "shop-1", recoveryId: "recovery-1", messageId: "message-1",
  body: "The recovery credit was released.",
};

describe("ARCH-028-BACKGROUND-008 support persistence", () => {
  it("creates one available, tenant-scoped SYSTEM message", async () => {
    const test = harness();
    await expect(test.service.write(input)).resolves.toBe("created");
    expect(test.rows.size).toBe(1);
    expect(test.tx.merchantSupportThread.upsert).toHaveBeenCalledWith({
      where: { shopId: "shop-1" }, create: { shopId: "shop-1" }, update: {},
    });
    expect([...test.rows.values()][0]?.data).toMatchObject({
      threadId: "support-thread-1", kind: "SYSTEM", state: "AVAILABLE",
      originalBody: input.body, sourceLanguageTag: "en-GB",
      systemCode: "ARCH028_RECOVERY_DELIVERY_FAILED", systemVersion: "1",
      availableAt: new Date("2026-10-22T18:00:00.000Z"),
    });
    expect(test.tx.merchantSupportThread.update).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a provider/job replay without moving lastMessageAt", async () => {
    const test = harness();
    expect(await test.service.write(input)).toBe("created");
    expect(await test.service.write(input)).toBe("duplicate");
    expect(test.rows.size).toBe(1);
    expect(test.tx.merchantSupportThread.update).toHaveBeenCalledTimes(1);
  });

  it("does not disguise a competing thread constraint or outage as a duplicate", async () => {
    const test = harness();
    test.tx.merchantSupportThread.upsert.mockRejectedValueOnce(
      Object.assign(new Error("thread constraint"), { code: "P2002" }),
    );
    await expect(test.service.write(input)).rejects.toThrow("thread constraint");
    test.tx.merchantSupportMessage.create.mockRejectedValueOnce(new Error("support unavailable"));
    await expect(test.service.write(input)).rejects.toThrow("support unavailable");
    await expect(test.service.write(input)).resolves.toBe("created");
    expect(test.rows.size).toBe(1);
  });
});
