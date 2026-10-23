import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";
import { whatsAppContactOptOutService } from "./whatsapp-contact-opt-out.service.js";
import { inboundWhatsAppAbuseAdmissionService } from "./inbound-whatsapp-abuse-admission.service.js";
import { recoveryRoutingService } from "./recovery-routing.service.js";
import { sendRoutingGuidance } from "./routing-guidance.service.js";
import { checkoutRecoveryService } from "./checkout-recovery.service.js";
import { inboundWhatsAppAudioService } from "./inbound-whatsapp-audio.service.js";
import { conversationService } from "./conversation.service.js";
import { outboundWhatsAppAdmissionService } from "./outbound-whatsapp-admission.service.js";
import { AiTurnOwnershipService } from "./recovery-conversation/ai-turn-ownership.service.js";
import { recipientReachabilityPositiveService } from "./recipient-reachability-positive.service.js";

export async function processRoutedInboundMessage(
  event: WhatsAppInboundEvent,
  audioOptions: { finalAttempt?: boolean },
  log: StructuredLogger,
  enqueueTurn: (conversationId: string, version: number) => Promise<unknown>,
) {
  log.debug("whatsapp.inbound.processing_started", {
    providerMessageId: event.providerMessageId,
    contentType: event.content.type,
  });

  // Negative customer STOP is an authenticated, priority operation. Do not let
  // raw abuse admission, moderation or ignored/guidance routing discard it.
  if (await whatsAppContactOptOutService.handleInbound(event)) return;

  const abuse = await inboundWhatsAppAbuseAdmissionService.admitRaw({
    providerMessageId: event.providerMessageId,
    customerPhone: event.customerPhone,
  });
  if (abuse.kind !== "allowed") {
    log.debug("whatsapp.inbound.processing_stopped", {
      providerMessageId: event.providerMessageId,
      reason: "raw-abuse-admission-denied",
    });
    return;
  }

  const route = await recoveryRoutingService.resolveInboundMessage(event);

  log.debug("whatsapp.inbound.route_resolved", {
    providerMessageId: event.providerMessageId,
    routeKind: route.kind,
    ...routeIdentifiers(route),
  });

  if (route.kind === "ignored") {
    log.debug("whatsapp.inbound.processing_stopped", {
      providerMessageId: event.providerMessageId,
      reason: "route-ignored",
    });
    return;
  }
  if (route.kind === "guidance") {
    await sendRoutingGuidance(event, route.reason);
    log.debug("whatsapp.inbound.guidance_sent", {
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
    const audioOwnership = "conversationId" in route && route.conversationId
      ? await new AiTurnOwnershipService().readTurnOwnership(route.conversationId)
      : null;
    if (!("conversationId" in route) || !("shopId" in route) || !route.conversationId || !route.shopId) return;
    const result = await inboundWhatsAppAudioService.process(event, route.conversationId, audioOptions);
    await recipientReachabilityPositiveService.fromRoutedInbound({
      shopId: route.shopId, conversationId: route.conversationId,
      providerMessageId: event.providerMessageId, customerPhone: event.customerPhone,
    });
    if (result.kind === "completed") {
      const state = await conversationService.getTurnState(route.conversationId);
      log.debug("whatsapp.inbound.audio_ready_for_turn", {
        providerMessageId: event.providerMessageId,
        conversationId: route.conversationId,
        observedVersion: state.inboundVersion,
      });
      await enqueueTurn(route.conversationId, state.inboundVersion);
    } else if (result.fallback) {
      await outboundWhatsAppAdmissionService.sendText({
        shopId: route.shopId,
        conversationId: route.conversationId,
        idempotencyKey: `voice-fallback:${event.providerMessageId}`,
        senderType: "AUTOMATION",
        ...(audioOwnership ? { expectedControlRevision: audioOwnership.revision } : {}),
        to: event.customerPhone,
        text: result.fallback,
      });
      log.debug("whatsapp.inbound.audio_fallback_sent", {
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
    log.debug("whatsapp.inbound.persisted", {
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
    await recipientReachabilityPositiveService.fromRoutedInbound({
      shopId: route.shopId, conversationId,
      providerMessageId: event.providerMessageId, customerPhone: event.customerPhone,
    });
    return;
  }

  const received = await conversationService.receiveMessage({
    conversationId: route.conversationId,

    providerMessageId: event.providerMessageId,

    inReplyToProviderId: event.contextMessageId,

    content: content.text,
    occurredAt: new Date(event.occurredAt),
  });

  log.debug("whatsapp.inbound.persisted", {
    providerMessageId: event.providerMessageId,
    conversationId: route.conversationId,
    observedVersion: received.version,
    duplicate: received.duplicate,
    contentType: "text",
  });

  if (received.duplicate) {
    log.debug("whatsapp.inbound.duplicate_repair_requested", {
      providerMessageId: event.providerMessageId,
      conversationId: route.conversationId,
      observedVersion: received.version,
    });
  }

  await recipientReachabilityPositiveService.fromRoutedInbound({
    shopId: route.shopId, conversationId: route.conversationId,
    providerMessageId: event.providerMessageId, customerPhone: event.customerPhone,
  });

  await enqueueTurn(
    route.conversationId,
    received.version,
  );
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
