import type { RecommendationSelection } from "./disposition.js";

type Proposal = NonNullable<RecommendationSelection["productRecommendations"]>[number];

export type RecommendationRefreshProposal = Readonly<{
  proposal: Proposal;
  productCallKey: string;
  basketCallKeys: readonly string[];
  offerIds: readonly string[];
}>;

export type RecommendationRefreshPlan = Readonly<{
  proposals: readonly RecommendationRefreshProposal[];
  shippingCallKey: string | null;
  calls: readonly string[];
}>;

function collectCalls(proposals: readonly RecommendationRefreshProposal[], shippingCallKey: string | null): string[] {
  const calls: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => { if (!seen.has(key)) { seen.add(key); calls.push(key); } };
  for (const item of proposals) {
    add(item.productCallKey);
    for (const key of item.basketCallKeys) add(key);
  }
  for (const item of proposals) for (const id of item.offerIds) add(`commerce_get_discount_details:${id}`);
  if (shippingCallKey) add(shippingCallKey);
  return calls;
}

/** Build the complete replay set before execution and prune claims in stable source order. */
export function planRecommendationRefreshes(input: {
  proposals: readonly RecommendationRefreshProposal[];
  shippingCallKey?: string | null;
  availableCalls: number;
}): RecommendationRefreshPlan {
  if (!Number.isSafeInteger(input.availableCalls) || input.availableCalls < 0)
    throw new RangeError("RECOMMENDATION_CALL_BUDGET_INVALID");
  const proposals = input.proposals.map((item) => ({
    ...item,
    basketCallKeys: Object.freeze([...new Set(item.basketCallKeys)]),
    offerIds: [...new Set(item.offerIds)].slice(0, 3),
  }));
  let shippingCallKey = input.shippingCallKey ?? null;
  const calls = () => collectCalls(proposals, shippingCallKey);
  while (proposals.length > 1 && calls().length > input.availableCalls) proposals.pop();
  while (proposals.length === 1 && calls().length > input.availableCalls && proposals[0]!.offerIds.length > 0)
    proposals[0]!.offerIds.pop();
  if (calls().length > input.availableCalls) shippingCallKey = null;
  while (proposals.length > 0 && calls().length > input.availableCalls) proposals.pop();
  const retained = proposals.map((item) => Object.freeze({
    proposal: item.proposal,
    productCallKey: item.productCallKey,
    basketCallKeys: Object.freeze([...item.basketCallKeys]),
    offerIds: Object.freeze([...item.offerIds]),
  }));
  return Object.freeze({
    proposals: Object.freeze(retained), shippingCallKey,
    calls: Object.freeze(calls()),
  });
}
