import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleManifest, exampleGrant, exampleTurn, exampleFinal } from "@modainteract/moda-interact-shared/commerce";
import { runCommerceContextProbe, type CommerceContextProbeSnapshot } from "../../../src/commerce/diagnostics/context-probe.js";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });
async function output() { const parent = await mkdtemp(join(tmpdir(), "moda-context-probe-")); directories.push(parent); return join(parent, "run"); }
function snapshot(): CommerceContextProbeSnapshot {
 const manifest = exampleManifest(digest, true);
 manifest.capabilities[0]!.toolDescriptor.name = "commerce_get_product";
 manifest.grantedTools[0]!.toolName = "commerce_get_product";
 return { provenance: "CURRENT_RECONSTRUCTION", turn: exampleTurn, manifest, grant: exampleGrant(manifest),
  hostInstructions: ["PRIVATE_HOST_CANARY"], context: { privateContext: "PRIVATE_CONTEXT_CANARY" },
  history: [{ role: "assistant", content: "PRIVATE_PRIOR_CANARY" }], currentCustomerMessages: [{ role: "user", content: "PRIVATE_CURRENT_CANARY" }],
  language: { tag: "en", source: "shopify" }, availableToolNames: ["commerce_get_product"],
  capturedModelSteps: [{ calls: [{ name: "finalResponse", arguments: structuredClone(exampleFinal) }], outputTokens: 12 }], capturedToolResults: [] };
}
describe("isolated commerce context probe", () => {
 it("defaults offline, keeps exact complete model context privately and emits no raw stdout", async () => {
  const source = snapshot(), before = structuredClone(source), directory = await output();
  const model = { invoke: vi.fn() }, readTool = vi.fn(), stdout = vi.spyOn(console, "log");
  const result = await runCommerceContextProbe(source, { outputDirectory: directory }, { model, readTool });
  expect(result.ok).toBe(true); expect(result.modelCalls).toBe(1); expect(model.invoke).not.toHaveBeenCalled(); expect(readTool).not.toHaveBeenCalled(); expect(stdout).not.toHaveBeenCalled();
  expect(source).toEqual(before); expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  const request = JSON.parse(await readFile(join(directory, "request-1.json"), "utf8"));
  expect(request.context.trustedRecovery).toEqual(source.context); expect(request.history).toEqual(source.history); expect(request.currentCustomerMessages).toEqual(source.currentCustomerMessages);
  const hostIndex = request.instructions.indexOf("PRIVATE_HOST_CANARY"), responseIndex = request.instructions.indexOf(source.manifest.responseContract.instructions);
  expect(hostIndex).toBeGreaterThanOrEqual(0); expect(responseIndex).toBeGreaterThan(hostIndex);
  expect(request.instructions.slice(responseIndex + 1, responseIndex + 1 + source.manifest.featureBehaviours.length)).toEqual(source.manifest.featureBehaviours.map(feature => feature.behaviourPrompt));
  expect(request.maxOutputTokens).toBe(2048);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  for (const name of await readdir(directory)) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
  await expect(runCommerceContextProbe(source, { outputDirectory: directory })).rejects.toMatchObject({ code: "EEXIST" });
 });
 it("requires explicit root operator opt-in before injected model/network dependencies", async () => {
  const model = { invoke: vi.fn() }, readTool = vi.fn();
  await expect(runCommerceContextProbe(snapshot(), { outputDirectory: await output(), mode: "live-model" }, { model, readTool })).rejects.toThrow("PROBE_OPERATOR_CONFIRMATION_REQUIRED");
  await expect(runCommerceContextProbe(snapshot(), { outputDirectory: await output(), liveReadTools: true }, { model, readTool })).rejects.toThrow("PROBE_MODE_INVALID");
  expect(model.invoke).not.toHaveBeenCalled(); expect(readTool).not.toHaveBeenCalled();
 });
 it("rejects unknown/write tool descriptors and mismatched grants before invoking anything", async () => {
  const source = snapshot(); source.manifest.capabilities[0]!.toolDescriptor.name = "commerce_create_order"; source.manifest.grantedTools[0]!.toolName = "commerce_create_order"; source.grant = exampleGrant(source.manifest);
  await expect(runCommerceContextProbe(source, { outputDirectory: await output() })).rejects.toThrow("PROBE_UNSAFE_TOOL");
  source.grant.shopId = "wrong-shop";
  await expect(runCommerceContextProbe(source, { outputDirectory: await output() })).rejects.toThrow("PROBE_GRANT_MISMATCH");
 });
 it("preserves exact returned model arguments and canonical final refusal in explicit synthetic live mode", async () => {
  const source = snapshot(), directory = await output();
  const step = { calls: [{ name: "finalResponse", arguments: { ...exampleFinal, answerKind: "ANSWER", referralReason: null, replyText: "PRIVATE_REPLY_CANARY", details: { unsupported: "PRIVATE_UNKNOWN_CANARY" } } }], outputTokens: 12 };
  const before = structuredClone(step), invoke = vi.fn(async () => step);
  const result = await runCommerceContextProbe(source, { outputDirectory: directory, mode: "live-model", operatorConfirmation: "ROOT_AUTHORIZED_READ_ONLY_DIAGNOSTIC" }, { model: { invoke } });
  expect(result.ok).toBe(false); expect(step).toEqual(before); expect(result.modelCalls).toBeLessThanOrEqual(12);
  expect(JSON.parse(await readFile(join(directory, "output-1.json"), "utf8"))).toEqual(before);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
 });
 it("replays only the exact captured read and refuses a mismatched argument without network", async () => {
  const source = snapshot(), directory = await output();
  source.capturedModelSteps.unshift({ calls: [{ name: "commerce_get_product", arguments: { handle: "shirt" } }], outputTokens: 12 });
  source.capturedToolResults = [{ name: "commerce_get_product", arguments: { handle: "shirt" }, result: { contractVersion: "commerce.v1", status: "OK", data: { synthetic: true }, renderedText: "PRIVATE_TOOL_CANARY" } }];
  const readTool = vi.fn();
  const result = await runCommerceContextProbe(source, { outputDirectory: directory }, { readTool });
  expect(result.toolCalls).toBe(1); expect(readTool).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(directory, "tool-output-1.json"), "utf8"))).toEqual(source.capturedToolResults[0]!.result);
  const mismatched = structuredClone(source); mismatched.capturedToolResults[0]!.arguments = { handle: "other" };
  const failed = await runCommerceContextProbe(mismatched, { outputDirectory: await output() }, { readTool });
  expect(failed.ok).toBe(false); expect(readTool).not.toHaveBeenCalled();
 });
 it("refuses expanded capture budgets before model or read invocation", async () => {
  const source = snapshot(); source.capturedModelSteps = Array.from({ length: 13 }, () => source.capturedModelSteps[0]!);
  const model = { invoke: vi.fn() };
  await expect(runCommerceContextProbe(source, { outputDirectory: await output() }, { model })).rejects.toThrow("PROBE_CAPTURE_BUDGET_INVALID");
  expect(model.invoke).not.toHaveBeenCalled();
 });

});
