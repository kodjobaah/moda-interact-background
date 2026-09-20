import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: {
    conversationMessage: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    conversation: { findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $queryRaw: vi.fn(), $transaction: vi.fn(),
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
    vi.resetAllMocks();
    mocks.database.conversationMessage.findFirst.mockResolvedValue(null);
    mocks.database.$queryRaw.mockResolvedValue([{id:"conversation-1"}]);
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
  mocks.database.$queryRaw.mockImplementationOnce(async()=>{mocks.database.conversationMessage.findFirst.mockResolvedValue({id:"newer"});return[{id:"conversation-1"}];});
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
  expect(mocks.database.conversation.updateMany).not.toHaveBeenCalled();
 });
 it("V03 unsupported MIME cannot call transcription", async () => {
  mocks.media.downloadAudio.mockResolvedValue({bytes:new Uint8Array([1,2]),mimeType:"audio/aac"});
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).toMatchObject({kind:"failed"});
  expect(mocks.transcription.transcribe).not.toHaveBeenCalled();
 });
});

// Regression specification from Attempt 2 architect review.
describe("review R1/R2 event ordering", () => {
 beforeEach(() => {
  vi.resetAllMocks();
  mocks.database.conversationMessage.findUnique.mockResolvedValue(null);
  mocks.database.conversationMessage.create.mockResolvedValue({id:"message-row",conversationId:"conversation-1",transcriptionStatus:"PENDING",createdAt:new Date(event.occurredAt)});
  mocks.database.conversationMessage.findFirst.mockResolvedValue(null);
  mocks.database.conversationMessage.updateMany.mockResolvedValue({count:1});
  mocks.database.conversation.updateMany.mockResolvedValue({count:1});
  mocks.database.$queryRaw.mockResolvedValue([{id:"conversation-1"}]);
  mocks.database.$transaction.mockImplementation(async(fn)=>fn(mocks.database));
  mocks.media.downloadAudio.mockResolvedValue({bytes:new TextEncoder().encode("OggSfixture"),mimeType:"audio/ogg"});
  mocks.parseBuffer.mockResolvedValue({format:{duration:30}});
  mocks.transcription.transcribe.mockResolvedValue({text:"Bonjour pouvez-vous vérifier ma commande",provider:"openai",model:"gpt-4o-mini-transcribe"});
 });
 it("R1 accepts a queued newer event even when an earlier note completed after its sent time",async()=>{
  mocks.database.conversation.findUniqueOrThrow.mockResolvedValue({inboundVersion:2,lastProcessedVersion:2,lastInboundAt:new Date("2026-09-16T12:00:05Z")});
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).toEqual({kind:"completed"});
  expect(mocks.transcription.transcribe).toHaveBeenCalledTimes(1);
  expect(mocks.database.conversationMessage.findFirst).toHaveBeenCalledWith({where:{conversationId:"conversation-1",direction:"INBOUND",senderType:"CUSTOMER",OR:[{createdAt:{gt:new Date(event.occurredAt)}},{createdAt:new Date(event.occurredAt),id:{gt:"message-row"}}]},select:{id:true}});
  expect(mocks.database.conversation.updateMany.mock.calls.filter(([a])=>a.data.inboundVersion)).toHaveLength(1);
 });
 it.each(["provider","transaction"])("R2 prior reply completion during %s does not discard incoming voice",async(timing)=>{
  const state={inboundVersion:2,lastProcessedVersion:1};
  mocks.database.conversation.findUniqueOrThrow.mockImplementation(async()=>({...state}));
  if(timing==="provider")mocks.transcription.transcribe.mockImplementation(async()=>{state.lastProcessedVersion=2;return{text:"A substantive customer reply",provider:"groq",model:"whisper-large-v3-turbo"};});
  else mocks.database.$queryRaw.mockImplementation(async()=>{state.lastProcessedVersion=2;return[{id:"conversation-1"}];});
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).toEqual({kind:"completed"});
  expect(state.lastProcessedVersion).toBe(2);
  expect(mocks.database.conversation.updateMany.mock.calls.filter(([a])=>a.data.inboundVersion)).toEqual([[{where:{id:"conversation-1"},data:{inboundVersion:{increment:1},lastInboundAt:expect.any(Date),lastMessageAt:expect.any(Date)}}]]);
 });
 it("R1 a genuinely newer persisted inbound rejects an older note before download",async()=>{
  mocks.database.conversationMessage.findFirst.mockResolvedValue({id:"newer-message"});
  expect(await new InboundWhatsAppAudioService(mocks.media,mocks.transcription).process(event,"conversation-1")).toEqual({kind:"ignored"});
  expect(mocks.media.downloadAudio).not.toHaveBeenCalled();expect(mocks.database.conversation.updateMany).not.toHaveBeenCalled();
 });
});

