import { Worker } from "bullmq";



import { connectionRedis } from "../lib/redis.js";

import { conversationService } from "../services/conversation.service.js";
import { recoveryRoutingService } from "../services/recovery-routing.service.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";

import { whatsAppService } from "../services/whatsapp.service.js";
import { runCommerceAgent } from "../agents/commerce.agent.js";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";


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

  /*
   * 1. Work out which CheckoutRecovery /
   * Conversation this WhatsApp message belongs to.
   *
   * Exact reply:
   *
   * contextMessageId
   *   -> outbound ConversationMessage
   *   -> Conversation
   *   -> CheckoutRecovery
   *
   * No contextMessageId:
   *   -> fallback resolution using customerPhone
   */
  const route =
    await recoveryRoutingService.resolveInboundMessage(
      event,
    );

  /*
   * 2. Persist the inbound message.
   *
   * This also increments inboundVersion.
   */
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

  /*
   * Meta/BullMQ may deliver the same event twice.
   */
  if (received.duplicate) {
    console.log(
      "Ignoring duplicate WhatsApp message",
      event.providerMessageId,
    );

    return;
  }

  /*
   * 3. Rebuild CURRENT recovery context from Postgres.
   *
   * Do not trust state copied into the queue message.
   *
   * The checkout may have become COMPLETED since the
   * original WhatsApp recovery message was sent.
   */
  const context =
    await checkoutRecoveryService.getAgentContext({
      checkoutRecoveryId:
        route.checkoutRecoveryId,

      conversationId:
        route.conversationId,
    });

  /*
   * 4. Run the commerce agent.
   */
  const result =
    await runCommerceAgent(context);

  /*
   * 5. Did another customer message arrive while
   * Groq was processing?
   *
   * If yes, don't send this potentially stale answer.
   *
   * The newer inbound message has its own BullMQ job,
   * which will process the latest conversation state.
   */
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

  /*
   * 6. Persist our intent to send BEFORE calling Meta.
   */
  const outboundMessage =
    await conversationService.createPendingAgentMessage(
      route.conversationId,
      result.text,
    );

  /*
   * 7. Send through Moda's WhatsApp account.
   *
   * customerPhone is the destination.
   */
  const sent =
    await whatsAppService.sendWhatsAppText({
      to: event.customerPhone,
      text: result.text,
    });

  /*
   * 8. Link Meta's wamid back to our internal message.
   */
  await conversationService.markMessageSent(
    outboundMessage.id,
    sent.providerMessageId,
  );

  /*
   * 9. Record that this inbound conversation version
   * has now been successfully processed.
   */
  await conversationService.markProcessed(
    route.conversationId,
    received.version,
  );
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