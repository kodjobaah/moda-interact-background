import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { RunnerDiagnostic } from "@modainteract/moda-interact-shared/commerce/runner";

/** Operational stages local to the Background Commerce host, not MCP wire fields. */
export type CommerceHostStage =
  | "configuration" | "mcp.connection" | "mcp.manifest" | "mcp.tool_list"
  | "mcp.authorization" | "mcp.tool_call" | "mcp.tool_result"
  | "host.authorization" | "host.turn_state" | "host.grant"
  | "host.release" | "host.runner_result" | "host.lifecycle";

type Explanation = Readonly<{ message: string; action: string }>;
const explanations = {
  CONFIG_URL_INVALID: { message: "The configured Commerce MCP URL is not a valid URL.", action: "Check COMMERCE_MCP_URL." },
  CONFIG_ENDPOINT_INVALID: { message: "The Commerce MCP URL must use HTTP(S) and the /api/mcp path without credentials, query or fragment.", action: "Correct COMMERCE_MCP_URL." },
  CONTEXT_ASSERTION_INVALID: { message: "The turn or grant could not be encoded as a valid Commerce assertion.", action: "Inspect the turn and retained grant identifiers." },
  MCP_REQUEST_DESTINATION_INVALID: { message: "The MCP client attempted an unexpected destination or HTTP method.", action: "Inspect the MCP transport configuration and SDK request path." },
  MCP_REQUEST_TOO_LARGE: { message: "The MCP request exceeded the allowed payload size.", action: "Inspect the MCP request size and tool arguments." },
  MCP_HTTP_UNAUTHENTICATED: { message: "The Commerce MCP endpoint returned HTTP 401 (unauthenticated request).", action: "Check the turn assertion and MCP request authentication." },
  MCP_HTTP_FORBIDDEN: { message: "The Commerce MCP endpoint returned HTTP 403 (operation forbidden).", action: "Check the shop, grant, release and MCP authorization rules." },
  MCP_HTTP_RATE_LIMITED: { message: "The Commerce MCP endpoint returned HTTP 429 (rate limited).", action: "Inspect the Commerce service's rate limit and capacity." },
  MCP_HTTP_SERVICE_UNAVAILABLE: { message: "The Commerce MCP endpoint returned HTTP 503 (service unavailable).", action: "Inspect Commerce service readiness, dependencies and capacity." },
  MCP_HTTP_GATEWAY_TIMEOUT: { message: "The Commerce MCP endpoint returned HTTP 504 (gateway timeout).", action: "Inspect upstream request latency and gateway timeouts." },
  MCP_HTTP_SERVER_ERROR: { message: "The Commerce MCP endpoint returned an HTTP 5xx server error.", action: "Inspect the matching Commerce service request failure." },
  MCP_HTTP_CLIENT_ERROR: { message: "The Commerce MCP endpoint returned an unexpected HTTP 4xx error.", action: "Inspect request validation and the matching Commerce service request failure." },
  MCP_HTTP_UNEXPECTED_STATUS: { message: "The Commerce MCP endpoint returned an unexpected non-success HTTP status.", action: "Inspect the HTTP status and the corresponding Commerce service request." },
  MCP_TRANSPORT_FAILED: { message: "The Commerce MCP transport failed before a valid response was received.", action: "Check MCP connectivity, DNS, TLS and service health." },
  MCP_DNS_HOST_NOT_FOUND: { message: "The Commerce MCP hostname could not be resolved by DNS.", action: "Check the configured MCP hostname and DNS records." },
  MCP_DNS_TEMPORARY_FAILURE: { message: "A temporary DNS failure prevented the Commerce MCP hostname from resolving.", action: "Check the DNS resolver and retry when resolution recovers." },
  MCP_CONNECTION_REFUSED: { message: "The Commerce MCP TCP connection was refused.", action: "Check the Commerce service listener and configured port." },
  MCP_CONNECTION_TIMED_OUT: { message: "The Commerce MCP transport timed out before receiving a valid response.", action: "Check network connectivity, service load and timeout settings." },
  MCP_TLS_CERTIFICATE_FAILURE: { message: "The Commerce MCP TLS certificate could not be validated.", action: "Check the endpoint certificate, hostname and trust chain." },
  MCP_SESSION_UNSUPPORTED: { message: "The MCP server returned a session identifier, but this client expects stateless requests.", action: "Check Commerce MCP server transport compatibility." },
  MCP_CONTENT_TYPE_INVALID: { message: "The MCP server returned a non-JSON content type for a JSON response.", action: "Inspect Commerce MCP response headers." },
  MCP_RESPONSE_TOO_LARGE: { message: "The MCP response exceeded the maximum accepted size.", action: "Inspect the Commerce MCP response size and result bounds." },
  MCP_CONNECTION_FAILED: { message: "The Commerce MCP SDK could not establish a connection.", action: "Inspect the MCP initialize exchange and Commerce service health." },
  MCP_MANIFEST_READ_FAILED: { message: "The Commerce MCP capability resource could not be read.", action: "Inspect the capabilities resource handler and connection." },
  MCP_MANIFEST_RESOURCE_INVALID: { message: "The Commerce MCP capabilities resource was missing or had an unexpected shape.", action: "Inspect the commerce://capabilities resource envelope." },
  MCP_MANIFEST_JSON_INVALID: { message: "The Commerce MCP capabilities resource contained invalid JSON.", action: "Inspect the manifest JSON emitted by Commerce." },
  MCP_MANIFEST_SCHEMA_INVALID: { message: "The Commerce MCP manifest did not satisfy its shared contract.", action: "Check the published shared-contract version and manifest fields." },
  MCP_TOOL_LIST_FAILED: { message: "The MCP SDK failed to list tools.", action: "Inspect the Commerce tools/list handler and transport." },
  MCP_TOOL_LIST_PAGINATED: { message: "The MCP tool list unexpectedly included a pagination cursor.", action: "Return the complete bounded tool catalogue in one response." },
  MCP_TOOL_LIST_TOO_LARGE: { message: "The MCP tool list exceeded the 32-tool limit.", action: "Check the Commerce tool catalogue size." },
  MCP_TOOL_DESCRIPTOR_INVALID: { message: "An MCP tool descriptor contained unsupported fields.", action: "Check the Commerce tools/list descriptor contract." },
  MCP_TOOL_CALL_FAILED: { message: "The MCP SDK failed to execute the requested Commerce tool.", action: "Inspect the Commerce tools/call handler and transport." },
  MCP_TOOL_RESULT_SCHEMA_INVALID: { message: "The Commerce tool returned structured content that failed shared-contract validation.", action: "Inspect the Commerce tool's structured result schema." },
  MCP_TOOL_ERROR_FLAG_MISMATCH: { message: "The MCP isError flag disagreed with the Commerce tool's structured status.", action: "Make isError agree with the structured result status." },
  HOST_AUTHORIZATION_DENIED: { message: "The host rejected a mismatched shop, recovery, grant or tool authorization.", action: "Verify the conversation's shop and pinned grant without exposing customer data." },
  HOST_CONVERSATION_MISSING: { message: "The requested conversation does not exist.", action: "Check the conversation identifier and its retention state." },
  HOST_RECOVERY_MISSING: { message: "The conversation has no associated checkout recovery.", action: "Check the recovery linkage for this conversation." },
  HOST_RECOVERY_MISMATCH: { message: "The conversation's recovery does not match the requested recovery.", action: "Check the recovery identity passed to the host." },
  HOST_RECOVERY_UNSUPPORTED: { message: "The recovery identifier is a standalone or product-only context unsupported by this host.", action: "Use the supported recovery execution path." },
  HOST_SHOP_ID_MISMATCH: { message: "The recovery's shop ID does not match the requesting shop.", action: "Check the canonical shop authorization context." },
  HOST_SHOP_DOMAIN_MISMATCH: { message: "The recovery's shop domain does not match the requesting shop.", action: "Check the resolved shop domain." },
  HOST_VERSION_STALE: { message: "The conversation inbound version changed since the turn was admitted.", action: "Inspect the latest conversation version before retrying." },
  HOST_PROCESSING_LEASE_MISSING: { message: "The conversation has no active processing lease.", action: "Inspect the conversation processing lifecycle." },
  HOST_PROCESSING_LEASE_EXPIRED: { message: "The conversation's processing lease has expired.", action: "Inspect the processing lease duration and worker delay." },
  HOST_TURN_STALE: { message: "The conversation's inbound version or processing lease is no longer current.", action: "Inspect the latest conversation version and processing lease." },
  HOST_MANIFEST_GRANT_MISMATCH: { message: "The current MCP manifest does not match the conversation's retained grant.", action: "Check the pinned release and granted tool descriptors." },
  HOST_GRANT_READ_FAILED: { message: "The host could not load or validate the conversation's retained grant.", action: "Inspect grant persistence and schema validation for the conversation." },
  HOST_GRANT_PERSIST_FAILED: { message: "The host could not persist the conversation's initial grant.", action: "Inspect grant persistence and transaction errors." },
  HOST_RELEASE_VALIDATION_FAILED: { message: "The pinned Commerce release failed local validation.", action: "Check its runner compatibility, response contract and persisted release record." },
  HOST_STATE_LOOKUP_FAILED: { message: "The host could not recheck the conversation processing state.", action: "Inspect the conversation query and database availability." },
  HOST_TOOL_LIST_UNAUTHORIZED: { message: "The MCP tool list differs from the tools authorized by the retained grant.", action: "Check tool authorization and the pinned release." },
  HOST_TOOL_NOT_GRANTED: { message: "Commerce advertised a tool absent from the pinned manifest.", action: "Check the pinned release and MCP tool catalogue." },
  HOST_TOOL_GRANT_MISMATCH: { message: "Commerce advertised a tool that the retained grant does not authorize.", action: "Inspect the pinned tool revision and grant." },
  HOST_TOOL_DESCRIPTOR_CHANGED: { message: "Commerce advertised a tool descriptor different from the pinned manifest.", action: "Check the tool name, description and input schema." },
  HOST_TOOL_LIST_DUPLICATE: { message: "The MCP tool list includes duplicate tool names.", action: "Remove duplicate tool names in the Commerce MCP catalogue." },
  HOST_RUNNER_FAILURE: { message: "The shared Commerce runner rejected the turn; the attached runner reason identifies its validation stage.", action: "Inspect the correlated commerce.turn.failed event and runner diagnostic." },
  HOST_CANCELLED: { message: "The Commerce host operation was cancelled by its caller.", action: "Inspect the caller cancellation and shutdown lifecycle." },
  HOST_DEADLINE_EXCEEDED: { message: "The Commerce host reached its execution deadline.", action: "Inspect the elapsed operation and MCP service latency." },
  HOST_UNEXPECTED_FAILURE: { message: "An unexpected Commerce host operation failed.", action: "Inspect adjacent application and database logs for this conversation." },
} as const satisfies Record<string, Explanation>;

