import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireModerationOperation: vi.fn() }));
vi.mock("../../../../src/services/platform-configuration/consumers.js", () => ({
  platformConsumerConfiguration: { requireModerationOperation: mocks.requireModerationOperation },
}));
import type { PrismaClient } from "@prisma/client";
import { PostgresModerationAssessmentService } from
  "../../../../src/services/conversation-moderation/moderation-assessment.service.js";
import { readModerationOperation, type ModerationOperation } from
  "../../../../src/services/conversation-moderation/moderation-operation.js";

const config = (modelId: string): ModerationOperation => ({
  moderation: { key: "omini.moderation", version: 1, value: { baseUrl: null, modelId } },
  openAiApiKey: "test-sealed-key", providerVersion: 1,
});

describe("ARCH-040 moderation ARCH-043 configuration admission", () => {
  it("consumes one purpose-scoped B001 reader instead of OPENAI_API_KEY or model env", async () => {
    const operation = config("test-moderation-model");
    mocks.requireModerationOperation.mockResolvedValueOnce(operation);
    await expect(readModerationOperation()).resolves.toBe(operation);
    expect(mocks.requireModerationOperation).toHaveBeenCalledTimes(1);
  });
  it("fails closed without a readable operation before any assessment write or model request", async () => {
    const moderate = vi.fn();
    const db = { conversationModerationAssessment: { findFirst: vi.fn() },
      conversationMessage: { findUnique: vi.fn() } } as unknown as PrismaClient;
    const service = new PostgresModerationAssessmentService(db, moderate, undefined,
      async () => { throw new Error("platform configuration missing"); });
    const subject = { kind: "CUSTOMER_MESSAGE" as const, messageId: "message-1" };
    await expect(service.assessText({ subject, shopId: "shop", conversationId: "conversation",
      effectiveText: "hello", inputKind: "TEXT", policyVersion: "arch040-moderation-v1",
      now: new Date() })).rejects.toThrow("platform configuration missing");
    expect(moderate).not.toHaveBeenCalled();
    expect(db.conversationMessage.findUnique).not.toHaveBeenCalled();
    await expect(service.requireCurrentAllowance({ subject, effectiveText: "hello",
      policyVersion: "arch040-moderation-v1" })).resolves.toBe(false);
  });
  it("rejects an old-model ALLOW after the configured moderation model changes", async () => {
    const db = {
      conversationMessage: { findUnique: vi.fn().mockResolvedValue({
        conversationId: "conversation", direction: "INBOUND", senderType: "CUSTOMER",
        content: "hello", contentType: "TEXT", transcriptionStatus: "NOT_REQUIRED",
        conversation: { shopId: "shop", checkoutRecovery: null },
      }) },
      conversationModerationAssessment: { findFirst: vi.fn().mockResolvedValue({
        decision: "ALLOW", requestedModel: "old-model",
      }) },
    } as unknown as PrismaClient;
    const service = new PostgresModerationAssessmentService(db, vi.fn(), undefined,
      async () => config("new-model"));
    await expect(service.requireCurrentAllowance({
      subject: { kind: "CUSTOMER_MESSAGE", messageId: "message-1" },
      effectiveText: "hello", policyVersion: "arch040-moderation-v1",
    })).resolves.toBe(false);
  });
});
