import { describe, expect, it, vi } from "vitest";
import { PlatformOperationalPolicyReader, OperationalPolicyError } from "../../../src/services/platform-operational-policy.js";
import { validateWooCouponSyncConfig } from "../../../src/services/woo-coupon-sync-config.js";

vi.mock("../../../src/lib/db.js", () => ({ default: { platformConfiguration: { findUnique: vi.fn() } } }));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({ resolveDeploymentEnvironmentName: () => "test" }));
const validWoo = {
  dispatchBatchSize: 2, refreshIntervalMinutes: 30, dispatchCooldownMinutes: 5,
  unavailableRecheckMinutes: 30, staleScanMinutes: 15, maxPages: 10,
  requestTimeoutMs: 8000, maxResponseBytes: 1048576, maxScanDurationMs: 120000,
  workerConcurrency: 3,
};
function repository(values: Record<string, unknown>) {
  const findUnique = vi.fn(async ({ where }: { where: { environment_key: { environment: string; key: string } } }) => {
    const { key, environment } = where.environment_key;
    if (environment !== "production" || !(key in values)) return null;
    return { key, environment, version: 2, value: values[key] };
  });
  return { db: { platformConfiguration: { findUnique } } as never, findUnique };
}
describe("ARCH-043 operation-scoped Background policy", () => {
  it("queries exact deployment/key on every call and observes committed revisions", async () => {
    const values: Record<string, unknown> = { "woo.couponSync": { ...validWoo } };
    const { db, findUnique } = repository(values);
    const reader = new PlatformOperationalPolicyReader(db, "production");
    expect((await reader.wooCouponSync()).dispatchBatchSize).toBe(2);
    values["woo.couponSync"] = { ...validWoo, dispatchBatchSize: 3 };
    expect((await reader.wooCouponSync()).dispatchBatchSize).toBe(3);
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(findUnique.mock.calls[0]?.[0].where.environment_key).toEqual({ environment: "production", key: "woo.couponSync" });
  });
  it("does not cross environments or consult deprecated environment overrides", async () => {
    const { db } = repository({ "woo.couponSync": validWoo });
    const reader = new PlatformOperationalPolicyReader(db, "test");
    expect((await reader.wooCouponSync()).dispatchBatchSize).toBe(500);
  });
  it("defaults only for missing rows and denies malformed, disabled or unavailable records", async () => {
    const values: Record<string, unknown> = { "woo.couponSync": { kind: "disabled", schemaVersion: 1 } };
    const { db, findUnique } = repository(values);
    const reader = new PlatformOperationalPolicyReader(db, "production");
    await expect(reader.wooCouponSync()).rejects.toMatchObject({ code: "disabled_policy" });
    values["woo.couponSync"] = { ...validWoo, workerConcurrency: 1000 };
    await expect(reader.wooCouponSync()).rejects.toThrow(RangeError);
    values["woo.couponSync"] = { kind: "disabled", schemaVersion: 3 };
    await expect(reader.wooCouponSync()).rejects.toMatchObject({ code: "invalid_policy" });
    findUnique.mockRejectedValueOnce(new Error("connection string with password"));
    await expect(reader.wooCouponSync()).rejects.toEqual(new OperationalPolicyError("database_unavailable"));
  });
  it("validates strict Woo bounds and rejects unknown keys", () => {
    expect(validateWooCouponSyncConfig(validWoo).workerConcurrency).toBe(3);
    expect(() => validateWooCouponSyncConfig({ ...validWoo, extra: 5 })).toThrow(RangeError);
  });
  it("reads speech policy once per operation with closed models and no env fallback", async () => {
    const values: Record<string, unknown> = { "speech.transcription": {
      provider: "openai", groqModelId: "whisper-large-v3-turbo", openaiModelId: "gpt-4o-transcribe",
    }};
    const { db, findUnique } = repository(values);
    const reader = new PlatformOperationalPolicyReader(db, "production");
    expect((await reader.transcription()).openaiModelId).toBe("gpt-4o-transcribe");
    values["speech.transcription"] = { ...values["speech.transcription"] as object, groqModelId: "bad model" };
    await expect(reader.transcription()).rejects.toMatchObject({ code: "invalid_policy" });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
