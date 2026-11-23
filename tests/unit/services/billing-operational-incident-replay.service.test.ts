import { describe, expect, it, vi } from "vitest";
import { ShopPlatform, SubscriptionProjectionStatus } from "@prisma/client";

import { BillingOperationalIncidentReplayService } from "../../../src/services/billing-operational-incident-replay.service.js";
import { billingIncidentReason } from "../../../src/services/billing-operational-incident.service.js";

function record(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, shopId: `shop-${id}`, status: SubscriptionProjectionStatus.UNMAPPED,
    observedShopifyPlanHandle: "growth", billingPeriodId: null,
    lastSyncErrorCode: null, lastSyncErrorAt: null, lastSyncedAt: new Date("2026-11-23T01:00:00Z"),
    ...overrides,
  };
}

describe("bounded Shopify billing incident replay", () => {
  it("retries persisted incidents with no nextReconcileAt without new queue jobs", async () => {
    const rows = [record("a"), record("b", {status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT"})];
    const database = {subscription: {findMany: vi.fn().mockImplementation(({where}) => Promise.resolve(
      rows.filter(row => !where.id?.gt || row.id > where.id.gt),
    ))}};
    const sink = {report: vi.fn().mockRejectedValueOnce(new Error("incident database temporarily unavailable")).mockResolvedValue(undefined)};
    const logger = {error: vi.fn()};
    const service = new BillingOperationalIncidentReplayService(database as never, sink, logger as never);
    expect(await service.replayOnce()).toBe(2);
    expect(sink.report).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith("billing.operational_incident.replay_failed", expect.objectContaining({subscriptionId: "a"}));
    expect(await service.replayOnce()).toBe(2); // wraps and retries the first failure
    expect(sink.report).toHaveBeenCalledTimes(4);
    expect(database.subscription.findMany.mock.calls[0]![0].where).toMatchObject({
      shop: {is: {platform: ShopPlatform.SHOPIFY}},
      OR: expect.any(Array),
    });
  });

  it("paginates large incident backlogs fairly without unbounded queries", async () => {
    const rows = Array.from({length: 55}, (_, i) => record(String(i).padStart(3,"0")));
    const database = { subscription: {findMany: vi.fn().mockImplementation(({where, take}) =>
      Promise.resolve(rows.filter(row => !where.id?.gt || row.id > where.id.gt).slice(0,take)),
    )}};
    const sink = {report: vi.fn().mockResolvedValue(undefined)};
    const service = new BillingOperationalIncidentReplayService(database as never, sink, {error: vi.fn()} as never);
    expect(await service.replayOnce()).toBe(50);
    expect(await service.replayOnce()).toBe(5);
    expect(await service.replayOnce()).toBe(50);
    expect(sink.report).toHaveBeenCalledTimes(105);
  });

  it("distinguishes an existing inactive plan from a missing Shopify plan", () => {
    expect(billingIncidentReason(record("a"))).toBe("UNMAPPED_PLAN_HANDLE");
    expect(billingIncidentReason(record("b", {lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE"}))).toBe("INACTIVE_SHOPIFY_PLAN_HANDLE");
    expect(billingIncidentReason(record("c", {status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE"}))).toBe("INACTIVE_SHOPIFY_PLAN_HANDLE");
  });
});
