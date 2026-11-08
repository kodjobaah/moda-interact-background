import { canonicalJson, CommerceToolOutputs } from "@modainteract/moda-interact-shared/commerce";
import type { RecommendationContext, RecommendationPolicy } from "./context.js";

export type RecommendationToolName =
  | "commerce_get_product" | "commerce_search_products"
  | "commerce_get_discount_options" | "commerce_get_discount_details"
  | "commerce_get_shipping_information";

export type RecommendationObservation = Readonly<{
  sequence: number;
  observedAt: string;
  toolName: RecommendationToolName;
  descriptorIdentity: string;
  arguments: Readonly<Record<string, unknown>>;
  argumentKey: string;
  output: unknown;
}>;

export type RecommendationDiscountInspection =
  | "NOT_REQUIRED" | "SATISFIED" | "MISSING_OPTIONS" | "MISSING_DETAILS";

function immutable<T>(value: T): T {
  return Object.freeze(JSON.parse(JSON.stringify(value)) as T);
}

export class TurnRecommendationObservations {
  private sequence = 0;
  private readonly entries: RecommendationObservation[] = [];

  constructor(readonly identity: Pick<RecommendationContext, "shopId" | "provider" | "turn" | "grantId" | "releaseId">) {}

  record<N extends RecommendationToolName>(input: {
    toolName: N;
    descriptorIdentity: string;
    arguments: Readonly<Record<string, unknown>>;
    output: unknown;
  }): RecommendationObservation {
    if (!input.descriptorIdentity) throw new TypeError("RECOMMENDATION_DESCRIPTOR_IDENTITY_REQUIRED");
    const schema = CommerceToolOutputs[input.toolName];
    const output = schema.parse(input.output);
    const args = immutable(input.arguments as Record<string, unknown>);
    const argumentKey = canonicalJson(args);
    const prior = [...this.entries].reverse().find((entry) =>
      entry.toolName === input.toolName && entry.descriptorIdentity === input.descriptorIdentity && entry.argumentKey === argumentKey);
    const record = Object.freeze({ sequence: ++this.sequence, observedAt: new Date().toISOString(), toolName: input.toolName,
      descriptorIdentity: input.descriptorIdentity, arguments: args, argumentKey,
      output: immutable(output) });
    if (prior) this.entries.splice(this.entries.indexOf(prior), 1);
    this.entries.push(record);
    return record;
  }

  latest<N extends RecommendationToolName>(toolName: N, args: Readonly<Record<string, unknown>>, descriptorIdentity?: string) {
    const key = canonicalJson(args);
    return [...this.entries].reverse().find((entry) => entry.toolName === toolName &&
      entry.argumentKey === key && (descriptorIdentity === undefined || entry.descriptorIdentity === descriptorIdentity));
  }

  all<N extends RecommendationToolName>(toolName: N, descriptorIdentity?: string) {
    return this.entries.filter((entry) => entry.toolName === toolName &&
      (descriptorIdentity === undefined || entry.descriptorIdentity === descriptorIdentity));
  }
}

export function evaluateRecommendationDiscountInspection(
  observations: TurnRecommendationObservations,
  policy: RecommendationPolicy,
): RecommendationDiscountInspection {
  if (policy.mode === "NONE" || policy.mode === "FIXED" && policy.authorisedDiscountIds.length === 0) return "NOT_REQUIRED";
  const options = observations.all("commerce_get_discount_options");
  if (options.length === 0) return "MISSING_OPTIONS";
  const permitted = new Set<string>();
  for (const observation of options) {
    const output = observation.output as ReturnType<typeof CommerceToolOutputs.commerce_get_discount_options.parse>;
    if ("outcome" in output) continue;
    if (output.mode !== policy.mode) continue;
    for (const offer of output.offers) {
      if (policy.mode !== "FIXED" || policy.authorisedDiscountIds.includes(offer.offerId)) permitted.add(offer.offerId);
    }
  }
  if (permitted.size === 0) return "SATISFIED";
  const details = observations.all("commerce_get_discount_details");
  return details.some((observation) => {
    const requested = observation.arguments.offerId;
    if (typeof requested !== "string" || !permitted.has(requested)) return false;
    const output = observation.output as ReturnType<typeof CommerceToolOutputs.commerce_get_discount_details.parse>;
    return "outcome" in output || output.details === null || output.details.offer.offerId === requested;
  }) ? "SATISFIED" : "MISSING_DETAILS";
}
