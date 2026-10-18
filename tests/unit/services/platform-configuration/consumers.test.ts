import { describe, expect, it, vi, beforeEach } from "vitest";

const mocked = vi.hoisted(() => ({ read: vi.fn(), readBundle: vi.fn() }));
vi.mock("../../../../src/services/platform-configuration/production.js", () => ({
  createProductionBackgroundPlatformConfiguration: () => mocked,
}));

import {
  readWooCouponPolicy, readR2Configuration, readSpeechOperation,
} from "../../../../src/services/platform-configuration/consumers.js";

const wooPolicy = {
  dispatchBatchSize: 50, refreshIntervalMinutes: 30, dispatchCooldownMinutes: 5,
  unavailableRecheckMinutes: 30, staleScanMinutes: 15, maxPages: 50,
  requestTimeoutMs: 8000, maxResponseBytes: 1048576, maxScanDurationMs: 120000,
  workerConcurrency: 4,
};
const r2 = {
  endpoint: "https://account.r2.cloudflarestorage.com", bucket: "merchant-knowledge-live",
  accessKeyId: "SYNTHETIC_ACCESS_KEY", secretAccessKey: "SYNTHETIC_SECRET_KEY",
  maxUploadBytes: 1024, maxXlsxUncompressedBytes: 8192,
};

describe("ARCH-043 Background consumer configuration snapshots", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads Woo policy for every separate operation rather than memoizing a revision", async () => {
    mocked.read.mockResolvedValueOnce({ key: "woo.couponSync", version: 1, value: wooPolicy })
      .mockResolvedValueOnce({ key: "woo.couponSync", version: 2, value: { ...wooPolicy, workerConcurrency: 7 } });
    expect((await readWooCouponPolicy()).workerConcurrency).toBe(4);
    expect((await readWooCouponPolicy()).workerConcurrency).toBe(7);
    expect(mocked.read).toHaveBeenNthCalledWith(2, "woo.couponSync");
  });

  it("returns a complete sealed R2 tuple from one reader call per operation", async () => {
    mocked.read.mockResolvedValue({ key: "merchant.knowledge.r2", version: 8, value: r2 });
    expect(await readR2Configuration()).toEqual(r2);
    expect(mocked.read).toHaveBeenCalledTimes(1);
    expect(mocked.read).toHaveBeenCalledWith("merchant.knowledge.r2");
  });

  it("uses one coherent speech policy and generic provider-key bundle", async () => {
    mocked.readBundle.mockResolvedValue({
      "speech.transcription": { version: 11, value: { provider: "openai", groqModelId: "groq-model", openaiModelId: "openai-model" } },
      "ai.providers": { version: 4, value: { openAiApiKey: "SYNTHETIC_KEY" } },
    });
    expect(await readSpeechOperation()).toEqual({ provider: "openai", model: "openai-model", apiKey: "SYNTHETIC_KEY" });
    expect(mocked.readBundle).toHaveBeenCalledWith(["speech.transcription", "ai.providers"]);
    expect(mocked.read).not.toHaveBeenCalled();
  });

  it("does not fall back to an unrelated speech provider after credential revocation", async () => {
    mocked.readBundle.mockResolvedValue({
      "speech.transcription": { version: 12, value: { provider: "openai", groqModelId: "groq-model", openaiModelId: "openai-model" } },
      "ai.providers": { version: 5, value: { groqApiKey: "SYNTHETIC_OTHER_KEY" } },
    });
    await expect(readSpeechOperation()).rejects.toThrow("speech-transcription-configuration-missing");
    expect(mocked.readBundle).toHaveBeenCalledTimes(1);
  });

  it("never retries revoked/disabled R2 configuration through environment variables", async () => {
    mocked.read.mockRejectedValue(new Error("DISABLED"));
    await expect(readR2Configuration()).rejects.toThrow("DISABLED");
    expect(mocked.read).toHaveBeenCalledTimes(1);
  });
});
