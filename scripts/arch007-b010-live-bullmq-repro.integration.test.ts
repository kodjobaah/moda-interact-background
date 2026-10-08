import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { Job, Queue, QueueEvents, type Worker } from "bullmq";
import IORedis from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const redisUrl = process.env.TEST_REDIS_URL;
const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" &&
  Boolean(redisUrl) &&
  Boolean(databaseUrl);
const describeDisposable = enabled ? describe.sequential : describe.skip;

const mocks = vi.hoisted(() => ({
  routing: { resolveInboundMessage: vi.fn() },
  checkoutRecovery: {
    recordExternalActivity: vi.fn(),
    getAgentContext: vi.fn(),
  },
  abuseAdmission: {
    admitRaw: vi.fn(),
    admitSettledTurn: vi.fn(),
  },
  outboundAdmission: {
    reserve: vi.fn(),
    sendPreparedText: vi.fn(),
    failPrepared: vi.fn(),
  },
  shopEligibility: { isShopExecutionActive: vi.fn() },
  runAgent: vi.fn(),
  guidance: vi.fn(),
  audio: { process: vi.fn() },
  providerStatus: { process: vi.fn() },
}));

vi.mock("../../src/services/recovery-routing.service.js", () => ({
  recoveryRoutingService: mocks.routing,
}));

vi.mock("../../src/services/checkout-recovery.service.js", () => ({
  checkoutRecoveryService: mocks.checkoutRecovery,
}));

vi.mock("../../src/services/inbound-whatsapp-abuse-admission.service.js", () => ({
  inboundWhatsAppAbuseAdmissionService: mocks.abuseAdmission,
}));

vi.mock("../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: mocks.outboundAdmission,
  runCommerceAgentAfterAdmission: async (input: any) => {
    if (input.admission.terminal) {
      await input.sendPreparedText({
        ...input.admission,
        to: input.to,
        text: "terminal response",
      });
      return null;
    }
    try {
      return await input.runAgent(input.context);
    } catch (error) {
      await input.failPrepared(input.admission.messageId);
      throw error;
    }
  },
}));

vi.mock("../../src/services/shop-execution-eligibility.service.js", () => ({
  shopExecutionEligibilityService: mocks.shopEligibility,
}));

vi.mock("../../src/services/routing-guidance.service.js", () => ({
  sendRoutingGuidance: mocks.guidance,
}));

vi.mock("../../src/services/inbound-whatsapp-audio.service.js", () => ({
  inboundWhatsAppAudioService: mocks.audio,
}));

vi.mock("../../src/services/whatsapp-provider-status.service.js", () => ({
  whatsappProviderStatusService: mocks.providerStatus,
}));

vi.mock("../../src/agents/commerce.agent.js", () => ({
  runCommerceAgent: mocks.runAgent,
}));

vi.mock("../../src/observability/worker-metrics.js", () => ({
  observeWorkerJob: vi.fn((_definition: unknown, _job: unknown, operation: () => unknown) => operation()),
}));

vi.mock("@modainteract/moda-interact-shared/observability/genai", () => ({
  observeConversationTurn: vi.fn((_name: string, operation: () => unknown) => operation()),
}));

type SeededConversation = {
  shopId: string;
  customerId: string;
  recoveryId: string;
  conversationId: string;
  customerPhone: string;
};

type ClaimSnapshot = {
  conversationId: string;
  inboundVersion: number;
  lastProcessedVersion: number;
  processingInboundVersion: number | null;
  processingStartedAt: Date | null;
};

const QUIET_WINDOW_MS = 1_000;
const MAX_SETTLE_WINDOW_MS = 3_000;
const QUEUE_NAME = "whatsapp-events";

let database: PrismaClient;
let sourceDatabase: PrismaClient;
let sourceRedis: IORedis;
let producerRedis: IORedis;
let queueEventsRedis: IORedis;
let queue: Queue;
let queueEvents: QueueEvents;
let worker: Worker;
let backgroundRuntimeConfigService: {
  start(): Promise<void>;
  close(): Promise<void>;
};
let claimSnapshots: ClaimSnapshot[] = [];
let activeRoute: SeededConversation | null = null;

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out. Last value: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
}

