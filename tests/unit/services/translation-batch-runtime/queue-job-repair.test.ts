import { describe, expect, it, vi } from "vitest";

import { ensureDeterministicTranslationQueueJob } from "../../../../src/services/translation-batch-runtime/queue-job-repair.js";

const expected = {
  id: "translation-job-1",
  name: "translation-job",
  data: { translationBatchId: "batch-1" },
};

describe("translation deterministic queue-job repair", () => {
  it("creates a missing deterministic job", async () => {
    const add = vi.fn(async () => undefined);
    const queue = {
      getJob: vi.fn(async () => undefined),
      add,
    };

    await expect(ensureDeterministicTranslationQueueJob(queue as never, expected))
      .resolves.toBe(1);
    expect(add).toHaveBeenCalledWith(expected.name, expected.data, { jobId: expected.id });
  });

  it.each(["waiting", "delayed", "active"])(
    "keeps an existing healthy %s job",
    async (state) => {
      const remove = vi.fn();
      const add = vi.fn();
      const queue = {
        getJob: vi.fn(async () => ({
          getState: vi.fn(async () => state),
          remove,
        })),
        add,
      };

      await expect(ensureDeterministicTranslationQueueJob(queue as never, expected))
        .resolves.toBe(0);
      expect(remove).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    },
  );

  it("removes a stale deterministic job before recreating it", async () => {
    const remove = vi.fn(async () => undefined);
    const add = vi.fn(async () => undefined);
    const queue = {
      getJob: vi.fn(async () => ({
        getState: vi.fn(async () => "completed"),
        remove,
      })),
      add,
    };

    await expect(ensureDeterministicTranslationQueueJob(queue as never, expected))
      .resolves.toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(expected.name, expected.data, { jobId: expected.id });
  });
});
