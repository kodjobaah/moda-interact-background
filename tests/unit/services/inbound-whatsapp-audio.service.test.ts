import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: {
    conversationMessage: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    conversation: { findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  media: { downloadAudio: vi.fn() },
  transcription: { transcribe: vi.fn() },
  parseBuffer: vi.fn(),
}));

vi.mock("../../../src/lib/db.js", () => ({ default: mocks.database }));
vi.mock("../../../src/services/whatsapp-media.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/whatsapp-media.service.js")>()),
  whatsappMediaService: mocks.media,
}));

vi.mock("music-metadata", () => ({ parseBuffer: mocks.parseBuffer }));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

import { InboundWhatsAppAudioService } from "../../../src/services/inbound-whatsapp-audio.service.js";
import { WhatsAppMediaError } from "../../../src/services/whatsapp-media.service.js";

const event = {
  schemaVersion: 1 as const, provider: "whatsapp" as const, providerAccountId: "waba",
  providerPhoneNumberId: "phone", providerMessageId: "message-1", customerPhone: "+1",
  contextMessageId: "outbound-1", occurredAt: "2026-09-16T12:00:00Z",
  content: { type: "audio" as const, mediaId: "media-1", mimeType: "audio/ogg", sha256: null, voice: true },
};

describe("InboundWhatsAppAudioService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    mocks.database.conversationMessage.findUnique.mockResolvedValue(null);
    mocks.database.conversationMessage.create.mockResolvedValue({ id: "message-row", conversationId: "conversation-1", transcriptionStatus: "PENDING" });
    mocks.database.conversationMessage.updateMany.mockResolvedValue({ count: 1 });
    mocks.database.conversation.updateMany.mockResolvedValue({ count: 1 });
    mocks.database.conversation.findUniqueOrThrow.mockResolvedValue({ inboundVersion: 2, lastProcessedVersion: 2, pendingTurnStartedAt: null });
    mocks.database.$transaction.mockImplementation((callback: (tx: typeof mocks.database) => unknown) => callback(mocks.database));
    mocks.media.downloadAudio.mockResolvedValue({ bytes: new TextEncoder().encode("OggSfixture"), mimeType: "audio/ogg" });
    mocks.parseBuffer.mockResolvedValue({ format: { duration: 30 } });
    mocks.transcription.transcribe.mockResolvedValue({ text: "Keep the transcript unchanged", provider: "groq", model: "whisper-large-v3-turbo" });
  });

  it("reserves, transcribes and completes one logical turn", async () => {
    const result = await new InboundWhatsAppAudioService(mocks.media, mocks.transcription).process(event, "conversation-1");
    expect(result).toEqual({ kind: "completed" });
    expect(mocks.transcription.transcribe).toHaveBeenCalledTimes(1);
    expect(mocks.database.conversationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ content: "Keep the transcript unchanged", transcriptionStatus: "COMPLETED" }) }));
  });

  it("accepts exactly 120 seconds without calling a fallback", async () => {
    mocks.parseBuffer.mockResolvedValue({ format: { duration: 120 } });
    const result = await new InboundWhatsAppAudioService(mocks.media, mocks.transcription).process(event, "conversation-1");
    expect(result.kind).toBe("completed");
    expect(mocks.transcription.transcribe).toHaveBeenCalledTimes(1);
  });

  it("rejects overlong audio before transcription", async () => {
    mocks.parseBuffer.mockResolvedValue({ format: { duration: 120.001 } });
    const result = await new InboundWhatsAppAudioService(mocks.media, mocks.transcription).process(event, "conversation-1");
    expect(result).toMatchObject({ kind: "rejected", fallback: "Please send a voice note that is 2 minutes or shorter." });
    expect(mocks.transcription.transcribe).not.toHaveBeenCalled();
  });

  it("does not call STT when a completed reservation is replayed", async () => {
    mocks.database.conversationMessage.findUnique.mockResolvedValue({ id: "message-row", conversationId: "conversation-1", transcriptionStatus: "COMPLETED" });
    const result = await new InboundWhatsAppAudioService(mocks.media, mocks.transcription).process(event, "conversation-1");
    expect(result).toEqual({ kind: "ignored" });
    expect(mocks.media.downloadAudio).not.toHaveBeenCalled();
    expect(mocks.transcription.transcribe).not.toHaveBeenCalled();
  });

  it("keeps a transient Meta failure pending and rethrows for queue retry", async () => {
    mocks.media.downloadAudio.mockRejectedValue(new WhatsAppMediaError("metadata-http", true));

    await expect(new InboundWhatsAppAudioService(mocks.media, mocks.transcription).process(event, "conversation-1", { finalAttempt: false }))
      .rejects.toMatchObject({ code: "metadata-http", retryable: true });
    expect(mocks.database.conversationMessage.updateMany).not.toHaveBeenCalled();
    expect(mocks.transcription.transcribe).not.toHaveBeenCalled();
  });

  it("marks corrupt media terminal and returns the unreadable fallback", async () => {
    mocks.parseBuffer.mockRejectedValue(new Error("parser exploded"));

    const result = await new InboundWhatsAppAudioService(mocks.media, mocks.transcription).process(event, "conversation-1");

    expect(result).toEqual({ kind: "failed", fallback: "I couldn't understand that voice note. Please try again or send your message as text." });
    expect(mocks.database.conversationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ transcriptionStatus: "FAILED", transcriptionFailureCode: "MEDIA_UNREADABLE" }),
    }));
    expect(mocks.transcription.transcribe).not.toHaveBeenCalled();
  });
