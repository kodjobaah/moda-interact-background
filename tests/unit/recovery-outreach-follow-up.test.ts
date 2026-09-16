import { describe, expect, it, vi } from "vitest";
import { createRecoveryOutreachFollowUpJobId } from "../../src/domain/recovery-outreach-follow-up.js";
import { RecoveryOutreachAttemptService } from "../../src/services/recovery-outreach-attempt.service.js";
import { safeParseEffectiveRecoveryPolicy } from "@modainteract/moda-interact-shared/recovery-policy";

describe("recovery outreach follow-up", () => {
  it("uses the exact deterministic sequence-two job identity", () => {
    expect(createRecoveryOutreachFollowUpJobId({ checkoutRecoveryId: "recovery-1", sequence: 2 }))
      .toBe("recovery-outreach-follow-up:recovery-1:2");
  });

  it("rejects an invalid fixed policy and accepts a disabled follow-up snapshot", () => {
    expect(safeParseEffectiveRecoveryPolicy({
      recoveryDelayMinutes: 30,
      recoveryOfferMode: "FIXED",
      fixedShopifyDiscountId: null,
      followUpEnabled: false,
      followUpDelayMinutes: null,
      source: "MERCHANT",
    }).success).toBe(false);
    expect(safeParseEffectiveRecoveryPolicy({
      recoveryDelayMinutes: 30,
      recoveryOfferMode: "NONE",
      fixedShopifyDiscountId: null,
      followUpEnabled: false,
      followUpDelayMinutes: null,
      source: "MERCHANT",
    }).success).toBe(true);
  });

  it("reuses the durable attempt identity and marks engagement", async () => {
    const attempt = { id: "attempt-1", status: "WAITING_FOR_RESPONSE", sequence: 1, sentAt: new Date("2026-09-16T10:00:00Z"), customerRespondedAt: null };
    const database = {
      recoveryOutreachAttempt: {
        upsert: vi.fn(async () => attempt),
        findFirst: vi.fn(async () => attempt),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => attempt),
      },
      conversation: { findUnique: vi.fn(async () => ({ checkoutRecoveryId: "recovery-1" })) },
    } as any;
    const service = new RecoveryOutreachAttemptService(database);
    const policy = {
      recoveryDelayMinutes: 30,
      recoveryOfferMode: "NONE" as const,
      fixedShopifyDiscountId: null,
      followUpEnabled: true,
      followUpDelayMinutes: 60,
      source: "MERCHANT" as const,
      offerSnapshot: null,
    };
    await expect(service.getOrCreateFollowUp({
      recoveryId: "recovery-1",
      initialAttempt: {
        configuredOfferMode: "FIXED",
        fixedShopifyDiscountId: "discount-1",
        offerSnapshot: { id: "discount-1", title: "Saved offer" },
      },
    })).resolves.toEqual(attempt);
    expect(database.recoveryOutreachAttempt.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        configuredOfferMode: "FIXED",
        fixedShopifyDiscountId: "discount-1",
        offerSnapshot: { id: "discount-1", title: "Saved offer" },
      }),
    }));
    await service.getOrCreate({ recoveryId: "recovery-1", sequence: 1, policy });
    await service.getOrCreate({ recoveryId: "recovery-1", sequence: 1, policy });
    expect(database.recoveryOutreachAttempt.upsert).toHaveBeenCalledTimes(3);
    await service.markEngagedForConversation("conversation-1", new Date("2026-09-16T10:01:00Z"));
    expect(database.recoveryOutreachAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "attempt-1", status: "WAITING_FOR_RESPONSE" },
    }));
    });
});