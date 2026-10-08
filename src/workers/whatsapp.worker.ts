import { Queue, Worker } from "bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { observeConversationTurn } from "@modainteract/moda-interact-shared/observability/genai";
import {
  safeParseNormalizedWhatsAppInboundMessage,
} from "@modainteract/moda-interact-shared/whatsapp";

import { connectionRedis } from "../lib/redis.js";
import prisma from "../lib/db.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";

import { runCommerceAgent } from "../agents/commerce.agent.js";
import type { RecoveryAgentContext } from "../agents/types.js";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import { inboundWhatsAppAudioService } from "../services/inbound-whatsapp-audio.service.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { conversationService } from "../services/conversation.service.js";
import { inboundWhatsAppAbuseAdmissionService } from "../services/inbound-whatsapp-abuse-admission.service.js";
import { outboundWhatsAppAdmissionService } from "../services/outbound-whatsapp-admission.service.js";
import { sendRoutingGuidance } from "../services/routing-guidance.service.js";
import { recoveryRoutingService } from "../services/recovery-routing.service.js";
import { whatsappProviderStatusService } from "../services/whatsapp-provider-status.service.js";
import { shopExecutionEligibilityService } from "../services/shop-execution-eligibility.service.js";
import {
  ConversationTurnProcessor,
  type ConversationTurnJob,
} from "../services/conversation-turn-processor.service.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { bindWorkerConcurrency } from "../runtime/queue-concurrency-controller.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-messaging-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "whatsapp",
  queueName: "whatsapp-events",
  jobNames: ["message-received", "message-status", "process-conversation-turn"],
} as const;
const conversationTurnObservation = {
  mapException: () => ({
    name: "InboundTurnError",
    message: "Inbound conversation turn failed",
  }),
} as const;

const whatsappQueue = new Queue("whatsapp-events", {
  connection: connectionRedis,
});

const conversationTurnProcessor = new ConversationTurnProcessor<
  RecoveryAgentContext,
  Awaited<ReturnType<typeof runCommerceAgent>>
>({
  queue: whatsappQueue,
  conversation: conversationService,
  admission: outboundWhatsAppAdmissionService,
  abuseAdmission: inboundWhatsAppAbuseAdmissionService,
  loadTurn: loadConversationTurn,
  runAgent: runCommerceAgent,
  getResult: (result) => result,
  logger,
});

export function createWhatsappWorker() {
  const worker = new Worker<
  WhatsAppInboundEvent | ConversationTurnJob
>(
  "whatsapp-events",

  async (job) =>
    observeWorkerJob(workerMetricDefinition, job, async () => {
      logger.debug("whatsapp.job.started", {
        jobId: normalizeJobId(job.id),
        jobName: job.name,
        attemptsMade: job.attemptsMade,
        configuredAttempts: job.opts.attempts ?? 1,
      });
      switch (job.name) {
        case "message-received":
          await processInboundJobData(job.data, job.id, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) });
          return;

        case "process-conversation-turn":
          await conversationTurnProcessor.process(
            job.data as ConversationTurnJob,
            job,
          );
          return;

        case "message-status":
          await whatsappProviderStatusService.process(job.data);
          return;

        default:
          throw new Error(`Unknown WhatsApp job: ${job.name}`);
      }
    }),

  {
    connection: connectionRedis,
    telemetry: bullMQTelemetry,
  },
);
  bindWorkerConcurrency(worker, backgroundRuntimeConfigService, "whatsappQueueGlobalConcurrency");
  worker.on("completed", (job) => {
    logger.debug("whatsapp.job.completed", {
      jobId: normalizeJobId(job.id),
      jobName: job.name,
      attemptsMade: job.attemptsMade,
    });
  });
  worker.on("failed", (job, error) => {
    logger.error("whatsapp.job.failed", {
      jobId: normalizeJobId(job?.id),
      jobName: job?.name ?? null,
      attemptsMade: job?.attemptsMade ?? null,
      ...boundedError(error),
    });
  });
  worker.on("error", (error) => {
    logger.error("whatsapp.worker.error", boundedError(error));
  });
  logger.info("whatsapp.worker.started", {
    queueName: "whatsapp-events",
    concurrency: worker.concurrency,
  });
  return worker;
}

