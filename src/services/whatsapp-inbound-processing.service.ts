import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
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
  const messageDigest = createHash("sha256").update(event.providerMessageId).digest("hex").slice(0, 16);
  try {
    return await processRoutedInboundMessageInternal(event, audioOptions, log, enqueueTurn, messageDigest);
  } catch (error) {
    log.error("whatsapp.inbound.processing_failed", {
      messageDigest, stage: "processing", error,
    });
    throw error;
  }
}

async function processRoutedInboundMessageInternal(
  event: WhatsAppInboundEvent,
  audioOptions: { finalAttempt?: boolean },
  log: StructuredLogger,
  enqueueTurn: (conversationId: string, version: number) => Promise<unknown>,
  messageDigest: string,
) {
  log.debug("whatsapp.inbound.processing_started", {
    messageDigest,
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
      messageDigest,
      reason: "raw-abuse-admission-denied",
    });
    return;
  }

  let route = await recoveryRoutingService.resolveInboundMessage(event, log);

  if (route.kind === "resolved" && route.mode === "active" &&
      !(await recoveryRoutingService.isCurrentActiveRoute(route))) {
    route = { ...route, mode: "historical" };
    log.warn("whatsapp.inbound.route_became_historical", {
      ...routeIdentifiers(route), messageDigest, mode: "historical",
      stage: "before-persistence", reason: "RECOVERY_CLOSED_OR_SUPERSEDED",
    });
  }

  log.debug("whatsapp.inbound.route_resolved", {
    messageDigest,
    routeKind: route.kind,
    ...("mode" in route ? { mode: route.mode } : {}),
    ...routeIdentifiers(route),
  });

  if (route.kind === "ignored") {
    log.debug("whatsapp.inbound.processing_stopped", {
      messageDigest,
      reason: "route-ignored",
    });
    return;
  }
  if (route.kind === "guidance") {
    await sendRoutingGuidance(event, route.reason);
    log.debug("whatsapp.inbound.guidance_sent", {
      messageDigest,
      reason: route.reason,
    });
    return;
  }

  if (route.kind === "resolved" && route.mode === "active") {
    await checkoutRecoveryService.recordExternalActivity(
      route.checkoutRecoveryId,
      new Date(event.occurredAt),
    );
  }

  const content = event.content;
  if (content.type === "audio") {
    if (route.mode === "historical") {
      const reservation = await inboundWhatsAppAudioService.reserve(event, route.conversationId);
      if (reservation.conversationId !== route.conversationId) throw new Error("Inbound message ownership mismatch");
      await recipientReachabilityPositiveService.fromRoutedInbound({
        shopId: route.shopId, conversationId: route.conversationId,
        providerMessageId: event.providerMessageId, customerPhone: event.customerPhone,
      });
      log.info("whatsapp.inbound.historical_persisted", {
        ...routeIdentifiers(route), messageDigest, mode: route.mode, contentType: "audio",
      });
      return;
    }
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
      if (!(await recoveryRoutingService.isCurrentActiveRoute(route))) {
        log.warn("whatsapp.inbound.turn_suppressed", {
          ...routeIdentifiers(route), messageDigest, mode: route.mode,
          stage: "audio-completion", reason: "RECOVERY_CLOSED_OR_SUPERSEDED",
        });
        return;
      }
      const state = await conversationService.getTurnState(route.conversationId);
      log.debug("whatsapp.inbound.audio_ready_for_turn", {
        messageDigest,
        conversationId: route.conversationId,
        observedVersion: state.inboundVersion,
      });
      await enqueueTurn(route.conversationId, state.inboundVersion);
    } else if (result.fallback) {
      if (!(await recoveryRoutingService.isCurrentActiveRoute(route))) {
        log.warn("whatsapp.inbound.audio_fallback_suppressed", {
          ...routeIdentifiers(route), messageDigest, mode: route.mode,
          stage: "audio-fallback", reason: "RECOVERY_CLOSED_OR_SUPERSEDED",
        });
        return;
      }
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
        messageDigest,
        conversationId: route.conversationId,
      });
    }
    return;
  }

  if (content.type === "unsupported") {
    if (!("conversationId" in route)) return;
    const conversationId = route.conversationId;
    if (!conversationId) return;
    if (route.mode === "historical") {
      await persistHistoricalInbound({
        conversationId, providerMessageId: event.providerMessageId,
        inReplyToProviderId: event.contextMessageId,
        content: `[Unsupported WhatsApp content: ${content.providerType.slice(0, 64)}]`,
        occurredAt: new Date(event.occurredAt), contentType: "UNSUPPORTED",
      });
      await recipientReachabilityPositiveService.fromRoutedInbound({
        shopId: route.shopId, conversationId,
        providerMessageId: event.providerMessageId, customerPhone: event.customerPhone,
      });
      log.info("whatsapp.inbound.historical_persisted", {
        ...routeIdentifiers(route), messageDigest, mode: route.mode, contentType: "unsupported",
      });
      return;
    }
    const received = await conversationService.receiveMessage({
      conversationId,
      providerMessageId: event.providerMessageId,
      inReplyToProviderId: event.contextMessageId,
      content: `[Unsupported WhatsApp content: ${content.providerType.slice(0, 64)}]`,
      occurredAt: new Date(event.occurredAt),
    });
    log.debug("whatsapp.inbound.persisted", {
      messageDigest,
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

  if (route.mode === "historical") {
    await persistHistoricalInbound({
      conversationId: route.conversationId,
      providerMessageId: event.providerMessageId,
      inReplyToProviderId: event.contextMessageId,
      content: content.text,
      occurredAt: new Date(event.occurredAt),
      contentType: "TEXT",
    });
    await recipientReachabilityPositiveService.fromRoutedInbound({
      shopId: route.shopId, conversationId: route.conversationId,
      providerMessageId: event.providerMessageId, customerPhone: event.customerPhone,
    });
    log.info("whatsapp.inbound.historical_persisted", {
      ...routeIdentifiers(route), messageDigest, mode: route.mode, contentType: "text",
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
    messageDigest,
    conversationId: route.conversationId,
    observedVersion: received.version,
    duplicate: received.duplicate,
    contentType: "text",
  });

  if (received.duplicate) {
    log.debug("whatsapp.inbound.duplicate_repair_requested", {
      messageDigest,
      conversationId: route.conversationId,
      observedVersion: received.version,
    });
  }

  await recipientReachabilityPositiveService.fromRoutedInbound({
    shopId: route.shopId, conversationId: route.conversationId,
    providerMessageId: event.providerMessageId, customerPhone: event.customerPhone,
  });

  if (!(await recoveryRoutingService.isCurrentActiveRoute(route))) {
    log.warn("whatsapp.inbound.turn_suppressed", {
      ...routeIdentifiers(route), messageDigest, mode: route.mode,
      stage: "before-enqueue", reason: "RECOVERY_CLOSED_OR_SUPERSEDED",
    });
    return;
  }
  await enqueueTurn(route.conversationId, received.version);
}

type HistoricalInbound = Readonly<{
  conversationId: string;
  providerMessageId: string;
  inReplyToProviderId: string | null;
  content: string;
  occurredAt: Date;
  contentType: "TEXT" | "UNSUPPORTED";
}>;

async function persistHistoricalInbound(message: HistoricalInbound): Promise<void> {
  const existing = await prisma.conversationMessage.findUnique({
    where: { providerMessageId: message.providerMessageId },
    select: { conversationId: true, direction: true },
  });
  if (existing) {
    if (existing.direction !== "INBOUND" || existing.conversationId !== message.conversationId)
      throw new Error("Inbound message ownership mismatch");
    return;
  }
  try {
    await prisma.conversationMessage.create({
      data: {
        conversationId: message.conversationId,
        providerMessageId: message.providerMessageId,
        inReplyToProviderId: message.inReplyToProviderId,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        status: "DELIVERED",
        content: message.content,
        contentType: message.contentType,
        createdAt: message.occurredAt,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const duplicate = await prisma.conversationMessage.findUnique({
      where: { providerMessageId: message.providerMessageId },
      select: { conversationId: true, direction: true },
    });
    if (duplicate?.direction !== "INBOUND" || duplicate.conversationId !== message.conversationId)
      throw new Error("Inbound message ownership mismatch", { cause: error });
  }
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
