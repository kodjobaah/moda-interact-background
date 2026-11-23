import { describe, expect, it, vi } from "vitest";
import { SubscriptionProjectionStatus } from "@prisma/client";

import {
  billingIncidentReason,
  createBillingIncidentSink,
  type BillingIncidentProjection,
} from "../../../src/services/billing-operational-incident.service.js";

const when = new Date("2026-11-22T12:00:00.000Z");

function projection(overrides: Partial<BillingIncidentProjection> = {}): BillingIncidentProjection {
  return {
    id: "subscription-1",
    status: SubscriptionProjectionStatus.SYNC_ERROR,
    observedShopifyPlanHandle: "growth",
    billingPeriodId: "period-1",
    lastSyncErrorCode: "UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED",
    lastSyncErrorAt: when,
    lastSyncedAt: when,
    ...overrides,
  };
}

function harness() {
  const reporter = { report: vi.fn().mockResolvedValue({ id: "incident-1" }) };
  const logger = { error: vi.fn() };
  const sink = createBillingIncidentSink(reporter as never, logger as never, "test");
  return { reporter, logger, sink };
}

describe("Shopify billing operational incidents", () => {
  it("publishes an actionable, deduplicated incident for a committed unfreeze accounting error", async () => {
    const { reporter, sink } = harness();
    await sink.report("shop-1", projection());
    await sink.report("shop-1", projection());
    const first = reporter.report.mock.calls[0]![0];
    const replay = reporter.report.mock.calls[1]![0];
    expect(first).toMatchObject({
      contractVersion: "operational-incident.v1",
      sourceService: "moda-billing-worker",
      category: "SHOPIFY_SUBSCRIPTION_BILLING",
      reasonCode: "UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED",
      resourceKey: "subscription-1",
      shopId: "shop-1", severity: "HIGH", correlationId: "subscription-1",
    });
    expect(first.errorMessage).toContain("verify provider acknowledgements");
    expect(first.errorMessage).toContain('Shopify plan "growth"');
    expect(first.occurrenceId).toBe(replay.occurrenceId);
    expect(first.errorMessage).not.toContain("Bearer ");
  });

  it("gives an unmapped plan an Admin configuration route even without an error code", async () => {
    const { reporter, sink } = harness();
    await sink.report("shop-1", projection({
      status: SubscriptionProjectionStatus.UNMAPPED,
      lastSyncErrorCode: null,
      lastSyncErrorAt: null,
    }));
    expect(reporter.report).toHaveBeenCalledOnce();
    expect(reporter.report.mock.calls[0]![0]).toMatchObject({
      reasonCode: "UNMAPPED_PLAN_HANDLE", severity: "MEDIUM",
    });
    expect(reporter.report.mock.calls[0]![0].errorMessage).toContain("Admin Billing > Unmapped");
    expect(reporter.report.mock.calls[0]![0].errorMessage).toContain('Shopify plan "growth"');
  });

  it("shows inactive-plan repair instructions without suggesting duplicate registration", async () => {
    const { reporter, sink } = harness();
    const inactive = projection({status: SubscriptionProjectionStatus.UNMAPPED, lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE"});
    await sink.report("shop-1", inactive);
    await sink.report("shop-1", {...inactive, lastSyncedAt: new Date("2026-11-23T12:00:00Z")});
    expect(reporter.report).toHaveBeenCalledTimes(2);
    const [first, replay] = reporter.report.mock.calls.map(([event]) => event);
    expect(first.reasonCode).toBe("INACTIVE_SHOPIFY_PLAN_HANDLE");
    expect(first.errorMessage).toContain("already exists locally but is inactive");
    expect(first.errorMessage).toContain("Do not register a duplicate handle");
    expect(first.occurrenceId).toBe(replay.occurrenceId);
  });

  it("does not open incidents for valid subscriptions or a transient provider retry", async () => {
    const { reporter, sink } = harness();
    await sink.report("shop-1", projection({ status: SubscriptionProjectionStatus.ACTIVE, lastSyncErrorCode: null }));
    await sink.report("shop-1", projection({ lastSyncErrorCode: "PARTNER_API_ERROR" }));
    await sink.report("shop-1", projection({ status: SubscriptionProjectionStatus.FROZEN, lastSyncErrorCode: null }));
    expect(reporter.report).not.toHaveBeenCalled();
    expect(billingIncidentReason(projection({ status: SubscriptionProjectionStatus.ACTIVE, lastSyncErrorCode: null }))).toBeNull();
  });

  it("keeps one unmapped occurrence across ordinary polling but changes identity for a different Shopify handle", async () => {
    const { reporter, sink } = harness();
    const unmapped = projection({
      status: SubscriptionProjectionStatus.UNMAPPED,
      lastSyncErrorCode: null, lastSyncErrorAt: null,
    });
    await sink.report("shop-1", unmapped);
    await sink.report("shop-1", { ...unmapped, lastSyncedAt: new Date("2026-11-23T12:00:00Z") });
    await sink.report("shop-1", { ...unmapped, observedShopifyPlanHandle: "growth-v2" });
    const [first, same, changed] = reporter.report.mock.calls.map(([event]) => event);
    expect(first.occurrenceId).toBe(same.occurrenceId);
    expect(changed.occurrenceId).not.toBe(first.occurrenceId);
  });

  it("reports persisted billing-cycle errors even when the subscription is still ACTIVE", async () => {
    const { reporter, sink } = harness();
    await sink.report("shop-1", projection({
      status: SubscriptionProjectionStatus.ACTIVE,
      lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED",
    }));
    expect(reporter.report).toHaveBeenCalledOnce();
    expect(reporter.report.mock.calls[0]![0].reasonCode).toBe("PRE_CLOSE_USAGE_FLUSH_FAILED");
  });

  it("prepares a useful incident when a partial subscription projection omits the plan handle", async () => {
    const { reporter, sink } = harness();
    await expect(sink.report("shop-1", {
      ...projection(), observedShopifyPlanHandle: undefined,
    } as unknown as BillingIncidentProjection)).resolves.toBeUndefined();
    expect(reporter.report).toHaveBeenCalledOnce();
    expect(reporter.report.mock.calls[0]![0].errorMessage).toContain("Shopify plan not observed");
  });

  it("logs incident persistence failures without changing committed subscription state", async () => {
    const { reporter, logger, sink } = harness();
    const error = new Error("Postgres unavailable");
    reporter.report.mockRejectedValueOnce(error);
    await expect(sink.report("shop-1", projection())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("billing.operational_incident.report_failed", expect.objectContaining({
      shopId: "shop-1", subscriptionId: "subscription-1",
      reasonCode: "UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED", errorMessage: "Postgres unavailable", error,
    }));
  });
});
