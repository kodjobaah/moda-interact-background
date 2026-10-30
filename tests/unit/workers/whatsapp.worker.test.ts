import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const mocks = vi.hoisted(() => ({
  guidance: vi.fn(),
  templateStatus: vi.fn(),
  dispatch: null as null | ((job: unknown) => Promise<void>),
  optOut: vi.fn(),
  reachability: vi.fn(),
  audio: vi.fn(),
  logger: (() => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    return logger;
  })(),
  abuse: { admitRaw: vi.fn() },
  conversation: {
    receiveMessage: vi.fn(),
    getTurnState: vi.fn(),
  },
  routing: { resolveInboundMessage: vi.fn(), isCurrentActiveRoute: vi.fn() },
  recovery: { recordExternalActivity: vi.fn() },
  processor: { enqueue: vi.fn() },
  database: { conversation: { findUniqueOrThrow: vi.fn() } },
  eligibility: { isShopExecutionActive: vi.fn() },
}));

vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: vi.fn(() => mocks.logger),
}));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: vi.fn(() => "test"),
}));
vi.mock("../../../src/services/routing-guidance.service.js", () => ({ sendRoutingGuidance: mocks.guidance }));
vi.mock("../../../src/services/whatsapp-contact-opt-out.service.js", () => ({
  whatsAppContactOptOutService: { handleInbound: mocks.optOut },
}));
vi.mock("../../../src/services/recipient-reachability-positive.service.js", () => ({
  recipientReachabilityPositiveService: { fromRoutedInbound: mocks.reachability },
}));
vi.mock("../../../src/services/inbound-whatsapp-audio.service.js", () => ({ inboundWhatsAppAudioService: { process: mocks.audio } }));
vi.mock("bullmq", () => ({
  Queue: class {
    add() {
      return Promise.resolve();
    }
  },
  Worker: class {
    concurrency = 1;
    constructor(_queue: string, handler: (job: unknown) => Promise<void>) {
      mocks.dispatch = handler;
    }
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
vi.mock("../../../src/runtime/queue-concurrency-controller.js", () => ({
  bindWorkerConcurrency: vi.fn(),
}));
vi.mock("../../../src/observability/worker-metrics.js", () => ({
  observeWorkerJob: vi.fn((_definition, _job, operation) => operation()),
}));
vi.mock("../../../src/agents/commerce.agent.js", () => ({
  runCommerceAgent: vi.fn(),
}));
vi.mock("../../../src/services/checkout-recovery.service.js", () => ({
  checkoutRecoveryService: mocks.recovery,
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
vi.mock("../../../src/services/meta-template-management/service.js", () => ({
  metaTemplateManagementService: { processTemplateStatusObservation: mocks.templateStatus },
}));
vi.mock("../../../src/services/shop-execution-eligibility.service.js", () => ({
  shopExecutionEligibilityService: mocks.eligibility,
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
  createWhatsappWorker,
  loadConversationTurn,
  processInboundJobData,
  processInboundMessage,
} from "../../../src/workers/whatsapp.worker.js";
import { processTemplateStatusJob } from "../../../src/services/meta-template-management/status-job.js";
import {
  formatMetaTemplateStatusEventIdentity,
  formatMetaTemplateStatusJobId,
} from "@modainteract/moda-interact-shared/whatsapp-template-events";

const event = {
  schemaVersion: 1 as const,
  provider: "whatsapp" as const,
  providerAccountId: "waba-1",
  providerPhoneNumberId: "phone-1",
  providerMessageId: "inbound-1",
  customerPhone: "+447700900000",
  contextMessageId: "outbound-1",
  occurredAt: "2026-09-16T12:00:00.000Z",
  content: { type: "text" as const, text: "Can you help?" },
};

describe("WhatsApp worker inbound execution gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.abuse.admitRaw.mockResolvedValue({ kind: "allowed" });
    mocks.optOut.mockResolvedValue(false);
    mocks.reachability.mockResolvedValue("recorded");
    mocks.conversation.receiveMessage.mockResolvedValue({
      duplicate: false,
      version: 4,
    });
    mocks.conversation.getTurnState.mockResolvedValue({
      pendingTurnStartedAt: new Date(),
      lastInboundAt: new Date(),
    });
    mocks.recovery.recordExternalActivity.mockResolvedValue({ count: 1 });
    mocks.eligibility.isShopExecutionActive.mockResolvedValue(true);
    mocks.routing.isCurrentActiveRoute.mockResolvedValue(true);
  });

  it("B011-03 performs raw admission before routing and persistence", async () => {
    mocks.routing.resolveInboundMessage.mockResolvedValue({
      kind: "resolved",
      conversationId: "conversation-1",
      checkoutRecoveryId: "recovery-1",
      shopId: "shop-1",
      mode: "active",
    });

    await processInboundMessage(event);

    expect(mocks.abuse.admitRaw).toHaveBeenCalledWith({
      providerMessageId: event.providerMessageId,
      customerPhone: event.customerPhone,
    });
    expect(mocks.routing.resolveInboundMessage).toHaveBeenCalledOnce();
    expect(mocks.conversation.receiveMessage).toHaveBeenCalledOnce();
    const admissionOrder = mocks.abuse.admitRaw.mock.invocationCallOrder[0]!;
    expect(admissionOrder).toBeLessThan(
      mocks.routing.resolveInboundMessage.mock.invocationCallOrder[0]!,
    );
    expect(admissionOrder).toBeLessThan(
      mocks.conversation.receiveMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("B011-05 prevents all downstream work on raw denial", async () => {
    mocks.abuse.admitRaw.mockResolvedValueOnce({
      kind: "denied",
      stage: "raw",
      reason: "RAW_SENDER",
    });

    await processInboundMessage(event);

    expect(mocks.abuse.admitRaw).toHaveBeenCalledOnce();
    expect(mocks.routing.resolveInboundMessage).not.toHaveBeenCalled();
    expect(mocks.conversation.receiveMessage).not.toHaveBeenCalled();
    expect(mocks.recovery.recordExternalActivity).not.toHaveBeenCalled();
    expect(mocks.reachability).not.toHaveBeenCalled();
    expect(mocks.guidance).not.toHaveBeenCalled();
    expect(mocks.processor.enqueue).not.toHaveBeenCalled();
  });

  it.each(["UNINSTALLED", "SUSPENDED"])(
    "does not persist or enqueue a context-linked %s inbound message",
    async (status) => {
      mocks.routing.resolveInboundMessage.mockResolvedValue({
        kind: "guidance",
        reason: "SHOP_UNAVAILABLE",
        customerPhone: event.customerPhone,
      });

      await processInboundMessage(event);

      expect(mocks.conversation.receiveMessage).not.toHaveBeenCalled();
      expect(mocks.processor.enqueue).not.toHaveBeenCalled();
      expect(status).toMatch(/UNINSTALLED|SUSPENDED/);
    },
  );

  it("handles authenticated STOP ahead of raw-abuse denial and ignored routing", async () => {
    mocks.optOut.mockResolvedValueOnce(true);
    // Use a persistent denial within this test: the STOP shortcut MUST NOT
    // consume it, and a queued mockResolvedValueOnce would leak into the next test.
    mocks.abuse.admitRaw.mockResolvedValue({ kind: "denied", reason: "RAW_SENDER" });
    await processInboundMessage({ ...event, content: { type: "text", text: "STOP" } });
    expect(mocks.optOut).toHaveBeenCalledOnce();
    expect(mocks.abuse.admitRaw).not.toHaveBeenCalled();
    expect(mocks.routing.resolveInboundMessage).not.toHaveBeenCalled();
    expect(mocks.guidance).not.toHaveBeenCalled();
    expect(mocks.processor.enqueue).not.toHaveBeenCalled();
  });

  it("persists and enqueues an active context-linked inbound message", async () => {
    mocks.routing.resolveInboundMessage.mockResolvedValue({
      kind: "resolved",
      conversationId: "conversation-1",
      checkoutRecoveryId: "recovery-1",
      shopId: "shop-1",
      mode: "active",
    });

    await processInboundJobData(event);

    expect(mocks.recovery.recordExternalActivity).toHaveBeenCalledWith(
      "recovery-1",
      new Date(event.occurredAt),
    );
    expect(mocks.conversation.receiveMessage).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      providerMessageId: event.providerMessageId,
      inReplyToProviderId: event.contextMessageId,
      content: event.content.text,
      occurredAt: new Date(event.occurredAt),
    });
    expect(mocks.processor.enqueue).toHaveBeenCalledWith("conversation-1", 4);
    expect(mocks.reachability).toHaveBeenCalledWith({
      shopId: "shop-1", conversationId: "conversation-1",
      providerMessageId: event.providerMessageId, customerPhone: event.customerPhone,
    });
  });

  it("persists and enqueues inbound for downstream HUMAN-mode turn suppression", async () => {
    mocks.routing.resolveInboundMessage.mockResolvedValue({
      kind: "resolved",
      conversationId: "conversation-1",
      checkoutRecoveryId: "recovery-1",
      shopId: "shop-1",
      mode: "active",
    });

    await processInboundJobData(event);

    expect(mocks.conversation.receiveMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      providerMessageId: event.providerMessageId,
      content: event.content.text,
    }));
    expect(mocks.processor.enqueue).toHaveBeenCalledWith("conversation-1", 4);
  });

  it("re-enqueues the current turn version when a duplicate delivery retries after persistence", async () => {
    mocks.routing.resolveInboundMessage.mockResolvedValue({
      kind: "resolved",
      conversationId: "conversation-1",
      checkoutRecoveryId: "recovery-1",
      shopId: "shop-1",
      mode: "active",
    });
    mocks.conversation.receiveMessage.mockResolvedValue({
      duplicate: true,
      version: 4,
    });

    await processInboundMessage(event);

    expect(mocks.conversation.receiveMessage).toHaveBeenCalledTimes(1);
    expect(mocks.processor.enqueue).toHaveBeenCalledWith("conversation-1", 4);
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      "whatsapp.inbound.duplicate_repair_requested",
      expect.objectContaining({
        conversationId: "conversation-1",
        messageDigest: expect.any(String),
        observedVersion: 4,
      }),
    );
  });


  it("uses recovery execution scope only for a continuing delayed recovery turn", async () => {
    mocks.eligibility.isShopExecutionActive.mockResolvedValue(false);
    mocks.database.conversation.findUniqueOrThrow.mockResolvedValue({
      id: "conversation-1",
      type: "RECOVERY",
      shopId: null,
      customer: { phone: "+447700900000", id: "customer-1", firstName: null },
      shop: null,
      checkoutRecoveryId: "recovery-1",
      checkoutRecovery: {
        id: "recovery-1",
        shopId: "shop-1",
        status: "ENGAGED",
        shop: { domain: "example.myshopify.com", status: "ACTIVE" },
        customer: { phone: "+447700900000", id: "customer-1", firstName: null },
      },
      messages: [],
    });

    await loadConversationTurn("conversation-1", new Date());
    expect(mocks.eligibility.isShopExecutionActive).toHaveBeenLastCalledWith(
      "shop-1",
      "recovery",
    );

    mocks.eligibility.isShopExecutionActive.mockClear();
    mocks.database.conversation.findUniqueOrThrow.mockResolvedValue({
      id: "conversation-1",
      type: "RECOVERY",
      shopId: null,
      customer: { phone: "+447700900000", id: "customer-1", firstName: null },
      shop: null,
      checkoutRecoveryId: "recovery-1",
      checkoutRecovery: {
        id: "recovery-1",
        shopId: "shop-1",
        status: "COMPLETED",
        shop: { domain: "example.myshopify.com", status: "ACTIVE" },
        customer: { phone: "+447700900000", id: "customer-1", firstName: null },
      },
      messages: [],
    });

    await loadConversationTurn("conversation-1", new Date());
    expect(mocks.eligibility.isShopExecutionActive).toHaveBeenLastCalledWith(
      "shop-1",
      "general",
    );
  });

  it("ignores a legacy payload before admission, routing, or persistence", async () => {
    await processInboundJobData({
      provider: "whatsapp",
      providerMessageId: "legacy-1",
      customerPhone: event.customerPhone,
      type: "audio",
      mediaId: "media-1",
      text: "",
    });

    expect(mocks.abuse.admitRaw).not.toHaveBeenCalled();
    expect(mocks.routing.resolveInboundMessage).not.toHaveBeenCalled();
    expect(mocks.conversation.receiveMessage).not.toHaveBeenCalled();
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

it("routes ambiguous voice to guidance before downloading or recording engagement", async () => {
 mocks.abuse.admitRaw.mockResolvedValue({kind:"allowed"});
 mocks.routing.resolveInboundMessage.mockResolvedValue({kind:"guidance",reason:"MULTIPLE_RECOVERIES"});
 mocks.audio.mockClear(); mocks.recovery.recordExternalActivity.mockClear();
 await processInboundMessage({...event,content:{type:"audio",mediaId:"media",mimeType:"audio/ogg",sha256:null,voice:true}} as any);
 expect(mocks.audio).not.toHaveBeenCalled(); expect(mocks.recovery.recordExternalActivity).not.toHaveBeenCalled(); expect(mocks.guidance).toHaveBeenCalled();
});


describe("ARCH-028 inbound reachability route gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.abuse.admitRaw.mockResolvedValue({ kind: "allowed" });
    mocks.optOut.mockResolvedValue(false);
    mocks.guidance.mockResolvedValue(undefined);
    mocks.reachability.mockResolvedValue("recorded");
    mocks.conversation.receiveMessage.mockResolvedValue({ duplicate: false, version: 1 });
    mocks.recovery.recordExternalActivity.mockResolvedValue({ count: 1 });
  });

  it("does not clear either shop for an ambiguous same-phone route", async () => {
    mocks.routing.resolveInboundMessage.mockResolvedValue({
      kind: "guidance", reason: "MULTIPLE_RECOVERIES",
    });
    await processInboundMessage(event);
    expect(mocks.reachability).not.toHaveBeenCalled();
    expect(mocks.conversation.receiveMessage).not.toHaveBeenCalled();
  });

  it("retries clearing after a persisted inbound duplicate", async () => {
    mocks.routing.resolveInboundMessage.mockResolvedValue({
      kind: "resolved", conversationId: "conversation-2",
      checkoutRecoveryId: "recovery-2", shopId: "shop-2", mode: "active",
    });
    mocks.conversation.receiveMessage.mockResolvedValue({ duplicate: true, version: 1 });
    await processInboundMessage(event);
    expect(mocks.reachability).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-2", conversationId: "conversation-2",
    }));
  });

  it("never clears on failed inbound persistence", async () => {
    mocks.routing.resolveInboundMessage.mockResolvedValue({
      kind: "resolved", conversationId: "conversation-2",
      checkoutRecoveryId: "recovery-2", shopId: "shop-2", mode: "active",
    });
    mocks.conversation.receiveMessage.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(processInboundMessage(event)).rejects.toThrow("database unavailable");
    expect(mocks.reachability).not.toHaveBeenCalled();
  });
});


describe("ARCH-047 BG003 strict Shared-v2 template-status dispatch", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const event = {
    schemaVersion: 2,
    eventIdentity: formatMetaTemplateStatusEventIdentity(uuid),
    wabaId: "123456789",
    providerTemplateId: "987654321",
    providerTemplateName: "checkout_recovery_initial_v2",
    providerLanguageCode: "en_GB",
    providerStatus: "PAUSED",
    reasonCode: "NONE",
    receivedAt: "2026-10-25T19:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.templateStatus.mockResolvedValue("current");
  });

  it("round-trips the published Shared-v2 golden fixture and BullMQ job identity", async () => {
    const fixturePath = createRequire(import.meta.url).resolve(
      "@modainteract/moda-interact-shared/whatsapp-template-events/fixtures",
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      observation: typeof event; expectedJobId: string;
    };
    expect(fixture.observation).toEqual({ ...event, providerStatus: "APPROVED" });
    expect(fixture.expectedJobId).toBe(formatMetaTemplateStatusJobId(uuid));
    await processTemplateStatusJob("meta-template-status-update", fixture.observation, fixture.expectedJobId);
    expect(mocks.templateStatus).toHaveBeenCalledOnce();
  });

  it("maps Shared-v2 receipt time and invokes only the template status port", async () => {
    await processTemplateStatusJob("meta-template-status-update", event, formatMetaTemplateStatusJobId(uuid));
    expect(mocks.templateStatus).toHaveBeenCalledExactlyOnceWith({
      eventIdentity: event.eventIdentity,
      wabaId: event.wabaId,
      providerTemplateId: event.providerTemplateId,
      providerTemplateName: event.providerTemplateName,
      providerLanguageCode: event.providerLanguageCode,
      providerStatus: event.providerStatus,
      reasonCode: event.reasonCode,
      occurredAt: event.receivedAt,
    });
  });

  it("processes distinct occurrence UUIDs even when Meta statuses are identical", async () => {
    const second = "550e8400-e29b-41d4-a716-446655440001";
    await processTemplateStatusJob("meta-template-status-update", event, formatMetaTemplateStatusJobId(uuid));
    await processTemplateStatusJob("meta-template-status-update", {
      ...event, eventIdentity: formatMetaTemplateStatusEventIdentity(second),
    }, formatMetaTemplateStatusJobId(second));
    expect(mocks.templateStatus).toHaveBeenCalledTimes(2);
    expect(mocks.templateStatus.mock.calls[0]![0].eventIdentity)
      .not.toEqual(mocks.templateStatus.mock.calls[1]![0].eventIdentity);
  });

  it.each([
    ["wrong job", "message-status", event, formatMetaTemplateStatusJobId(uuid)],
    ["wrong version", "meta-template-status-update", { ...event, schemaVersion: 1 }, formatMetaTemplateStatusJobId(uuid)],
    ["extra field", "meta-template-status-update", { ...event, extra: "x" }, formatMetaTemplateStatusJobId(uuid)],
    ["content hash v1", "meta-template-status-update", { ...event, eventIdentity: "meta-template-status:v1:hash" }, formatMetaTemplateStatusJobId(uuid)],
    ["wrong job ID", "meta-template-status-update", event, "meta-template-status-v1-stale"],
    ["wrong provider ID", "meta-template-status-update", { ...event, providerTemplateId: "p-99" }, formatMetaTemplateStatusJobId(uuid)],
    ["noncanonical receipt", "meta-template-status-update", { ...event, receivedAt: "2026-10-25T19:00:00Z" }, formatMetaTemplateStatusJobId(uuid)],
    ["oversized payload", "meta-template-status-update", { ...event, providerTemplateName: "x".repeat(5000) }, formatMetaTemplateStatusJobId(uuid)],
  ])("rejects %s before any Meta service work", async (_label, name, data, jobId) => {
    await expect(processTemplateStatusJob(name as string, data, jobId as string)).rejects.toThrow();
    expect(mocks.templateStatus).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("the actual WhatsApp worker switch dispatches this job without touching customer messages", async () => {
    createWhatsappWorker();
    expect(mocks.dispatch).toBeTypeOf("function");
    await mocks.dispatch!({
      id: formatMetaTemplateStatusJobId(uuid),
      name: "meta-template-status-update", data: event,
      attemptsMade: 0, opts: { attempts: 5 },
    });
    expect(mocks.templateStatus).toHaveBeenCalledTimes(1);
    expect(mocks.routing.resolveInboundMessage).not.toHaveBeenCalled();
    expect(mocks.conversation.receiveMessage).not.toHaveBeenCalled();
  });

  it("logs and rethrows provider reconciliation errors for BullMQ retry", async () => {
    const error = new Error("provider outage");
    mocks.templateStatus.mockRejectedValueOnce(error);
    await expect(processTemplateStatusJob("meta-template-status-update", event,
      formatMetaTemplateStatusJobId(uuid))).rejects.toBe(error);
    expect(mocks.logger.error).toHaveBeenCalledWith("whatsapp.template_status.failed", expect.anything());
  });
});
