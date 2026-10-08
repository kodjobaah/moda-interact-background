import { describe, expect, it, vi } from "vitest";

import { applyTranslationProviderResults } from "../../../../src/services/translation-batch-runtime/provider-results.js";

const messages = {
  countMismatch: "count mismatch",
  unknownProviderCustomId: (providerCustomId: string) => `unknown:${providerCustomId}`,
  duplicateProviderCustomId: "duplicate",
};

function result(providerCustomId: string) {
  return {
    providerCustomId,
    status: "completed" as const,
    translatedText: `translated:${providerCustomId}`,
    failureCode: null,
  };
}

describe("translation provider results runtime", () => {
  it("reads all provider result files, proves membership, and counts applied results", async () => {
    const events: string[] = [];
    const provider = {
      readOutputFile: vi.fn(async (fileId: string) => {
        events.push(`read:${fileId}`);
        return fileId === "output-1" ? [result("item-1")] : [result("item-2")];
      }),
    };
    const loadExpectedProviderCustomIds = vi.fn(async () => {
      events.push("expected");
      return ["item-1", "item-2"];
    });
    const applyResult = vi.fn(async (current: ReturnType<typeof result>) => {
      events.push(`apply:${current.providerCustomId}`);
      return current.providerCustomId === "item-1";
    });

    await expect(applyTranslationProviderResults({
      provider: provider as never,
      outputFileId: "output-1",
      errorFileId: "error-1",
      missingResultFileMessage: "missing",
      loadExpectedProviderCustomIds,
      membershipMessages: messages,
      applyResult,
    })).resolves.toEqual({ applied: 1 });

    expect(provider.readOutputFile).toHaveBeenCalledTimes(2);
    expect(events.indexOf("expected")).toBeGreaterThan(events.indexOf("read:output-1"));
    expect(events.indexOf("expected")).toBeGreaterThan(events.indexOf("read:error-1"));
    expect(applyResult).toHaveBeenCalledTimes(2);
  });

  it("rejects a batch with no provider result files before loading expected items", async () => {
    const loadExpectedProviderCustomIds = vi.fn();

    await expect(applyTranslationProviderResults({
      provider: { readOutputFile: vi.fn() } as never,
      outputFileId: null,
      errorFileId: null,
      missingResultFileMessage: "missing result file",
      loadExpectedProviderCustomIds,
      membershipMessages: messages,
      applyResult: vi.fn(),
    })).rejects.toThrow("missing result file");

    expect(loadExpectedProviderCustomIds).not.toHaveBeenCalled();
  });

  it("proves exact membership before applying any domain result", async () => {
    const applyResult = vi.fn();

    await expect(applyTranslationProviderResults({
      provider: {
        readOutputFile: vi.fn(async () => [result("foreign-item")]),
      } as never,
      outputFileId: "output-1",
      errorFileId: null,
      missingResultFileMessage: "missing",
      loadExpectedProviderCustomIds: async () => ["item-1"],
      membershipMessages: messages,
      applyResult,
    })).rejects.toThrow("unknown:foreign-item");

    expect(applyResult).not.toHaveBeenCalled();
  });
});
