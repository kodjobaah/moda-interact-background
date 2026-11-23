import { createHash } from "node:crypto";

import { SubscriptionProjectionStatus } from "@prisma/client";
import {
  createOperationalIncidentReporter,
  createPrismaOperationalIncidentPersistence,
  OPERATIONAL_INCIDENT_CONTRACT_VERSION,
} from "@modainteract/moda-interact-shared/incidents";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

// Keep the remedy attached to the incident, not in an inaccessible worker log.
// These are investigation/repair instructions, never permission to reset credits.
const remedies: Record<string, string> = {
  UNMAPPED_PLAN_HANDLE: "In Admin Billing > Unmapped, register the exact Shopify plan handle and configure its pricing, then reconcile the subscription.",
  INACTIVE_SHOPIFY_PLAN_HANDLE: "The exact Shopify plan handle already exists locally but is inactive. Inspect the existing Merchant Pricing Plan and operational plan, correct or activate the approved configuration, then reconcile. Do not register a duplicate handle.",
  INVALID_INCLUDED_ALLOWANCE: "Inspect the configured plan allowance; correct the catalogue/operational plan, then rerun billing reconciliation.",
  MISSING_BILLING_CYCLE: "Check Shopify's current billing-cycle dates and subscription identity; reconcile after the provider returns a valid cycle.",
  MISSING_USAGE_METER: "If credit packs are enabled, configure the dedicated credit-pack Shopify usage meter and verify it on the active subscription.",
  UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT: "Compare the Shopify cycle with the current billing period and included-credit ledger. Repair only from verified records, then retry reconciliation.",
  UNFREEZE_LIFETIME_FREE_COUNTER_HISTORY_CONFLICT: "Audit historical Free usage and the lifetime counter. Reconstruct from verified ledger evidence; never reset lifetime credits.",
  UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED: "Inspect outstanding Shopify usage reports, retry delivery, verify provider acknowledgements and only then reconcile.",
  BILLING_PERIOD_PLAN_CONFLICT: "Reconcile the stored billing period and credit counter against Shopify and the credit ledger; do not grant replacement credits.",
  LIFETIME_FREE_COUNTER_HISTORY_CONFLICT: "Audit Free credit history and the lifetime counter; use verified ledger evidence for any repair.",
  PRE_CLOSE_USAGE_FLUSH_FAILED: "Check undelivered Shopify usage reports and provider acknowledgements before retrying the cycle transition.",
};

export type BillingIncidentProjection = {
  id: string;
  status: SubscriptionProjectionStatus;
  observedShopifyPlanHandle: string | null;
  billingPeriodId: string | null;
  lastSyncErrorCode: string | null;
  lastSyncErrorAt: Date | null;
  lastSyncedAt: Date | null;
};

export type BillingIncidentSink = {
  report(shopId: string, subscription: BillingIncidentProjection): Promise<void>;
};

type IncidentReporter = Pick<ReturnType<typeof createOperationalIncidentReporter>, "report">;

export const nonActionableBillingErrorCodes = [
  "PARTNER_API_ERROR", "PROVIDER_STATE_UNRESOLVED", "UNFROZEN_LIVE_CONTRACT_PENDING", "PROVIDER_CYCLE_LAG",
] as const;

