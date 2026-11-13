import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrozenMultipart } from "../../../../src/services/recovery-multipart/frozen.js";

const runtime = vi.hoisted(() => ({
  freeze: vi.fn(async () => "created" as const),
  continue: vi.fn(async () => "acknowledged" as const),
}));
vi.mock("../../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("../../../../src/services/recovery-multipart/runtime.js", () => ({ recoveryMultipartEngine: runtime }));

import { createHumanDispatcherDependencies } from "../../../../src/services/recovery-conversation/human-command-dispatcher.service.js";

describe("default production HUMAN multipart adapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates absent-root freeze and continuation to the same canonical runtime", async () => {
    // Deliberately construct production dependencies; injecting a complete engine
    // into the dispatcher would hide the missing production freeze delegation.
    const adapter = createHumanDispatcherDependencies().multipart!;
    const source = { messageId: "immutable-human-root" } as FrozenMultipart;
    expect(adapter.freeze).toBeTypeOf("function");
    await expect(adapter.freeze!(source)).resolves.toBe("created");
    await expect(adapter.continue(source.messageId)).resolves.toBe("acknowledged");
    expect(runtime.freeze).toHaveBeenCalledExactlyOnceWith(source);
    expect(runtime.continue).toHaveBeenCalledExactlyOnceWith(source.messageId);
  });
});
