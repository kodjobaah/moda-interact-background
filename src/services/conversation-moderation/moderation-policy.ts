export const MODERATION_POLICY_VERSION = "arch040-moderation-v1";
export const MODERATION_TIMEOUT_MS = 8_000;

export type ModerationActor = "CUSTOMER_MESSAGE" | "HUMAN_COMMAND" | "AGENT_MESSAGE" | "AUTOMATION_MESSAGE";
export type ClassifiedModeration = {
  decision: "ALLOW" | "BLOCK" | "REVIEW_REQUIRED";
  flagged: boolean | null;
  reasonCode: string | null;
  categories: Record<string, boolean> | null;
  scores: Record<string, number> | null;
  returnedModel: string | null;
  requestId: string | null;
};
export type ModerationResponse = {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  appliedInputTypes?: Record<string, string[]>;
  returnedModel: string;
  requestId?: string;
};

/** Vendor scores are evidence only: no invented category-score threshold. */
export function classifyModeration(input: ModerationResponse, _actor: ModerationActor): ClassifiedModeration {
  if (typeof input.flagged !== "boolean" || !input.returnedModel?.trim() ||
      !input.categories || Array.isArray(input.categories) || typeof input.categories !== "object" ||
      !input.categoryScores || Array.isArray(input.categoryScores) || typeof input.categoryScores !== "object") {
    throw new Error("moderation_response_invalid");
  }
  const keys = Object.keys(input.categories);
  if (keys.length === 0 || keys.length > 64 || Object.keys(input.categoryScores).length > 64 ||
      !keys.every((key) => /^[a-z0-9/_-]{1,64}$/i.test(key) && typeof input.categories[key] === "boolean") ||
      !Object.entries(input.categoryScores).every(([key, value]) =>
        /^[a-z0-9/_-]{1,64}$/i.test(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("moderation_response_invalid");
  }
  if (input.appliedInputTypes !== undefined &&
      (!input.appliedInputTypes || typeof input.appliedInputTypes !== "object" ||
        Object.values(input.appliedInputTypes).some((value) => !Array.isArray(value) || value.some((v) => typeof v !== "string")))) {
    throw new Error("moderation_response_invalid");
  }
  const category = keys.find((key) => input.categories[key] === true);
  if (input.flagged && !category) throw new Error("moderation_response_invalid");
  const reasonCode = input.flagged
    ? `moderation_${(category ?? "flagged").replace(/[^a-z0-9]/gi, "_").toLowerCase()}`.slice(0, 64)
    : null;
  return {
    decision: input.flagged ? "BLOCK" : "ALLOW",
    flagged: input.flagged,
    reasonCode,
    categories: Object.fromEntries(Object.entries(input.categories).slice(0, 64)),
    scores: Object.fromEntries(Object.entries(input.categoryScores).slice(0, 64)),
    returnedModel: input.returnedModel.slice(0, 96),
    requestId: input.requestId?.slice(0, 128) ?? null,
  };
}

export function moderationConfig() {
  const policyVersion = process.env.MODA_CONVERSATION_MODERATION_POLICY_VERSION ?? MODERATION_POLICY_VERSION;
  if (!/^[a-zA-Z0-9._:-]{1,48}$/.test(policyVersion)) {
    throw new Error("moderation_configuration_invalid");
  }
  return { policyVersion };
}
