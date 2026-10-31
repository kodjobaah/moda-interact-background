import {
  CommerceToolInputs,
  CommerceToolOutputs,
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

export const OUTREACH_MCP_TOOL_NAMES = [
  "commerce_get_discount_options",
  "commerce_get_discount_details",
  "commerce_search_products",
  "commerce_get_product",
] as const;

export type OutreachMcpToolName = typeof OUTREACH_MCP_TOOL_NAMES[number];
export type OutreachMcpToolDescriptor = Readonly<{
  name: string;
  description: string;
  inputSchema: unknown;
}>;
export type OutreachMcpResult = z.infer<typeof CommerceToolResultSchema>;

const ALLOWED_TOOLS = new Set<string>(OUTREACH_MCP_TOOL_NAMES);
const MAX_MCP_CALLS = 16;
const MAX_PRODUCT_SEARCHES = 3;
const MAX_PRODUCT_DETAIL_READS = 5;

type Client = Pick<CommerceMcpClient, "connect" | "tools" | "call" | "close">;

export type RecoveryOutreachMcpSelectorDependencies = Readonly<{
  clientFactory?: (config: McpConfiguration, identity: CommerceOutreachMcpIdentity, signal: AbortSignal) => Client;
  configuration?: () => McpConfiguration;
}>;

function invalidInput(reason: string): CommerceHostError {
  return new CommerceHostError("INVALID_INPUT", false, undefined, new Error(reason));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function matchesType(value: unknown, type: unknown): boolean {
  if (typeof type !== "string") return true;
  if (type === "null") return value === null;
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateJsonSchema(value: unknown, schema: unknown, depth = 0): boolean {
  if (depth > 12 || !isRecord(schema)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((type) => matchesType(value, type))) {
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
    if (typeof value === "string") {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) return false;
      if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
      if (schema.items !== undefined && !value.every((item) => validateJsonSchema(item, schema.items, depth + 1))) return false;
    }
    if (isRecord(value)) {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (required.some((key) => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
      for (const [key, child] of Object.entries(value)) {
        const childSchema = properties[key];
        if (childSchema !== undefined && !validateJsonSchema(child, childSchema, depth + 1)) return false;
      }
    }
    return true;
  }
  return false;
}

function sharedInputSchema(name: OutreachMcpToolName) {
  return (CommerceToolInputs as Record<string, z.ZodType>)[name];
}

function sharedOutputSchema(name: OutreachMcpToolName) {
  return (CommerceToolOutputs as Record<string, z.ZodType>)[name];
}

export class RecoveryOutreachMcpSelectorService {
  private readonly client: Client;
  private listedTools: Map<string, OutreachMcpToolDescriptor> | null = null;
  private connected = false;
  private closed = false;
  private connectionAttempted = false;
  private calls = 0;
  private productSearches = 0;
  private productDetailReads = 0;

  constructor(
    private readonly input: Readonly<{ shopId: string; signal: AbortSignal }>,
    dependencies: RecoveryOutreachMcpSelectorDependencies = {},
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
    if (this.listedTools) return [...this.listedTools.values()];
    const listed = await this.client.tools(this.input.signal);
    const seen = new Set<string>();
    const allowed = new Map<string, OutreachMcpToolDescriptor>();
    for (const raw of listed) {
      const descriptor = raw as unknown as Record<string, unknown>;
      if (typeof descriptor.name !== "string" || seen.has(descriptor.name)) {
        throw invalidInput("OUTREACH_TOOL_LIST_DUPLICATE_OR_INVALID");
      }
      seen.add(descriptor.name);
      if (!ALLOWED_TOOLS.has(descriptor.name)) continue;
      if (typeof descriptor.description !== "string" || descriptor.description.length > 4_000 ||
          !isRecord(descriptor.inputSchema) || descriptor.inputSchema.type !== "object") {
        throw invalidInput("OUTREACH_TOOL_DESCRIPTOR_INVALID");
      }
      const name = descriptor.name as OutreachMcpToolName;
      if (!sharedInputSchema(name) || !sharedOutputSchema(name)) throw invalidInput("OUTREACH_SHARED_SCHEMA_MISSING");
      allowed.set(name, Object.freeze({
        name,
        description: descriptor.description,
        inputSchema: structuredClone(descriptor.inputSchema),
      }));
    }
    if (!allowed.has("commerce_get_discount_options") || !allowed.has("commerce_get_discount_details")) {
      throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_DISCOUNT_TOOLS_MISSING"));
    }
    this.listedTools = allowed;
    return [...allowed.values()];
  }

  async call(name: string, rawArguments: unknown, signal = this.input.signal): Promise<OutreachMcpResult> {
    if (!this.connected || this.closed || !this.listedTools) throw invalidInput("OUTREACH_TOOLS_NOT_RESOLVED");
    if (!ALLOWED_TOOLS.has(name)) throw invalidInput("OUTREACH_TOOL_NOT_ALLOWED");
    const descriptor = this.listedTools.get(name);
    if (!descriptor) throw invalidInput("OUTREACH_TOOL_NOT_LISTED");
    if (!isRecord(rawArguments) || !validateJsonSchema(rawArguments, descriptor.inputSchema)) {
      throw invalidInput("OUTREACH_TOOL_ARGUMENTS_INVALID");
    }
    const toolName = name as OutreachMcpToolName;
    const inputSchema = sharedInputSchema(toolName);
    const outputSchema = sharedOutputSchema(toolName);
    if (!inputSchema || !outputSchema) throw invalidInput("OUTREACH_SHARED_SCHEMA_MISSING");
    const parsedArguments = inputSchema.safeParse(rawArguments);
    if (!parsedArguments.success) throw invalidInput("OUTREACH_TOOL_ARGUMENTS_SCHEMA_INVALID");
    if (!isRecord(parsedArguments.data)) throw invalidInput("OUTREACH_TOOL_ARGUMENTS_NOT_OBJECT");
    if (this.calls >= MAX_MCP_CALLS) throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_MCP_CALL_BUDGET_EXHAUSTED"));
    if (toolName === "commerce_search_products" && this.productSearches >= MAX_PRODUCT_SEARCHES) {
      throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_PRODUCT_SEARCH_BUDGET_EXHAUSTED"));
    }
    if (toolName === "commerce_get_product" && this.productDetailReads >= MAX_PRODUCT_DETAIL_READS) {
      throw new CommerceHostError("UNAVAILABLE", true, undefined, new Error("OUTREACH_PRODUCT_READ_BUDGET_EXHAUSTED"));
    }
    signal.throwIfAborted();
    this.calls += 1;
    if (toolName === "commerce_search_products") this.productSearches += 1;
    if (toolName === "commerce_get_product") this.productDetailReads += 1;
    const result = CommerceToolResultSchema.parse(await this.client.call(toolName, parsedArguments.data, signal));
    if (result.status === "OK") {
      const parsedOutput = outputSchema.safeParse(result.data);
      if (!parsedOutput.success) throw new CommerceHostError("UNAVAILABLE", true, undefined,
        new Error("OUTREACH_TOOL_OUTPUT_SCHEMA_INVALID"));
      return { ...result, data: parsedOutput.data } as OutreachMcpResult;
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.connectionAttempted) await this.client.close();
  }
}