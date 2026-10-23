import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
import { RecoveryConsentNoticeService } from "../../../../src/services/checkout-recovery/recovery-consent-notice.service.js";

describe("checkout-scoped merchant Support consent notices", () => {
  it("deduplicates the same checkout/reason without retaining raw checkout tokens or phone data", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const upsert = vi.fn(async () => ({ id: "thread-1" }));
    const update = vi.fn(async () => undefined);
    const createMany = vi.fn(async (input: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }) => {
      expect(input.skipDuplicates).toBe(true);
      const row = input.data[0]!;
      const key = row.sourceKey as string;
      if (rows.has(key)) return { count: 0 };
      rows.set(key, row);
      return { count: 1 };
    });
    const tx = {
      merchantSupportThread: { upsert, update },
      merchantSupportMessage: { createMany },
    };
    const service = new RecoveryConsentNoticeService({
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    } as never, () => new Date("2026-10-23T10:00:00Z"));
    const input = { shopId: "shop-1", checkoutToken: "sensitive-checkout-token", reason: "NO_VERIFIED_OPT_IN" } as const;
    expect(await service.publish(input)).toBe("created");
    expect(await service.publish(input)).toBe("duplicate");
    expect(rows.size).toBe(1);
    expect(update).toHaveBeenCalledOnce();
    const row = [...rows.values()][0]!;
    expect(row.kind).toBe("SYSTEM");
    expect(row.systemCode).toBe("SHOPIFY_RECOVERY_CONSENT_ADMISSION");
    expect(row.originalBody).not.toContain(input.checkoutToken);
    expect(row.sourceKey).not.toContain(input.checkoutToken);
    expect(JSON.stringify(row)).not.toContain("447700900001");
    expect(await service.publish({ ...input, reason: "VERIFICATION_UNAVAILABLE" })).toBe("created");
    expect(rows.size).toBe(2);
    expect(String([...rows.values()][1]!.originalBody)).toContain("unknown, not refused");
  });
});
