import { observeCommerceTool } from "./observe-tool.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CommerceAssertionSchema,
  CommerceOutreachToolContextSchema,
  CommerceManifestSchema,
  CommerceToolResultSchema,
} from "@modainteract/moda-interact-shared/commerce";
import type {
  CommerceConversationGrant,
  CommerceOutreachToolContext,
  CommerceTurnIdentity,
} from "@modainteract/moda-interact-shared/commerce";
import {
  hostDiagnostic,
  mcpTransportDiagnostic,
  type CommerceHostDiagnostic,
  type CommerceHostOperation,
  type CommerceHostStage,
  type CommerceHostReason,
} from "./host-diagnostics.js";

export class CommerceHostError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly diagnostic?: CommerceHostDiagnostic,
    cause?: unknown,
    readonly sourceFailure?: McpSourceFailure,
  ) {
    super(`Commerce host: ${code}`, { cause });
    this.name = "CommerceHostError";
  }
}
export type McpSourceFailure = Readonly<{
  origin: "mcp_response";
  provider: "commerce-mcp";
  operation: CommerceHostOperation;
  httpStatus: number;
  providerRequestId?: string;
  providerError?: Readonly<{ code?: string; message?: string; details?: unknown }>;
  providerErrorBody?: string;
  redactionApplied: boolean;
  truncated: boolean;
}>;

type SafeDiagnosticText = Readonly<{ value: string; redacted: boolean; truncated: boolean }>;

function safeDiagnosticText(value: string, maximum = 1024): SafeDiagnosticText {
  const scrubbed = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret|password|passwd|secret|credential)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
    .replace(/(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){6,14}(?![A-Za-z0-9])/g, "[REDACTED]")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, "[REDACTED_URL]");
  const truncated = scrubbed.length > maximum;
  return { value: truncated ? `${scrubbed.slice(0, maximum)}[TRUNCATED]` : scrubbed,
    redacted: scrubbed !== value, truncated };
}

function safeErrorDetails(value: unknown, depth = 0): { value: unknown; redacted: boolean; truncated: boolean } {
  if (depth > 4) return { value: "[TRUNCATED]", redacted: false, truncated: true };
  if (typeof value === "string") {
    const safe = safeDiagnosticText(value, 256);
    return { value: safe.value, redacted: safe.redacted, truncated: safe.truncated };
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return { value: typeof value === "number" && !Number.isFinite(value) ? "[REDACTED]" : value,
      redacted: typeof value === "number" && !Number.isFinite(value), truncated: false };
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => safeErrorDetails(item, depth + 1));
    return { value: items.map((item) => item.value), redacted: items.some((item) => item.redacted),
      truncated: value.length > 8 || items.some((item) => item.truncated) };
  }
  if (value === null || typeof value !== "object") return { value: "[REDACTED]", redacted: true, truncated: false };
  const source = value as Record<string, unknown>;
  const allowed = new Set(["code", "message", "type", "details", "errors", "error_data", "error_subcode", "subcode", "param", "field", "extensions"]);
  const output: Record<string, unknown> = {};
  let redacted = false;
  let truncated = false;
  for (const [key, child] of Object.entries(source).slice(0, 8)) {
    if (!allowed.has(key.toLowerCase()) || /email|phone|address|customer|token|secret|password|authorization|cookie|url|prompt|header|body|success/.test(key.toLowerCase())) {
      redacted = true;
      continue;
    }
    const safe = safeErrorDetails(child, depth + 1);
    output[key] = safe.value;
    redacted ||= safe.redacted;
    truncated ||= safe.truncated;
  }
  return { value: output, redacted, truncated: truncated || Object.keys(source).length > 8 };
}

