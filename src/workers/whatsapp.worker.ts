import { Worker } from "bullmq";

import { connectionRedis } from "../lib/redis.js";

import { runCommerceAgent } from "../agents/commerce.agent.js";
import type { RecoveryAgentContext } from "../agents/types.js";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { conversationService } from "../services/conversation.service.js";
import { recoveryRoutingService } from "../services/recovery-routing.service.js";
import { whatsAppService } from "../services/whatsapp.service.js";

export const whatsappWorker =
  new Worker<WhatsAppInboundEvent>(
    "whatsapp-events",

    async (job) => {
      switch (job.name) {
        case "message-received":
          await processInboundMessage(job.data);
          return;

        default:
          throw new Error(
            `Unknown WhatsApp job: ${job.name}`,
          );
      }
    },

    {
      connection: connectionRedis,
      concurrency: 20,
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

  if (route.kind === "product-only") {
    const context = buildProductOnlyContext(
      route,
      event,
    );

    const result =
      await runCommerceAgent(context);

    await whatsAppService.sendWhatsAppText({
      to: event.customerPhone,
      text: result.text,
    });

    return;
  }

  if (route.kind === "clarify") {
    const options = route.recoveries
      .map((recovery) =>
        `- ${recovery.checkoutToken}${recovery.totalPrice ? ` (${recovery.totalPrice})` : ""}`,
      )
      .join("\n");

    await whatsAppService.sendWhatsAppText({
      to: event.customerPhone,
      text:
        "I found more than one active abandoned basket for your account. Please tell me which one you mean by replying with the basket reference below:\n\n" +
        options,
    });

    return;
  }

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

  const result =
    await runCommerceAgent(context);

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

    return;
  }

  const outboundMessage =
    await conversationService.createPendingAgentMessage(
      route.conversationId,
      result.text,
    );

  const sent =
    await whatsAppService.sendWhatsAppText({
      to: event.customerPhone,
      text: result.text,
    });

  await conversationService.markMessageSent(
    outboundMessage.id,
    sent.providerMessageId,
  );

  await conversationService.markProcessed(
    route.conversationId,
    received.version,
  );
}

function buildProductOnlyContext(
  route: {
    kind: "product-only";
    customerPhone: string;
    shop?: string;
    customerId?: string;
  },
  event: WhatsAppInboundEvent,
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
      conversationId: `product-only-${event.providerMessageId}`,
      shop: route.shop ?? "unknown-shop",
      type: "PRODUCT_DISCOVERY",
      summary: null,
      version: 0,
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
