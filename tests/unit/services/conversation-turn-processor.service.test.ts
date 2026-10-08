import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));
vi.mock(
  "../../../src/services/outbound-whatsapp-admission.service.js",
  () => ({
    runCommerceAgentAfterAdmission: async (input: any) => {
      if (input.admission.terminal) {
        await input.sendPreparedText({
          ...input.admission,
          to: input.to,
          text: "terminal response",
        });
        return null;
      }
      const result = await input.runAgent(input.context);
      return result;
    },
  }),
);

import {
  ConversationTurnProcessor,
  PROCESSING_LEASE_MS,
} from "../../../src/services/conversation-turn-processor.service.js";

import { registerSchedulingCases } from "./conversation-turn-processor/facade-scheduling.cases.js";
import { registerClaimAndStateCases } from "./conversation-turn-processor/facade-claims-and-state.cases.js";
import { registerContextCases } from "./conversation-turn-processor/facade-context.cases.js";
import { registerAbuseAdmissionCases } from "./conversation-turn-processor/facade-abuse-admission.cases.js";
import { registerOutboundCases } from "./conversation-turn-processor/facade-outbound.cases.js";
import { registerAgentRaceCases } from "./conversation-turn-processor/facade-agent-races.cases.js";

const first = new Date("2026-09-08T12:00:00.000Z");

function state(overrides: Partial<any> = {}) {
  return {
    inboundVersion: 3,
    lastProcessedVersion: 0,
    lastInboundAt: new Date(first.getTime() + 3_000),
    pendingTurnStartedAt: first,
    processingInboundVersion: null,
    processingStartedAt: null,
    ...overrides,
  };
}

function harness(overrides: Partial<any> = {}) {
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const conversation = {
    getTurnState: vi.fn().mockResolvedValue(state()),
    claimTurn: vi.fn().mockResolvedValue(true),
    completeTurn: vi.fn().mockResolvedValue(true),
    releaseTurn: vi.fn().mockResolvedValue(undefined),
    hasChanged: vi.fn().mockResolvedValue(false),
    applyDetectedLanguage: vi.fn().mockResolvedValue(true),
  };
  const admission = {
    reserve: vi.fn().mockResolvedValue({
      kind: "admitted",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: false,
    }),
    sendPreparedText: vi.fn().mockResolvedValue({
      kind: "admitted",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: false,
    }),
    failPrepared: vi.fn().mockResolvedValue(undefined),
  };
  const abuseAdmission = {
    admitSettledTurn: vi.fn().mockResolvedValue({ kind: "allowed" }),
  };
  const runAgent = vi.fn().mockResolvedValue({
    replyText: "reply",
    detectedLanguageTag: null,
    detectedLanguageConfidence: null,
  });
  const loaded = {
    shopId: "shop-1",
    to: "+447700900000",
    customerPhone: "+447700900000",
    conversationType: "PRODUCT_SUPPORT" as const,
    checkoutRecoveryId: null,
    hasReplyContext: false,
    context: { conversation: { messages: [{ role: "user", content: "Hi" }] } },
    languageMessage: "Hi",
  };
  const now = overrides.now ?? (() => new Date(first.getTime() + 20_000));
  const runtimeConfig = overrides.runtimeConfig ?? {
    current: vi.fn().mockReturnValue({
      conversationQuietWindowMs: 3_000,
      conversationMaxSettleWindowMs: 10_000,
    }),
  };
  const processor = new ConversationTurnProcessor({
    queue,
    conversation,
    admission,
    abuseAdmission,
    loadTurn: vi.fn().mockResolvedValue(loaded),
    runAgent,
    getResult: (result: any) => result,
    now,
    runtimeConfig,
    logger,
  });

  return {
    processor,
    queue,
    conversation,
    admission,
    abuseAdmission,
    runAgent,
    loaded,
    runtimeConfig,
    logger,
    ...overrides,
  };
}

const facadeContext = { harness, state, first, ConversationTurnProcessor, PROCESSING_LEASE_MS };

// Type-only import by case modules; no runtime cycle.
export type ConversationTurnFacadeContext = typeof facadeContext;

describe("ConversationTurnProcessor", () => {
  registerSchedulingCases(facadeContext);
  registerClaimAndStateCases(facadeContext);
  registerContextCases(facadeContext);
  registerAbuseAdmissionCases(facadeContext);
  registerOutboundCases(facadeContext);
  registerAgentRaceCases(facadeContext);
});

// Preserve the original standalone regression outside the describe block.
it("does not persist model language or send when the version/lease is stale", async () => {
 const test = harness();test.conversation.hasChanged.mockResolvedValue(true);
 await test.processor.process({conversationId:"conversation-1",observedVersion:3});
 expect(test.conversation.applyDetectedLanguage).not.toHaveBeenCalled();expect(test.admission.sendPreparedText).not.toHaveBeenCalled();expect(test.admission.failPrepared).toHaveBeenCalledWith("message-1");
});