async function readMcpSourceFailure(
  response: Response,
  operation: CommerceHostOperation,
): Promise<McpSourceFailure> {
  const requestIdValue = response.headers.get("x-request-id") ?? response.headers.get("request-id") ??
    response.headers.get("x-correlation-id");
  const providerRequestId = requestIdValue && /^[A-Za-z0-9._:-]{1,128}$/.test(requestIdValue)
    ? requestIdValue : undefined;
  let text = "";
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = 8 * 1024 - size;
        if (remaining <= 0) { truncated = true; break; }
        if (value.byteLength > remaining) {
          chunks.push(value.slice(0, remaining));
          size += remaining;
          truncated = true;
          break;
        }
        chunks.push(value);
        size += value.byteLength;
      }
      text = new TextDecoder().decode(Buffer.concat(chunks));
    } catch {
      return { origin: "mcp_response", provider: "commerce-mcp", operation, httpStatus: response.status,
        ...(providerRequestId ? { providerRequestId } : {}), redactionApplied: true, truncated };
    } finally {
      try { await reader.cancel(); } catch { /* Response body is already bounded and discarded. */ }
    }
  }
  if (!text) return { origin: "mcp_response", provider: "commerce-mcp", operation, httpStatus: response.status,
    ...(providerRequestId ? { providerRequestId } : {}), redactionApplied: false, truncated };
  let document: unknown;
  try { document = JSON.parse(text); } catch { document = undefined; }
  let redacted = false;
  let providerError: McpSourceFailure["providerError"];
  let providerErrorBody: string | undefined;
  if (document !== undefined && document !== null && typeof document === "object" && !Array.isArray(document)) {
    const envelope = document as Record<string, unknown>;
    const errorValue = envelope.error;
    const structured = errorValue && typeof errorValue === "object" && !Array.isArray(errorValue)
      ? errorValue as Record<string, unknown> : null;
    const graphqlErrors = Array.isArray(envelope.errors) ? envelope.errors : undefined;
    if (typeof errorValue === "string") {
      const message = safeDiagnosticText(errorValue);
      providerError = { message: message.value };
      redacted ||= message.redacted;
      truncated ||= message.truncated;
    } else if (structured) {
      const codeValue = structured.code;
      const code = typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue).slice(0, 96) : undefined;
      const message = typeof structured.message === "string" ? safeDiagnosticText(structured.message) : null;
      const details = structured.details === undefined ? null : safeErrorDetails(structured.details);
      providerError = { ...(code ? { code } : {}), ...(message ? { message: message.value } : {}), ...(details ? { details: details.value } : {}) };
      redacted ||= message?.redacted === true || details?.redacted === true;
      truncated ||= message?.truncated === true || details?.truncated === true;
    } else if (graphqlErrors) {
      const errors = safeErrorDetails(graphqlErrors);
      providerError = { details: errors.value };
      redacted ||= errors.redacted;
      truncated ||= errors.truncated;
    } else {
      const safe = safeErrorDetails(envelope);
      if (Object.keys(safe.value as Record<string, unknown>).length > 0 || Object.keys(envelope).length === 0) {
        providerErrorBody = JSON.stringify(safe.value);
      }
      redacted ||= safe.redacted;
      truncated ||= safe.truncated;
      if (!providerErrorBody && Object.keys(envelope).length > 0) { providerErrorBody = "[REDACTED]"; redacted = true; }
    }
  } else {
    const safe = safeDiagnosticText(text, 1024);
    providerErrorBody = safe.value;
    redacted ||= safe.redacted;
    truncated ||= safe.truncated;
  }
  return { origin: "mcp_response", provider: "commerce-mcp", operation, httpStatus: response.status,
    ...(providerRequestId ? { providerRequestId } : {}), ...(providerError ? { providerError } : {}),
    ...(providerErrorBody ? { providerErrorBody } : {}), redactionApplied: redacted, truncated };
}
export type McpConfiguration = {
  endpoint: URL;
};
export type CommerceOutreachMcpIdentity = Readonly<{
  shopId: string;
  toolContext: CommerceOutreachToolContext;
}>;
export function mcpConfiguration(): McpConfiguration {
  let endpoint: URL;
  try {
    endpoint = new URL(process.env.COMMERCE_MCP_URL ?? "http://invalid.invalid");
  } catch (error) {
    // Invalid URL parsing previously reached the host as UNAVAILABLE/retryable.
    throw new CommerceHostError("UNAVAILABLE", true,
      hostDiagnostic("configuration", "CONFIG_URL_INVALID"), error);
  }
  if (
    endpoint.pathname !== "/api/mcp" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["http:", "https:"].includes(endpoint.protocol)
  )
    throw new CommerceHostError("CONFIGURATION", false,
      hostDiagnostic("configuration", "CONFIG_ENDPOINT_INVALID"));
  return { endpoint };
}
export function encodeCommerceContext(
  turn: CommerceTurnIdentity | CommerceOutreachMcpIdentity,
  grant?: CommerceConversationGrant,
): string {
  if ("toolContext" in turn) {
    if (grant || !/^[A-Za-z0-9_-]{1,128}$/.test(turn.shopId) ||
        !CommerceOutreachToolContextSchema.safeParse(turn.toolContext).success) {
      throw new CommerceHostError("INVALID_INPUT", false,
        hostDiagnostic("mcp.authorization", "CONTEXT_ASSERTION_INVALID"));
    }
    return Buffer.from(JSON.stringify({ shopId: turn.shopId, toolContext: turn.toolContext }), "utf8")
      .toString("base64url");
  }
  const context = CommerceAssertionSchema.safeParse(
    grant
      ? {
          ...turn,
          purpose: "execute",
          grantId: grant.id,
          releaseId: grant.releaseId,
        }
      : { ...turn, purpose: "resolve" },
  );
  if (!context.success) throw new CommerceHostError("INVALID_INPUT", false,
    hostDiagnostic("mcp.authorization", "CONTEXT_ASSERTION_INVALID"));
  return Buffer.from(JSON.stringify(context.data), "utf8").toString("base64url");
}

