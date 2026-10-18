import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { ModerationAssessmentService } from "../../../src/services/conversation-moderation/moderation-assessment.service.js";

/** B002 regression fixtures deliberately isolate provider fencing from BG006.
 * BG006 integration tests inject the REAL SQL moderation service with a fake
 * OpenAI classifier. This adapter is never wired into production.
 */
export function allowModerationFixture(): ModerationAssessmentService {
  return {
    effectiveText: vi.fn(async () => "fixture-content"),
    assessText: vi.fn(async (input) => ({
      kind: "allow" as const, assessmentId: "b002-test-allow",
      digest: createHash("sha256").update(input.effectiveText).digest("hex"),
      policyVersion: input.policyVersion,
    })),
    requireCurrentAllowance: vi.fn(async () => true),
  };
}
