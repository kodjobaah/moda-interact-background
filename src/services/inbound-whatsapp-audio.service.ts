import { Prisma } from "@prisma/client";
import { parseBuffer } from "music-metadata";
import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";
import prisma from "../lib/db.js";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { whatsappMediaService, WhatsAppMediaError } from "./whatsapp-media.service.js";
import { speechTranscriptionService, SpeechTranscriptionError, validateTranscriptionMedia, type SpeechTranscriptionService } from "./speech-transcription.service.js";
import { recoveryOutreachAttemptService } from "./recovery-outreach-attempt.service.js";

const MAX_DURATION_MS = 120_000;
const TOO_LONG = "Please send a voice note that is 2 minutes or shorter.";
const UNREADABLE = "I couldn't understand that voice note. Please try again or send your message as text.";

export class InboundWhatsAppAudioService {
  constructor(
    private readonly media = whatsappMediaService,
    private readonly transcription: SpeechTranscriptionService = speechTranscriptionService,
    private readonly logger: StructuredLogger = createLogger({ serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName() }),
  ) {}

  async reserve(event: NormalizedWhatsAppInboundMessage, conversationId: string) {
    const existing = await prisma.conversationMessage.findUnique({ where: { providerMessageId: event.providerMessageId }, select: { id: true, conversationId: true, transcriptionStatus: true, transcriptionFailureCode: true, transcriptionCompletedAt: true } });
    if (existing) return existing;
    return prisma.conversationMessage.create({ data: {
      conversationId, providerMessageId: event.providerMessageId, inReplyToProviderId: event.contextMessageId,
      direction: "INBOUND", senderType: "CUSTOMER", status: "DELIVERED", content: "", createdAt: new Date(event.occurredAt),
      contentType: "AUDIO", providerMediaId: event.content.type === "audio" ? event.content.mediaId : null,
      providerMediaMimeType: event.content.type === "audio" ? event.content.mimeType : null,
      providerMediaSha256: event.content.type === "audio" ? event.content.sha256 : null,
      transcriptionStatus: "PENDING",
    } }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return prisma.conversationMessage.findUniqueOrThrow({ where: { providerMessageId: event.providerMessageId }, select: { id: true, conversationId: true, transcriptionStatus: true, transcriptionFailureCode: true, transcriptionCompletedAt: true } });
      throw error;
    });
  }

  async process(event: NormalizedWhatsAppInboundMessage, conversationId: string, options: { finalAttempt?: boolean } = {}): Promise<{ kind: "completed" | "rejected" | "failed" | "ignored"; fallback?: string }> {
    const reservation = await this.reserve(event, conversationId);
    if (reservation.conversationId !== conversationId) throw new Error("Inbound message ownership mismatch");
    await recoveryOutreachAttemptService.markEngagedForConversation(
      reservation.conversationId,
      new Date(event.occurredAt),
    );
    if (reservation.transcriptionFailureCode === "STALE_TRANSCRIPTION") return { kind: "ignored" };
    if (reservation.transcriptionStatus === "COMPLETED") {
      const state = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { inboundVersion: true, lastProcessedVersion: true, lastInboundAt: true } });
      // Recover an interrupted enqueue only while this remains the pending turn.
      return { kind: state.inboundVersion > state.lastProcessedVersion && state.lastInboundAt?.getTime() === reservation.transcriptionCompletedAt?.getTime() ? "completed" : "ignored" };
    }
    const baseline = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { inboundVersion: true, lastInboundAt: true, lastProcessedVersion: true },
    });
    if (baseline.lastInboundAt && baseline.lastInboundAt > new Date(event.occurredAt)) {
      await this.reject(reservation.id, "STALE_TRANSCRIPTION", 0);
      return { kind: "ignored" };
    }
    if (reservation.transcriptionStatus === "REJECTED" || reservation.transcriptionStatus === "FAILED") return { kind: "failed", fallback: UNREADABLE };
    try {
      if (event.content.type !== "audio") throw new Error("audio-event-required");
      const downloaded = await this.media.downloadAudio(event.content.mediaId, event.content.mimeType);
      validateTranscriptionMedia(downloaded);
      let metadata;
      try {
        metadata = await parseBuffer(downloaded.bytes, { mimeType: downloaded.mimeType });
      } catch {
        if (await this.isStale(conversationId, baseline.inboundVersion, baseline.lastProcessedVersion)) {
          await this.reject(reservation.id, "STALE_TRANSCRIPTION", 0);
          return { kind: "ignored" };
        }
        await this.fail(reservation.id, "MEDIA_UNREADABLE");
        this.logger.warn("whatsapp.inbound.transcription-terminal-failure", { providerMessageId: event.providerMessageId, reason: "media-parse-failed" });
        return { kind: "failed", fallback: UNREADABLE };
      }
      if (await this.isStale(conversationId, baseline.inboundVersion, baseline.lastProcessedVersion)) {
        await this.reject(reservation.id, "STALE_TRANSCRIPTION", 0);
        return { kind: "ignored" };
      }
      const durationMs = Math.round((metadata.format.duration ?? 0) * 1000);
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
        await this.reject(reservation.id, durationMs > MAX_DURATION_MS ? "VOICE_TOO_LONG" : "VOICE_UNREADABLE", durationMs);
        this.logger.info("whatsapp.inbound.rejected-too-long", { providerMessageId: event.providerMessageId });
        return { kind: "rejected", fallback: durationMs > MAX_DURATION_MS ? TOO_LONG : UNREADABLE };
      }
      const transcript = await this.transcription.transcribe(downloaded);
      if (await this.isStale(conversationId, baseline.inboundVersion, baseline.lastProcessedVersion)) {
        await this.reject(reservation.id, "STALE_TRANSCRIPTION", 0);
        return { kind: "ignored" };
      }
      if (!transcript.text.trim()) {
        await this.reject(reservation.id, "VOICE_UNREADABLE", durationMs);
        return { kind: "rejected", fallback: UNREADABLE };
      }
      const completed = await this.complete(reservation.id, reservation.conversationId, transcript.text, transcript.provider, transcript.model, durationMs, baseline.inboundVersion, baseline.lastProcessedVersion);
      if (!completed) return { kind: "ignored" };
      this.logger.info("whatsapp.inbound.transcription-completed", { providerMessageId: event.providerMessageId });
      return { kind: "completed" };
    } catch (error) {
      if (isTerminalAudioError(error) || options.finalAttempt !== false) {
        if (await this.isStale(conversationId, baseline.inboundVersion, baseline.lastProcessedVersion)) {
          await this.reject(reservation.id, "STALE_TRANSCRIPTION", 0);
          return { kind: "ignored" };
        }
        await this.fail(reservation.id, "MEDIA_UNREADABLE");
        this.logger.warn("whatsapp.inbound.transcription-terminal-failure", { providerMessageId: event.providerMessageId, reason: "typed-terminal-error" });
        return { kind: "failed", fallback: UNREADABLE };
      }
      this.logger.warn("whatsapp.inbound.transcription-retryable-failure", { providerMessageId: event.providerMessageId });
      throw error instanceof WhatsAppMediaError || error instanceof SpeechTranscriptionError
        ? error : new SpeechTranscriptionError("network", true);
    }
  }

  private async isStale(conversationId: string, inboundVersion: number, lastProcessedVersion: number) {
    const state = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { inboundVersion: true, lastProcessedVersion: true } });
    return state.inboundVersion !== inboundVersion || state.lastProcessedVersion !== lastProcessedVersion;
  }
  private async complete(id: string, conversationId: string, text: string, provider: string, model: string, durationMs: number, inboundVersion: number, lastProcessedVersion: number) {
    const duplicate = new Error("transcription-already-completed");
    try {
      return await prisma.$transaction(async (tx) => {
        const now = new Date();
        // This CAS locks the conversation against a newer inbound/processed turn.
        // A losing duplicate rolls back its version increment in the same transaction.
        const admitted = await tx.conversation.updateMany({
          where: { id: conversationId, inboundVersion, lastProcessedVersion },
          data: { inboundVersion: { increment: 1 }, lastInboundAt: now, lastMessageAt: now },
        });
        if (admitted.count !== 1) {
          await tx.conversationMessage.updateMany({ where: { id, transcriptionStatus: "PENDING" }, data: { transcriptionStatus: "REJECTED", transcriptionFailureCode: "STALE_TRANSCRIPTION" } });
          return false;
        }
        const updated = await tx.conversationMessage.updateMany({ where: { id, transcriptionStatus: "PENDING" }, data: { content: text, mediaDurationMs: durationMs, transcriptionProvider: provider, transcriptionModel: model, transcriptionStatus: "COMPLETED", transcriptionCompletedAt: now } });
        if (updated.count !== 1) throw duplicate;
        await tx.conversation.updateMany({ where: { id: conversationId, pendingTurnStartedAt: null }, data: { pendingTurnStartedAt: now } });
        return true;
      });
    } catch (error) {
      if (error === duplicate) return false;
      throw error;
    }
  }
  private reject(id: string, code: string, durationMs: number) { return prisma.conversationMessage.updateMany({ where: { id, transcriptionStatus: "PENDING" }, data: { transcriptionStatus: "REJECTED", transcriptionFailureCode: code, mediaDurationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null } }); }
  private fail(id: string, code: string) { return prisma.conversationMessage.updateMany({ where: { id, transcriptionStatus: "PENDING" }, data: { transcriptionStatus: "FAILED", transcriptionFailureCode: code } }); }
}

function isTerminalAudioError(error: unknown): boolean {
  if (error instanceof WhatsAppMediaError) return !error.retryable;
  if (error instanceof SpeechTranscriptionError) return !error.retryable;
  return false;
}

export const inboundWhatsAppAudioService = new InboundWhatsAppAudioService();