import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import { lockRecoveryContext, type SqlTransaction } from "../../../../src/services/recovery-conversation/recovery-conversation.sql.js";

const owner = { shopId: "shop-1", recoveryId: "recovery-1", contention: "nowait" as const };
const context = { id: "conversation-1", shopId: owner.shopId, recoveryId: owner.recoveryId,
  checkoutToken: "checkout-1", recoveryStatus: "MESSAGE_SENT", mode: "AI", revision: 0,
  inboundVersion: 0, lastInboundAt: null };

function fixture() {
  const query = vi.fn();
  return { query, tx: { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn() } as unknown as SqlTransaction };
}

describe("retry owner locks", () => {
  it("locks Shop then the matching Conversation with two bound queries", async () => {
    const { query, tx } = fixture();
    query.mockResolvedValueOnce([{ id: owner.shopId }]).mockResolvedValueOnce([context]);
    await expect(lockRecoveryContext(tx, context.id, owner)).resolves.toEqual(context);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('"Shop" WHERE "id"=$1 FOR UPDATE NOWAIT'), owner.shopId]);
    expect(query.mock.calls[1]).toEqual([expect.stringContaining('AND r."shopId"=$2 AND r."id"=$3 FOR UPDATE OF c NOWAIT'), context.id, owner.shopId, owner.recoveryId]);
  });

  it("retains the existing blocking four-query lock path for other callers", async () => {
    const { query, tx } = fixture();
    query.mockResolvedValueOnce([context]).mockResolvedValueOnce([{ id: owner.shopId }])
      .mockResolvedValueOnce([{ id: context.id }]).mockResolvedValueOnce([context]);
    await expect(lockRecoveryContext(tx, context.id)).resolves.toEqual(context);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.map(call => call[0]).join(" ")).not.toContain("NOWAIT");
    expect(query.mock.calls[1]?.[0]).toContain('"Shop" WHERE "id"=$1 FOR UPDATE');
    expect(query.mock.calls[2]?.[0]).toContain('"Conversation" WHERE "id"=$1 FOR UPDATE');
  });

  it("does not return a mismatched or missing owner", async () => {
    const { query, tx } = fixture();
    query.mockResolvedValueOnce([{ id: owner.shopId }]).mockResolvedValueOnce([{ ...context, shopId: "other-shop" }]);
    await expect(lockRecoveryContext(tx, context.id, owner)).resolves.toBeNull();
    query.mockReset().mockResolvedValueOnce([]);
    await expect(lockRecoveryContext(tx, context.id, owner)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("propagates the original lock error and does not proceed after the Shop lock fails", async () => {
    const { query, tx } = fixture();
    const original = new Error("could not obtain lock on row");
    query.mockRejectedValueOnce(original);
    await expect(lockRecoveryContext(tx, context.id, owner)).rejects.toBe(original);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
