import { describe, expect, it, vi } from "vitest";
import { lockRecoverySenderRecipient } from "../../../src/services/recovery-sender-pool/recipient-lock.js";

describe("sender allocation recipient serialization", () => {
  it.each(["", "+447700900123", "0447700900123", "1e12", "1234567890123456"])(
    "rejects noncanonical identity %s",
    async (value) => {
      const query = vi.fn();
      await expect(
        lockRecoverySenderRecipient({ $queryRawUnsafe: query } as never, value),
      ).rejects.toThrow("INVALID_SENDER_POOL_RECIPIENT");
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("reuses a deterministic int64 per recipient and parameterizes SQL", async () => {
    const query = vi.fn(async () => []);
    const tx = { $queryRawUnsafe: query } as never;
    await lockRecoverySenderRecipient(tx, "447700900123");
    await lockRecoverySenderRecipient(tx, "447700900123");
    await lockRecoverySenderRecipient(tx, "447700900124");
    expect(query.mock.calls[0]).toEqual(query.mock.calls[1]);
    expect(query.mock.calls[0]![1]).not.toBe(query.mock.calls[2]![1]);
    expect(typeof query.mock.calls[0]![1]).toBe("bigint");
    expect(query.mock.calls[0]![0]).not.toContain("447700900123");
  });
});