export type CommerceHostReason = keyof typeof explanations;
export type CommerceHostOperation = "initialize" | "read_manifest" | "list_tools" | "call_tool";
export type CommerceHostDiagnostic = Readonly<{
  stage: CommerceHostStage;
  reasonCode: CommerceHostReason;
  reasonMessage: string;
  operatorAction: string;
  operation?: CommerceHostOperation;
  statusCode?: number;
  transportCode?: string;
  runnerDiagnostic?: RunnerDiagnostic;
}>;

const transportCodes = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
function safeTransportCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    try {
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "string" && transportCodes.has(code)) return code;
      current = current.cause;
    } catch { return undefined; }
  }
  return undefined;
}

/** Stable transport explanations; underlying exception messages never escape. */
export function mcpTransportDiagnostic(
  stage: CommerceHostStage, operation: CommerceHostOperation, cause: unknown,
): CommerceHostDiagnostic {
  const code = safeTransportCode(cause);
  const reason: CommerceHostReason = code === "ENOTFOUND" ? "MCP_DNS_HOST_NOT_FOUND"
    : code === "EAI_AGAIN" ? "MCP_DNS_TEMPORARY_FAILURE"
    : code === "ECONNREFUSED" ? "MCP_CONNECTION_REFUSED"
    : code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT"
      ? "MCP_CONNECTION_TIMED_OUT"
    : code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      code === "ERR_TLS_CERT_ALTNAME_INVALID" ? "MCP_TLS_CERTIFICATE_FAILURE"
    : "MCP_TRANSPORT_FAILED";
  return hostDiagnostic(stage, reason, { operation, cause });
}

