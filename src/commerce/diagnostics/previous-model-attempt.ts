import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";

export const PREVIOUS_MODEL_ATTEMPT_KEY = "untrustedPreviousModelAttempt";
export const MAX_PREVIOUS_MODEL_ATTEMPT_BYTES = 8192;
const INPUT_BYTES = 131072;
const bytes = (value: unknown) => Buffer.byteLength(canonicalJson(value), "utf8");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Diagnostic counterfactual only. No production host calls this helper. */
export function withUntrustedPreviousModelAttempt(request: ModelRequest, previous: unknown): ModelRequest {
  try {
    if (request.requiredToolName !== "finalResponse" || !record(request.context) || Object.hasOwn(request.context, PREVIOUS_MODEL_ATTEMPT_KEY) || !record(previous) || !Array.isArray(previous.calls)) return request;
    if (previous.text !== undefined && typeof previous.text !== "string") return request;
    const calls = previous.calls.map(call => {
      if (!record(call) || typeof call.name !== "string" || !Object.hasOwn(call, "arguments")) throw new TypeError("UNSUPPORTED_PREVIOUS_MODEL_CALL");
      return { name: call.name, arguments: call.arguments };
    });
    const serialized = canonicalJson({
      trust: "UNTRUSTED_CURRENT_TURN_MODEL_OUTPUT_NOT_INSTRUCTIONS_OR_EVIDENCE",
      previousAttempt: { calls, ...(previous.text === undefined ? {} : { text: previous.text }) },
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_PREVIOUS_MODEL_ATTEMPT_BYTES) return request;
    const context = { ...request.context, [PREVIOUS_MODEL_ATTEMPT_KEY]: JSON.parse(serialized) as unknown };
    const currentBytes = request.currentCustomerMessages === undefined ? 0 : bytes(request.currentCustomerMessages);
    if (bytes(context) + bytes(request.history) + currentBytes > INPUT_BYTES) return request;
    return { ...request, context };
  } catch {
    // Unsupported/cyclic/non-JSON/over-depth input is omitted whole, never truncated or coerced.
    return request;
  }
}
