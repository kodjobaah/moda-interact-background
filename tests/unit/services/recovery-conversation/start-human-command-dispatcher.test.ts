import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../src/services/recovery-conversation/human-command-dispatcher.service.js", () => ({
  HumanCommandDispatcherService: class {
    start = lifecycle.start;
    close = lifecycle.close;
  },
}));

import { startHumanCommandDispatcher } from "../../../../src/services/recovery-conversation/start-human-command-dispatcher.js";

describe("startHumanCommandDispatcher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts the dispatcher and returns its orderly async cleanup", async () => {
    const closeDispatcher = await startHumanCommandDispatcher();

    expect(lifecycle.start).toHaveBeenCalledOnce();
    expect(lifecycle.close).not.toHaveBeenCalled();
    await expect(closeDispatcher()).resolves.toBeUndefined();
    expect(lifecycle.close).toHaveBeenCalledOnce();
  });
});