function occurrenceId(subscription: BillingIncidentProjection, code: string): string {
  // Identical retries of the same persisted error produce one occurrence.
  const source = (code === "UNMAPPED_PLAN_HANDLE" || code === "INACTIVE_SHOPIFY_PLAN_HANDLE")
    ? `${subscription.id}:${code}:${subscription.observedShopifyPlanHandle ?? "missing"}`
    : `${subscription.id}:${code}:${subscription.lastSyncErrorAt?.toISOString() ?? "unspecified"}`;
  const hex = createHash("sha256").update(source).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Report persisted actionable errors regardless of projection status; ignore transient retries. */
export function billingIncidentReason(subscription: BillingIncidentProjection): string | null {
  // Projection writers persist UNMAPPED_PLAN_HANDLE only when an existing
  // operational plan is inactive. A genuinely missing plan has no sync code.
  if (subscription.status === SubscriptionProjectionStatus.UNMAPPED) {
    return subscription.lastSyncErrorCode === "UNMAPPED_PLAN_HANDLE"
      ? "INACTIVE_SHOPIFY_PLAN_HANDLE"
      : "UNMAPPED_PLAN_HANDLE";
  }
  // A cycle or activation failure can be recorded while the subscription is
  // ACTIVE/TRIALING or NO_CONTRACT. The persisted error, not status alone,
  // determines whether an administrator needs to investigate.
  const code = subscription.lastSyncErrorCode;
  if (!code || (nonActionableBillingErrorCodes as readonly string[]).includes(code)) return null;
  return code === "UNMAPPED_PLAN_HANDLE" ? "INACTIVE_SHOPIFY_PLAN_HANDLE" : code;
}

export function createBillingIncidentSink(
  reporter: IncidentReporter = createOperationalIncidentReporter({
    persistence: createPrismaOperationalIncidentPersistence({ prisma }),
    logger: createLogger({ serviceName: "moda-billing-worker", environment: resolveDeploymentEnvironmentName() }),
  }),
  logger: StructuredLogger = createLogger({ serviceName: "moda-billing-worker", environment: resolveDeploymentEnvironmentName() }),
  environment = resolveDeploymentEnvironmentName(),
): BillingIncidentSink {
  return {
    async report(shopId, subscription) {
      const reasonCode = billingIncidentReason(subscription);
      if (!reasonCode) return;
      try {
        // Incident preparation is best effort too: malformed evidence must
        // not turn a committed reconciliation into a new billing failure.
        // The original provider/SDK error remains in the structured server log.
        const guidance = remedies[reasonCode]
          ?? "Inspect the subscription, Shopify provider response and billing ledger. Repair the verified cause before retrying reconciliation.";
        // A plan handle is a Shopify identifier, not a provider exception body.
        // Quote/bound it so an administrator can register the exact handle.
        const planHandle = typeof subscription.observedShopifyPlanHandle === "string"
          ? JSON.stringify(subscription.observedShopifyPlanHandle.slice(0, 128))
          : "not observed";
        const errorMessage = `Subscription ${subscription.id}; Shopify plan ${planHandle}; period ${subscription.billingPeriodId ?? "none"}. ${guidance}`.slice(0, 512);
        const result = await reporter.report({
          contractVersion: OPERATIONAL_INCIDENT_CONTRACT_VERSION,
          sourceService: "moda-billing-worker",
          environment,
          category: "SHOPIFY_SUBSCRIPTION_BILLING",
          reasonCode,
          resourceKey: subscription.id,
          shopId,
          severity: reasonCode === "UNMAPPED_PLAN_HANDLE" || reasonCode === "INACTIVE_SHOPIFY_PLAN_HANDLE" ? "MEDIUM" : "HIGH",
          occurrenceId: occurrenceId(subscription, reasonCode),
          correlationId: subscription.id,
          occurredAt: (subscription.lastSyncErrorAt ?? subscription.lastSyncedAt ?? new Date()).toISOString(),
          errorMessage,
        });
        if (!result) logger.error("billing.operational_incident.not_recorded", { shopId, subscriptionId: subscription.id, reasonCode });
      } catch (error) {
        // Subscription state has already committed: never roll it back because
        // Incident persistence failed after billing committed. The periodic
        // bounded incident replay also covers rows with no scheduled retry.
        logger.error("billing.operational_incident.report_failed", {
          shopId, subscriptionId: subscription.id, reasonCode,
          errorMessage: error instanceof Error ? error.message : String(error),
          error,
        });
      }
    },
  };
}

export const billingIncidentProjectionSelect = {
  id: true, status: true, observedShopifyPlanHandle: true,
  billingPeriodId: true, lastSyncErrorCode: true,
  lastSyncErrorAt: true, lastSyncedAt: true,
} as const;

/** Read only committed state after a known failure, never inside its transaction. */
export async function reportCommittedBillingFailure(
  database: Pick<import("@prisma/client").PrismaClient, "subscription">,
  sink: BillingIncidentSink,
  shopId: string,
  subscriptionId: string,
): Promise<void> {
  const committed = await database.subscription.findUnique({
    where: { id: subscriptionId }, select: billingIncidentProjectionSelect,
  });
  if (committed) await sink.report(shopId, committed);
}

export const billingOperationalIncidentSink = createBillingIncidentSink();
