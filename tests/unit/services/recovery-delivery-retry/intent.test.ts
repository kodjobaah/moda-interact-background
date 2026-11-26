import { describe, expect, it, vi } from "vitest";
import { recordRecoveryDeliveryRetryIntent } from "../../../../src/services/recovery-delivery-retry/intent.js";
import type { CompensationTransaction } from "../../../../src/services/recovery-delivery-compensation/types.js";

const failedAt = new Date("2026-11-25T11:32:42.000Z");
const input = {
  attemptId: "attempt", messageId: "message", reservationId: "reservation",
  expectedGeneration: 1, expectedLastExternalActivityAt: failedAt,
  providerFailureCode: "131016", failedAt,
};
const config = {
  recoveryDeliveryTemporaryRetryDelayMinutes: 7,
  recoveryDeliveryRateLimitRetryDelayMinutes: 29,
  recoveryDeliveryMarketingRetryDelayMinutes: 2880,
  recoveryDeliveryMaxRetries: 4,
};

function fixture(settings: typeof config | null) {
  const findUnique = vi.fn().mockResolvedValue(settings);
  const upsert = vi.fn().mockResolvedValue({ id: "intent", failedMessageId: input.messageId,
    fundingReservationId: input.reservationId, providerFailureCode: input.providerFailureCode, cancelledAt: null });
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = { backgroundRuntimeConfig: { findUnique }, recoveryOutreachRetryIntent: { upsert, updateMany } } as unknown as CompensationTransaction;
  return { tx, findUnique, upsert, updateMany };
}

describe("recovery retry intent runtime configuration", () => {
  it("reads the authoritative singleton and does not rewrite an existing decision on replay", async () => {
    const f = fixture(config);
    await recordRecoveryDeliveryRetryIntent(f.tx, input);
    expect(f.findUnique).toHaveBeenCalledWith({ where: { id: "default" }, select: {
      recoveryDeliveryTemporaryRetryDelayMinutes: true, recoveryDeliveryRateLimitRetryDelayMinutes: true,
      recoveryDeliveryMarketingRetryDelayMinutes: true, recoveryDeliveryMaxRetries: true,
    } });
    expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { failedAttemptId: input.attemptId },
      create: expect.objectContaining({ policy: "AFTER_COOLDOWN", notBeforeAt: new Date(failedAt.getTime() + 7 * 60_000) }), update: {} }));
    f.findUnique.mockResolvedValue({ ...config, recoveryDeliveryTemporaryRetryDelayMinutes: 29 });
    await recordRecoveryDeliveryRetryIntent(f.tx, input);
    expect(f.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: {} }));
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it.each([null, { ...config, recoveryDeliveryMaxRetries: 0 }, { ...config, recoveryDeliveryTemporaryRetryDelayMinutes: -1 }])(
    "records an inert decision rather than throwing when configuration is missing, disabled or invalid", async settings => {
      const f = fixture(settings);
      await expect(recordRecoveryDeliveryRetryIntent(f.tx, input)).resolves.toBeUndefined();
      expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ policy: "REVIEW_REQUIRED", notBeforeAt: null }), update: {},
      }));
    },
  );

  it("propagates the original database exception for whole-transaction retry", async () => {
    const f = fixture(config);
    const original = new Error("Configuration query failed");
    f.findUnique.mockRejectedValue(original);
    await expect(recordRecoveryDeliveryRetryIntent(f.tx, input)).rejects.toBe(original);
    expect(f.upsert).not.toHaveBeenCalled();
  });
});