export {};
export async function processInboundMessage(event: WhatsAppInboundEvent, audioOptions: { finalAttempt?: boolean } = {}) {
  logger.debug("whatsapp.inbound.processing_started", {
    providerMessageId: event.providerMessageId,
    contentType: event.content.type,
  });

  const abuse = await inboundWhatsAppAbuseAdmissionService.admitRaw({
    providerMessageId: event.providerMessageId,
    customerPhone: event.customerPhone,
  });
  if (abuse.kind !== "allowed") {
    logger.debug("whatsapp.inbound.processing_stopped", {
      providerMessageId: event.providerMessageId,
      reason: "raw-abuse-admission-denied",
    });
    return;
  }

  const route = await recoveryRoutingService.resolveInboundMessage(event);

  logger.debug("whatsapp.inbound.route_resolved", {
    providerMessageId: event.providerMessageId,
    routeKind: route.kind,
    ...routeIdentifiers(route),
  });

  if (route.kind === "ignored") {
    logger.debug("whatsapp.inbound.processing_stopped", {
      providerMessageId: event.providerMessageId,
      reason: "route-ignored",
    });
    return;
  }
  if (route.kind === "guidance") {
    await sendRoutingGuidance(event, route.reason);
    logger.debug("whatsapp.inbound.guidance_sent", {
      providerMessageId: event.providerMessageId,
      reason: route.reason,
    });
    return;
  }

  if (route.kind === "resolved") {
    await checkoutRecoveryService.recordExternalActivity(
      route.checkoutRecoveryId,
      new Date(event.occurredAt),
    );
  }

  const content = event.content;
  if (content.type === "audio") {
    if (!("conversationId" in route) || !("shopId" in route) || !route.conversationId || !route.shopId) return;
    const result = await inboundWhatsAppAudioService.process(event, route.conversationId, audioOptions);
    if (result.kind === "completed") {
      const state = await conversationService.getTurnState(route.conversationId);
      logger.debug("whatsapp.inbound.audio_ready_for_turn", {
        providerMessageId: event.providerMessageId,
        conversationId: route.conversationId,
        observedVersion: state.inboundVersion,
      });
      await conversationTurnProcessor.enqueue(route.conversationId, state.inboundVersion);
    } else if (result.fallback) {
      await outboundWhatsAppAdmissionService.sendText({
        shopId: route.shopId,
        conversationId: route.conversationId,
        idempotencyKey: `voice-fallback:${event.providerMessageId}`,
        senderType: "AUTOMATION",
        to: event.customerPhone,
        text: result.fallback,
      });
      logger.debug("whatsapp.inbound.audio_fallback_sent", {
        providerMessageId: event.providerMessageId,
        conversationId: route.conversationId,
      });
    }
    return;
  }

  if (content.type === "unsupported") {
    if (!("conversationId" in route)) return;
    const conversationId = route.conversationId;
    if (!conversationId) return;
    const received = await conversationService.receiveMessage({
      conversationId,
      providerMessageId: event.providerMessageId,
      inReplyToProviderId: event.contextMessageId,
      content: `[Unsupported WhatsApp content: ${content.providerType.slice(0, 64)}]`,
      occurredAt: new Date(event.occurredAt),
    });
    logger.debug("whatsapp.inbound.persisted", {
      providerMessageId: event.providerMessageId,
      conversationId,
      observedVersion: received.version,
      duplicate: received.duplicate,
      contentType: "unsupported",
    });
    if (!received.duplicate) {
      await prisma.conversationMessage.update({
        where: { providerMessageId: event.providerMessageId },
        data: { contentType: "UNSUPPORTED" },
      });
    }
    return;
  }

  const received = await conversationService.receiveMessage({
    conversationId: route.conversationId,

    providerMessageId: event.providerMessageId,

    inReplyToProviderId: event.contextMessageId,

    content: content.text,
    occurredAt: new Date(event.occurredAt),
  });

  logger.debug("whatsapp.inbound.persisted", {
    providerMessageId: event.providerMessageId,
    conversationId: route.conversationId,
    observedVersion: received.version,
    duplicate: received.duplicate,
    contentType: "text",
  });

  if (received.duplicate) {
    logger.debug("whatsapp.inbound.duplicate_repair_requested", {
      providerMessageId: event.providerMessageId,
      conversationId: route.conversationId,
      observedVersion: received.version,
    });
  }

  await conversationTurnProcessor.enqueue(
    route.conversationId,
    received.version,
  );
}

