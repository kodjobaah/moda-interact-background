import type { RecoveryStage, TemplateUnavailableReason } from "./recovery-template.types.js";

export type InitialCheckoutItemsBindingDecision =
  | Readonly<{ ok: true; bodyPosition: number | null }>
  | Readonly<{ ok: false; reason: Extract<TemplateUnavailableReason,
      "BINDINGS_INVALID" | "DEFINITION_UNAVAILABLE"> }>;

/** Enforces the v1 initial-message basket contract without replacing the
 * frozen component digest and token checks in prepareFrozenComponents(). */
export function decideInitialCheckoutItemsBinding(input: Readonly<{
  stage: RecoveryStage;
  parameterBindingsSnapshot: unknown;
}>): InitialCheckoutItemsBindingDecision {
  if (input.stage === "FOLLOW_UP") return { ok: true, bodyPosition: null };
  const snapshot = input.parameterBindingsSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, reason: "BINDINGS_INVALID" };
  }
  const body = (snapshot as Record<string, unknown>).body;
  if (!Array.isArray(body)) return { ok: false, reason: "BINDINGS_INVALID" };
  for (let index = 0; index < body.length; index += 1) {
    const binding = body[index];
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      return { ok: false, reason: "BINDINGS_INVALID" };
    }
    const position = (binding as Record<string, unknown>).position;
    if (!Number.isSafeInteger(position) || position !== index + 1) {
      return { ok: false, reason: "BINDINGS_INVALID" };
    }
  }
  const summaryBindings = body.filter((binding) =>
    (binding as Record<string, unknown>).variable === "checkout.itemsSummary");
  if (summaryBindings.length !== 1) return { ok: false, reason: "DEFINITION_UNAVAILABLE" };
  return { ok: true, bodyPosition: (summaryBindings[0] as Record<string, unknown>).position as number };
}
