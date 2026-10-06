import { describe, expect, it } from "vitest";

import {
  PostContractRecoveryPolicyError,
  PostContractRecoveryPolicyResolver,
} from "../../../src/services/post-contract-recovery-policy.service.js";

const now = new Date("2026-10-06T09:00:00.000Z");

function client({
  onboardingCompleted = true,
  lifecycle = "CANCELED",
  status = "NO_CONTRACT",
  shopStatus = "ACTIVE",
  override = null,
}: {
  onboardingCompleted?: boolean;
  lifecycle?: string | null;
  status?: string;
  shopStatus?: string;
  override?: Record<string, unknown> | null;
} = {}) {
  return {
    subscription: {
      findUnique: async () => ({
        id: "subscription-1",
        status,
        lastProviderLifecycleState: lifecycle,
        shop: {
          status: shopStatus,
          onboardingCompleted,
        },
      }),
    },
    platformBillingPolicy: {
      findUnique: async () => ({
        id: "default",
        defaultOutboundSoftLimit: 10,
        defaultOutboundHardLimit: 20,
        absoluteOutboundHardLimit: 15,
        terminalMessageReservedSlots: 1,
        globalPauseNewRecoveries: false,
        globalPauseAutomatedWhatsapp: false,
      }),
    },
    shopBillingPolicyOverride: {
      findUnique: async () => override,
    },
  } as never;
}

describe("PostContractRecoveryPolicyResolver", () => {
  it("resolves recovery-only policy for an onboarded merchant whose Shopify contract ended", async () => {
    const policy = await new PostContractRecoveryPolicyResolver(client()).resolve(
      "shop-1",
      now,
    );

    expect(policy).toMatchObject({
      mode: "POST_CONTRACT_DURABLE_CREDITS",
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      subscriptionStatus: "NO_CONTRACT",
      newRecoveriesPaused: false,
      automatedWhatsappPaused: false,
      outboundSoftLimit: 10,
      outboundHardLimit: 15,
      terminalMessageReservedSlots: 1,
      billingPeriod: null,
    });
  });

  it("keeps a never-subscribed onboarded merchant contract-required", async () => {
    await expect(
      new PostContractRecoveryPolicyResolver(
        client({ lifecycle: null }),
      ).resolve("shop-1", now),
    ).rejects.toMatchObject<Partial<PostContractRecoveryPolicyError>>({
      reason: "CONTRACT_REQUIRED",
    });
  });

  it("does not treat a canceled lifecycle marker as post-contract before onboarding completed", async () => {
    await expect(
      new PostContractRecoveryPolicyResolver(
        client({ onboardingCompleted: false }),
      ).resolve("shop-1", now),
    ).rejects.toMatchObject<Partial<PostContractRecoveryPolicyError>>({
      reason: "CONTRACT_REQUIRED",
    });
  });

  it("does not override an active subscription merely because the last lifecycle marker was canceled", async () => {
    await expect(
      new PostContractRecoveryPolicyResolver(
        client({ status: "ACTIVE" }),
      ).resolve("shop-1", now),
    ).rejects.toMatchObject<Partial<PostContractRecoveryPolicyError>>({
      reason: "CONTRACT_REQUIRED",
    });
  });

  it("honours platform and active shop pause controls after contract end", async () => {
    const policy = await new PostContractRecoveryPolicyResolver(
      client({
        override: {
          outboundSoftLimit: 7,
          outboundHardLimit: 8,
          terminalMessageReservedSlots: 2,
          pauseNewRecoveries: true,
          pauseAutomatedWhatsapp: true,
          expiresAt: null,
        },
      }),
    ).resolve("shop-1", now);

    expect(policy).toMatchObject({
      newRecoveriesPaused: true,
      automatedWhatsappPaused: true,
      outboundSoftLimit: 7,
      outboundHardLimit: 8,
      terminalMessageReservedSlots: 2,
    });
  });
});
