import { Queue, Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { observeConversationTurn } from "@modainteract/moda-interact-shared/observability/genai";

import { connectionRedis } from "../lib/redis.js";
import prisma from "../lib/db.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";

import { runCommerceAgent } from "../agents/commerce.agent.js";
import type { RecoveryAgentContext } from "../agents/types.js";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { conversationService } from "../services/conversation.service.js";
import {
  outboundWhatsAppAdmissionService,
  runCommerceAgentAfterAdmission,
} from "../services/outbound-whatsapp-admission.service.js";
import type { OutboundAdmissionResult } from "../services/outbound-whatsapp-admission.service.js";
import { recoveryRoutingService } from "../services/recovery-routing.service.js";

const QUIET_WINDOW_MS = 3_000;
const MAX_SETTLE_WINDOW_MS = 10_000;
const PROCESSING_LEASE_MS = 120_000;

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-messaging-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "whatsapp",
  queueName: "whatsapp-events",
  jobNames: ["message-received", "process-conversation-turn"],
} as const;
const conversationTurnObservation = {
  mapException: () => ({
    name: "InboundTurnError",
    message: "Inbound conversation turn failed",
  }),
} as const;

type ConversationTurnJob = {
  conversationId: string;
  observedVersion: number;
};

const whatsappQueue = new Queue("whatsapp-events", {
  connection: connectionRedis,
});

export const whatsappWorker =
  new Worker<WhatsAppInboundEvent | ConversationTurnJob>(
    "whatsapp-events",

    async (job) =>
      observeWorkerJob(workerMetricDefinition, job, async () => {
        switch (job.name) {
          case "message-received":
            await observeConversationTurn(
              "whatsapp",
              () => processInboundMessage(job.data as WhatsAppInboundEvent),
              conversationTurnObservation,
            );
            return;

          case "process-conversation-turn":
            await observeConversationTurn(
              "whatsapp",
              () => processConversationTurn(job.data as ConversationTurnJob),
              conversationTurnObservation,
            );
            return;

          default:
            throw new Error(
              `Unknown WhatsApp job: ${job.name}`,
            );
        }
      }),

    {
      connection: connectionRedis,
      concurrency: 20,
      telemetry: bullMQTelemetry,
    },
  );

async function processInboundMessage(
  event: WhatsAppInboundEvent,
) {
  console.log(
    "Processing WhatsApp message",
    event.providerMessageId,
  );

  const route =
    await recoveryRoutingService.resolveInboundMessage(
      event,
    );

  if (route.kind === "product-only" || route.kind === "standalone") {
    if (!route.shopId || !route.conversationId) return;

    const received = await conversationService.receiveMessage({
      conversationId: route.conversationId,
      providerMessageId: event.providerMessageId,
      inReplyToProviderId: event.contextMessageId,
      content: event.text ?? "",
    });

    if (received.duplicate) return;

    await enqueueConversationTurn(route.conversationId, received.version);
    return;
  }

  if (route.kind === "clarify") {
    const received = await conversationService.receiveMessage({
      conversationId: route.conversationId,
      providerMessageId: event.providerMessageId,
      inReplyToProviderId: event.contextMessageId,
      content: event.text ?? "",
    });

    if (received.duplicate) return;

    await enqueueConversationTurn(route.conversationId, received.version);
    return;
  }

  if (route.kind === "unresolved") return;

  const received =
    await conversationService.receiveMessage({
      conversationId:
        route.conversationId,

      providerMessageId:
        event.providerMessageId,

      inReplyToProviderId:
        event.contextMessageId,

      content:
        event.text ?? "",
    });

  if (received.duplicate) {
    console.log(
      "Ignoring duplicate WhatsApp message",
      event.providerMessageId,
    );

    return;
  }

  await enqueueConversationTurn(route.conversationId, received.version);
}

async function enqueueConversationTurn(
  conversationId: string,
  observedVersion: number,
  retrySuffix?: string,
): Promise<void> {
  const state = await conversationService.getTurnState(conversationId);
  if (!state.pendingTurnStartedAt || !state.lastInboundAt) return;

  const now = Date.now();
  const quietDeadline = state.lastInboundAt.getTime() + QUIET_WINDOW_MS;
  const maximumDeadline = state.pendingTurnStartedAt.getTime() + MAX_SETTLE_WINDOW_MS;
  const delay = Math.max(0, Math.min(quietDeadline, maximumDeadline) - now);

  await whatsappQueue.add(
    "process-conversation-turn",
    { conversationId, observedVersion },
    {
      jobId: retrySuffix
        ? `conversation-turn:${conversationId}:${observedVersion}:${retrySuffix}`
        : `conversation-turn:${conversationId}:${observedVersion}`,
      delay,
    },
  );
}

