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
import { outboundWhatsAppAdmissionService } from "../services/outbound-whatsapp-admission.service.js";
import { recoveryRoutingService } from "../services/recovery-routing.service.js";
import { whatsappProviderStatusService } from "../services/whatsapp-provider-status.service.js";
import {
  ConversationTurnProcessor,
  type ConversationTurnJob,
} from "../services/conversation-turn-processor.service.js";

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
  loadTurn: loadConversationTurn,
  runAgent: runCommerceAgent,
  getResult: (result) => result,
});

export const whatsappWorker = new Worker<
  WhatsAppInboundEvent | ConversationTurnJob
>(
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
    concurrency: 20,
    telemetry: bullMQTelemetry,
  },
);

async function processInboundMessage(event: WhatsAppInboundEvent) {
  console.log("Processing WhatsApp message", event.providerMessageId);

  const route = await recoveryRoutingService.resolveInboundMessage(event);

  if (route.kind === "product-only" || route.kind === "standalone") {
    if (!route.shopId || !route.conversationId) return;

    const received = await conversationService.receiveMessage({
      conversationId: route.conversationId,
      providerMessageId: event.providerMessageId,
      inReplyToProviderId: event.contextMessageId,
      content: event.text ?? "",
    });

    if (received.duplicate) return;

    await conversationTurnProcessor.enqueue(
      route.conversationId,
      received.version,
    );
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

    await conversationTurnProcessor.enqueue(
      route.conversationId,
      received.version,
    );
    return;
  }

  if (route.kind === "unresolved") return;

  const received = await conversationService.receiveMessage({
    conversationId: route.conversationId,

    providerMessageId: event.providerMessageId,

    inReplyToProviderId: event.contextMessageId,

    content: event.text ?? "",
  });

  if (received.duplicate) {
    console.log("Ignoring duplicate WhatsApp message", event.providerMessageId);

    return;
  }

  await conversationTurnProcessor.enqueue(
    route.conversationId,
    received.version,
  );
}

async function loadConversationTurn(
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
  const to =
    conversation.checkoutRecovery?.customer?.phone ??
    conversation.customer?.phone;
  if (!shopId || !to)
    throw new Error(`Conversation ${conversationId} has no outbound ownership`);

  const clarification =
    await recoveryRoutingService.getCurrentClarification(conversationId);
  if (clarification?.kind === "unresolved") {
    return {
      shopId,
      to,
      context: null,
      languageMessage: "",
      handledWithoutAgent: true,
    };
  }
  if (clarification?.kind === "clarify") {
    return {
      shopId,
      to,
      context: null,
      languageMessage: "",
      clarificationText: formatClarification(clarification.recoveries),
    };
  }

  const context =
    clarification?.kind === "resolved"
      ? await checkoutRecoveryService.getAgentContextForStandaloneConversation({
          checkoutRecoveryId: clarification.checkoutRecoveryId,
          conversationId,
          pendingTurnStartedAt,
        })
      : conversation.checkoutRecoveryId
        ? await checkoutRecoveryService.getAgentContext({
            checkoutRecoveryId: conversation.checkoutRecoveryId,
            conversationId,
            pendingTurnStartedAt,
          })
        : await buildStandaloneAgentContext(conversation, pendingTurnStartedAt);

  return {
    shopId,
    to,
    context,
    languageMessage: context.conversation.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n"),
  };
}

function formatClarification(
  recoveries: Array<{ checkoutToken: string; totalPrice: string | null }>,
): string {
  const options = recoveries
    .map(
      ({ checkoutToken, totalPrice }) =>
        `- ${checkoutToken}${totalPrice ? ` (${totalPrice})` : ""}`,
    )
    .join("\n");
  return `I found more than one recent basket. Which one would you like help with?\n${options}`;
}

async function buildStandaloneAgentContext(
  conversation: {
    id: string;
    shop: { domain: string } | null;
    customer: {
      id: string;
      phone: string | null;
      firstName: string | null;
    } | null;
  },
  pendingTurnStartedAt: Date,
): Promise<RecoveryAgentContext> {
  const snapshot = await conversationService.getAgentSnapshot(
    conversation.id,
    pendingTurnStartedAt,
  );
  return {
    shop: conversation.shop?.domain ?? snapshot.shop,
    recovery: {
      id: "standalone",
      status: "ENGAGED",
      checkoutToken: "standalone",
      completedAt: null,
      totalPrice: null,
    },
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

whatsappWorker.on("completed", (job) => {
  console.log(`WhatsApp job ${job.id} completed successfully`);
});

whatsappWorker.on("failed", (job, error) => {
  console.error(`WhatsApp job ${job?.id} failed`, error);
});

whatsappWorker.on("error", (error) => {
  console.error("WhatsApp worker error", error);
});

console.log("WhatsApp worker started");
