import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { observeConversationTurn } from "@modainteract/moda-interact-shared/observability/genai";

import { connectionRedis } from "../lib/redis.js";
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
import { recoveryRoutingService } from "../services/recovery-routing.service.js";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-messaging-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "whatsapp",
  queueName: "whatsapp-events",
  jobNames: ["message-received"],
} as const;
const conversationTurnObservation = {
  mapException: () => ({
    name: "InboundTurnError",
    message: "Inbound conversation turn failed",
  }),
} as const;

export const whatsappWorker =
  new Worker<WhatsAppInboundEvent>(
    "whatsapp-events",

    async (job) =>
      observeWorkerJob(workerMetricDefinition, job, async () => {
        switch (job.name) {
          case "message-received":
            await observeConversationTurn(
              "whatsapp",
              () => processInboundMessage(job.data),
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

    const admission = await outboundWhatsAppAdmissionService.reserve({
      shopId: route.shopId,
      conversationId: route.conversationId,
      idempotencyKey: `agent:${event.providerMessageId}`,
      senderType: "AGENT",
    });
    if (admission.kind !== "admitted") return;

    const context = buildProductOnlyContext(
      route,
      event,
      route.conversationId,
    );

    const result = await runCommerceAgentAfterAdmission({
      admission,
      to: event.customerPhone,
      context,
      runAgent: runCommerceAgent,
      sendPreparedText: (input) =>
        outboundWhatsAppAdmissionService.sendPreparedText(input),
      failPrepared: (messageId) =>
        outboundWhatsAppAdmissionService.failPrepared(messageId),
    });
    if (result === null) return;

    await outboundWhatsAppAdmissionService.sendPreparedText({
      ...admission,
      to: event.customerPhone,
      text: result.replyText,
    });

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

    const options = route.recoveries
      .map((recovery) =>
        `- ${recovery.checkoutToken}${recovery.totalPrice ? ` (${recovery.totalPrice})` : ""}`,
      )
      .join("\n");

    await outboundWhatsAppAdmissionService.sendText({
      shopId: route.shopId,
      conversationId: route.conversationId,
      idempotencyKey: `clarify:${event.providerMessageId}`,
      senderType: "AUTOMATION",
      to: event.customerPhone,
      text:
        "I found more than one active abandoned basket for your account. Please tell me which one you mean by replying with the basket reference below:\n\n" +
        options,
    });

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

  const context =
    await checkoutRecoveryService.getAgentContext({
      checkoutRecoveryId:
        route.checkoutRecoveryId,

      conversationId:
        route.conversationId,
    });

  const admission = await outboundWhatsAppAdmissionService.reserve({
    shopId: route.shopId,
    conversationId: route.conversationId,
    idempotencyKey: `agent:${route.conversationId}:${received.version}`,
    senderType: "AGENT",
  });
  if (admission.kind !== "admitted") {
    await conversationService.markProcessed(
      route.conversationId,
      received.version,
    );
    return;
  }

  const result = await runCommerceAgentAfterAdmission({
    admission,
    to: event.customerPhone,
    context,
    runAgent: runCommerceAgent,
    sendPreparedText: (input) =>
      outboundWhatsAppAdmissionService.sendPreparedText(input),
    failPrepared: (messageId) =>
      outboundWhatsAppAdmissionService.failPrepared(messageId),
  });
  if (result === null) {
    await conversationService.markProcessed(
      route.conversationId,
      received.version,
    );
    return;
  }

  await conversationService.applyDetectedLanguage({
    conversationId: route.conversationId,
    version: received.version,
    message: event.text ?? "",
    detectedLanguageTag: result.detectedLanguageTag,
    detectedLanguageConfidence: result.detectedLanguageConfidence,
  });

  const changed =
    await conversationService.hasChanged(
      route.conversationId,
      received.version,
    );

  if (changed) {
    console.log(
      "Conversation changed while agent was processing; dropping stale response",
      {
        conversationId:
          route.conversationId,

        processedVersion:
          received.version,
      },
    );

    await outboundWhatsAppAdmissionService.failPrepared(admission.messageId);
    return;
  }

  await outboundWhatsAppAdmissionService.sendPreparedText({
    ...admission,
      to: event.customerPhone,
      text: result.replyText,
  });

  await conversationService.markProcessed(
    route.conversationId,
    received.version,
  );
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
