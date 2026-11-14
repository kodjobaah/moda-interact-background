# Isolated full-context Commerce probe

This operator diagnostic calls the published runner in memory. It does not import the production host, database client, conversation processor, outbound sender, usage service or product-context persistence. It is not a replay of a production inbound event.

Import `runCommerceContextProbe` from `dist/commerce/diagnostics/context-probe.js` after building the exact reviewed source. The repository agent runs synthetic tests only. Actual provider or MCP execution belongs to the authorized root operator.

## Input snapshot

Supply a protected, independently collected `RunCommerceTurnInput` snapshot without `signal`, `dependencies` or `budgets`, plus:

- `provenance`: `CURRENT_RECONSTRUCTION` unless exact original request inputs were captured; otherwise `CAPTURED_ORIGINAL`.
- `availableToolNames`: exact observed available read-tool names.
- `capturedModelSteps`: original captured model outputs, in order, for default offline mode.
- `capturedToolResults`: ordered `{name, arguments, result}` receipts. Arguments must match exactly.

The runner input includes `turn`, `grant`, complete pinned `manifest` (including ordered `featureBehaviours` and response contract), `hostInstructions`, `context`, `history`, `currentCustomerMessages`, `language`, and applicable `platform`/`productContext`. Supply the application `hostInstructions` only, in the deployed host's order; the actual runner adds platform instructions, pinned response instructions, ordered feature prompts, current-customer and dynamic selection/repair instructions. Do not precompose these twice.

Use the deployed bounded moderation-aware history reader and actual language/policy/context projections. Raw database messages, omitted feature prompts, current facts substituted for historical facts, or a reconstructed turn boundary must never be described as an exact historical replay. Record all reconstruction limitations privately alongside the snapshot.

No credentials belong in this snapshot. Resolve the configured model/credential separately in the operator process using existing read-only configuration readers. Do not fabricate a conversation claim or invoke the production host to bypass its claim checks.

## Default offline invocation

```js
const result = await runCommerceContextProbe(snapshot, {
  outputDirectory: freshProtectedDirectory,
});
// Only this bounded shape/digest result may be printed.
console.log(JSON.stringify(result));
```

The output directory must not exist. It is created as 0700; all artifacts are created exclusively as 0600. A repeated path refuses before any model/tool call. Each request, original model output, exact tool arguments/result, runner result and shared structured-log stream is saved privately. Inspect/export them only through protected operator channels; never paste raw prompts, history, IDs, checkout URLs or provider bodies into public logs or task reports.

## Root-only actual model diagnostic

Use `mode: "live-model"` and exact explicit `operatorConfirmation: "ROOT_AUTHORIZED_READ_ONLY_DIAGNOSTIC"`, with `{model: actualConfiguredModelInvoker, extractEvidence: deployedExtractTrustedEvidence}`. The extractor callback is passed unchanged to each runner tool. For product search/read/category/shipping it normally yields no discount evidence; preserve the deployed extractor nevertheless. This isolated runner does not execute the host’s post-model evidence rewrite or final delivery revalidation; record that boundary explicitly, and inspect original outputs rather than treating this as a delivery proof. Tool results remain exact captured receipts by default. The model request is captured before invocation, with no argument or instruction transformation.

Only if separately authorized, additionally set `liveReadTools: true` and inject `readTool(name, args, signal)` backed by the existing pinned read-only MCP client. The harness independently refuses unknown/non-read descriptor names and unavailable/non-granted calls. Allowed operations are product search/read/category resolution, shipping-information read and discount-options/details read. It does not permit create/apply/cart/order mutations. The operator adapter must preserve existing policy authorization and suppress/redirect its own generic transport logs to a private 0600 file; the probe cannot control a supplied adapter's external logging or side effects. If policy equivalence cannot be established, use captured results instead.

Limits are fixed to the reviewed incident's actual configuration: 12 model steps, 6 remote calls, 60 seconds, 2048 output tokens. There is no additional repair, retry loop, result selection, final-response rewrite, persistence or delivery. Do not repeat calls merely to obtain a preferred answer.

Unexpected invocation errors must be reported with a fixed generic error code only; inspect detailed errors privately. The returned safe result is conformance/diagnostic evidence, not a production delivery or incident-resolution receipt.

## Single-request previous-output counterfactual

`withUntrustedPreviousModelAttempt(request, previousStep)` is a pure diagnostic helper; no production host path calls it. It acts only on an existing forced `finalResponse` request. It adds exact prior model calls/name/arguments and optional visible text as `context.untrustedPreviousModelAttempt`, explicitly labelled untrusted data rather than instructions or evidence. Provider/transport/reasoning metadata is excluded. Existing context fields, instructions, tool schemas/order, customer objective, arguments and model budget are unchanged.

The complete frame must fit 8192 UTF-8 bytes and the resulting context plus history/current messages must fit the existing 131072-byte input ceiling. Collisions, non-object/unsupported/cyclic input or insufficient space return the original request unchanged; nothing is truncated. A normal prior discovery call must be described as discovery, not an invalid final answer. The existing runner's budget-forced finalization and missing-selection repair are different paths even though both set `requiredToolName`.

Root may evaluate a specifically authorized captured request/prior-output pair with one actual configured SDK call and no MCP calls. Record exact input/output hashes, full pinned-schema validation and accepted observed selections separately. Nonempty details or schema validity alone do not establish accepted product identities or delivery success. A negative counterfactual does not authorize production wiring or repeated calls chasing a preferred result.

## Known-schema normal-form diagnostic

`diagnosticFinalSchemaNormalForm(rawParameters, verifiedContract)` is another pure diagnostic helper, not production host wiring or a validator replacement. It accepts only the published generated finalResponse envelope with its known disjoint ANSWER/referral and language branches plus one supported product-selection conjunction. It distributes that known shape into complete root `anyOf` alternatives, retaining the original root object/properties/required/extra-field restrictions and leaf schemas. Selection fragment conjunctions use required-key union, same-type checks, min-item conjunctions, const checks and enum intersection. Unsupported shapes, conflicts, embedded leaf logic, excessive branches or output size refuse transformation.

The differential fixture captures schemas from the actual published runner, including observed generic shipping. Its 502 original-versus-normal acceptance vectors are evidence, not a formal proof for arbitrary JSON Schema. The helper is intentionally not a generic normalizer. Retaining generic JSON Schema semantics does not imply compliance with any provider's strict subset; root `anyOf` is not universally portable.

For a specifically authorized one-call diagnostic, use the original captured forced request, without previous-output feedback. Change only that final tool's inputSchema. Before invoking the SDK, independently compile both schemas and verify known missing-selection outputs fail both. Afterwards report pinned response validation, original dynamic tool-schema validation, normalized-schema validation, accepted selection and exact observed identities separately. Preserve the original canonical validators and all model/tool budgets; no result rewriting, extra MCP calls, selection synthesis or production mechanism is authorized by this diagnostic.
