import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abuse: { admitRaw: vi.fn() },
  conversation: {
    receiveMessage: vi.fn(),
    getTurnState: vi.fn(),
  },
  routing: { resolveInboundMessage: vi.fn() },
  processor: { enqueue: vi.fn() },
  database: { conversation: { findUniqueOrThrow: vi.fn() } },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add() {
      return Promise.resolve();
    }
  },
  Worker: class {
    on() {
      return this;
    }
  },
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: vi.fn(() => ({})),
}));
vi.mock("@modainteract/moda-interact-shared/observability/genai", () => ({
  observeConversationTurn: vi.fn((_name, operation) => operation()),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../../src/lib/db.js", () => ({ default: mocks.database }));
vi.mock("../../../src/observability/worker-metrics.js", () => ({
  observeWorkerJob: vi.fn((_definition, _job, operation) => operation()),
}));
vi.mock("../../../src/agents/commerce.agent.js", () => ({
  runCommerceAgent: vi.fn(),
}));
vi.mock("../../../src/services/checkout-recovery.service.js", () => ({
  checkoutRecoveryService: {},
}));
vi.mock("../../../src/services/conversation.service.js", () => ({
  conversationService: mocks.conversation,
}));
vi.mock("../../../src/services/inbound-whatsapp-abuse-admission.service.js", () => ({
  inboundWhatsAppAbuseAdmissionService: mocks.abuse,
}));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: {},
}));
vi.mock("../../../src/services/recovery-routing.service.js", () => ({
  recoveryRoutingService: mocks.routing,
}));
vi.mock("../../../src/services/whatsapp-provider-status.service.js", () => ({
  whatsappProviderStatusService: { process: vi.fn() },
}));
vi.mock(
  "../../../src/services/conversation-turn-processor.service.js",
  () => ({
    ConversationTurnProcessor: class {
      enqueue = mocks.processor.enqueue;
    },
  }),
);

import {
  loadConversationTurn,
  processInboundMessage,
} from "../../../src/workers/whatsapp.worker.js";

const event = {
  provider: "whatsapp" as const,
  providerMessageId: "inbound-1",
  customerPhone: "+447700900000",
  contextMessageId: "outbound-1",
  phoneNumberId: "phone-1",
  timestamp: Date.now(),
  type: "text" as const,
  text: "Can you help?",
};

describe("WhatsApp worker inbound execution gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.abuse.admitRaw.mockResolvedValue({ kind: "allowed" });
    mocks.conversation.receiveMessage.mockResolvedValue({
      duplicate: false,
      version: 4,
    });
    mocks.conversation.getTurnState.mockResolvedValue({
      pendingTurnStartedAt: new Date(),
      lastInboundAt: new Date(),
    });
  });

  it.each(["UNINSTALLED", "SUSPENDED"])(
    "does not persist or enqueue a context-linked %s inbound message",
    async (status) => {
      mocks.routing.resolveInboundMessage.mockResolvedValue({
        kind: "shop-unavailable",
        customerPhone: event.customerPhone,
      });

      await processInboundMessage(event);

      expect(mocks.conversation.receiveMessage).not.toHaveBeenCalled();
      expect(mocks.processor.enqueue).not.toHaveBeenCalled();
      expect(status).toMatch(/UNINSTALLED|SUSPENDED/);
    },
  );

  it("persists and enqueues an active context-linked inbound message", async () => {
    mocks.routing.resolveInboundMessage.mockResolvedValue({
      kind: "resolved",
      conversationId: "conversation-1",
      checkoutRecoveryId: "recovery-1",
      shopId: "shop-1",
    });

    await processInboundMessage(event);

    expect(mocks.conversation.receiveMessage).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      providerMessageId: event.providerMessageId,
      inReplyToProviderId: event.contextMessageId,
      content: event.text,
    });
    expect(mocks.processor.enqueue).toHaveBeenCalledWith("conversation-1", 4);
  });

  it.each(["UNINSTALLED", "SUSPENDED"])(
    "stops a durable delayed turn before context loading for %s shops",
    async (status) => {
      mocks.database.conversation.findUniqueOrThrow.mockResolvedValue({
        id: "conversation-1",
        type: "RECOVERY",
        shopId: null,
        customer: { phone: "+447700900000", id: "customer-1", firstName: null },
        shop: null,
        checkoutRecoveryId: "recovery-1",
        checkoutRecovery: {
          shopId: "shop-1",
          shop: { domain: "example.myshopify.com", status },
          customer: { phone: "+447700900000", id: "customer-1", firstName: null },
        },
        messages: [],
      });

      const loaded = await loadConversationTurn("conversation-1", new Date());

      expect(loaded).toMatchObject({ shopId: "shop-1", shopUnavailable: true });
      expect(mocks.database.conversation.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    },
  );
});
