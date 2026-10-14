import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
import { hostFixture as f } from "../host.fixture.js";

export function registerGrantHostTests() {
  describe("Commerce host grants, discovery, and concurrency", () => {
it("discovers arbitrary names, sends bounded context only and sends only reply text", async () => {
    const requests: ModelRequest[] = [];
    const output = await f.run(async (request) => {
      requests.push(request);
      return requests.length === 1
        ? {
            calls: [
              {
                name: "never_seeded_catalogue_facts",
                arguments: { handle: "linen" },
              },
            ],
            outputTokens: 10,
          }
        : f.final({
            answerKind: "ANSWER",
            referralReason: null,
            replyText: "Blue linen",
          });
    });
    expect(output.replyText).toBe("Blue linen");
    expect(output).not.toHaveProperty("details");
    expect(f.grants.size).toBe(1);
    expect(requests[0]?.instructions.filter((instruction) =>
      instruction.includes("Synthetic Feature behavior."),
    )).toHaveLength(1);
    expect(f.observations.some((observation) => observation.method === "prompts/get")).toBe(false);
    expect(requests[1]?.messages).toEqual([
      expect.objectContaining({ tool: "never_seeded_catalogue_facts" }),
    ]);
    const list = f.observations.filter((o) => o.method === "tools/list");
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((o) => JSON.stringify(o.params) === "{}")).toBe(true);
    expect(
      f.observations.find((o) => o.method === "initialize")?.params
        .protocolVersion,
    ).toBe("2025-11-25");
    expect(f.observations[0]?.claims).toMatchObject({
      purpose: "resolve",
      shopId: "shop-fixture",
      checkoutRecoveryId: "recovery-fixture",
    });
    expect(f.observations[0]?.claims).not.toHaveProperty("grantId");
    expect(list[0]?.claims).toMatchObject({
      purpose: "execute",
      grantId: "grant-0",
      releaseId: "release-fixture",
    });
  });

it("applies shared Feature behaviour once and exposes a reused Tool once", async () => {
    const sibling = structuredClone(f.active.capabilities[0]!);
    sibling.capabilityId = "capability-sibling";
    sibling.key = "feature_product_read_sibling";
    sibling.position = 1;
    f.active.capabilities.push(sibling);
    f.active.selectedCapabilityKeys.push(sibling.key);
    f.active.grantedTools[0]!.capabilityKeys.push(sibling.key);

    let captured: ModelRequest | undefined;
    await f.run(async (request) => {
      captured = request;
      return f.final();
    });

    expect(f.active.featureBehaviours).toHaveLength(1);
    expect(captured?.instructions.filter((instruction) =>
      instruction.includes("Synthetic Feature behavior."),
    )).toHaveLength(1);
    expect(captured?.tools.map((entry) => entry.name)).toEqual([
      f.active.capabilities[0]!.toolDescriptor.name,
      "finalResponse",
    ]);
    expect(f.grants.get(f.state.id).selectedCapabilityKeys).toEqual([
      f.active.capabilities[0]!.key,
      sibling.key,
    ]);
    expect(f.grants.get(f.state.id).grantedTools[0].capabilityKeys).toEqual([
      f.active.capabilities[0]!.key,
      sibling.key,
    ]);
    expect(f.observations.some((observation) => observation.method === "prompts/get")).toBe(false);
  });

it("R02 validates new bounded details without interpreting them; R08 referral has empty details", async () => {
    f.active.responseContract = {
      version: "response.v1",
      instructions: "Return a summary detail",
      detailsSchema: {
        type: "object",
        properties: { summary: { type: "string", maxLength: 40 } },
        required: ["summary"],
        additionalProperties: false,
      },
    };
    f.active.responseContractHash = f.digest(
      f.responseContractCanonicalJson(f.active.responseContract),
    );
    expect(
      await f.run(async () =>
        f.final({
          answerKind: "ANSWER",
          referralReason: null,
          replyText: "Facts",
          details: { summary: "internal only" },
        }),
      ),
    ).toMatchObject({ replyText: "Facts" });
    expect(await f.run(async () => f.final())).toMatchObject({
      replyText: expect.stringContaining("https://fixture.myshopify.com"),
    });
  });

it("R07/P05 retains old grant and response hash on a later turn while fresh state changes", async () => {
    await f.run(async () => f.final());
    const old = f.grants.get(f.state.id);
    f.active = structuredClone(f.active);
    f.active.releaseId = "release-new";
    f.active.responseContract.instructions = "New definition";
    f.active.responseContractHash = f.digest(
      f.responseContractCanonicalJson(f.active.responseContract),
    );
    f.releases.set(f.active.releaseId, f.active);
    f.state.inboundVersion = 2;
    f.state.processingInboundVersion = 2;
    f.state.checkoutRecovery.status = "COMPLETED";
    const second = vi.fn(async (request: ModelRequest) => {
      expect((request.context as any).trustedRecovery.recovery.status).toBe(
        "COMPLETED",
      );
      return f.final();
    });
    await f.run(second, {
      ...f.context,
      conversation: { ...f.context.conversation, version: 2 },
    });
    expect(f.grants.get(f.state.id)).toEqual(old);
    expect(f.db.commerceConversationGrant.create).toHaveBeenCalledTimes(1);
    expect(
      f.observations.filter((o) => o.method === "resources/read").at(-1)?.claims
        .releaseId,
    ).toBe("release-fixture");
  });

it("a newly named tool is available only to new grants, without a host switch", async () => {
    await f.run(async () => f.final());
    f.active = structuredClone(f.active);
    f.active.releaseId = "new-release";
    f.active.capabilities[0]!.toolDescriptor.name = "newly_authored_fabric";
    f.active.grantedTools[0]!.toolName = "newly_authored_fabric";
    f.active.capabilities[0]!.toolDescriptor.toolId = "new-tool";
    f.active.capabilities[0]!.toolDescriptor.toolRevisionId =
      "new-tool-revision";
    f.active.grantedTools[0]!.toolId = "new-tool";
    f.active.grantedTools[0]!.toolRevisionId = "new-tool-revision";
    f.releases.set(f.active.releaseId, f.active);
    await f.run(async (request) => {
      expect(request.tools.map((t) => t.name)).not.toContain(
        "newly_authored_fabric",
      );
      return f.final();
    });
    f.state.id = "new-conversation";
    await f.run(
      async (request) => {
        expect(request.tools.map((t) => t.name)).toContain(
          "newly_authored_fabric",
        );
        return f.final();
      },
      {
        ...f.context,
        conversation: { ...f.context.conversation, conversationId: f.state.id },
      },
    );
    expect(f.grants.size).toBe(2);
  });

it("first-turn insert races retain the unique winner", async () => {
    try {
      await Promise.all([f.run(async () => f.final()), f.run(async () => f.final())]);
    } catch (error) {
      if (f.fixtureError) throw f.fixtureError;
      throw error;
    }
    expect(f.fixtureError).toBeNull();
    expect(f.grants.size).toBe(1);
    expect(
      f.observations
        .filter((o) => o.method === "tools/list")
        .every((o) => o.claims.grantId === "grant-0"),
    ).toBe(true);
  });

it("uses a concurrently persisted different release instead of its losing resolve candidate", async () => {
  const winner = structuredClone(f.active);
  winner.releaseId = "winner-release";
  f.releases.set(winner.releaseId, winner);
  f.db.commerceConversationGrant.create.mockImplementationOnce(
    async ({ data }) => {
      f.grants.set(data.conversationId, {
        ...data,
        id: "winner-grant",
        releaseId: winner.releaseId,
        createdAt: new Date(),
        expiresAt: null,
      });
      throw new f.Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "6.19.3",
      });
    },
  );
  try {
    await f.run(async () => f.final());
  } catch (error) {
    if (f.fixtureError) throw f.fixtureError;
    throw error;
  }
  expect(f.fixtureError).toBeNull();
  expect(
    f.observations
      .filter((o) => o.method === "tools/list")
      .every(
        (o) =>
          o.claims.releaseId === "winner-release" &&
          o.claims.grantId === "winner-grant",
      ),
  ).toBe(true);
});
  });
}
