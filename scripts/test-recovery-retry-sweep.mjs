import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

// Transpile only the scheduler, redaction and coalescing modules. Type-only
// imports are erased; no application singleton, database or provider is loaded.
const ts = createRequire(import.meta.url)("typescript");
const dir = mkdtempSync(join(tmpdir(), "moda-retry-sweep-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
for (const name of ["sweep", "sweep-logging", "error-diagnostic"]) {
  const source = readFileSync(new URL(`../src/services/recovery-delivery-retry/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.equal(output.diagnostics?.length ?? 0, 0);
  writeFileSync(join(dir, `${name}.js`), output.outputText);
}
const { RecoveryDeliveryRetrySweep, retryWorkerEnabled } = await import(pathToFileURL(join(dir, "sweep.js")).href);
const { retrySweepLogger } = await import(pathToFileURL(join(dir, "sweep-logging.js")).href);
function recordingLogger(records = [], inherited = {}) {
  return Object.assign(Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (event, fields) => records.push({ level, event, ...inherited, ...fields })])), {
    child(fields) { return recordingLogger(records, { ...inherited, ...fields }); },
  });
}
const empty = async () => ({ outcomes: [], next: null });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test("sweep advances both bounded cursors and restarts at the beginning", async () => {
  const calls = [];
  const cursor = { id: "intent", notBeforeAt: new Date(0) };
  const worker = new RecoveryDeliveryRetrySweep({
    async reconcileClaimedPage(input) { calls.push(["reconcile", input]); return { outcomes: [], next: input.afterId ? null : "retry_intent" }; },
    async runDuePage(input) { calls.push(["due", input]); return { outcomes: [], next: input.after ? null : cursor }; },
  }, recordingLogger(), 60_000, 5);
  for (let i = 0; i < 3; i++) await worker.runOnce();
  assert.deepEqual(calls, [["reconcile", { limit: 5 }], ["due", { limit: 5 }],
    ["reconcile", { limit: 5, afterId: "retry_intent" }], ["due", { limit: 5, after: cursor }],
    ["reconcile", { limit: 5 }], ["due", { limit: 5 }]]);
  await worker.close();
});

test("concurrent sweeps share one cycle; close drains it without starting another page", async () => {
  const gate = deferred();
  let recon = 0, due = 0;
  const worker = new RecoveryDeliveryRetrySweep({ async reconcileClaimedPage() { recon++; await gate.promise; return empty(); },
    async runDuePage() { due++; return empty(); } }, recordingLogger());
  const first = worker.runOnce();
  assert.equal(worker.runOnce(), first);
  const closed = worker.close();
  gate.resolve();
  await Promise.all([first, closed]);
  await worker.runOnce();
  assert.equal(recon, 1);
  assert.equal(due, 0);
});

test("page failure preserves its cursor, logs redacted error, and does not starve discovery", async () => {
  const calls = [], records = [];
  let recon = 0;
  const worker = new RecoveryDeliveryRetrySweep({
    async reconcileClaimedPage(input) { calls.push(input); if (++recon === 2) throw new Error("database failed password=secret"); return { outcomes: [], next: "retry_intent" }; },
    async runDuePage() { calls.push("due"); return empty(); },
  }, recordingLogger(records));
  for (let i = 0; i < 3; i++) await worker.runOnce();
  assert.deepEqual(calls, [{ limit: 5 }, "due", { limit: 5, afterId: "retry_intent" }, "due", { limit: 5, afterId: "retry_intent" }, "due"]);
  const error = records.find(r => r.event === "recovery.delivery_retry.sweep_page_failed");
  assert.equal(error.stage, "reconcile");
  assert.match(error.sourceError.message, /database failed \[REDACTED_CREDENTIAL\]/);
  assert.doesNotMatch(JSON.stringify(records), /password=secret/);
  await worker.close();
});

test("unchanged holds are coalesced but changed reasons, exceptions and other intents remain visible", () => {
  let now = 1_000;
  const records = [];
  const log = retrySweepLogger(recordingLogger(records), () => now, 100, 2);
  const event = "recovery.delivery_retry.execution_held";
  const child = log.child({ retryIntentId: "a" });
  child.debug(event, { reason: "cooldown" });
  child.debug(event, { reason: "cooldown" });
  child.debug(event, { reason: "policy" });
  child.debug(event, { reason: "policy", sourceError: { message: "cause" } });
  child.warn(event, { reason: "policy" });
  child.error(event, { reason: "policy" });
  log.debug(event, { retryIntentId: "b", reason: "policy" });
  assert.equal(records.length, 6);
  now += 100;
  child.debug(event, { reason: "policy" });
  assert.equal(records.length, 7);
  log.debug(event, { retryIntentId: "c", reason: "policy" }); // evicts b
  log.debug(event, { retryIntentId: "b", reason: "policy" });
  assert.equal(records.length, 9);
  log.info("recovery.delivery_retry.claimed", { retryIntentId: "a" });
  log.info("recovery.delivery_retry.claimed", { retryIntentId: "a" });
  assert.equal(records.length, 11);
});

test("worker is enabled only by an explicit opt-in and the sweep cannot restart after shutdown", async () => {
  assert.equal(retryWorkerEnabled("1"), true);
  for (const value of [undefined, "", "0", "true", " 1", "01", "1 "]) assert.equal(retryWorkerEnabled(value), false);
  const worker = new RecoveryDeliveryRetrySweep({ reconcileClaimedPage: empty, runDuePage: empty }, recordingLogger());
  worker.start();
  assert.throws(() => worker.start(), /cannot be started twice/);
  await worker.close();
  await worker.close();
  assert.throws(() => worker.start(), /cannot be started twice/);
  assert.throws(() => new RecoveryDeliveryRetrySweep({ reconcileClaimedPage: empty, runDuePage: empty }, recordingLogger(), 0, 5), RangeError);
  assert.throws(() => new RecoveryDeliveryRetrySweep({ reconcileClaimedPage: empty, runDuePage: empty }, recordingLogger(), 1, 251), RangeError);
});

test("dedicated follow-up reconciliation has its own bounded restart cursor and cannot discover follow-up sends", async () => {
  const calls = [], records = [];
  let count = 0;
  const worker = new RecoveryDeliveryRetrySweep({
    async reconcileClaimedPage(input) { calls.push(["initial-reconcile", input]); return empty(); },
    async runDuePage(input) { calls.push(["initial-due", input]); return empty(); },
  }, recordingLogger(records), 60_000, 5, {
    async reconcilePage(input) {
      calls.push(["follow-up-reconcile", input]);
      if (++count === 2) throw new Error("database temporarily unavailable");
      return { outcomes: [{ blockId: "allowance_retry_test", kind: "held" }], next: input.afterId ? null : "allowance_retry_test" };
    },
  });
  for (let i = 0; i < 4; i++) await worker.runOnce();
  assert.deepEqual(calls.filter(c => c[0] === "follow-up-reconcile"), [
    ["follow-up-reconcile", { limit: 5 }], ["follow-up-reconcile", { limit: 5, afterId: "allowance_retry_test" }],
    ["follow-up-reconcile", { limit: 5, afterId: "allowance_retry_test" }], ["follow-up-reconcile", { limit: 5 }],
  ]);
  assert.equal(calls.filter(c => c[0] === "initial-due").length, 4);
  assert.equal(records.filter(r => r.event === "recovery.delivery_retry.sweep_page_failed" && r.stage === "follow-up-reconcile").length, 1);
  await worker.close();
});

test("shutdown waits for follow-up reconciliation without starting discovery", async () => {
  const gate = deferred(), started = deferred();
  let discoveries = 0;
  const worker = new RecoveryDeliveryRetrySweep({ reconcileClaimedPage: empty, async runDuePage() { discoveries++; return empty(); } },
    recordingLogger(), 60_000, 5, { async reconcilePage() { started.resolve(); await gate.promise; return empty(); } });
  const first = worker.runOnce();
  await started.promise;
  const closed = worker.close();
  gate.resolve();
  await Promise.all([first, closed]);
  assert.equal(discoveries, 0);
});
