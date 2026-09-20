import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  steps: [] as string[], row: null as any, version: 0, processed: 0, language: "en-GB", jobs: [] as any[], handler: null as any,
  state: { pendingTurnStartedAt: null, lastInboundAt: null } as any,
  database: { conversationMessage: {findUnique:vi.fn(),create:vi.fn(),updateMany:vi.fn()},conversation:{findUniqueOrThrow:vi.fn(),updateMany:vi.fn()},$transaction:vi.fn() },
  transcript: vi.fn(), agent: vi.fn(), reserve: vi.fn(), send: vi.fn(), fallback:vi.fn(),
  conversation: {getTurnState:vi.fn(),claimTurn:vi.fn(),completeTurn:vi.fn(),releaseTurn:vi.fn(),hasChanged:vi.fn(),applyDetectedLanguage:vi.fn()},
}));
vi.mock("../../../src/lib/db.js",()=>({default:h.database}));
vi.mock("../../../src/lib/redis.js",()=>({connectionRedis:{}}));
vi.mock("bullmq",()=>({DelayedError:class extends Error {}, Queue:class {async add(_name:string,data:any){h.jobs.push(data);}},Worker:class {constructor(_name:string,handler:any){h.handler=handler;}on(){return this;}}}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq",()=>({createBullMQTelemetry:()=>({})}));
vi.mock("@modainteract/moda-interact-shared/observability/genai",()=>({observeConversationTurn:(_n:any,fn:any)=>fn()}));
vi.mock("../../../src/observability/worker-metrics.js",()=>({observeWorkerJob:(_d:any,_j:any,fn:any)=>fn()}));
vi.mock("../../../src/runtime/queue-concurrency-controller.js",()=>({bindWorkerConcurrency:()=>{}}));
vi.mock("../../../src/runtime/background-runtime-config.js",()=>({backgroundRuntimeConfigService:{current:()=>({conversationQuietWindowMs:0,conversationMaxSettleWindowMs:0,whatsappWorkerConcurrency:1})}}));
vi.mock("../../../src/services/whatsapp-media.service.js",async(original)=>({...await original<any>(),whatsappMediaService:{downloadAudio:async()=>{h.steps.push("download");return{bytes:new TextEncoder().encode("OggSfixture"),mimeType:"audio/ogg"};}}}));
vi.mock("music-metadata",()=>({parseBuffer:async()=>{h.steps.push("validate");return{format:{duration:30}};}}));
vi.mock("../../../src/services/speech-transcription.service.js",async(original)=>({...await original<any>(),speechTranscriptionService:{transcribe:h.transcript}}));
vi.mock("../../../src/services/recovery-outreach-attempt.service.js",()=>({recoveryOutreachAttemptService:{markEngagedForConversation:async()=>{h.steps.push("engaged");}}}));
vi.mock("../../../src/services/recovery-routing.service.js",()=>({recoveryRoutingService:{resolveInboundMessage:async()=>{h.steps.push("route");return{kind:"resolved",conversationId:"c",shopId:"s",checkoutRecoveryId:"r"};}}}));
vi.mock("../../../src/services/routing-guidance.service.js",()=>({sendRoutingGuidance:vi.fn()}));
vi.mock("../../../src/services/whatsapp-provider-status.service.js",()=>({whatsappProviderStatusService:{}}));
vi.mock("../../../src/services/shop-execution-eligibility.service.js",()=>({shopExecutionEligibilityService:{isShopExecutionActive:async()=>true}}));
vi.mock("../../../src/services/inbound-whatsapp-abuse-admission.service.js",()=>({inboundWhatsAppAbuseAdmissionService:{admitRaw:async()=>{h.steps.push("raw-abuse");return{kind:"allowed"};},admitSettledTurn:async()=>({kind:"allowed"})}}));
vi.mock("../../../src/services/conversation.service.js",()=>({conversationService:h.conversation}));
vi.mock("../../../src/services/checkout-recovery.service.js",()=>({checkoutRecoveryService:{recordExternalActivity:async()=>{},getAgentContext:async()=>({conversation:{messages:[{role:"user",content:h.row.content}],languageTag:h.language}})}}));
vi.mock("../../../src/agents/commerce.agent.js",()=>({runCommerceAgent:h.agent}));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js",async(original)=>({...await original<any>(),outboundWhatsAppAdmissionService:{reserve:h.reserve,sendPreparedText:h.send,sendText:h.fallback,failPrepared:vi.fn()}}));
import { createWhatsappWorker, processInboundMessage } from "../../../src/workers/whatsapp.worker.js";
const event={schemaVersion:1 as const,provider:"whatsapp" as const,providerAccountId:"waba",providerPhoneNumberId:"phone",providerMessageId:"voice-1",customerPhone:"+33123456789",contextMessageId:"outbound",occurredAt:new Date().toISOString(),content:{type:"audio" as const,mediaId:"media",mimeType:"audio/ogg",sha256:null,voice:true}};
beforeEach(()=>{
 vi.clearAllMocks();h.steps=[];h.jobs=[];h.row=null;h.version=0;h.processed=0;h.language="en-GB";h.state={pendingTurnStartedAt:null,lastInboundAt:null};
 h.database.conversationMessage.findUnique.mockImplementation(async()=>h.row);
 h.database.conversationMessage.create.mockImplementation(async({data})=>h.row={id:"m",...data});
 h.database.conversationMessage.updateMany.mockImplementation(async({where,data})=>{if(h.row.transcriptionStatus!==where.transcriptionStatus)return{count:0};Object.assign(h.row,data);if(data.transcriptionStatus==="COMPLETED")h.steps.push("persist");return{count:1};});
 h.database.conversation.findUniqueOrThrow.mockImplementation(async()=>({id:"c",type:"RECOVERY",checkoutRecoveryId:"r",checkoutRecovery:{shopId:"s",shop:{status:"ACTIVE"},customer:{phone:event.customerPhone}},messages:[{inReplyToProviderId:"outbound"}],inboundVersion:h.version,lastProcessedVersion:h.processed,...h.state}));
 h.database.conversation.updateMany.mockImplementation(async({where,data})=>{if(where.inboundVersion!==undefined&&(where.inboundVersion!==h.version||where.lastProcessedVersion!==h.processed))return{count:0};if(data.inboundVersion)h.version++;if(data.lastInboundAt)h.state.lastInboundAt=data.lastInboundAt;if(data.pendingTurnStartedAt)h.state.pendingTurnStartedAt=data.pendingTurnStartedAt;return{count:1};});
 h.database.$transaction.mockImplementation(async(fn)=>fn(h.database));
 h.conversation.getTurnState.mockImplementation(async()=>({inboundVersion:h.version,lastProcessedVersion:h.processed,processingInboundVersion:null,processingStartedAt:null,...h.state}));
 h.conversation.claimTurn.mockResolvedValue(true);h.conversation.hasChanged.mockResolvedValue(false);
 h.conversation.completeTurn.mockImplementation(async()=>{h.processed=h.version;h.state.pendingTurnStartedAt=null;return true;});
 h.conversation.applyDetectedLanguage.mockImplementation(async({detectedLanguageTag})=>{h.language=detectedLanguageTag;return true;});
 h.transcript.mockImplementation(async()=>{h.steps.push("transcribe");return{text:"Bonjour, pouvez-vous vérifier ma commande ?",provider:"openai",model:"gpt-4o-mini-transcribe"};});
 h.reserve.mockImplementation(async()=>{h.steps.push("admit");return{kind:"admitted",messageId:"reply",conversationId:"c",terminal:false};});
 h.agent.mockImplementation(async(context)=>{h.steps.push("agent");expect(context.conversation.messages[0].content).toBe(h.row.content);expect(h.row.transcriptionStatus).toBe("COMPLETED");return{replyText:"Bonjour !",detectedLanguageTag:"fr",detectedLanguageConfidence:0.99};});
 h.send.mockImplementation(async()=>{h.steps.push("text-reply");return{kind:"admitted"};});h.fallback.mockResolvedValue({kind:"admitted"});
 createWhatsappWorker();
});
it("A2-V02/V06 persists once, admits once, runs once, sends text once across replay",async()=>{
 await processInboundMessage(event);
 expect(h.jobs).toHaveLength(1);
 await h.handler({name:"process-conversation-turn",data:h.jobs[0]});
 await processInboundMessage(event);
 expect(h.steps.slice(0,9)).toEqual(["raw-abuse","route","engaged","download","validate","transcribe","persist","admit","agent"]);
 expect(h.steps[9]).toBe("text-reply");expect(h.version).toBe(1);expect(h.processed).toBe(1);expect(h.language).toBe("fr");
 for(const fn of [h.transcript,h.reserve,h.agent,h.send])expect(fn).toHaveBeenCalledTimes(1);
 expect(h.jobs).toHaveLength(1);expect(h.fallback).not.toHaveBeenCalled();
 expect(h.row).toMatchObject({transcriptionProvider:"openai",transcriptionModel:"gpt-4o-mini-transcribe"});
});
it.each(["empty","failure","stale"])("A2-V04/V05/V07 %s has no agent admission/reply",async(kind)=>{
 if(kind==="empty")h.transcript.mockResolvedValue({text:"",provider:"openai",model:"gpt-4o-mini-transcribe"});
 if(kind==="failure")h.transcript.mockRejectedValue(new Error("private provider error"));
 if(kind==="stale")h.transcript.mockImplementation(async()=>{h.version++;h.language="de";return{text:"Bonjour tout le monde",provider:"openai",model:"gpt-4o-mini-transcribe"};});
 await processInboundMessage(event);
 expect(h.jobs).toHaveLength(0);expect(h.agent).not.toHaveBeenCalled();expect(h.reserve).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
 if(kind==="stale"){expect(h.language).toBe("de");expect(h.fallback).not.toHaveBeenCalled();}else expect(h.fallback).toHaveBeenCalledTimes(1);
});