it("rejects a stored inbound ownership race before media download",async()=>{
 mocks.database.conversationMessage.findUnique.mockResolvedValue({id:"message-row",conversationId:"other",transcriptionStatus:"PENDING"});
 mocks.media.downloadAudio.mockClear();
 await expect(new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).rejects.toThrow("ownership mismatch");
 expect(mocks.media.downloadAudio).not.toHaveBeenCalled();
});

 it("V04 empty transcription cannot increment a turn", async () => {
  mocks.transcription.transcribe.mockResolvedValue({text:" ",provider:"openai",model:"gpt-4o-mini-transcribe"});
  const result=await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1");
  expect(result.kind).toBe("rejected"); expect(mocks.database.conversation.updateMany).not.toHaveBeenCalled();
 });


 it("V05 final queue attempt persists terminal failure and requests text", async () => {
  mocks.media.downloadAudio.mockRejectedValue(new WhatsAppMediaError("metadata-http", true));
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1",{finalAttempt:true})).toMatchObject({kind:"failed",fallback:expect.any(String)});
  expect(mocks.database.conversationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({transcriptionStatus:"FAILED"})}));
  expect(mocks.database.conversation.updateMany).not.toHaveBeenCalled();
 });
 it("V07 completion losing to a newer turn cannot persist transcript or mutate language", async () => {
  mocks.database.conversation.updateMany.mockResolvedValueOnce({count:0});
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).toEqual({kind:"ignored"});
  expect(mocks.database.conversationMessage.updateMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({data:{transcriptionStatus:"REJECTED",transcriptionFailureCode:"STALE_TRANSCRIPTION"}}));
 });
 it("V07 retries do not revive a stale transcript", async () => {
  mocks.database.conversationMessage.findUnique.mockResolvedValue({id:"message-row",conversationId:"conversation-1",transcriptionStatus:"REJECTED",transcriptionFailureCode:"STALE_TRANSCRIPTION"});
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).toEqual({kind:"ignored"});
  expect(mocks.media.downloadAudio).not.toHaveBeenCalled();
 });
 it("V06 concurrent completion rolls back the losing duplicate", async () => {
  mocks.database.conversationMessage.updateMany.mockResolvedValueOnce({count:0});
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).toEqual({kind:"ignored"});
  expect(mocks.database.conversation.updateMany).toHaveBeenCalledTimes(1);
 });
 it("V03 unsupported MIME cannot call transcription", async () => {
  mocks.media.downloadAudio.mockResolvedValue({bytes:new Uint8Array([1,2]),mimeType:"audio/aac"});
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).toMatchObject({kind:"failed"});
  expect(mocks.transcription.transcribe).not.toHaveBeenCalled();
 });
});