async function processConversationTurn({
  conversationId,
  observedVersion,
}: ConversationTurnJob): Promise<void> {
  const state = await conversationService.getTurnState(conversationId);
  if (
    observedVersion < state.inboundVersion ||
    observedVersion <= state.lastProcessedVersion ||
    !state.pendingTurnStartedAt
  ) {
    return;
  }

  const now = new Date();
  const quietDeadline = (state.lastInboundAt?.getTime() ?? now.getTime()) + QUIET_WINDOW_MS;
  const maximumDeadline = state.pendingTurnStartedAt.getTime() + MAX_SETTLE_WINDOW_MS;
  if (now.getTime() < quietDeadline && now.getTime() < maximumDeadline) {
    await enqueueConversationTurn(
      conversationId,
      observedVersion,
      `settle:${now.getTime()}`,
    );
    return;
  }

  if (!await conversationService.claimTurn(conversationId, observedVersion, now)) {
    await whatsappQueue.add(
      "process-conversation-turn",
      { conversationId, observedVersion },
      { jobId: `conversation-turn-retry:${conversationId}:${observedVersion}:${now.getTime()}`, delay: 250 },
    );
    return;
  }

  let admission: OutboundAdmissionResult | null = null;
  try {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        id: true,
        type: true,
        shopId: true,
        customer: { select: { phone: true, id: true, firstName: true } },
        shop: { select: { domain: true } },
        checkoutRecoveryId: true,
        checkoutRecovery: {
          select: {
            id: true,
            shopId: true,
            customer: { select: { phone: true, id: true, firstName: true } },
          },
        },
      },
    });
    const shopId = conversation.checkoutRecovery?.shopId ?? conversation.shopId;
    const to = conversation.checkoutRecovery?.customer?.phone ?? conversation.customer?.phone;
    if (!shopId || !to) throw new Error(`Conversation ${conversationId} has no outbound ownership`);

    const context = conversation.checkoutRecoveryId
      ? await checkoutRecoveryService.getAgentContext({
          checkoutRecoveryId: conversation.checkoutRecoveryId,
          conversationId,
          pendingTurnStartedAt: state.pendingTurnStartedAt,
        })
      : await buildStandaloneAgentContext(conversation, state.pendingTurnStartedAt);

    const reserved = await outboundWhatsAppAdmissionService.reserve({
      shopId,
      conversationId,
      idempotencyKey: `agent:${conversationId}:${observedVersion}`,
      senderType: "AGENT",
    });
    admission = reserved;
    if (reserved.kind !== "admitted") {
      await conversationService.completeTurn(conversationId, observedVersion);
      return;
    }
    const admitted = reserved;

    const result = await runCommerceAgentAfterAdmission({
      admission: admitted,
      to,
      context,
      runAgent: runCommerceAgent,
      sendPreparedText: (input) => outboundWhatsAppAdmissionService.sendPreparedText(input),
      failPrepared: (messageId) => outboundWhatsAppAdmissionService.failPrepared(messageId),
    });
    if (result === null) {
      await conversationService.completeTurn(conversationId, observedVersion);
      return;
    }

    await conversationService.applyDetectedLanguage({
      conversationId,
      version: observedVersion,
      message: context.conversation.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n"),
      detectedLanguageTag: result.detectedLanguageTag,
      detectedLanguageConfidence: result.detectedLanguageConfidence,
    });

    if (await conversationService.hasChanged(conversationId, observedVersion)) {
      await outboundWhatsAppAdmissionService.failPrepared(admitted.messageId);
      await conversationService.releaseTurn(conversationId, observedVersion);
      await enqueueConversationTurn(conversationId, (await conversationService.getTurnState(conversationId)).inboundVersion);
      return;
    }

    await outboundWhatsAppAdmissionService.sendPreparedText({ ...admitted, to, text: result.replyText });
    await conversationService.completeTurn(conversationId, observedVersion);
  } catch (error) {
    if (admission?.kind === "admitted") {
      await outboundWhatsAppAdmissionService.failPrepared(admission.messageId).catch(() => undefined);
    }
    await conversationService.releaseTurn(conversationId, observedVersion);
    throw error;
  }
}

async function buildStandaloneAgentContext(
  conversation: {
    id: string;
    type: RecoveryAgentContext["conversation"]["type"];
    shop: { domain: string } | null;
    customer: { id: string; phone: string | null; firstName: string | null } | null;
  },
  pendingTurnStartedAt: Date,
): Promise<RecoveryAgentContext> {
  const snapshot = await conversationService.getAgentSnapshot(conversation.id, pendingTurnStartedAt);
  return {
    shop: conversation.shop?.domain ?? snapshot.shop,
    recovery: { id: "standalone", status: "ENGAGED", checkoutToken: "standalone", completedAt: null, totalPrice: null },
    customer: conversation.customer,
    conversation: snapshot,
  };
}

function buildProductOnlyContext(
  route: {
    kind: "product-only" | "standalone";
    customerPhone: string;
    shop?: string;
    customerId?: string;
    type: "PRODUCT_DISCOVERY" | "PRODUCT_SUPPORT";
  },
  event: WhatsAppInboundEvent,
  conversationId: string,
): RecoveryAgentContext {
  return {
    shop: route.shop ?? "unknown-shop",
    recovery: {
      id: "product-only",
      status: "ENGAGED",
      checkoutToken: "product-only",
      completedAt: null,
      totalPrice: null,
    },
    customer: route.customerId
      ? {
          id: route.customerId,
          phone: route.customerPhone,
          firstName: null,
        }
      : null,
    conversation: {
      conversationId,
      shop: route.shop ?? "unknown-shop",
      type: route.type,
      summary: null,
      version: 0,
      languageTag: null,
      languageSource: null,
      messages: [
        {
          role: "user",
          content: event.text ?? "",
        },
      ],
    },
  };
}

whatsappWorker.on(
  "completed",
  (job) => {
    console.log(
      `WhatsApp job ${job.id} completed successfully`,
    );
  },
);

whatsappWorker.on(
  "failed",
  (job, error) => {
    console.error(
      `WhatsApp job ${job?.id} failed`,
      error,
    );
  },
);

whatsappWorker.on(
  "error",
  (error) => {
    console.error(
      "WhatsApp worker error",
      error,
    );
  },
);

console.log("WhatsApp worker started");
