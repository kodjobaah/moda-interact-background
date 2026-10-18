/** Database-only final-send eligibility, evaluated while BG001 holds the Shop and
 * Conversation locks. The normal provider/entitlement admission still happens
 * outside this short transaction; this check closes the suspension/takeover gap.
 */
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import { first } from "./recovery-conversation.sql.js";
import type { DurableEligibility } from "./outbound-send-fence.service.js";

export const recoveryRuntimeEligibility: DurableEligibility = async (tx, input, context) => {
  const current = await first<{
    status: "ACTIVE" | "SUSPENDED" | "UNINSTALLED";
    platform: "SHOPIFY" | "WOOCOMMERCE";
    onboardingCompleted: boolean;
    subscriptionStatus: string | null;
    lifecycle: string | null;
  }>(tx, `
    SELECT s."status"::text AS "status", s."platform"::text AS "platform",
      s."onboardingCompleted", b."status"::text AS "subscriptionStatus",
      b."lastProviderLifecycleState"::text AS "lifecycle"
    FROM "commerce"."Shop" s LEFT JOIN "billing"."Subscription" b ON b."shopId"=s."id"
    WHERE s."id"=$1`, context.shopId);
  if (!current || !current.subscriptionStatus) return "shop-unavailable";
  const execution = shopExecutionEligibilityService.evaluateResolvedShop({
    id: context.shopId,
    status: current.status,
    platform: current.platform,
    onboardingCompleted: current.onboardingCompleted,
    subscription: {
      status: current.subscriptionStatus,
      lastProviderLifecycleState: current.lifecycle,
    },
  }, "recovery");
  if (!execution.allowed) return execution.reason.toLowerCase().replaceAll("_", "-");
  if (input.senderType !== "HUMAN") {
    const recorded = await first<{ id: string }>(tx, `
      SELECT "id" FROM "billing"."UsageEvent"
      WHERE "sourceId"=$1 AND "shopId"=$2 AND "metric"='OUTBOUND_AUTOMATED_MESSAGE'
      LIMIT 1`, input.messageId, context.shopId);
    if (!recorded) return "automated-quota-not-reserved";
  }
  // HUMAN sends do not enter the automated-message usage ledger; the dispatcher
  // explicitly admits recovery credit for templates before calling this fence.
  return null;
};
