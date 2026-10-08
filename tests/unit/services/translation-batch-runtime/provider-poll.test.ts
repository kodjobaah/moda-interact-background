import { describe, expect, it, vi } from "vitest";

import { pollTranslationProviderBatch } from "../../../../src/services/translation-batch-runtime/provider-poll.js";
import { translationItemRetryDisposition } from "../../../../src/services/translation-batch-runtime/item-retry.js";

function providerBatch(status: "nonterminal" | "completed" | "failed" | "expired" | "cancelled") {
  return {
    provider: "openai" as const,
    providerStatus: status === "nonterminal" ? "in_progress" as const : status,
    providerBatchId: "provider-batch-1",
    logicalBatchId: "batch-1",
    status,
    inputFileId: "input-1",
    outputFileId: status === "completed" ? "output-1" : null,
    errorFileId: status === "failed" ? "error-1" : null,
    failureCode: status === "failed" ? "http-500" : null,
    createdAt: null,
    completedAt: status === "completed" ? "2026-10-08T00:00:00.000Z" : null,
  };
}

function callbacks(status: Parameters<typeof providerBatch>[0]) {
  return {
    retrieve: vi.fn().mockResolvedValue(providerBatch(status)),
    onReadFailure: vi.fn().mockResolvedValue("read-failed"),
    onNonterminal: vi.fn().mockResolvedValue("nonterminal"),
    onCompleted: vi.fn().mockResolvedValue("completed"),
    onTerminal: vi.fn().mockResolvedValue("terminal"),
  };
}

describe("translation provider poll runtime", () => {
  it("routes retrieval failures without treating callback failures as provider read failures", async () => {
    const current = callbacks("nonterminal");
    current.retrieve.mockRejectedValue(new Error("provider unavailable"));

    await expect(pollTranslationProviderBatch(current)).resolves.toBe("read-failed");
    expect(current.onReadFailure).toHaveBeenCalledTimes(1);
    expect(current.onNonterminal).not.toHaveBeenCalled();
  });

  it("routes nonterminal and completed provider batches to their canonical callbacks", async () => {
    const nonterminal = callbacks("nonterminal");
    await expect(pollTranslationProviderBatch(nonterminal)).resolves.toBe("nonterminal");
    expect(nonterminal.onNonterminal).toHaveBeenCalledWith(expect.objectContaining({ status: "nonterminal" }));

    const completed = callbacks("completed");
    await expect(pollTranslationProviderBatch(completed)).resolves.toBe("completed");
    expect(completed.onCompleted).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("routes failed, expired and cancelled batches through the terminal callback", async () => {
    for (const status of ["failed", "expired", "cancelled"] as const) {
      const current = callbacks(status);
      await expect(pollTranslationProviderBatch(current)).resolves.toBe("terminal");
      expect(current.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status }));
    }
  });

  it("does not reinterpret domain callback failures as provider read failures", async () => {
    const current = callbacks("completed");
    current.onCompleted.mockRejectedValue(new Error("database unavailable"));

    await expect(pollTranslationProviderBatch(current)).rejects.toThrow("database unavailable");
    expect(current.onReadFailure).not.toHaveBeenCalled();
  });
});

describe("translation item retry disposition", () => {
  it("retries a retryable failure within budget at the configured delay", () => {
    expect(translationItemRetryDisposition({
      failureCode: "http-500",
      retryCount: 1,
      maxAutoRetries: 3,
      retryDelaySeconds: 60,
      nowMs: 1_000,
    })).toEqual({
      shouldRetry: true,
      status: "PENDING",
      retryIncrement: 1,
      nextAttemptAt: new Date(61_000),
    });
  });

  it("fails terminal provider errors and retryable errors whose budget is exhausted", () => {
    expect(translationItemRetryDisposition({
      failureCode: "invalid-request",
      retryCount: 0,
      maxAutoRetries: 3,
      retryDelaySeconds: 60,
      nowMs: 1_000,
    })).toEqual({
      shouldRetry: false,
      status: "FAILED",
      retryIncrement: 0,
      nextAttemptAt: null,
    });

    expect(translationItemRetryDisposition({
      failureCode: "http-500",
      retryCount: 3,
      maxAutoRetries: 3,
      retryDelaySeconds: 60,
      nowMs: 1_000,
    })).toEqual({
      shouldRetry: false,
      status: "FAILED",
      retryIncrement: 0,
      nextAttemptAt: null,
    });
  });
});
