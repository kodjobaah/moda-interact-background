import { compileSubset } from "@modainteract/moda-interact-shared/commerce";
import { assertPublishedManifest, assertPublishedToolList, selectPublishedFeatures } from "../../commerce/published-tools.js";
import { validateRelease, readOutreachFeatureScope } from "../../commerce/grants.js";
import { entitlementService, EntitlementError } from "../entitlement.service.js";
import {
  CommerceToolResultSchema,
} from "@modainteract/moda-interact-shared/commerce";
import { z } from "zod";
import {
  CommerceHostError,
  CommerceMcpClient,
  mcpConfiguration,
  type CommerceOutreachMcpIdentity,
  type McpConfiguration,
} from "../../commerce/mcp-client.js";

export type OutreachMcpToolDescriptor = Readonly<{
  name: string;
  description: string;
  inputSchema: unknown;
}>;
export type OutreachMcpResult = z.infer<typeof CommerceToolResultSchema>;

const MAX_MCP_CALLS = 16;

type Client = Pick<CommerceMcpClient, "connect" | "manifest" | "tools" | "call" | "close">;

export type RecoveryOutreachMcpSelectorDependencies = Readonly<{
  clientFactory?: (config: McpConfiguration, identity: CommerceOutreachMcpIdentity, signal: AbortSignal) => Client;
  configuration?: () => McpConfiguration;
  validateRelease?: typeof validateRelease;
  resolveFeatureScope?: () => Promise<readonly string[]>;
}>;

function invalidInput(reason: string): CommerceHostError {
  return new CommerceHostError("INVALID_INPUT", false, undefined, new Error(reason));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class RecoveryOutreachMcpSelectorService {
  private readonly client: Client;
  private listedTools: Map<string, OutreachMcpToolDescriptor> | null = null;
  private connected = false;
  private closed = false;
  private connectionAttempted = false;
  private calls = 0;

  constructor(
    private readonly input: Readonly<{ shopId: string; signal: AbortSignal }>,
    private readonly dependencies: RecoveryOutreachMcpSelectorDependencies = {},
  ) {
    if (!input.shopId || !input.signal) throw invalidInput("OUTREACH_SELECTOR_INPUT_INVALID");
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
    const manifest = await this.client.manifest();
    assertPublishedManifest(manifest);
    await (this.dependencies.validateRelease ?? validateRelease)(manifest);
    const featureIds = await (this.dependencies.resolveFeatureScope ?? readOutreachFeatureScope)();
    const permitted = selectPublishedFeatures(manifest, featureIds);
    const listed = await this.client.tools(this.input.signal);
    assertPublishedToolList(manifest, listed);
    const permittedNames = new Set(permitted.capabilities.map(cap => cap.key));
    const seen = new Set<string>();
    const allowed = new Map<string, OutreachMcpToolDescriptor>();
    for (const raw of listed) {
      const descriptor = raw as unknown as Record<string, unknown>;
      if (typeof descriptor.name !== "string" || seen.has(descriptor.name)) {
        throw invalidInput("OUTREACH_TOOL_LIST_DUPLICATE_OR_INVALID");
      }
      seen.add(descriptor.name);
      if (!permittedNames.has(descriptor.name)) continue;
      if (typeof descriptor.description !== "string" || descriptor.description.length > 4_000 ||
          !isRecord(descriptor.inputSchema) || descriptor.inputSchema.type !== "object") {
        throw invalidInput("OUTREACH_TOOL_DESCRIPTOR_INVALID");
      }
      const name = descriptor.name;
      allowed.set(name, Object.freeze({
        name,
        description: descriptor.description,
        inputSchema: structuredClone(descriptor.inputSchema),
      }));
    }
    this.listedTools = allowed;
    return [...allowed.values()];
  }

  async call(name: string, rawArguments: unknown, signal = this.input.signal): Promise<OutreachMcpResult> {
    if (!this.connected || this.closed || !this.listedTools) throw invalidInput("OUTREACH_TOOLS_NOT_RESOLVED");
    await this.tools();
    const descriptor = this.listedTools.get(name);
    if (!descriptor) throw new CommerceHostError("DENIED");
    let args: Record<string, unknown>;
    try {
      if (!isRecord(rawArguments)) throw new Error("Expected object arguments");
      args = compileSubset(descriptor.inputSchema as never, "input").parse(rawArguments) as Record<string, unknown>;
    } catch { throw invalidInput("OUTREACH_TOOL_ARGUMENTS_INVALID"); }
    if (this.calls >= MAX_MCP_CALLS) throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_MCP_CALL_BUDGET_EXHAUSTED"));
    signal.throwIfAborted();
    this.calls += 1;
    const result = CommerceToolResultSchema.parse(await this.client.call(name, args, signal));
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.connectionAttempted) await this.client.close();
  }
}

/** Host-owned checkout_recovery admission precedes selector/client creation.
 * No credit reservation or delivery state is changed here. */
export async function createAdmittedRecoveryOutreachMcpSelector(
  input: Readonly<{ shopId: string; signal: AbortSignal }>,
  dependencies: RecoveryOutreachMcpSelectorDependencies & {
    assertFeature?: typeof entitlementService.assertFeature;
  } = {},
): Promise<RecoveryOutreachMcpSelectorService> {
  input.signal.throwIfAborted();
  try { await (dependencies.assertFeature ?? entitlementService.assertFeature.bind(entitlementService))(input.shopId, "checkout_recovery"); }
  catch (error) {
    if (error instanceof EntitlementError) throw new CommerceHostError("DENIED", false);
    throw error;
  }
  input.signal.throwIfAborted();
  return new RecoveryOutreachMcpSelectorService(input, dependencies);
}
