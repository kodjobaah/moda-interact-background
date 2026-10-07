import { describe, expect, it, vi } from "vitest";

import { EffectiveBillingPolicyError } from "../../../../src/services/effective-billing-policy.service.js";
import { PostContractRecoveryPolicyError } from "../../../../src/services/post-contract-recovery-policy.service.js";
import { OutboundAdmissionPolicyService } from "../../../../src/services/outbound-whatsapp-admission/outbound-admission-policy.service.js";

const input = {
  shopId: "shop-1",
  conversationId: "conversation-1",
  idempotencyKey: "outbound-1",
  senderType: "AGENT" as const,
};

function harness({
  effective = {},
  postContract = {},
  durableReservation = null,
}: {
  effective?: Record<string, unknown>;
  postContract?: Record<string, unknown>;
  durableReservation?: Record<string, unknown> | null;
} = {}) {
  const effectiveResolver = {
    resolve: vi.fn().mockResolvedValue({
      shopId: "shop-1",
      outboundHardLimit: 3,
      terminalMessageReservedSlots: 1,
      automatedWhatsappPaused: false,
      billingPeriod: null,
      ...effective,
    }),
  };
  const postContractResolver = {
    resolve: vi.fn().mockResolvedValue({
      mode: "POST_CONTRACT_DURABLE_CREDITS",
      shopId: "shop-1",
      automatedWhatsappPaused: false,
      outboundHardLimit: 3,
      terminalMessageReservedSlots: 1,
      billingPeriod: null,
      ...postContract,
    }),
  };
  const transaction = {
    usageReservation: {
      findUnique: vi.fn().mockResolvedValue(durableReservation),
    },
  };
  return {
    effectiveResolver,
    postContractResolver,
    transaction,
    service: new OutboundAdmissionPolicyService(
      () => effectiveResolver,
      () => postContractResolver,
    ),
  };
}

const genericConversation = {
  shopId: "shop-1",
  checkoutRecovery: null,
};

const recoveryConversation = (status: "DETECTED" | "MESSAGE_SENT" | "ENGAGED") => ({
  shopId: null,
  checkoutRecovery: { shopId: "shop-1", status },
});

describe("OutboundAdmissionPolicyService", () => {
  it("resolves the effective billing policy for normal outbound work", async () => {
    const test = harness();

    await expect(
      test.service.resolve(test.transaction as never, input, genericConversation as never),
    ).resolves.toMatchObject({
      kind: "resolved",
      executionScope: "general",
      policy: { shopId: "shop-1" },
    });
    expect(test.postContractResolver.resolve).not.toHaveBeenCalled();
  });

  it("maps a frozen subscription to subscription-frozen", async () => {
    const test = harness();
    test.effectiveResolver.resolve.mockRejectedValue(
      new EffectiveBillingPolicyError("SUBSCRIPTION_FROZEN", "frozen"),
    );

    await expect(
      test.service.resolve(test.transaction as never, input, genericConversation as never),
    ).resolves.toEqual({ kind: "suppressed", reason: "subscription-frozen" });
  });

  it("blocks generic NO_CONTRACT outbound work", async () => {
    const test = harness();
    test.effectiveResolver.resolve.mockRejectedValue(
      new EffectiveBillingPolicyError("NO_CONTRACT", "ended"),
    );

    await expect(
      test.service.resolve(test.transaction as never, input, genericConversation as never),
    ).resolves.toEqual({ kind: "suppressed", reason: "contract-required" });
    expect(test.postContractResolver.resolve).not.toHaveBeenCalled();
  });

  it.each(["MESSAGE_SENT", "ENGAGED"] as const)(
    "allows continuing recovery %s through post-contract policy",
    async (status) => {
      const test = harness();
      test.effectiveResolver.resolve.mockRejectedValue(
        new EffectiveBillingPolicyError("NO_CONTRACT", "ended"),
      );

      await expect(
        test.service.resolve(
          test.transaction as never,
          input,
          recoveryConversation(status) as never,
        ),
      ).resolves.toMatchObject({
        kind: "resolved",
        executionScope: "recovery",
      });
      expect(test.postContractResolver.resolve).toHaveBeenCalledWith("shop-1");
    },
  );

  it.each(["PURCHASED_RECOVERY_CREDITS", "LIFETIME_FREE_RECOVERY_CREDITS"])(
    "allows an unstarted recovery when durable %s capacity is reserved",
    async (counter) => {
      const test = harness({
        durableReservation: {
          shopId: "shop-1",
          status: "RESERVED",
          counter: { counter },
        },
      });
      test.effectiveResolver.resolve.mockRejectedValue(
        new EffectiveBillingPolicyError("NO_CONTRACT", "ended"),
      );

      await expect(
        test.service.resolve(
          test.transaction as never,
          { ...input, recoveryCreditSourceKey: "recovery:shop-1:1" },
          recoveryConversation("DETECTED") as never,
        ),
      ).resolves.toMatchObject({ kind: "resolved", executionScope: "recovery" });
    },
  );

  it("does not treat non-durable or wrong-shop reservations as post-contract authority", async () => {
    const test = harness({
      durableReservation: {
        shopId: "shop-other",
        status: "RESERVED",
        counter: { counter: "PURCHASED_RECOVERY_CREDITS" },
      },
    });
    test.effectiveResolver.resolve.mockRejectedValue(
      new EffectiveBillingPolicyError("NO_CONTRACT", "ended"),
    );

    await expect(
      test.service.resolve(
        test.transaction as never,
        { ...input, recoveryCreditSourceKey: "recovery:shop-1:1" },
        recoveryConversation("DETECTED") as never,
      ),
    ).resolves.toEqual({ kind: "suppressed", reason: "contract-required" });
  });

  it.each(["CONTRACT_REQUIRED", "SHOP_UNAVAILABLE"] as const)(
    "maps post-contract resolver %s to contract-required",
    async (reason) => {
      const test = harness();
      test.effectiveResolver.resolve.mockRejectedValue(
        new EffectiveBillingPolicyError("NO_CONTRACT", "ended"),
      );
      test.postContractResolver.resolve.mockRejectedValue(
        new PostContractRecoveryPolicyError(reason, "unavailable"),
      );

      await expect(
        test.service.resolve(
          test.transaction as never,
          input,
          recoveryConversation("ENGAGED") as never,
        ),
      ).resolves.toEqual({ kind: "suppressed", reason: "contract-required" });
    },
  );
});
