import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { PostgresModerationAssessmentService } from "../../../../src/services/conversation-moderation/moderation-assessment.service.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
it("canonical customer moderation uses the exact associated additional clause, not selection controls", async () => {
  const original = {
    id: "original-message",
    providerMessageId: "original",
    conversationId: "conversation",
    direction: "INBOUND",
    senderType: "CUSTOMER",
    content: "Can it arrive Friday?",
    contentType: "TEXT",
    transcriptionStatus: "NOT_REQUIRED",
    createdAt: new Date(1000),
  };
  const current = {
    ...original,
    id: "selection-message",
    providerMessageId: "selection",
    content: "2. Can I collect on Saturday?",
    createdAt: new Date(2000),
    conversation: { shopId: "shop", checkoutRecovery: { shopId: "shop" } },
  };
  const clause = current.content.slice(3);
  const decision = {
    schemaVersion: 1,
    role: "SELECT_AND_QUESTION",
    currentInboundProviderMessageId: "selection",
    selectedAssignmentConversationId: "conversation",
    originalTurnId: "original",
    originalInboundProviderMessageId: "original",
    associatedMessages: {
      originalMessageId: original.id,
      currentMessageId: current.id,
    },
    originalTextSha256: hash(original.content),
    currentTextSha256: hash(current.content),
    clause: { start: 3, end: current.content.length, sha256: hash(clause) },
    moderation: {
      current: { id: "current-assessment", hash: hash(current.content) },
      clause: { id: "clause-assessment", hash: hash(clause) },
    },
  };
  const db = {
    conversationMessage: {
      findUnique: vi.fn().mockResolvedValue(current),
      findMany: vi.fn().mockResolvedValue([original, current]),
    },
    recoveryBasketRoutingTurn: {
      findMany: vi.fn().mockResolvedValue([
        {
          inboundProviderMessageId: "selection",
          resolutionInboundProviderMessageId: "selection",
          parentProviderMessageId: "original",
          threadId: "thread",
          routeId: "route",
          resolvedAt: new Date(3000),
          routingDecision: decision,
          parent: {
            inboundProviderMessageId: "original",
            threadId: "thread",
            routeId: "route",
            state: "RESOLVED",
            selectedConversationId: "conversation",
            resolutionInboundProviderMessageId: "selection",
          },
        },
      ]),
    },
    conversationModerationAssessment: {
      findFirst: vi.fn().mockResolvedValue({
        decision: "ALLOW",
        requestedModel: "moderation-model",
      }),
    },
  };
  const service = new PostgresModerationAssessmentService(
    db as never,
    vi.fn(),
    undefined,
    async () => ({
      moderation: {
        key: "omini.moderation",
        version: 1,
        value: { baseUrl: null, modelId: "moderation-model" },
      },
      openAiApiKey: "fixture-key",
      providerVersion: 1,
    }),
  );
  const subject = { kind: "CUSTOMER_MESSAGE" as const, messageId: current.id };
  expect(await service.effectiveText(subject)).toBe(clause);
  expect(
    await service.requireCurrentAllowance({
      subject,
      effectiveText: clause,
      policyVersion: "arch040-moderation-v1",
    }),
  ).toBe(true);
  expect(
    await service.requireCurrentAllowance({
      subject,
      effectiveText: current.content,
      policyVersion: "arch040-moderation-v1",
    }),
  ).toBe(false);
  expect(
    db.conversationModerationAssessment.findFirst.mock.calls[0]![0],
  ).toMatchObject({
    where: { conversationMessageId: current.id, contentSha256: hash(clause) },
  });
});
