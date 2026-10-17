import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { MerchantSendCommandService } from "../../src/services/recovery-conversation/merchant-send-command.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { HumanSendReconciliationService } from "../../src/services/recovery-conversation/human-send-reconciliation.service.js";
import { RecoveryFollowUpPolicyService } from "../../src/services/recovery-conversation/recovery-follow-up-policy.service.js";
import { HumanSendPolicyService } from "../../src/services/recovery-conversation/human-send-policy.service.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fixture(db: PrismaClient, label: string) {
  const shopId = `arch040-${label}-${randomUUID()}`;
  const recoveryId = randomUUID();
  const conversationId = randomUUID();
  await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.test`, status: "ACTIVE" } });
  await db.checkoutRecovery.create({ data: {
    id: recoveryId, shopId, checkoutToken: `${recoveryId}-checkout`,
    lastExternalActivityAt: new Date(), status: "MESSAGE_SENT",
  } });
  await db.conversation.create({ data: {id:conversationId,type:"RECOVERY",checkoutRecoveryId:recoveryId,
    lastInboundAt:new Date(Date.now()-60_000)} });
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation"
      SET "controlMode"='HUMAN',"controlRevision"=1,"controlChangedAt"=statement_timestamp()
      WHERE "id"=$1`,conversationId);
    await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
      ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
      VALUES ($1,$2,'AI','HUMAN',0,1)`,randomUUID(),conversationId);
  });
  async function addCommand(kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE" = "HUMAN_TEXT", attemptId?: string) {
    const id = randomUUID();
    const sha = createHash("sha256").update(`Hello ${id}`).digest("hex");
    await db.$executeRawUnsafe(`
      INSERT INTO "whatsapp"."MerchantConversationSendCommand"
       ("id","shopId","conversationId","idempotencyKey","payloadSha256", "expectedControlRevision",
        "kind","recipientSnapshot","textBody","templateName","templateLanguageCode","recoveryOutreachAttemptId")
      VALUES ($1,$2,$3,$4,$5,1,$6::"whatsapp"."MerchantConversationSendKind",$7,$8,$9,$10,$11)`,
      id,shopId,conversationId,id,sha,kind,"15551234567",
      kind === "HUMAN_TEXT" ? `Hello ${id}` : null,
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? "recovery_follow_up" : null,
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? "en_US" : null,
      attemptId ?? null);
    return id;
  }
  return { shopId,recoveryId,conversationId, addCommand, async cleanup(){ await db.shop.delete({ where: {id:shopId} }); } };
}

suite("ARCH-040 BACKGROUND-001 real PostgreSQL service semantics", () => {
  it("provider admission commits before later takeover, then UNKNOWN is reconciliation-only", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const f = await fixture(db,"admitted-first");
    try {
      const cmdId = await f.addCommand();
      const commandService = new MerchantSendCommandService(db);
      const claim = (await commandService.claimDueHumanCommands({limit:1,now:new Date()})).find(row => row.id===cmdId);
      expect(claim).toBeDefined();
      const provider = async () => "wa:accepted"; // Only called after transaction commits
      const fence = new OutboundSendFenceService(db,async()=>null);
      const permit = await fence.admitFinalSend({senderType:"HUMAN",conversationId:f.conversationId,
        recoveryId:f.recoveryId,shopId:f.shopId,commandId:cmdId,leaseToken:claim!.leaseToken,
        expectedControlRevision:1,recipient:"15551234567",now:new Date()});
      expect(permit.kind).toBe("admitted");
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation" SET "controlMode"='AI',
          "controlRevision"=2,"controlChangedAt"=statement_timestamp() WHERE "id"=$1`,f.conversationId);
        await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
          ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
          VALUES ($1,$2,'HUMAN','AI',1,2)`,randomUUID(),f.conversationId);
      });
      // Once durably admitted the external call may proceed even after control changed.
      const meta = await provider();
      const reconciliation = new HumanSendReconciliationService(db);
      expect((await reconciliation.recordProviderUnknown({commandId:cmdId,leaseToken:claim!.leaseToken})).kind).toBe("unknown");
      expect(await commandService.claimDueHumanCommands({limit:10,now:new Date(Date.now()+90_000)})).toHaveLength(0);
      expect((await reconciliation.reconcileUnknown({commandId:cmdId,outcome:{kind:"accepted",providerMessageId:meta},verified:true})).kind).toBe("sent");
      expect(await db.$queryRawUnsafe(`SELECT "state" FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`,cmdId))
        .toEqual([expect.objectContaining({state:"SENT"})]);
    } finally { await f.cleanup(); await db.$disconnect(); }
  }, 60_000);

  it("takeover holding the conversation lock wins before durable provider admission",async()=>{
    const db = new PrismaClient({ datasourceUrl: url! });
    const f = await fixture(db,"takeover-first");
    try {
      const cmdId=await f.addCommand();
      const claim=(await new MerchantSendCommandService(db).claimDueHumanCommands({limit:1,now:new Date()}))[0]!;
      let release!:()=>void;
      let taken!:()=>void;
      const started = new Promise<void>(resolve=>{taken=resolve;});
      const stop = new Promise<void>(resolve=>{release=resolve;});
      const takeover=db.$transaction(async tx=>{
        await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`,f.shopId);
        await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`,f.conversationId);
        await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation" SET "controlMode"='AI',
          "controlRevision"=2,"controlChangedAt"=statement_timestamp() WHERE "id"=$1`,f.conversationId);
        await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
          ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
          VALUES ($1,$2,'HUMAN','AI',1,2)`,randomUUID(),f.conversationId);
        taken(); await stop;
      },{timeout:20_000});
      await started;
      let finished=false;
      const permit=new OutboundSendFenceService(db,async()=>null).admitFinalSend({
        senderType:"HUMAN",conversationId:f.conversationId,shopId:f.shopId,recoveryId:f.recoveryId,
        commandId:cmdId,leaseToken:claim.leaseToken,expectedControlRevision:1,recipient:"15551234567",now:new Date(),
      }).then(result=>{finished=true;return result;});
      await pause(100); expect(finished).toBe(false);
      release();await takeover;
      expect(await permit).toEqual({kind:"suppressed",reason:"stale-control-revision"});
      const command=await db.$queryRawUnsafe<Array<{providerDispatchKey:string|null}>>(`
        SELECT "providerDispatchKey" FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`,cmdId);
      expect(command[0]?.providerDispatchKey).toBeNull();
    } finally { await f.cleanup(); await db.$disconnect(); }
  },60_000);

  it("missing restriction row still serializes with Shop lock, and suspension blocks admission",async()=>{
    const db=new PrismaClient({datasourceUrl:url!});
    const f=await fixture(db,"restriction");
    const adminId=randomUUID();
    try {
      await db.platformAdmin.create({data:{id:adminId,email:`${adminId}@example.test`}});
      const cmdId=await f.addCommand();
      const claim=(await new MerchantSendCommandService(db).claimDueHumanCommands({limit:1,now:new Date()}))[0]!;
      await db.$transaction(async tx=>{
        await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`,f.shopId);
        await tx.$executeRawUnsafe(`INSERT INTO "commerce"."ShopHumanMessagingRestriction"
          ("shopId","status","revision","reasonCode","suspendedAt")
          VALUES ($1,'SUSPENDED',1,'manual_review',statement_timestamp())`,f.shopId);
        await tx.$executeRawUnsafe(`INSERT INTO "commerce"."ShopHumanMessagingRestrictionEvent"
          ("id","shopId","fromStatus","toStatus","revision","reasonCode","platformAdminId")
          VALUES ($1,$2,'ACTIVE','SUSPENDED',1,'manual_review',$3)`,randomUUID(),f.shopId,adminId);
      });
      expect(await new HumanSendPolicyService(db).checkRestriction(f.shopId)).toEqual({kind:"denied",reason:"human_messaging_suspended"});
      const permit=await new OutboundSendFenceService(db,async()=>null).admitFinalSend({senderType:"HUMAN",
        conversationId:f.conversationId,recoveryId:f.recoveryId,shopId:f.shopId,
        commandId:cmdId,leaseToken:claim.leaseToken,expectedControlRevision:1,recipient:"15551234567",now:new Date()});
      expect(permit).toEqual({kind:"suppressed",reason:"human_messaging_suspended"});
    } finally { await f.cleanup();await db.platformAdmin.delete({where:{id:adminId}});await db.$disconnect(); }
  },60_000);

  it("one shared sequence-two row wins concurrent HUMAN/AUTOMATION claim and billing identity",async()=>{
    const db=new PrismaClient({datasourceUrl:url!});
    const f=await fixture(db,"followup");
    try {
      const initialId=randomUUID();
      const initialMessageId=randomUUID();
      const initialSentAt=new Date(Date.now()-48*60*60_000);
      // WAITING_FOR_RESPONSE requires real sent-message evidence (ARCH-016).
      // A timestamp alone violates ck_arch016_outreach_waiting_message.
      await db.conversationMessage.create({data:{
        id:initialMessageId,conversationId:f.conversationId,
        direction:"OUTBOUND",senderType:"AUTOMATION",status:"SENT",
        content:"Initial recovery outreach",createdAt:initialSentAt,sentAt:initialSentAt,
      }});
      await db.$executeRawUnsafe(`INSERT INTO "commerce"."RecoveryOutreachAttempt"
       ("id","checkoutRecoveryId","recipient","sequence","trigger","status",
       "configuredOfferMode","outboundMessageId","sentAt","updatedAt")
       VALUES ($1,$2,'15551234567',1,'INITIAL','WAITING_FOR_RESPONSE','NONE', $3,$4,statement_timestamp())`,
       initialId,f.recoveryId,initialMessageId,initialSentAt);
      await db.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation" SET "lastInboundAt"=$2 WHERE "id"=$1`,
        f.conversationId,new Date(Date.now()-48*60*60_000));
      const service=new RecoveryFollowUpPolicyService(db);
      const results=await Promise.all([
        service.claimSequenceTwo({recoveryId:f.recoveryId,initiator:"merchant_post_window",initiationKey:`human-${randomUUID()}`,recipient:"15551234567",now:new Date()}),
        service.claimSequenceTwo({recoveryId:f.recoveryId,initiator:"scheduled_no_response",initiationKey:`auto-${randomUUID()}`,recipient:"15551234567",now:new Date()}),
      ]);
      expect(results.filter(result=>result.kind==="claimed")).toHaveLength(1);
      const rows=await db.$queryRawUnsafe<Array<{id:string;initiationKey:string|null}>>(`
        SELECT "id","initiationKey" FROM "commerce"."RecoveryOutreachAttempt" WHERE "checkoutRecoveryId"=$1 AND "sequence"=2`,f.recoveryId);
      expect(rows).toHaveLength(1);
      const win=results.find(result=>result.kind==="claimed");
      if (win?.kind==="claimed") expect(win.billingSource).toBe(`recovery-outreach:${rows[0]?.id}`);
    } finally {await f.cleanup();await db.$disconnect();}
  },60_000);
  it("Redis screens repeated command IDs exactly once and limits new HUMAN sends atomically",async()=>{
    const db = new PrismaClient({datasourceUrl:url!});
    const f = await fixture(db,"redis");
    if (!process.env.REDIS_URL) throw new Error("Disposable Redis URL missing");
    const redis = new Redis(process.env.REDIS_URL, {maxRetriesPerRequest:1});
    try {
      const policy = new HumanSendPolicyService(db,redis,{
        maxTextCharacters:4000,shopPerMinute:2,recipientPerHour:2,repeatedIdenticalPerTenMinutes:2,
      });
      const command = {commandId:`cmd-${randomUUID()}`,shopId:f.shopId,recipient:"15551234567",
        kind:"HUMAN_TEXT" as const,content:"An ordinary human response"};
      const replay = await Promise.all(Array.from({length:8},()=>policy.screenHumanCommand(command)));
      expect(replay.every(result=>result.kind==="allowed")).toBe(true);
      expect(await policy.screenHumanCommand({...command,commandId:`cmd-${randomUUID()}`})).toEqual({kind:"allowed"});
      expect(await policy.screenHumanCommand({...command,commandId:`cmd-${randomUUID()}`})).toEqual({kind:"denied",reason:"human_rate_limited"});
      const scoped = await redis.keys("human:*:seen:*");
      expect(scoped.length).toBeGreaterThan(0);
      const ttl = await redis.pttl(scoped[0]!);
      expect(ttl).toBeGreaterThan(0);
    } finally {
      await redis.quit();await f.cleanup();await db.$disconnect();
    }
  },60_000);

});
