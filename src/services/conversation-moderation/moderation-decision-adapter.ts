import type { ModerationResult } from "./moderation-assessment.service.js";

export type ModerationAdmission =
  | { kind: "allowed" }
  | { kind: "blocked"; failureCode: "HUMAN_CONTENT_MODERATION_BLOCKED" | "HUMAN_MODERATION_REVIEW_REQUIRED" }
  | { kind: "retry"; retryAt: Date };

/** Decision is NOT a provider permit or credit. */
export function humanModerationAdmission(decision: ModerationResult): ModerationAdmission {
  if (decision.kind === "allow") return { kind: "allowed" };
  if (decision.kind === "retry") return { kind: "retry", retryAt: decision.retryAt };
  return { kind: "blocked", failureCode: decision.kind === "block"
    ? "HUMAN_CONTENT_MODERATION_BLOCKED" : "HUMAN_MODERATION_REVIEW_REQUIRED" };
}
