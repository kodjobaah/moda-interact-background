import { Prisma } from "@prisma/client";
import { parseBuffer } from "music-metadata";
import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";
import prisma from "../lib/db.js";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { whatsappMediaService, WhatsAppMediaError } from "./whatsapp-media.service.js";
import { groqSpeechTranscriptionService, SpeechTranscriptionError, type SpeechTranscriptionService } from "./speech-transcription.service.js";
import { recoveryOutreachAttemptService } from "./recovery-outreach-attempt.service.js";

const MAX_DURATION_MS = 120_000;
const TOO_LONG = "Please send a voice note that is 2 minutes or shorter.";
const UNREADABLE = "I couldn't understand that voice note. Please try again or send your message as text.";

export class InboundWhatsAppAudioService {
  constructor(
    private readonly media = whatsappMediaService,
    private readonly transcription: SpeechTranscriptionService = groqSpeechTranscriptionService,
    private readonly logger: StructuredLogger = createLogger({ serviceName: "moda-messaging-worker", environment: process.env.NODE_ENV ?? "development" }),
  ) {}

  async reserve(event: NormalizedWhatsAppInboundMessage, conversationId: string) {
    const existing = await prisma.conversationMessage.findUnique({ where: { providerMessageId: event.providerMessageId }, select: { id: true, conversationId: true, transcriptionStatus: true } });
    if (existing) return existing;
    return prisma.conversationMessage.create({ data: {
      conversationId, providerMessageId: event.providerMessageId, inReplyToProviderId: event.contextMessageId,
      direction: "INBOUND", senderType: "CUSTOMER", status: "DELIVERED", content: "", createdAt: new Date(event.occurredAt),
      contentType: "AUDIO", providerMediaId: event.content.type === "audio" ? event.content.mediaId : null,
      providerMediaMimeType: event.content.type === "audio" ? event.content.mimeType : null,
      providerMediaSha256: event.content.type === "audio" ? event.content.sha256 : null,
      transcriptionStatus: "PENDING",
    } }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return prisma.conversationMessage.findUniqueOrThrow({ where: { providerMessageId: event.providerMessageId }, select: { id: true, conversationId: true, transcriptionStatus: true } });
      throw error;
    });
  }

  async process(event: NormalizedWhatsAppInboundMessage, conversationId: string): Promise<{ kind: "completed" | "rejected" | "failed"; fallback?: string }> {
    const reservation = await this.reserve(event, conversationId);
    await recoveryOutreachAttemptService.markEngagedForConversation(
      reservation.conversationId,
      new Date(event.occurredAt),
    );
    if (reservation.transcriptionStatus === "COMPLETED") return { kind: "completed" };
    if (reservation.transcriptionStatus === "REJECTED" || reservation.transcriptionStatus === "FAILED") return { kind: "failed", fallback: UNREADABLE };
    try {
      if (event.content.type !== "audio") throw new Error("audio-event-required");
      const downloaded = await this.media.downloadAudio(event.content.mediaId, event.content.mimeType);
      let metadata;
      try {
        metadata = await parseBuffer(downloaded.bytes, { mimeType: downloaded.mimeType });
      } catch {
        await this.fail(reservation.id, "MEDIA_UNREADABLE");
        this.logger.warn("whatsapp.inbound.transcription-terminal-failure", { providerMessageId: event.providerMessageId, reason: "media-parse-failed" });
        return { kind: "failed", fallback: UNREADABLE };
      }
      const durationMs = Math.round((metadata.format.duration ?? 0) * 1000);
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
        await this.reject(reservation.id, durationMs > MAX_DURATION_MS ? "VOICE_TOO_LONG" : "VOICE_UNREADABLE", durationMs);
        this.logger.info("whatsapp.inbound.rejected-too-long", { providerMessageId: event.providerMessageId });
        return { kind: "rejected", fallback: durationMs > MAX_DURATION_MS ? TOO_LONG : UNREADABLE };
      }
      const transcript = await this.transcription.transcribe(downloaded);
      if (!transcript.text.trim()) {
        await this.reject(reservation.id, "VOICE_UNREADABLE", durationMs);
        return { kind: "rejected", fallback: UNREADABLE };
      }
      await this.complete(reservation.id, conversationId, transcript.text, transcript.provider, transcript.model, durationMs);
      this.logger.info("whatsapp.inbound.transcription-completed", { providerMessageId: event.providerMessageId });
      return { kind: "completed" };
    } catch (error) {
      if (isTerminalAudioError(error)) {
        await this.fail(reservation.id, "MEDIA_UNREADABLE");
        this.logger.warn("whatsapp.inbound.transcription-terminal-failure", { providerMessageId: event.providerMessageId, reason: "typed-terminal-error" });
        return { kind: "failed", fallback: UNREADABLE };
      }
      this.logger.warn("whatsapp.inbound.transcription-retryable-failure", { providerMessageId: event.providerMessageId });
      throw error;
    }
  }

  private async complete(id: string, conversationId: string, text: string, provider: string, model: string, durationMs: number) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.conversationMessage.updateMany({ where: { id, transcriptionStatus: "PENDING" }, data: { content: text, mediaDurationMs: durationMs, transcriptionProvider: provider, transcriptionModel: model, transcriptionStatus: "COMPLETED", transcriptionCompletedAt: new Date() } });
      if (updated.count === 1) {
        const now = new Date();
        const state = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { inboundVersion: true, lastProcessedVersion: true, pendingTurnStartedAt: true, checkoutRecoveryId: true } });
        await tx.conversation.update({ where: { id: conversationId }, data: { ...(state.inboundVersion === state.lastProcessedVersion && state.pendingTurnStartedAt === null ? { pendingTurnStartedAt: now } : {}), inboundVersion: { increment: 1 }, lastInboundAt: now, lastMessageAt: now } });
      }
    });
  }
  private reject(id: string, code: string, durationMs: number) { return prisma.conversationMessage.updateMany({ where: { id, transcriptionStatus: "PENDING" }, data: { transcriptionStatus: "REJECTED", transcriptionFailureCode: code, mediaDurationMs: durationMs >= 0 ? durationMs : null } }); }
  private fail(id: string, code: string) { return prisma.conversationMessage.updateMany({ where: { id, transcriptionStatus: "PENDING" }, data: { transcriptionStatus: "FAILED", transcriptionFailureCode: code } }); }
}

function isTerminalAudioError(error: unknown): boolean {
  if (error instanceof WhatsAppMediaError) return !error.retryable;
  if (error instanceof SpeechTranscriptionError) return !error.retryable;
  return false;
}

export const inboundWhatsAppAudioService = new InboundWhatsAppAudioService();