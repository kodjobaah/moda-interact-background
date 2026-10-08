import { expect, it } from "vitest";
import type { CandidateFacadeContext } from "../pending-recovery-candidate.service.test.js";

/** Coordinator-level coverage; collaborator branch detail lives in the focused suites. */
export function registerActivityCases(context: CandidateFacadeContext) {
  const { queueInstance, domainModule, serviceModule, recoveryPolicyMocks, redisZsets } = context;

  it("merges newer non-null context dimensions without erasing others", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_context_merge",
      cartToken: "cart_context_merge",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-10-06T00:00:00Z",
      internationalContext: {
        languageTag: "en-GB",
        languageSource: "shopify",
        countryCode: "GB",
        currencyCode: "GBP",
        timeZone: "Europe/London",
      },
    });

    await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: "checkout_context_merge",
      cartToken: "cart_context_merge",
      activityAt: "2026-11-06T00:01:00Z",
      isEmpty: false,
      internationalContext: {
        languageTag: "fr-FR",
        languageSource: "shopify",
        countryCode: null,
        currencyCode: "EUR",
        timeZone: null,
      },
    });

    expect(queueInstance.jobs.get(result.jobId)?.updatedData?.internationalContext).toEqual({
      languageTag: "fr-FR",
      languageSource: "shopify",
      countryCode: "GB",
      currencyCode: "EUR",
      timeZone: "Europe/London",
    });
  });

  it("reschedules from newer activity and leaves older activity stale", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_activity",
      cartToken: "cart_activity",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      activityAt: "2026-08-28T00:00:00.000Z",

    });
    const job = queueInstance.jobs.get(result.jobId)!;
    const refreshed = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: null,
      cartToken: "cart_activity",
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
    });

    expect(refreshed.outcome).toBe("rescheduled");
    expect(job.updatedData?.lastActivityAt).toBe("2026-08-28T01:00:00.000Z");
    expect(job.delayChanges.at(-1)).toBe(0);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.get(result.jobId)).toBe(
      Date.parse("2026-08-28T01:45:00.000Z"),
    );

    const stale = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: "checkout_activity",
      cartToken: null,
      activityAt: "2026-08-28T00:30:00.000Z",
      isEmpty: null,
    });
    expect(stale).toMatchObject({ outcome: "stale", jobId: result.jobId });
    expect(job.delayChanges).toHaveLength(1);
  });

  it("re-resolves the effective recovery-policy delay for activity rescheduling", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_policy_refresh",
      cartToken: "cart_policy_refresh",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T00:00:00.000Z",
    });
    recoveryPolicyMocks.resolve.mockResolvedValueOnce({
      recoveryDelayMinutes: 120,
      recoveryOfferMode: "NONE",
      fixedShopifyDiscountId: null,
      followUpEnabled: false,
      followUpDelayMinutes: null,
      source: "ADMIN_OVERRIDE",
      offerSnapshot: null,
    });

    const refreshed = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: "checkout_policy_refresh",
      cartToken: null,
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
    });

    expect(refreshed.outcome).toBe("rescheduled");
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.get(result.jobId)).toBe(
      Date.parse("2026-08-28T01:00:00.000Z") + 120 * 60 * 1000,
    );
    expect(recoveryPolicyMocks.resolve).toHaveBeenLastCalledWith("shop_1");
  });

  it("cancels a matched cart candidate and removes every alias", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_empty",
      cartToken: "cart_empty",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T00:00:00.000Z",

    });

    const cancelled = await serviceModule.pendingRecoveryCandidateService.refreshCandidateActivity({
      shopId: "shop_1",
      checkoutToken: null,
      cartToken: "cart_empty",
      activityAt: "2026-08-28T00:01:00.000Z",
      isEmpty: true,
    });

    expect(cancelled).toEqual({ outcome: "cancelled", jobId: result.jobId });
    expect(queueInstance.jobs.get(result.jobId)?.removed).toBe(true);
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout({
      shopId: "shop_1",
      checkoutToken: "checkout_empty",
    })).toBeNull();
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart({
      shopId: "shop_1",
      cartToken: "cart_empty",
    })).toBeNull();
  });
}