export class CommerceMcpClient {
  private client = new Client({ name: "moda-background", version: "1.0.0" });
  private operation: CommerceHostOperation = "initialize";
  private httpFailure: CommerceHostDiagnostic | undefined;
  private httpSourceFailure: McpSourceFailure | undefined;
  constructor(
    private config: McpConfiguration,
    private turn: CommerceTurnIdentity | CommerceOutreachMcpIdentity,
    private signal: AbortSignal,
    private grant?: CommerceConversationGrant,
  ) {}
  private options(signal = this.signal) {
    return { signal, timeout: 10_000 };
  }
  /** The SDK may wrap an HTTP error. Retain only the safe transport observation. */
  private async sdkOperation<T>(
    operation: CommerceHostOperation,
    stage: CommerceHostStage,
    reason: CommerceHostReason,
    execute: () => Promise<T>,
  ): Promise<T> {
    this.operation = operation;
    this.httpFailure = undefined;
    try {
      return await execute();
    } catch (error) {
      if (error instanceof CommerceHostError) throw error;
      if (this.signal.aborted) throw this.abortedHostError(error);
      throw new CommerceHostError("UNAVAILABLE", true,
        this.httpFailure ?? hostDiagnostic(stage, reason, { operation, cause: error }), error, this.httpSourceFailure);
    } finally {
      this.httpFailure = undefined;
      this.httpSourceFailure = undefined;
    }
  }
  private httpError(
    code: string,
    retryable: boolean,
    stage: CommerceHostStage,
    reason: CommerceHostReason,
    statusCode?: number,
    sourceFailure?: McpSourceFailure,
  ): CommerceHostError {
    const diagnostic = hostDiagnostic(stage, reason, {
      operation: this.operation,
      ...(statusCode === undefined ? {} : { statusCode }),
    });
    this.httpFailure = diagnostic;
    this.httpSourceFailure = sourceFailure;
    return new CommerceHostError(code, retryable, diagnostic, undefined, sourceFailure);
  }
  private requestStage(): CommerceHostStage {
    return this.operation === "read_manifest" ? "mcp.manifest"
      : this.operation === "list_tools" ? "mcp.tool_list"
      : this.operation === "call_tool" ? "mcp.tool_call" : "mcp.connection";
  }
  private abortedHostError(cause: unknown): CommerceHostError {
    const deadline = this.signal.reason instanceof Error && this.signal.reason.name === "TimeoutError";
    return new CommerceHostError(deadline ? "DEADLINE" : "CANCELLED", deadline,
      hostDiagnostic(this.requestStage(), deadline ? "HOST_DEADLINE_EXCEEDED" : "HOST_CANCELLED", {
        operation: this.operation,
      }), cause);
  }
  async connect() {
    const transport = new StreamableHTTPClientTransport(this.config.endpoint, {
      fetch: async (url, init) => {
        this.signal.throwIfAborted();
        if (
          String(url) !== this.config.endpoint.href ||
          (init?.method ?? "GET") !== "POST"
        )
          throw this.httpError("INVALID_INPUT", false, this.requestStage(), "MCP_REQUEST_DESTINATION_INVALID");
        if (
          typeof init?.body === "string" &&
          Buffer.byteLength(init.body) > 128 * 1024
        )
          throw this.httpError("INVALID_INPUT", false, this.requestStage(), "MCP_REQUEST_TOO_LARGE");
        const headers = new Headers(init?.headers);
        headers.set("Content-Type", "application/json");
        headers.set(
          "X-Moda-Commerce-Context",
          encodeCommerceContext(this.turn, this.grant),
        );
        let response: Response;
        try {
          response = await fetch(url, {
            ...init,
            headers,
            redirect: "error",
            signal: AbortSignal.any([
              this.signal,
              AbortSignal.timeout(10_000),
              ...(init?.signal ? [init.signal] : []),
            ]),
          });
        } catch (error) {
          // The caller/turn's abort takes priority over an apparent network outage.
          if (this.signal.aborted) throw this.abortedHostError(error);
          const diagnostic = mcpTransportDiagnostic(this.requestStage(), this.operation, error);
          this.httpFailure = diagnostic;
          throw new CommerceHostError("UNAVAILABLE", true, diagnostic, error);
        }
        if (!response.ok) {
          const sourceFailure = await readMcpSourceFailure(response, this.operation);
          if (response.status === 401 || response.status === 403)
          throw this.httpError("DENIED", false, "mcp.authorization",
              response.status === 401 ? "MCP_HTTP_UNAUTHENTICATED" : "MCP_HTTP_FORBIDDEN", response.status, sourceFailure);
          const reason = response.status === 429 ? "MCP_HTTP_RATE_LIMITED"
            : response.status === 503 ? "MCP_HTTP_SERVICE_UNAVAILABLE"
            : response.status === 504 ? "MCP_HTTP_GATEWAY_TIMEOUT"
            : response.status >= 500 ? "MCP_HTTP_SERVER_ERROR"
            : response.status >= 400 ? "MCP_HTTP_CLIENT_ERROR" : "MCP_HTTP_UNEXPECTED_STATUS";
          throw this.httpError("UNAVAILABLE", true, this.requestStage(), reason, response.status, sourceFailure);
        }
        if (response.headers.has("mcp-session-id"))
          throw this.httpError("INCOMPATIBLE_VERSION", false, this.requestStage(), "MCP_SESSION_UNSUPPORTED", response.status);
        if (!response.body) return response;
        if (
          response.status !== 202 &&
          !response.headers.get("content-type")?.includes("application/json")
        )
          throw this.httpError("INVALID_INPUT", false, this.requestStage(), "MCP_CONTENT_TYPE_INVALID", response.status);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 256 * 1024)
              throw this.httpError("INVALID_INPUT", false, this.requestStage(), "MCP_RESPONSE_TOO_LARGE", response.status);
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        return new Response(Buffer.concat(chunks), {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    // SDK 1.30.0 declares sessionId as string | undefined rather than optional;
    // its runtime Transport implementation is compatible (covered over HTTP).
    await this.sdkOperation("initialize", "mcp.connection", "MCP_CONNECTION_FAILED", () =>
      this.client.connect(transport as Transport, this.options()));
  }
  async manifest() {
    const result = await this.sdkOperation("read_manifest", "mcp.manifest", "MCP_MANIFEST_READ_FAILED", () =>
      this.client.readResource({ uri: "commerce://capabilities" }, this.options()));
    if (
      result.contents.length !== 1 ||
      result.contents[0]!.uri !== "commerce://capabilities" ||
      !("text" in result.contents[0]!)
    )
      throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
        hostDiagnostic("mcp.manifest", "MCP_MANIFEST_RESOURCE_INVALID", { operation: "read_manifest" }));
    let document: unknown;
    try { document = JSON.parse(result.contents[0]!.text as string); }
    catch (error) {
      // Preserve the old UNAVAILABLE classification for JSON.parse failures.
      throw new CommerceHostError("UNAVAILABLE", true,
        hostDiagnostic("mcp.manifest", "MCP_MANIFEST_JSON_INVALID", { operation: "read_manifest" }), error);
    }
    const parsed = CommerceManifestSchema.safeParse(document);
    if (!parsed.success) throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
      hostDiagnostic("mcp.manifest", "MCP_MANIFEST_SCHEMA_INVALID", { operation: "read_manifest" }));
    return parsed.data;
  }
  async tools(signal = this.signal) {
    const result = await this.sdkOperation("list_tools", "mcp.tool_list", "MCP_TOOL_LIST_FAILED", () =>
      this.client.listTools({}, this.options(signal)));
    if (result.nextCursor) throw new CommerceHostError("INVALID_INPUT", false,
      hostDiagnostic("mcp.tool_list", "MCP_TOOL_LIST_PAGINATED", { operation: "list_tools" }));
    if (result.tools.length > 32) throw new CommerceHostError("INVALID_INPUT", false,
      hostDiagnostic("mcp.tool_list", "MCP_TOOL_LIST_TOO_LARGE", { operation: "list_tools" }));
    if (result.tools.some((t) =>
        Object.keys(t).some(
          (k) => !["name", "description", "inputSchema"].includes(k),
        ),
      )) throw new CommerceHostError("INVALID_INPUT", false,
        hostDiagnostic("mcp.tool_list", "MCP_TOOL_DESCRIPTOR_INVALID", { operation: "list_tools" }));
    return result.tools;
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal = this.signal,
  ) {
    return observeCommerceTool(async () => {
      const result = await this.sdkOperation("call_tool", "mcp.tool_call", "MCP_TOOL_CALL_FAILED", () =>
        this.client.callTool({ name, arguments: args }, undefined, this.options(signal)));
      const parsed = CommerceToolResultSchema.safeParse(result.structuredContent);
      if (!parsed.success) throw new CommerceHostError("UNAVAILABLE", true,
        hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID", { operation: "call_tool" }));
      const value = parsed.data;
      if ((value.status === "ERROR") !== Boolean(result.isError))
        throw new CommerceHostError("INVALID_INPUT", false,
          hostDiagnostic("mcp.tool_result", "MCP_TOOL_ERROR_FLAG_MISMATCH", { operation: "call_tool" }));
      return value;
    });
  }
  async close() {
    await this.client.close();
  }
}