async function seedConversation(label: string): Promise<SeededConversation> {
  const suffix = `${label}-${randomUUID()}`;
  const shopId = `shop-${suffix}`;
  const customerId = `customer-${suffix}`;
  const recoveryId = `recovery-${suffix}`;
  const conversationId = `conversation-${suffix}`;
  const customerPhone = "+15550003333";

  await database.shop.create({
    data: {
      id: shopId,
      domain: `${suffix}.myshopify.com`,
      onboardingCompleted: true,
      status: "ACTIVE",
      defaultLanguageTag: "en",
    },
  });

  await database.customer.create({
    data: {
      id: customerId,
      shopId,
      phone: customerPhone,
      firstName: "Integration",
    },
  });

  await database.checkoutRecovery.create({
    data: {
      id: recoveryId,
      shopId,
      customerId,
      checkoutToken: `checkout-${suffix}`,
      status: "ENGAGED",
      lastExternalActivityAt: new Date(),
    },
  });

  await database.conversation.create({
    data: {
      id: conversationId,
      checkoutRecoveryId: recoveryId,
      type: "RECOVERY",
      languageTag: "en",
      languageSource: "MERCHANT_DEFAULT",
    },
  });

  return { shopId, customerId, recoveryId, conversationId, customerPhone };
}

function inboundEvent(
  route: SeededConversation,
  providerMessageId: string,
  text: string,
) {
  return {
    schemaVersion: 1 as const,
    provider: "whatsapp" as const,
    providerAccountId: "waba-integration",
    providerPhoneNumberId: "phone-integration",
    providerMessageId,
    customerPhone: route.customerPhone,
    contextMessageId: null,
    occurredAt: new Date().toISOString(),
    content: { type: "text" as const, text },
  };
}

async function addAndWaitForInbound(
  event: ReturnType<typeof inboundEvent>,
  options: { attempts?: number; backoffMs?: number } = {},
): Promise<Job> {
  const job = await queue.add("message-received", event, {
    jobId: `integration-message__${event.providerMessageId}`,
    attempts: options.attempts ?? 1,
    ...(options.backoffMs
      ? { backoff: { type: "fixed" as const, delay: options.backoffMs } }
      : {}),
    removeOnComplete: false,
    removeOnFail: false,
  });
  await job.waitUntilFinished(queueEvents, 8_000);
  return job;
}

async function conversationState(conversationId: string) {
  return database.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: {
      inboundVersion: true,
      lastProcessedVersion: true,
      pendingTurnStartedAt: true,
      processingInboundVersion: true,
      processingStartedAt: true,
      lastInboundAt: true,
    },
  });
}

async function turnJob(conversationId: string, version: number) {
  return queue.getJob(`conversation-turn__${conversationId}__${version}`);
}

