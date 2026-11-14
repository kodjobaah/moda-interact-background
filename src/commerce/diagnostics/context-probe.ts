import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, lstat, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, manifestMatchesGrant, isBuiltInTool, isTrustedCommerceBuiltInGrant } from "@modainteract/moda-interact-shared/commerce";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { runCommerceTurn, type RunCommerceTurnInput, type ModelStep, type CommerceModelInvoker } from "@modainteract/moda-interact-shared/commerce/runner";
import { projectFinalSelectionShape } from "../final-selection-shape.js";

const READ_TOOLS = new Set(["commerce_search_products", "commerce_get_product", "commerce_resolve_product_categories", "commerce_get_shipping_information", "commerce_get_discount_options", "commerce_get_discount_details"]);
const MAX_BYTES = 2_000_000;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
type Input = Omit<RunCommerceTurnInput, "dependencies" | "signal" | "budgets">;
export type CommerceContextProbeSnapshot = Input & {
  provenance: "CURRENT_RECONSTRUCTION" | "CAPTURED_ORIGINAL";
  availableToolNames: string[];
  capturedModelSteps: ModelStep[];
  capturedToolResults: { name: string; arguments: Record<string, unknown>; result: unknown }[];
};
export type CommerceContextProbeOptions = {
  outputDirectory: string;
  mode?: "offline" | "live-model";
  liveReadTools?: boolean;
  /** Explicit operator gate, not a substitute for the operator's external authorization. */
  operatorConfirmation?: "ROOT_AUTHORIZED_READ_ONLY_DIAGNOSTIC";
};
type Dependencies = {
  model?: CommerceModelInvoker;
  readTool?: (name: string, arguments_: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
};

async function privateWrite(directory: string, name: string, value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("PROBE_ARTIFACT_TOO_LARGE");
  await writeFile(join(directory, name), text, { mode: 0o600, flag: "wx" });
  return digest(text);
}

/** Operator-only isolated runner. No database, conversation processor, persistence or delivery imports. */
export async function runCommerceContextProbe(snapshot: CommerceContextProbeSnapshot, options: CommerceContextProbeOptions, dependencies: Dependencies = {}) {
  const mode = options.mode ?? "offline";
  if (!["offline", "live-model"].includes(mode) || options.liveReadTools && mode !== "live-model") throw new Error("PROBE_MODE_INVALID");
  if ((mode === "live-model" || options.liveReadTools) && options.operatorConfirmation !== "ROOT_AUTHORIZED_READ_ONLY_DIAGNOSTIC") throw new Error("PROBE_OPERATOR_CONFIRMATION_REQUIRED");
  if (mode === "live-model" && !dependencies.model || options.liveReadTools && !dependencies.readTool) throw new Error("PROBE_DEPENDENCY_MISSING");
  if (!["CURRENT_RECONSTRUCTION", "CAPTURED_ORIGINAL"].includes(snapshot.provenance)) throw new Error("PROBE_PROVENANCE_REQUIRED");
  if (!Array.isArray(snapshot.availableToolNames) || !Array.isArray(snapshot.capturedModelSteps) || !Array.isArray(snapshot.capturedToolResults)) throw new Error("PROBE_CAPTURE_INVALID");
  if (!manifestMatchesGrant(snapshot.manifest, snapshot.grant) || snapshot.turn.shopId !== snapshot.grant.shopId || snapshot.turn.conversationId !== snapshot.grant.conversationId || snapshot.turn.inboundVersion < snapshot.grant.initialInboundVersion) throw new Error("PROBE_GRANT_MISMATCH");
  const descriptors = [...new Map(snapshot.manifest.capabilities.map(capability => [capability.toolDescriptor.name, capability.toolDescriptor])).values(), ...snapshot.manifest.builtInTools];
  const names = new Set(snapshot.availableToolNames);
  if (snapshot.availableToolNames.some(name => !READ_TOOLS.has(name)) || descriptors.some(descriptor => !READ_TOOLS.has(descriptor.name))) throw new Error("PROBE_UNSAFE_TOOL");
  if (snapshot.capturedModelSteps.length > 12 || snapshot.capturedToolResults.length > 6) throw new Error("PROBE_CAPTURE_BUDGET_INVALID");
  // Fresh directory is an idempotency guard: a repeated invocation cannot silently repeat provider calls.
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const directory = await lstat(options.outputDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw new Error("PROBE_DIRECTORY_UNSAFE");
  const snapshotSha256 = await privateWrite(options.outputDirectory, "snapshot.json", snapshot);
  const log = await open(join(options.outputDirectory, "runner-log.jsonl"), "wx", 0o600);
  let modelCalls = 0, toolCalls = 0;
  const requestDigests: string[] = [], outputDigests: string[] = [], shapes: ReturnType<typeof projectFinalSelectionShape>[] = [];
  let replayTool = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const { provenance: _provenance, availableToolNames: _available, capturedModelSteps: _steps, capturedToolResults: _results, ...input } = snapshot;
  try {
    const result = await runCommerceTurn({ ...input, signal: controller.signal,
      budgets: { modelSteps: 12, remoteCalls: 6, deadlineMs: 60_000, outputTokens: 2048 },
      dependencies: { now: Date.now, digest,
        logger: createLogger({ serviceName: "commerce-context-probe", environment: "ISOLATED_DIAGNOSTIC", sink: record => { writeSync(log.fd, JSON.stringify(record) + "\n"); } }),
        model: { invoke: async (request, signal) => {
          if (++modelCalls > 12) throw new Error("PROBE_MODEL_BUDGET");
          requestDigests.push(await privateWrite(options.outputDirectory, `request-${modelCalls}.json`, request));
          const step = mode === "live-model" ? await dependencies.model!.invoke(request, signal) : snapshot.capturedModelSteps[modelCalls - 1];
          if (!step) throw new Error("PROBE_MODEL_CAPTURE_MISSING");
          outputDigests.push(await privateWrite(options.outputDirectory, `output-${modelCalls}.json`, step));
          if (step.calls.length === 1 && step.calls[0]?.name === "finalResponse") shapes.push(projectFinalSelectionShape(step.calls[0].arguments));
          return step; // Preserve original step/call/argument identity; no repair outside the published runner.
        } },
        tools: descriptors.map(descriptor => ({ descriptor,
          isAuthorized: async authorized => names.has(descriptor.name) && snapshot.grant.grantedTools.some(granted => canonicalJson(granted) === canonicalJson(authorized) && granted.toolName === descriptor.name && granted.definitionVersion === descriptor.definitionVersion && ("toolId" in descriptor ? "toolId" in granted && granted.toolId === descriptor.toolId && granted.toolRevisionId === descriptor.toolRevisionId : isBuiltInTool(granted) && isTrustedCommerceBuiltInGrant(granted))),
          execute: async (arguments_, signal) => {
            if (!READ_TOOLS.has(descriptor.name) || !names.has(descriptor.name) || ++toolCalls > 6) throw new Error("PROBE_TOOL_REFUSED");
            await privateWrite(options.outputDirectory, `tool-request-${toolCalls}.json`, { name: descriptor.name, arguments: arguments_ });
            let value: unknown;
            if (options.liveReadTools) value = await dependencies.readTool!(descriptor.name, arguments_, signal);
            else {
              const captured = snapshot.capturedToolResults[replayTool++];
              if (!captured || captured.name !== descriptor.name || canonicalJson(captured.arguments) !== canonicalJson(arguments_)) throw new Error("PROBE_TOOL_CAPTURE_MISMATCH");
              value = captured.result;
            }
            await privateWrite(options.outputDirectory, `tool-output-${toolCalls}.json`, value);
            return value as Awaited<ReturnType<RunCommerceTurnInput["dependencies"]["tools"][number]["execute"]>>;
          },
        })),
      },
    });
    await privateWrite(options.outputDirectory, "result.json", result);
    // Fixed values, capped shapes and digests only: caller may print this, never private artifacts.
    return { provenance: snapshot.provenance, mode, ok: result.ok, modelCalls, toolCalls, snapshotSha256, requestDigests, outputDigests, shapes,
      failure: result.ok ? null : { code: result.error.code, reasonCode: result.error.diagnostic?.reasonCode ?? null } };
  } finally { clearTimeout(timeout); controller.abort(); await log.close(); }
}
