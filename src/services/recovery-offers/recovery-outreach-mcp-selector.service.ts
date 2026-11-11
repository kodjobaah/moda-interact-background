import {
  CommerceManifestSchema,
  CommercePurposeProfileSchema,
  compileSubset,
  compileCommercePurposeOutputSchema,
  type CommercePurposeProfile,
  CommerceToolResultSchema,
} from "@modainteract/moda-interact-shared/commerce";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { Buffer } from "node:buffer";
import {
  CommerceHostError,
  CommerceMcpClient,
  mcpConfiguration,
  type CommerceOutreachMcpIdentity,
  type McpConfiguration,
} from "../../commerce/mcp-client.js";

export type OutreachMcpToolName = string;
export type OutreachMcpToolDescriptor = Readonly<{ name: string; description: string; inputSchema: unknown }>;
export type OutreachMcpResult = z.infer<typeof CommerceToolResultSchema>;
const DEFAULT_MAX_MCP_CALLS = 16;
const MAX_CONFIGURED_MCP_CALLS = 64;
const MAX_PRODUCT_SEARCHES = 3;
const MAX_PRODUCT_DETAIL_READS = 5;
type Client = Pick<CommerceMcpClient, "connect" | "manifest" | "pinOutreachProfile" | "tools" | "call" | "close">;
export type RecoveryOutreachMcpSelectorDependencies = Readonly<{
  clientFactory?: (config: McpConfiguration, identity: CommerceOutreachMcpIdentity, signal: AbortSignal) => Client;
  configuration?: () => McpConfiguration;
}>;
function invalidInput(reason: string): CommerceHostError {
  return new CommerceHostError("INVALID_INPUT", false, undefined, new Error(reason));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export class RecoveryOutreachMcpSelectorService {
  private readonly client: Client;
  private pinnedProfile: CommercePurposeProfile | null = null;
  private listedTools: Map<string, OutreachMcpToolDescriptor> | null = null;
  private connected = false;
  private closed = false;
  private connectionAttempted = false;
  private calls = 0;
  private productSearches = 0;
  private productDetailReads = 0;
  private readonly maxCalls: number;

  constructor(
    private readonly input: Readonly<{ shopId: string; signal: AbortSignal; maxCalls?: number; maxProductDetailReads?: number; maxToolResultBytes?: number }>,
    dependencies: RecoveryOutreachMcpSelectorDependencies = {},
  ) {
    if (!input.shopId || !input.signal) throw invalidInput("OUTREACH_SELECTOR_INPUT_INVALID");
    this.maxCalls = input.maxCalls ?? DEFAULT_MAX_MCP_CALLS;
    if (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 1 || this.maxCalls > MAX_CONFIGURED_MCP_CALLS)
      throw invalidInput("OUTREACH_SELECTOR_CALL_BUDGET_INVALID");
    const identity: CommerceOutreachMcpIdentity = {
      shopId: input.shopId,
      toolContext: { purpose: "INITIAL_RECOVERY_OUTREACH" },
    };
    this.client = (dependencies.clientFactory ?? ((config, context, signal) =>
      new CommerceMcpClient(config, context, signal))) (
      (dependencies.configuration ?? mcpConfiguration)(), identity, input.signal,
    );
  }

  async connect(): Promise<void> {
    if (this.connectionAttempted || this.closed) throw invalidInput("OUTREACH_CLIENT_CONNECT_REUSED");
    this.connectionAttempted = true;
    await this.client.connect();
    this.connected = true;
  }

  async tools(): Promise<readonly OutreachMcpToolDescriptor[]> {
    if (!this.connected || this.closed) throw invalidInput("OUTREACH_CLIENT_NOT_CONNECTED");
    if (this.listedTools) return [...this.listedTools.values()];
    const manifest = CommerceManifestSchema.parse(await this.client.manifest());
    const profile = CommercePurposeProfileSchema.parse(manifest.purposeProfile);
    if (profile.releaseId !== manifest.releaseId || manifest.capabilities.length !== profile.capabilities.length)
      throw invalidInput("OUTREACH_PROFILE_MANIFEST_MISMATCH");
    if (profile.capabilities.some(member => member.name === "submitInitialOutreachOffer"))
      throw invalidInput("OUTREACH_RESERVED_TOOL_NAME");
    this.client.pinOutreachProfile(profile);
    const listed = await this.client.tools(this.input.signal);
    if (listed.length !== profile.capabilities.length) throw invalidInput("OUTREACH_TOOL_PROFILE_COUNT_MISMATCH");
    const allowed = new Map<string, OutreachMcpToolDescriptor>();
    for (const raw of listed) {
      const descriptor = raw as unknown as Record<string, unknown>;
      const member = profile.capabilities.find(member => member.name === descriptor.name);
      const published = manifest.capabilities.find(capability => capability.capabilityId === member?.capabilityId)?.toolDescriptor;
      if (!member || !published || descriptor.description !== published.description || allowed.has(member.name) || typeof descriptor.description !== "string"
          || descriptor.description.length > 4000 || !isDeepStrictEqual(descriptor.inputSchema, member.inputSchema))
        throw invalidInput("OUTREACH_TOOL_PROFILE_MISMATCH");
      // Compile only the published bounded schemas; never evaluate caller regex/JSON Schema.
      compileSubset(member.inputSchema, "input");
      compileCommercePurposeOutputSchema(member.outputSchema);
      allowed.set(member.name, Object.freeze({ name: member.name, description: descriptor.description, inputSchema: member.inputSchema }));
    }
    this.pinnedProfile = profile;
    this.listedTools = new Map(profile.capabilities.map(member => [member.name, allowed.get(member.name)!]));
    return [...this.listedTools.values()];
  }

  async call(name: string, rawArguments: unknown, signal = this.input.signal): Promise<OutreachMcpResult> {
    if (!this.connected || this.closed || !this.listedTools) throw invalidInput("OUTREACH_TOOLS_NOT_RESOLVED");
    const member = this.pinnedProfile?.capabilities.find(member => member.name === name);
    if (!member || !this.listedTools.has(name)) throw invalidInput("OUTREACH_TOOL_NOT_LISTED");
    const parsedArguments = compileSubset(member.inputSchema, "input").safeParse(rawArguments);
    if (!parsedArguments.success || !isRecord(parsedArguments.data)) throw invalidInput("OUTREACH_TOOL_ARGUMENTS_SCHEMA_INVALID");
    const toolName = name;
    if (this.calls >= this.maxCalls) throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_MCP_CALL_BUDGET_EXHAUSTED"));
    if (toolName === "commerce_search_products" && this.productSearches >= MAX_PRODUCT_SEARCHES) {
      throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_PRODUCT_SEARCH_BUDGET_EXHAUSTED"));
    }
    if (toolName === "commerce_get_product" && this.productDetailReads >= (this.input.maxProductDetailReads ?? MAX_PRODUCT_DETAIL_READS)) {
      throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_PRODUCT_READ_BUDGET_EXHAUSTED"));
    }
    signal.throwIfAborted();
    this.calls += 1;
    if (toolName === "commerce_search_products") this.productSearches += 1;
    if (toolName === "commerce_get_product") this.productDetailReads += 1;
    const result = CommerceToolResultSchema.parse(await this.client.call(toolName, parsedArguments.data, signal));
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > (this.input.maxToolResultBytes ?? 32 * 1024)) {
      throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_TOOL_RESULT_BUDGET_EXHAUSTED"));
    }
    if (result.status === "OK") {
      const data = member.outputSchema.properties?.values && isRecord(result.data)
        ? { values: result.data.values } : result.data;
      const parsedOutput = compileCommercePurposeOutputSchema(member.outputSchema).safeParse(data);
      if (!parsedOutput.success) throw new CommerceHostError("UNAVAILABLE", true, undefined,
        new Error("OUTREACH_TOOL_OUTPUT_SCHEMA_INVALID"));
      return { ...result, data: parsedOutput.data } as OutreachMcpResult;
    }
    return result;
  }

  profile(): CommercePurposeProfile {
    if (!this.pinnedProfile) throw invalidInput("OUTREACH_PROFILE_NOT_RESOLVED");
    return this.pinnedProfile;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.connectionAttempted) await this.client.close();
  }
}
