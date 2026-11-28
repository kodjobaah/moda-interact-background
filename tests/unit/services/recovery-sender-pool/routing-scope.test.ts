import { describe, expect, it, vi } from "vitest";
import { RoutingRuntime } from "../../../../src/services/recovery-sender-pool/routing-runtime.js";

/** Quote identity is not shop authorization, including while the same sender hosts two shops. */
describe("routing prompt history scope", () => {
  it("excludes foreign quoted prompts before their original text is read by the model", async () => {
    const own = {
      inboundProviderMessageId: "own-prompt",
      threadId: "thread-a",
      routeId: "route-a",
      promptScopeRouteId: "route-a",
      parentProviderMessageId: "own-root",
      promptText: "Choose your basket",
    };
    const foreign = {
      ...own,
      inboundProviderMessageId: "foreign-prompt",
      routeId: "route-b",
      promptScopeRouteId: "route-b",
      parentProviderMessageId: "foreign-root",
      promptProviderMessageId: "quoted-provider",
    };
    const findMany = vi.fn(async () => [own, foreign]);
    const findUnique = vi.fn(
      async ({ where }: { where: { inboundProviderMessageId: string } }) =>
        where.inboundProviderMessageId === "own-root"
          ? {
              threadId: "thread-a",
              routeId: "route-a",
              inputJson: { content: { type: "text", text: "my question" } },
            }
          : {
              threadId: "thread-a",
              routeId: "route-b",
              inputJson: {
                content: { type: "text", text: "foreign private question" },
              },
            },
    );
    const runtime = new RoutingRuntime({
      recoveryBasketRoutingTurn: { findMany, findUnique },
    } as never);
    const row = {
      threadId: "thread-a",
      routeId: "route-a",
      inputJson: { contextMessageId: "quoted-provider" },
    };
    const prompts = await (
      runtime as unknown as {
        confirmedPrompts(row: unknown, text: string): Promise<unknown[]>;
      }
    ).confirmedPrompts(row, "2");
    expect(prompts).toEqual([own]);
    const queried = findUnique.mock.calls.map(
      ([arg]) => arg.where.inboundProviderMessageId,
    );
    expect(queried).not.toContain("foreign-root");
  });
  it("ignores a foreign quoted prompt without reading its original question", async () => {
    const foreign = {
      inboundProviderMessageId: "foreign-prompt",
      threadId: "thread-a",
      routeId: "route-b",
      promptScopeRouteId: "route-b",
      parentProviderMessageId: "foreign-q1",
      promptProviderMessageId: "foreign-receipt",
    };
    const findUnique = vi.fn();
    const db = {
      recoveryBasketRoutingTurn: {
        findMany: vi.fn(async () => [foreign]),
        findUnique,
      },
    };
    const runtime = new RoutingRuntime(db as never);
    const prompts = await (
      runtime as unknown as {
        confirmedPrompts(row: unknown, text: string): Promise<unknown[]>;
      }
    ).confirmedPrompts(
      {
        threadId: "thread-a",
        routeId: "route-a",
        inputJson: { contextMessageId: "foreign-receipt" },
      },
      "2",
    );
    expect(prompts).toEqual([]);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("keeps a same-shop basket prompt whose original Q1 was neutral", async () => {
    const own = {
      inboundProviderMessageId: "shop-selection-q2",
      threadId: "thread-a",
      routeId: "route-a",
      promptScopeRouteId: "route-a",
      parentProviderMessageId: "neutral-q1",
      promptProviderMessageId: "basket-receipt",
    };
    const db = {
      recoveryBasketRoutingTurn: {
        findMany: vi.fn(async () => [own]),
        findUnique: vi.fn(async () => ({
          threadId: "thread-a",
          routeId: null,
        })),
      },
    };
    const runtime = new RoutingRuntime(db as never);
    const prompts = await (
      runtime as unknown as {
        confirmedPrompts(row: unknown, text: string): Promise<unknown[]>;
      }
    ).confirmedPrompts(
      {
        threadId: "thread-a",
        routeId: "route-a",
        inputJson: { contextMessageId: "basket-receipt" },
      },
      "running shoes",
    );
    expect(prompts).toEqual([own]);
    expect(db.recoveryBasketRoutingTurn.findUnique).toHaveBeenCalledWith({
      where: { inboundProviderMessageId: "neutral-q1" },
    });
  });

  it("rejects a shop-bound prompt whose parent is owned by another shop", async () => {
    const prompt = {
      inboundProviderMessageId: "foreign-parent-q2",
      threadId: "thread-a",
      routeId: "route-a",
      promptScopeRouteId: "route-a",
      parentProviderMessageId: "foreign-q1",
      promptProviderMessageId: "quoted-receipt",
    };
    const db = {
      recoveryBasketRoutingTurn: {
        findMany: vi.fn(async () => [prompt]),
        findUnique: vi.fn(async () => ({
          threadId: "thread-a",
          routeId: "route-b",
        })),
      },
    };
    const runtime = new RoutingRuntime(db as never);
    const prompts = await (
      runtime as unknown as {
        confirmedPrompts(row: unknown, text: string): Promise<unknown[]>;
      }
    ).confirmedPrompts(
      {
        threadId: "thread-a",
        routeId: "route-a",
        inputJson: { contextMessageId: "quoted-receipt" },
      },
      "2",
    );
    expect(prompts).toEqual([]);
  });

  it("rejects a neutral original when the child prompt was not scoped to the shop", async () => {
    const prompt = {
      inboundProviderMessageId: "unscoped-child",
      threadId: "thread-a",
      routeId: "route-a",
      promptScopeRouteId: null,
      parentProviderMessageId: "neutral-q1",
      promptProviderMessageId: "quoted-receipt",
    };
    const db = {
      recoveryBasketRoutingTurn: {
        findMany: vi.fn(async () => [prompt]),
        findUnique: vi.fn(async () => ({
          threadId: "thread-a",
          routeId: null,
        })),
      },
    };
    const runtime = new RoutingRuntime(db as never);
    const prompts = await (
      runtime as unknown as {
        confirmedPrompts(row: unknown, text: string): Promise<unknown[]>;
      }
    ).confirmedPrompts(
      {
        threadId: "thread-a",
        routeId: "route-a",
        inputJson: { contextMessageId: "quoted-receipt" },
      },
      "2",
    );
    expect(prompts).toEqual([]);
  });

  it("preserves a verified neutral prompt that was bound to the same shop", async () => {
    const neutral = {
      inboundProviderMessageId: "neutral",
      threadId: "thread",
      routeId: "route-a",
      promptScopeRouteId: null,
      parentProviderMessageId: null,
      promptProviderMessageId: "neutral-receipt",
    };
    const db = {
      recoveryBasketRoutingTurn: {
        findMany: vi.fn(async () => [neutral]),
        findUnique: vi.fn(async () => ({
          threadId: "thread",
          routeId: "route-a",
        })),
      },
    };
    const runtime = new RoutingRuntime(db as never);
    const result = await (
      runtime as unknown as {
        confirmedPrompts(row: unknown, text: string): Promise<unknown[]>;
      }
    ).confirmedPrompts(
      {
        threadId: "thread",
        routeId: "route-a",
        inputJson: { contextMessageId: "neutral-receipt" },
      },
      "1",
    );
    expect(result).toEqual([neutral]);
  });
});
