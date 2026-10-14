import type { PrismaClient } from "@prisma/client";
import type { CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";

/** ARCH-038 LIVE only. PREVIEW policies are never read by Background. */
export type LiveBudgetSource = "PLATFORM" | "PRICE_PLAN" | "MERCHANT";
export type ResolvedLiveBudget = Readonly<{
  shopId: string;
  conversationId: string;
  recoveryId: string;
  inboundVersion: number;
  environment: CommerceEnvironment;
  deadlineMs: number;
  outputTokens: number;
  deadlineSource: LiveBudgetSource;
  outputTokenSource: LiveBudgetSource;
  merchantPricingPlanId: string | null;
  shopifyPlanHandle: string | null;
  policyEditVersions: Readonly<{ platform: number; pricePlan: number | null; merchant: number | null }>;
  resolvedAt: string;
}>;

export class LiveBudgetPolicyError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string) {
    super(`LIVE CommerceAgent budget: ${reasonCode}`);
    this.reasonCode = reasonCode;
    this.name = "LiveBudgetPolicyError";
  }
}

const BUDGET_KEYS = ["deadlineMs", "outputTokens"] as const;
type Key = (typeof BUDGET_KEYS)[number];
type Budget = Partial<Record<Key, number>>;

type Policy = {
  id: string;
  scope: "PLATFORM" | "PRICE_PLAN" | "SHOP";
  shopId: string | null;
  merchantPricingPlanId: string | null;
  budgetSchemaVersion: number;
  budget: unknown;
  editVersion: number;
};

function parseBudget(row: Policy): Budget {
  if (row.budgetSchemaVersion !== 1) throw new LiveBudgetPolicyError("UNSUPPORTED_SCHEMA");
  const value = row.budget;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LiveBudgetPolicyError("INVALID_BUDGET");
  const result: Budget = {};
  const keys = Object.keys(value);
  if (keys.some((key) => !BUDGET_KEYS.includes(key as Key)))
    throw new LiveBudgetPolicyError("UNKNOWN_BUDGET_FIELD");
  for (const key of keys) {
    const number = (value as Record<string, unknown>)[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
      throw new LiveBudgetPolicyError("INVALID_BUDGET_VALUE");
    result[key as Key] = number;
  }
  if (row.scope === "PLATFORM" && keys.length !== 2)
    throw new LiveBudgetPolicyError("PLATFORM_BUDGET_INCOMPLETE");
  if (row.scope !== "PLATFORM" && keys.length === 0)
    throw new LiveBudgetPolicyError("EMPTY_OVERRIDE");
  if (!Number.isSafeInteger(row.editVersion) || row.editVersion < 1)
    throw new LiveBudgetPolicyError("INVALID_EDIT_VERSION");
  return result;
}

function single(rows: Policy[], scope: Policy["scope"], owner: string | null): Policy | null {
  const candidates = rows.filter((row) => row.scope === scope &&
    (scope === "PRICE_PLAN" ? row.merchantPricingPlanId === owner :
      scope === "SHOP" ? row.shopId === owner : true));
  if (candidates.length > 1) throw new LiveBudgetPolicyError("DUPLICATE_POLICY");
  return candidates[0] ?? null;
}

/** Repeatable-read ensures a plan switch cannot produce a mixed policy snapshot. */
export async function resolveLiveBudget(input: {
  db: PrismaClient;
  environment: CommerceEnvironment;
  shopId: string;
  conversationId: string;
  recoveryId: string;
  inboundVersion: number;
  now?: () => Date;
}): Promise<ResolvedLiveBudget> {
  const { db, environment, shopId } = input;
  return db.$transaction(async (tx) => {
    const subscription = await tx.subscription.findUnique({
      where: { shopId },
      select: { status: true, planId: true, plan: { select: { shopifyPlanHandle: true } } },
    });
    let planId: string | null = null;
    let handle: string | null = null;
    if (subscription && (subscription.status === "ACTIVE" || subscription.status === "TRIALING")) {
      if (!subscription.planId || !subscription.plan?.shopifyPlanHandle)
        throw new LiveBudgetPolicyError("ACTIVE_PLAN_UNRESOLVED");
      handle = subscription.plan.shopifyPlanHandle;
      const plan = await tx.merchantPricingPlan.findUnique({
        where: { shopifyPlanHandle: handle }, select: { id: true },
      });
      if (!plan) throw new LiveBudgetPolicyError("ACTIVE_PLAN_UNMATCHED");
      planId = plan.id;
    }
    const rows: Policy[] = await tx.commerceModelPolicy.findMany({
      where: {
        environment, context: "LIVE",
        OR: [
          { scope: "PLATFORM" },
          { scope: "SHOP", shopId },
          ...(planId ? [{ scope: "PRICE_PLAN" as const, merchantPricingPlanId: planId }] : []),
        ],
      },
      select: {
        id: true, scope: true, shopId: true, merchantPricingPlanId: true,
        budgetSchemaVersion: true, budget: true, editVersion: true,
      },
    });
    const platform = single(rows, "PLATFORM", null);
    if (!platform) throw new LiveBudgetPolicyError("PLATFORM_DEFAULT_MISSING");
    const pricePlan = planId ? single(rows, "PRICE_PLAN", planId) : null;
    const merchant = single(rows, "SHOP", shopId);
    const base = parseBudget(platform);
    const plan = pricePlan ? parseBudget(pricePlan) : {};
    const shop = merchant ? parseBudget(merchant) : {};
    const deadlineMs = shop.deadlineMs ?? plan.deadlineMs ?? base.deadlineMs!;
    const outputTokens = shop.outputTokens ?? plan.outputTokens ?? base.outputTokens!;
    return {
      shopId, conversationId: input.conversationId, recoveryId: input.recoveryId,
      inboundVersion: input.inboundVersion, environment,
      deadlineMs, outputTokens,
      deadlineSource: shop.deadlineMs !== undefined ? "MERCHANT" : plan.deadlineMs !== undefined ? "PRICE_PLAN" : "PLATFORM",
      outputTokenSource: shop.outputTokens !== undefined ? "MERCHANT" : plan.outputTokens !== undefined ? "PRICE_PLAN" : "PLATFORM",
      merchantPricingPlanId: planId, shopifyPlanHandle: handle,
      policyEditVersions: { platform: platform.editVersion, pricePlan: pricePlan?.editVersion ?? null, merchant: merchant?.editVersion ?? null },
      resolvedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
  }, { isolationLevel: "RepeatableRead" });
}

/** The existing processing lease is 120 s. Reserve 2 s for completion and fencing. */
export const LIVE_TURN_LEASE_MS = 120_000;
export const LIVE_TURN_COMPLETION_RESERVE_MS = 2_000;
export function assertLiveBudgetFitsLease(budget: ResolvedLiveBudget, processingStartedAt: Date, now = Date.now()): void {
  const remaining = LIVE_TURN_LEASE_MS - (now - processingStartedAt.getTime());
  if (!Number.isFinite(remaining) || budget.deadlineMs > remaining - LIVE_TURN_COMPLETION_RESERVE_MS)
    throw new LiveBudgetPolicyError("DEADLINE_EXCEEDS_PROCESSING_LEASE");
}
