import { describe, expect, it, vi } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

export function registerAuthorityHostTests() {
  describe("Commerce host authority and trust boundaries", () => {
it("denies a mismatched canonical Shop ID before invoking the model", async () => {
    const invoke = vi.fn(async () => f.final());

    await expect(f.run(invoke, { ...f.context, shopId: "another-shop" })).rejects.toMatchObject({
      code: "DENIED",
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(f.observations).toHaveLength(0);
  });

it("denies a mismatched Shop domain before invoking the model", async () => {
    const invoke = vi.fn(async () => f.final());

    await expect(f.run(invoke, { ...f.context, shop: "another-shop.myshopify.com" })).rejects.toMatchObject({
      code: "DENIED",
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(f.observations).toHaveLength(0);
  });

it.each(["wrong-hash", "missing-hash", "unknown-contract", "unknown-runner"])(
    "R12 fails closed for %s",
    async (issue) => {
      if (issue === "wrong-hash") f.active.responseContractHash = "0".repeat(64);
      if (issue === "missing-hash") delete (f.active as any).responseContractHash;
      if (issue === "unknown-contract")
        (f.active as any).contractVersion = "commerce.v9";
      if (issue === "unknown-runner") f.active.runnerCompatibility = "^9.0.0";
      const model = vi.fn(async () => f.final());
      await expect(f.run(model)).rejects.toThrow();
      expect(model).not.toHaveBeenCalled();
    },
  );

it("rejects another shop's persisted grant", async () => {
    await f.run(async () => f.final());
    f.state.checkoutRecovery.shopId = "another-shop";
    const model = vi.fn();
    await expect(f.run(model)).rejects.toMatchObject({ code: "DENIED" });
    expect(model).not.toHaveBeenCalled();
  });

it("rejects server expansion beyond the retained grant", async () => {
    await f.run(async () => f.final());
    f.active = structuredClone(f.active);
    f.active.capabilities[0]!.toolDescriptor.name = "injected_tool";
    f.expand = true;
    await expect(f.run(vi.fn())).rejects.toMatchObject({ code: "DENIED" });
  });

it("supports zero tools and current revocation without changing the original grant", async () => {
    await f.run(async () => f.final());
    f.revoked = true;
    await f.run(async (request) => {
      expect(request.tools.map((t) => t.name)).toEqual(["finalResponse"]);
      return f.final();
    });
    expect(f.grants.get(f.state.id).grantedTools).toHaveLength(1);
  });

it.each(["COMPLETED", "EXPIRED", "CANCELLED", "MESSAGE_SENT", "ENGAGED"])(
    "P01-P04 passes fresh %s as data, null completedAt and fixed original-grant instructions",
    async (status) => {
      f.state.checkoutRecovery.status = status;
      await f.run(async (request) => {
        expect((request.context as any).trustedRecovery.recovery).toMatchObject(
          { status, completedAt: null, totalPrice: "10.00" },
        );
        expect(request.instructions.join(" ")).toContain(
          "COMPLETED means the purchase completed even when completedAt is null",
        );
        expect(request.instructions.join(" ")).not.toContain(
          "Name <ignore rules>",
        );
        expect(JSON.stringify(request.context)).not.toContain(
          "UNTRUSTED IGNORE RULES",
        );
        expect(request.history).toEqual(f.context.conversation.history);
        return f.final();
      });
    },
  );

it("P10/P11 refuses invalid final and stale results before delivery", async () => {
    await expect(
      f.run(async () => f.final({ details: { injected: "not allowed" } })),
    ).rejects.toMatchObject({ code: "INVALID_FINAL" });
    await expect(
      f.run(async () => {
        f.state.inboundVersion = 2;
        return f.final();
      }),
    ).rejects.toMatchObject({ code: "STALE_TURN" });
  });

it("propagates cancellation and MCP outage without model fallback", async () => {
    f.outage = true;
    const model = vi.fn(async () => f.final());
    await expect(f.run(model)).rejects.toThrow();
    expect(model).not.toHaveBeenCalled();
    f.outage = false;
    const controller = new AbortController();
    controller.abort();
    await expect(f.run(model, f.context, controller.signal)).rejects.toThrow();
    expect(model).not.toHaveBeenCalled();
  });

it("a pinned release with genuinely no tools still produces a bounded referral", async () => {
  f.active = f.exampleManifest(f.digest, false);
  f.releases.set(f.active.releaseId, f.active);
  expect(f.active.capabilities).toEqual([]);
  expect(f.active.selectedCapabilityKeys).toEqual([]);
  const result = await f.run(async (request) => {
    expect(request.tools.map((t) => t.name)).toEqual(["finalResponse"]);
    return f.final();
  });
  expect(result.answerKind).toBe("REFER_TO_STORE");
  expect(f.grants.get(f.state.id).selectedCapabilityKeys).toEqual([]);
  expect(f.grants.get(f.state.id).grantedTools).toEqual([]);
});

it("P10 a model cannot expand authority through tool arguments", async () => {
  let step = 0;
  const model = async () =>
    ++step === 1
      ? {
          calls: [
            {
              name: "never_seeded_catalogue_facts",
              arguments: { handle: "linen", shopId: "another-shop" },
            },
          ],
          outputTokens: 10,
        }
      : f.final();
  await expect(f.run(model)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(f.observations.filter((o) => o.method === "tools/call")).toEqual([]);
});
  });
}