describe("R1 overlapping notes retain durable event order",()=>{
 it.each(["older-first","newer-first"])("%s provider completion admits the newer note once",async(order)=>{
  vi.resetAllMocks();
  const rows:any[]=[];const state={inboundVersion:2,lastProcessedVersion:2};
  mocks.database.conversationMessage.findUnique.mockImplementation(async({where})=>rows.find(r=>r.providerMessageId===where.providerMessageId)??null);
  mocks.database.conversationMessage.create.mockImplementation(async({data})=>{const row={...data,id:data.providerMessageId};rows.push(row);return row;});
  mocks.database.conversationMessage.findFirst.mockImplementation(async({where})=>rows.find(r=>r.conversationId===where.conversationId&&(r.createdAt>where.OR[0].createdAt.gt||(r.createdAt.getTime()===where.OR[1].createdAt.getTime()&&r.id>where.OR[1].id.gt)))??null);
  mocks.database.conversationMessage.updateMany.mockImplementation(async({where,data})=>{const r=rows.find(r=>r.id===where.id&&r.transcriptionStatus===where.transcriptionStatus);if(!r)return{count:0};Object.assign(r,data);return{count:1};});
  mocks.database.conversation.findUniqueOrThrow.mockImplementation(async()=>({...state}));
  mocks.database.conversation.updateMany.mockImplementation(async({data})=>{if(data.inboundVersion)state.inboundVersion++;return{count:1};});
  mocks.database.$queryRaw.mockResolvedValue([{id:"conversation-1"}]);
  mocks.database.$transaction.mockImplementation(async(fn)=>fn(mocks.database));
  mocks.media.downloadAudio.mockResolvedValue({bytes:new TextEncoder().encode("OggSfixture"),mimeType:"audio/ogg"});
  mocks.parseBuffer.mockResolvedValue({format:{duration:30}});
  let finishOld!:(value:any)=>void;let finishNew!:(value:any)=>void;
  let oldStarted!:()=>void;let newStarted!:()=>void;
  const oldReady=new Promise<void>(r=>oldStarted=r),newReady=new Promise<void>(r=>newStarted=r);
  mocks.transcription.transcribe.mockImplementationOnce(()=>{oldStarted();return new Promise(r=>finishOld=r);}).mockImplementationOnce(()=>{newStarted();return new Promise(r=>finishNew=r);});
  const service=new InboundWhatsAppAudioService(mocks.media,mocks.transcription);
  const old=service.process({...event,providerMessageId:"old",occurredAt:"2026-09-16T11:59:50Z"},"conversation-1");
  await oldReady;
  const newer=service.process({...event,providerMessageId:"new"},"conversation-1");
  await newReady;
  const transcript={text:"A substantive voice note",provider:"openai",model:"gpt-4o-mini-transcribe"};
  if(order==="older-first"){finishOld(transcript);expect(await old).toEqual({kind:"ignored"});finishNew(transcript);}
  else{finishNew(transcript);expect(await newer).toEqual({kind:"completed"});finishOld(transcript);}
  expect(await old).toEqual({kind:"ignored"});expect(await newer).toEqual({kind:"completed"});
  expect(state.inboundVersion).toBe(3);expect(state.lastProcessedVersion).toBe(2);
  expect(rows.find(r=>r.id==="new").transcriptionStatus).toBe("COMPLETED");
  expect(rows.find(r=>r.id==="old").transcriptionFailureCode).toBe("STALE_TRANSCRIPTION");
 });
});