describeDisposable("ARCH-007-BACKGROUND-010 real Redis/PostgreSQL scheduling reproduction", () => {
  beforeAll(async () => {
    database = new PrismaClient({ datasourceUrl: databaseUrl! });

    await database.backgroundRuntimeConfig.update({
      where: { id: "default" },
      data: {
        version: { increment: 1 },
        conversationQuietWindowMs: QUIET_WINDOW_MS,
        conversationMaxSettleWindowMs: MAX_SETTLE_WINDOW_MS,
        whatsappQueueGlobalConcurrency: 4,
      },
    });

    const runtimeModule = await import("../../src/runtime/background-runtime-config.js");
    backgroundRuntimeConfigService = runtimeModule.backgroundRuntimeConfigService;
    await backgroundRuntimeConfigService.start();

    const dbModule = await import("../../src/lib/db.js");
    sourceDatabase = dbModule.default;
    const redisModule = await import("../../src/lib/redis.js");
    sourceRedis = redisModule.connectionRedis;

    producerRedis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
    queueEventsRedis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
    await producerRedis.flushdb();

    queue = new Queue(QUEUE_NAME, { connection: producerRedis });
    queueEvents = new QueueEvents(QUEUE_NAME, { connection: queueEventsRedis });
    await queueEvents.waitUntilReady();

    const workerModule = await import("../../src/workers/whatsapp.worker.js");
    worker = workerModule.createWhatsappWorker();
    await worker.waitUntilReady();
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    claimSnapshots = [];
    activeRoute = null;

    mocks.abuseAdmission.admitRaw.mockResolvedValue({ kind: "allowed" });
    mocks.abuseAdmission.admitSettledTurn.mockResolvedValue({ kind: "allowed" });
    mocks.shopEligibility.isShopExecutionActive.mockResolvedValue(true);
    mocks.checkoutRecovery.recordExternalActivity.mockResolvedValue({ count: 1 });
    mocks.audio.process.mockResolvedValue({ kind: "ignored" });

    mocks.routing.resolveInboundMessage.mockImplementation(async () => {
      if (!activeRoute) throw new Error("No active integration route configured.");
      return {
        kind: "resolved",
        conversationId: activeRoute.conversationId,
        checkoutRecoveryId: activeRoute.recoveryId,
        shopId: activeRoute.shopId,
      };
    });

    let admissionSequence = 0;
    mocks.outboundAdmission.reserve.mockImplementation(async (input: any) => ({
      kind: "admitted",
      shopId: input.shopId,
      conversationId: input.conversationId,
      messageId: `integration-outbound-${++admissionSequence}`,
      terminal: false,
    }));
    mocks.outboundAdmission.sendPreparedText.mockImplementation(async (input: any) => ({
      kind: "admitted",
      shopId: input.shopId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      terminal: false,
    }));
    mocks.outboundAdmission.failPrepared.mockResolvedValue(undefined);

    mocks.runAgent.mockResolvedValue({
      replyText: "settled integration response",
      detectedLanguageTag: null,
      detectedLanguageConfidence: null,
    });

    mocks.checkoutRecovery.getAgentContext.mockImplementation(
      async (input: {
        conversationId: string;
        pendingTurnStartedAt: Date;
      }) => {
        const state = await database.conversation.findUniqueOrThrow({
          where: { id: input.conversationId },
          select: {
            inboundVersion: true,
            lastProcessedVersion: true,
            processingInboundVersion: true,
            processingStartedAt: true,
          },
        });
        claimSnapshots.push({
          conversationId: input.conversationId,
          ...state,
        });

        const messages = await database.conversationMessage.findMany({
          where: {
            conversationId: input.conversationId,
            direction: "INBOUND",
            senderType: "CUSTOMER",
            createdAt: { gte: input.pendingTurnStartedAt },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { content: true },
        });

        return {
          conversation: {
            oversized: false,
            messages: messages.map((message) => ({
              role: "user",
              content: message.content,
            })),
          },
        };
      },
    );
  });

  afterAll(async () => {
    const closers = [
      async () => worker?.close(),
      async () => queueEvents?.close(),
      async () => queue?.close(),
      async () => backgroundRuntimeConfigService?.close(),
      async () => sourceRedis?.quit(),
      async () => sourceDatabase?.$disconnect(),
      async () => database?.$disconnect(),
      async () => producerRedis?.quit(),
      async () => queueEventsRedis?.quit(),
    ];
    for (const close of closers) {
      await close().catch(() => undefined);
    }
  }, 30_000);

  it("control: persists versions 1/2/3, creates real delayed jobs, and executes only settled version 3", async () => {
    const seeded = await seedConversation("control");
    activeRoute = seeded;
    const fragments = [
      "Hi I was looking at",
      "the black jacket",
      "sorry I mean blue",
    ];

    const sendCountBefore = mocks.outboundAdmission.sendPreparedText.mock.calls.length;
    const agentCountBefore = mocks.runAgent.mock.calls.length;

    for (let index = 0; index < fragments.length; index += 1) {
      await addAndWaitForInbound(
        inboundEvent(seeded, `control-inbound-${index + 1}-${randomUUID()}`, fragments[index]!),
      );
    }

    const immediatelyAfterReceive = await conversationState(seeded.conversationId);
    expect(immediatelyAfterReceive.inboundVersion).toBe(3);
    expect(immediatelyAfterReceive.lastProcessedVersion).toBe(0);
    expect(immediatelyAfterReceive.pendingTurnStartedAt).not.toBeNull();

    const initialTurnJobs = await Promise.all([
      turnJob(seeded.conversationId, 1),
      turnJob(seeded.conversationId, 2),
      turnJob(seeded.conversationId, 3),
    ]);
    expect(initialTurnJobs.every((job) => job !== null)).toBe(true);

    const finalState = await waitFor(
      "settled version 3 completion",
      () => conversationState(seeded.conversationId),
      (state) => state.lastProcessedVersion === 3 && state.pendingTurnStartedAt === null,
      8_000,
    );

    expect(finalState).toMatchObject({
      inboundVersion: 3,
      lastProcessedVersion: 3,
      pendingTurnStartedAt: null,
      processingInboundVersion: null,
      processingStartedAt: null,
    });

    const claim = claimSnapshots.find(
      (snapshot) =>
        snapshot.conversationId === seeded.conversationId &&
        snapshot.processingInboundVersion === 3,
    );
    expect(claim).toBeDefined();
    expect(claim?.processingStartedAt).not.toBeNull();

    expect(mocks.runAgent.mock.calls.length - agentCountBefore).toBe(1);
    expect(mocks.outboundAdmission.sendPreparedText.mock.calls.length - sendCountBefore).toBe(1);

    const agentContext = mocks.runAgent.mock.calls.at(-1)?.[0] as any;
    expect(agentContext?.conversation?.messages?.map((message: any) => message.content)).toEqual(fragments);

    await waitFor(
      "stale turn jobs to be removed",
      async () => Promise.all([
        turnJob(seeded.conversationId, 1),
        turnJob(seeded.conversationId, 2),
        turnJob(seeded.conversationId, 3),
      ]),
      (jobs) => jobs.every((job) => job === null),
      4_000,
    );

    console.log("[ARCH-007-B010] control evidence", {
      conversationId: seeded.conversationId,
      inboundVersion: finalState.inboundVersion,
      lastProcessedVersion: finalState.lastProcessedVersion,
      claimedVersion: claim?.processingInboundVersion,
      providerOutputs: mocks.outboundAdmission.sendPreparedText.mock.calls.length - sendCountBefore,
      fragments,
    });
  }, 15_000);

  it("reproduces the retry hole: persistence succeeds, first turn enqueue fails, duplicate retry leaves the pending turn stranded", async () => {
    const seeded = await seedConversation("enqueue-failure");
    activeRoute = seeded;
    const providerMessageId = `enqueue-failure-${randomUUID()}`;
    const expectedTurnJobId = `conversation-turn__${seeded.conversationId}__1`;
    const sendCountBefore = mocks.outboundAdmission.sendPreparedText.mock.calls.length;

    const queuePrototype = Queue.prototype as any;
    const originalAdd = queuePrototype.add;
    let injectedFailures = 0;
    queuePrototype.add = async function (
      name: string,
      data: any,
      options: any,
    ) {
      if (
        injectedFailures === 0 &&
        name === "process-conversation-turn" &&
        data?.conversationId === seeded.conversationId
      ) {
        injectedFailures += 1;
        throw new Error("ARCH007_B010_INJECTED_TURN_ENQUEUE_FAILURE");
      }
      return originalAdd.call(this, name, data, options);
    };

    try {
      const parentJob = await addAndWaitForInbound(
        inboundEvent(seeded, providerMessageId, "Please help with this basket"),
        { attempts: 2, backoffMs: 50 },
      );
      const persistedParent = await queue.getJob(parentJob.id!);
      expect(persistedParent?.attemptsMade).toBeGreaterThanOrEqual(1);
    } finally {
      queuePrototype.add = originalAdd;
    }

    expect(injectedFailures).toBe(1);

    const stateAfterRetry = await conversationState(seeded.conversationId);
    expect(stateAfterRetry.inboundVersion).toBe(1);
    expect(stateAfterRetry.lastProcessedVersion).toBe(0);
    expect(stateAfterRetry.pendingTurnStartedAt).not.toBeNull();
    expect(stateAfterRetry.processingInboundVersion).toBeNull();
    expect(stateAfterRetry.processingStartedAt).toBeNull();

    const missingTurnJob = await queue.getJob(expectedTurnJobId);
    expect(missingTurnJob).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS + 500));

    const stranded = await conversationState(seeded.conversationId);
    expect(stranded).toMatchObject({
      inboundVersion: 1,
      lastProcessedVersion: 0,
      processingInboundVersion: null,
      processingStartedAt: null,
    });
    expect(stranded.pendingTurnStartedAt).not.toBeNull();
    expect(await queue.getJob(expectedTurnJobId)).toBeNull();
    expect(mocks.outboundAdmission.sendPreparedText.mock.calls.length - sendCountBefore).toBe(0);

    console.log("[ARCH-007-B010] BUG REPRODUCED", {
      conversationId: seeded.conversationId,
      injectedFailures,
      inboundVersion: stranded.inboundVersion,
      lastProcessedVersion: stranded.lastProcessedVersion,
      pendingTurnStartedAt: stranded.pendingTurnStartedAt?.toISOString(),
      processingInboundVersion: stranded.processingInboundVersion,
      turnJobPresent: false,
      providerOutputs: mocks.outboundAdmission.sendPreparedText.mock.calls.length - sendCountBefore,
    });
  }, 15_000);
});
