import { Queue, Worker } from "bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { observeConversationTurn } from "@modainteract/moda-interact-shared/observability/genai";
import {
  safeParseNormalizedWhatsAppInboundMessage,
} from "@modainteract/moda-interact-shared/whatsapp";
import {
  META_TEMPLATE_STATUS_JOB,
  type MetaTemplateStatusObservationV2,
} from "@modainteract/moda-interact-shared/whatsapp-template-events";

import { connectionRedis } from "../lib/redis.js";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";
import { processRoutedInboundMessage } from "../services/whatsapp-inbound-processing.service.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";

import { runCommerceAgent } from "../agents/commerce.agent.js";
import type { RecoveryAgentContext } from "../agents/types.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { conversationService } from "../services/conversation.service.js";
import { moderationTurnGate } from "../services/conversation-moderation/moderation-turn-gate.js";
import { AiTurnOwnershipService } from "../services/recovery-conversation/ai-turn-ownership.service.js";
import { ConversationWrapperService } from "../services/conversation-wrappers/service.js";
import { inboundWhatsAppAbuseAdmissionService } from "../services/inbound-whatsapp-abuse-admission.service.js";
import { outboundWhatsAppAdmissionService } from "../services/outbound-whatsapp-admission.service.js";
import { whatsappProviderStatusService } from "../services/whatsapp-provider-status.service.js";
import { processTemplateStatusJob } from "../services/meta-template-management/status-job.js";
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
  jobNames: ["message-received", "message-status", "process-conversation-turn", META_TEMPLATE_STATUS_JOB],
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
  moderation: moderationTurnGate,
  ownership: new AiTurnOwnershipService(),
  admission: outboundWhatsAppAdmissionService,
  abuseAdmission: inboundWhatsAppAbuseAdmissionService,
  loadTurn: loadConversationTurn,
  runAgent: runCommerceAgent,
  aiWrapper: new ConversationWrapperService({ onMissingSlot: "passthrough", logger }),
  getResult: (result) => result,
  logger,
});

export function createWhatsappWorker() {
  const worker = new Worker<
  WhatsAppInboundEvent | ConversationTurnJob | MetaTemplateStatusObservationV2
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

        case META_TEMPLATE_STATUS_JOB:
          await processTemplateStatusJob(job.name, job.data, job.id);
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
export async function processInboundMessage(
  event: WhatsAppInboundEvent,
  audioOptions: { finalAttempt?: boolean } = {},
) {
  return processRoutedInboundMessage(event, audioOptions, logger,
    (conversationId, version) => conversationTurnProcessor.enqueue(conversationId, version));
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