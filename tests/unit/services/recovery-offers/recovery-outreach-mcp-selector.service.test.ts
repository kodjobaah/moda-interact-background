import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RESPONSE_CONTRACT, CommerceManifestSchema, CommercePurposeProfileSchema } from "@modainteract/moda-interact-shared/commerce";
import { RecoveryOutreachMcpSelectorService, type OutreachMcpToolDescriptor } from "../../../../src/services/recovery-offers/recovery-outreach-mcp-selector.service.js";
import { CommerceMcpClient } from "../../../../src/commerce/mcp-client.js";
const inputSchema = { type: "object", properties: { query: { type: "string", maxLength: 64 } }, required: ["query"], additionalProperties: false };
const outputSchema = { type: "object", properties: { label: { type: "string", maxLength: 100 } }, required: ["label"], additionalProperties: false };
const names = ["commerce_get_discount_options", "commerce_get_discount_details", "commerce_search_products", "commerce_get_product", "commerce_store_hours"];
function fixture(config: {
    names?: string[];
    manifest?: unknown;
    tools?: OutreachMcpToolDescriptor[];
    data?: unknown;
} = {}) {
    const chosen = config.names ?? names;
    const capabilities = chosen.map((name, position) => ({ capabilityId: `cap-${position}`, key: `key-${position}`, featureId: "owner", position, toolDescriptor: { toolId: `tool-${position}`, toolRevisionId: `rev-${position}`, name, definitionVersion: "1.0.0", description: name, inputSchema } }));
    const profile = { purpose: "INITIAL_RECOVERY_OUTREACH", featureId: "outreach", releaseId: "release-1", behaviourPrompt: "Published trusted behavior", capabilities: capabilities.map(c => ({ capabilityId: c.capabilityId, toolId: c.toolDescriptor.toolId, revisionId: c.toolDescriptor.toolRevisionId, name: c.toolDescriptor.name, position: c.position, inputSchema, outputSchema })) };
    const manifest = { contractVersion: "commerce.v1", releaseId: "release-1", runnerCompatibility: "^1.0.0", capabilities, selectedCapabilityKeys: capabilities.map(c => c.key), featureBehaviours: [{ featureId: "owner", behaviourPrompt: "owner behavior" }], builtInTools: [], grantedTools: capabilities.map(c => ({ toolId: c.toolDescriptor.toolId, toolRevisionId: c.toolDescriptor.toolRevisionId, toolName: c.toolDescriptor.name, definitionVersion: "1.0.0", capabilityKeys: [c.key] })), responseContract: EMPTY_RESPONSE_CONTRACT, responseContractHash: "a".repeat(64), purposeProfile: profile };
    const client = { connect: vi.fn(async () => undefined), manifest: vi.fn(async () => config.manifest ?? manifest), pinOutreachProfile: vi.fn(raw => CommercePurposeProfileSchema.parse(raw)), tools: vi.fn(async () => config.tools ?? capabilities.map(c => ({ name: c.toolDescriptor.name, description: c.toolDescriptor.description, inputSchema }))), call: vi.fn(async () => ({ contractVersion: "commerce.v1", status: "OK", data: config.data ?? { label: "open" }, renderedText: "open" })), close: vi.fn(async () => undefined) };
    const service = new RecoveryOutreachMcpSelectorService({ shopId: "shop-1", signal: new AbortController().signal }, { configuration: () => ({ endpoint: new URL("https://mcp.test/api/mcp") }), clientFactory: () => client as never });
    return { service, client, manifest, profile };
}
beforeEach(() => vi.restoreAllMocks());
describe("pinned published outreach profiles", () => {
    it("admits a fifth implemented read from profile without name code changes and freezes snapshot", async () => {
        const f = fixture();
        expect(CommerceManifestSchema.safeParse(f.manifest).success).toBe(true);
        await f.service.connect();
        expect((await f.service.tools()).map(t => t.name)).toEqual(names);
        expect(f.client.pinOutreachProfile).toHaveBeenCalledOnce();
        expect(Object.isFrozen(f.service.profile().capabilities[0])).toBe(true);
        expect((await f.service.call(names[4]!, { query: "hours" })).data).toEqual({ label: "open" });
        await expect(f.service.call("commerce_delete_customer", {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(f.client.call).toHaveBeenCalledOnce();
        await f.service.close();
        await f.service.close();
        expect(f.client.close).toHaveBeenCalledOnce();
    });
    it("accepts removal of discount tools without restoration; next profile removes fifth", async () => {
        const f = fixture({ names: ["commerce_store_hours"] });
        await f.service.connect();
        expect((await f.service.tools()).map(t => t.name)).toEqual(["commerce_store_hours"]);
        const next = fixture({ names: ["commerce_get_product"] });
        await next.service.connect();
        await next.service.tools();
        await expect(next.service.call("commerce_store_hours", { query: "hours" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(next.client.call).not.toHaveBeenCalled();
    });
    it.each(["missing", "release", "revision", "duplicate", "schema"])("rejects forged %s profile before calls", async (kind) => {
        const initial = fixture();
        const manifest: any = structuredClone(initial.manifest);
        if (kind === "missing")
            delete manifest.purposeProfile;
        if (kind === "release")
            manifest.purposeProfile.releaseId = "other";
        if (kind === "revision")
            manifest.purposeProfile.capabilities[0].revisionId = "forged";
        if (kind === "duplicate")
            manifest.purposeProfile.capabilities[1].name = manifest.purposeProfile.capabilities[0].name;
        if (kind === "schema")
            manifest.purposeProfile.capabilities[0].inputSchema = { type: "object", properties: {}, additionalProperties: false };
        const f = fixture({ manifest });
        await f.service.connect();
        await expect(f.service.tools()).rejects.toThrow();
        expect(f.client.call).not.toHaveBeenCalled();
    });
    it("rejects duplicate, unlisted or mismatched tools/list instead of filtering", async () => {
        for (const tools of [[{ name: "commerce_delete_customer", description: "delete", inputSchema }], Array(5).fill({ name: names[0], description: "same", inputSchema }), names.map(name => ({ name, description: name, inputSchema: { type: "object" } }))]) {
            const f = fixture({ tools: tools as OutreachMcpToolDescriptor[] });
            await f.service.connect();
            await expect(f.service.tools()).rejects.toThrow();
            expect(f.client.call).not.toHaveBeenCalled();
        }
    });
    it("validates canonical input/results and bounds before returning data", async () => {
        const f = fixture();
        await f.service.connect();
        await f.service.tools();
        await expect(f.service.call(names[4]!, { query: "hours", forged: true })).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(f.client.call).not.toHaveBeenCalled();
        for (const data of [{ label: 4 }, { label: "x".repeat(33000) }]) {
            const bad = fixture({ data });
            await bad.service.connect();
            await bad.service.tools();
            await expect(bad.service.call(names[4]!, { query: "hours" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
        }
    });
    it("preserves global16 and known semantic3/5 budgets", async () => {
        for (const [name, limit] of [[names[4], 16], ["commerce_search_products", 3], ["commerce_get_product", 5]] as const) {
            const f = fixture();
            await f.service.connect();
            await f.service.tools();
            for (let i = 0; i < limit; i++)
                await f.service.call(name!, { query: String(i) });
            await expect(f.service.call(name!, { query: "more" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
            expect(f.client.call).toHaveBeenCalledTimes(limit);
        }
    });
    it("pins one client immutable release and denies unpinned/unlisted calls", async () => {
        const f = fixture();
        const client = new CommerceMcpClient({ endpoint: new URL("https://mcp.test/api/mcp") }, { shopId: "shop-1", toolContext: { purpose: "INITIAL_RECOVERY_OUTREACH" } }, new AbortController().signal);
        await expect(client.call(names[4]!, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
        client.pinOutreachProfile(f.profile);
        expect(() => client.pinOutreachProfile({ ...f.profile, releaseId: "new-release" })).toThrow();
        await expect(client.call("unlisted", {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });
});
describe("private MCP HTTP purpose release binding", () => {
    it("discovers trusted purpose then pins release on later HTTP calls; revoked/stale server denial propagates", async () => {
        const f = fixture({ names: ["commerce_store_hours"] });
        const seen: {
            method: string;
            context: any;
        }[] = [];
        let stale = false;
        vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
            const message = JSON.parse(String(init?.body));
            const header = new Headers(init?.headers).get("X-Moda-Commerce-Context")!;
            const context = JSON.parse(Buffer.from(header, "base64url").toString());
            seen.push({ method: message.method, context });
            if (message.method === "notifications/initialized")
                return new Response(null, { status: 202 });
            if (message.method === "tools/call" && stale)
                return new Response(JSON.stringify({ error: { code: "DENIED", message: "pinned release changed or authorization revoked" } }), { status: 403, headers: { "content-type": "application/json" } });
            const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { resources: {}, tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } : message.method === "resources/read" ? { contents: [{ uri: "commerce://capabilities", mimeType: "application/json", text: JSON.stringify(f.manifest) }] } : message.method === "tools/list" ? { tools: [{ name: "commerce_store_hours", description: "commerce_store_hours", inputSchema }] } : { content: [{ type: "text", text: "hours" }], structuredContent: { contractVersion: "commerce.v1", status: "OK", data: { label: "open" }, renderedText: "hours" } };
            return Response.json({ jsonrpc: "2.0", id: message.id, result });
        }));
        const service = new RecoveryOutreachMcpSelectorService({ shopId: "shop-1", signal: new AbortController().signal }, { configuration: () => ({ endpoint: new URL("https://mcp.test/api/mcp") }) });
        try {
            await service.connect();
            await service.tools();
            expect((await service.call("commerce_store_hours", { query: "hours" })).data).toEqual({ label: "open" });
            stale = true;
            await expect(service.call("commerce_store_hours", { query: "next" })).rejects.toMatchObject({ code: "DENIED" });
            expect(seen.find(r => r.method === "resources/read")!.context).toMatchObject({ shopId: "shop-1", executionPurpose: "INITIAL_RECOVERY_OUTREACH" });
            expect(seen.find(r => r.method === "resources/read")!.context).not.toHaveProperty("releaseId");
            expect(seen.filter(r => r.method === "tools/call").every(r => r.context.releaseId === "release-1")).toBe(true);
        }
        finally {
            await service.close();
            vi.unstubAllGlobals();
        }
    });
});