/** Never copies provider messages, URLs, bodies, tool arguments or arbitrary codes. */
export function hostDiagnostic(
  stage: CommerceHostStage,
  reasonCode: CommerceHostReason,
  options: { operation?: CommerceHostOperation; statusCode?: number; cause?: unknown; runnerDiagnostic?: RunnerDiagnostic } = {},
): CommerceHostDiagnostic {
  const explanation = explanations[reasonCode];
  const code = safeTransportCode(options.cause);
  return Object.freeze({
    stage, reasonCode, reasonMessage: explanation.message, operatorAction: explanation.action,
    ...(options.operation ? { operation: options.operation } : {}),
    ...(Number.isInteger(options.statusCode) && options.statusCode! >= 100 && options.statusCode! <= 599
      ? { statusCode: options.statusCode } : {}),
    ...(code ? { transportCode: code } : {}),
    ...(options.runnerDiagnostic ? { runnerDiagnostic: options.runnerDiagnostic } : {}),
  });
}

/** Domain-semantic event on the canonical shared logger; sink exceptions are isolated. */
export function logCommerceHostFailure(
  logger: StructuredLogger,
  code: string,
  retryable: boolean,
  diagnostic: CommerceHostDiagnostic,
  identifiers: { shopId: string; recoveryId: string; conversationId: string; inboundVersion: number },
): void {
  const { runnerDiagnostic, ...safe } = diagnostic;
  try {
    const log = ["DENIED", "STALE_TURN", "CANCELLED"].includes(code) ? logger.warn.bind(logger) : logger.error.bind(logger);
    log("commerce.host.failed", {
      ...identifiers, errorCode: code, retryable, ...safe,
      ...(runnerDiagnostic ? {
        runnerStage: runnerDiagnostic.stage,
        runnerReasonCode: runnerDiagnostic.reasonCode,
        runnerReasonMessage: runnerDiagnostic.reasonMessage,
        runnerOperatorAction: runnerDiagnostic.operatorAction,
      } : {}),
    });
  } catch { /* Logging must never change the Commerce host result. */ }
}