function isContinuingRecoveryStatus(status: string | null | undefined): boolean {
  return status === "MESSAGE_SENT" || status === "ENGAGED";
}

export async function processInboundJobData(input: unknown, jobId?: string, audioOptions: { finalAttempt?: boolean } = {}) {
  const parsed = safeParseNormalizedWhatsAppInboundMessage(input);
  if (!parsed.success) {
    logger.warn("whatsapp.inbound.invalid_job", {
      jobId: normalizeJobId(jobId),
    });
    return;
  }
  await observeConversationTurn(
    "whatsapp",
    () => processInboundMessage(parsed.data, audioOptions),
    conversationTurnObservation,
  );
}

function normalizeJobId(jobId: string | undefined): string | null {
  return typeof jobId === "string" ? jobId.slice(0, 192) : null;
}

function boundedError(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return {
      errorName: error.name.slice(0, 64),
      errorMessage: error.message.slice(0, 256),
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error).slice(0, 256),
  };
}

function routeIdentifiers(route: Awaited<ReturnType<typeof recoveryRoutingService.resolveInboundMessage>>): {
  conversationId?: string | null;
  checkoutRecoveryId?: string | null;
  shopId?: string | null;
} {
  return {
    ...("conversationId" in route ? { conversationId: route.conversationId ?? null } : {}),
    ...("checkoutRecoveryId" in route ? { checkoutRecoveryId: route.checkoutRecoveryId ?? null } : {}),
    ...("shopId" in route ? { shopId: route.shopId ?? null } : {}),
  };
}

export async function loadConversationTurn(
  conversationId: string,
  pendingTurnStartedAt: Date,
) {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: {
      id: true,
      type: true,
      shopId: true,
      customer: { select: { phone: true, id: true, firstName: true } },
      shop: { select: { domain: true, status: true } },
      checkoutRecoveryId: true,
      checkoutRecovery: {
        select: {
          id: true,
          shopId: true,
          status: true,
          shop: { select: { domain: true, status: true } },
          customer: { select: { phone: true, id: true, firstName: true } },
        },
      },
      messages: {
        where: {
          OR: [
            { contentType: { not: "AUDIO" }, createdAt: { gte: pendingTurnStartedAt } },
            { contentType: "AUDIO", transcriptionCompletedAt: { gte: pendingTurnStartedAt } },
          ],
          direction: "INBOUND",
          senderType: "CUSTOMER",
        },
        select: { inReplyToProviderId: true },
      },
    },
  });
  const shopId = conversation.checkoutRecovery?.shopId;
  const to =
    conversation.checkoutRecovery?.customer?.phone;
  const shopStatus =
    conversation.checkoutRecovery?.shop?.status;
  const recoveryStatus = conversation.checkoutRecovery?.status;
  const executionScope = isContinuingRecoveryStatus(recoveryStatus)
    ? "recovery"
    : "general";
  if (
    shopId &&
    (shopStatus !== "ACTIVE" ||
      !(await shopExecutionEligibilityService.isShopExecutionActive(
        shopId,
        executionScope,
      )))
  ) {
    return {
      shopId,
      to: to ?? "",
      customerPhone: to ?? "",
      conversationType: conversation.type,
      checkoutRecoveryId: conversation.checkoutRecoveryId,
      hasReplyContext: false,
      context: null,
      languageMessage: "",
      shopUnavailable: true,
    };
  }
  if (!shopId || !to)
    throw new Error(`Conversation ${conversationId} has no outbound ownership`);

  const settledMetadata = {
    customerPhone: to,
    conversationType: conversation.type,
    checkoutRecoveryId: conversation.checkoutRecoveryId,
    hasReplyContext: conversation.messages.some(
      (message) => message.inReplyToProviderId !== null,
    ),
  } as const;

  if (!conversation.checkoutRecoveryId) throw new Error("Recovery ownership is required");
  const context = await checkoutRecoveryService.getAgentContext({
    checkoutRecoveryId: conversation.checkoutRecoveryId, conversationId, pendingTurnStartedAt,
  });

  return {
    shopId,
    to,
    ...settledMetadata,
    context,
    ...(context.conversation.oversized ? { clarificationText: "Please send a shorter question so I can help with your basket." } : {}),
    languageMessage: context.conversation.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n"),
  };
}