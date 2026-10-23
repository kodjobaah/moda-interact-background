import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { MerchantSendCommandService } from "../../src/services/recovery-conversation/merchant-send-command.service.js";
import { OutboundSendFenceService } from "../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { HumanSendReconciliationService } from "../../src/services/recovery-conversation/human-send-reconciliation.service.js";
import { RecoveryFollowUpPolicyService } from "../../src/services/recovery-conversation/recovery-follow-up-policy.service.js";
import { HumanSendPolicyService } from "../../src/services/recovery-conversation/human-send-policy.service.js";
import { HumanCommandEvaluationService } from "../../src/services/recovery-conversation/human-command-evaluation.service.js";
import type { RecoveryDatabase, SqlTransaction } from "../../src/services/recovery-conversation/recovery-conversation.sql.js";

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
    if (kind === "HUMAN_TEXT") {
      const initial = await db.recoveryOutreachAttempt.findFirst({ where: {
        checkoutRecoveryId: recoveryId, sequence: 1,
      } });
      if (!initial) await initialOutreach(db, conversationId, recoveryId);
      await db.conversationMessage.create({ data: {
        conversationId, direction: "INBOUND", senderType: "CUSTOMER", status: "DELIVERED",
        providerMessageId: `arch040-inbound-${randomUUID()}`, content: "Customer replied",
        createdAt: new Date(Date.now() - 5_000),
      } });
    }
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

/** Seed a sent initial outreach; waiting state requires a real sent message. */
async function initialOutreach(db: PrismaClient, conversationId: string, recoveryId: string) {
  const initialId = randomUUID();
  const initialMessageId = randomUUID();
  const initialSentAt = new Date(Date.now() - 48 * 60 * 60_000);
  await db.conversationMessage.create({ data: {
    id: initialMessageId, conversationId,
    direction: "OUTBOUND", senderType: "AUTOMATION", status: "SENT",
    content: "Initial recovery outreach", createdAt: initialSentAt, sentAt: initialSentAt,
  } });
  await db.$executeRawUnsafe(`INSERT INTO "commerce"."RecoveryOutreachAttempt"
    ("id","checkoutRecoveryId","recipient","sequence","trigger","status",
     "configuredOfferMode","outboundMessageId","sentAt","followUpDueAt","updatedAt")
    VALUES ($1,$2,'15551234567',1,'INITIAL','WAITING_FOR_RESPONSE','NONE',$3,$4,$5,statement_timestamp())`,
  initialId, recoveryId, initialMessageId, initialSentAt,
  new Date(initialSentAt.getTime() + 60 * 60_000));
  await db.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation" SET "lastInboundAt"=$2 WHERE "id"=$1`,
    conversationId, initialSentAt);
}

/** Exercise real control transitions rather than artificially toggling fixture modes. */
async function transitionControl(db: PrismaClient, shopId: string, conversationId: string,
  fromMode: "AI" | "HUMAN", toMode: "AI" | "HUMAN", fromRevision: number) {
  await db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, shopId);
    await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, conversationId);
    await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation" SET "controlMode"=$2::"whatsapp"."ConversationControlMode",
      "controlRevision"=$3,"controlChangedAt"=statement_timestamp() WHERE "id"=$1`,
    conversationId, toMode, fromRevision + 1);
    await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
      ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
      VALUES ($1,$2,$3::"whatsapp"."ConversationControlMode",$4::"whatsapp"."ConversationControlMode",$5,$6)`,
    randomUUID(), conversationId, fromMode, toMode, fromRevision, fromRevision + 1);
  });
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
      const durableEligibility = vi.fn(async () => null); // BG002's entitlement/billing admission port
      const permit=await new OutboundSendFenceService(db,durableEligibility).admitFinalSend({senderType:"HUMAN",
        conversationId:f.conversationId,recoveryId:f.recoveryId,shopId:f.shopId,
        commandId:cmdId,leaseToken:claim.leaseToken,expectedControlRevision:1,recipient:"15551234567",now:new Date()});
      expect(permit).toEqual({kind:"suppressed",reason:"human_messaging_suspended"});
      expect(durableEligibility).not.toHaveBeenCalled();
      expect(await db.$queryRawUnsafe(`SELECT "providerDispatchKey" FROM "whatsapp"."MerchantConversationSendCommand"
        WHERE "id"=$1`, cmdId)).toEqual([{ providerDispatchKey: null }]);
    } finally { await f.cleanup();await db.platformAdmin.delete({where:{id:adminId}});await db.$disconnect(); }
  },60_000);

  it("HUMAN takeover wins an overlapping eligible-AI scheduled claim, consuming only one shared slot", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const f = await fixture(db, "followup-human-wins");
    let unblock = () => {};
    try {
      await initialOutreach(db, f.conversationId, f.recoveryId);
      // The scheduled caller starts while committed mode is AI, not the fixture's default HUMAN.
      await transitionControl(db, f.shopId, f.conversationId, "HUMAN", "AI", 1);
      expect(await db.$queryRawUnsafe(`SELECT "controlMode"::text AS mode FROM "whatsapp"."Conversation"
        WHERE "id"=$1`, f.conversationId)).toEqual([{ mode: "AI" }]);
      let takeoverReady!: () => void;
      let releaseTakeover!: () => void;
      const ready = new Promise<void>((resolve) => { takeoverReady = resolve; });
      const release = new Promise<void>((resolve) => { releaseTakeover = resolve; });
      unblock = releaseTakeover;
      const takeover = db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, f.shopId);
        await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, f.conversationId);
        await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation" SET "controlMode"='HUMAN',
          "controlRevision"=3,"controlChangedAt"=statement_timestamp() WHERE "id"=$1`, f.conversationId);
        await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
          ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
          VALUES ($1,$2,'AI','HUMAN',2,3)`, randomUUID(), f.conversationId);
        takeoverReady();
        await release;
      }, { timeout: 20_000 });
      await ready;
      const service = new RecoveryFollowUpPolicyService(db);
      const autoKey = `auto-${randomUUID()}`;
      const humanKey = `human-${randomUUID()}`;
      let autoFinished = false;
      let humanFinished = false;
      const scheduled = service.claimSequenceTwo({ recoveryId: f.recoveryId, initiator: "scheduled_no_response",
        initiationKey: autoKey, recipient: "15551234567", now: new Date() })
        .then((result) => { autoFinished = true; return result; });
      const merchant = service.claimSequenceTwo({ recoveryId: f.recoveryId, initiator: "merchant_post_window",
        initiationKey: humanKey, recipient: "15551234567", now: new Date(), expectedRevision: 3 })
        .then((result) => { humanFinished = true; return result; });
      await pause(100);
      expect(autoFinished).toBe(false);
      expect(humanFinished).toBe(false);
      releaseTakeover();
      await takeover;
      const [autoResult, humanResult] = await Promise.all([scheduled, merchant]);
      expect(autoResult).toEqual({ kind: "suppressed", reason: "human-controlled" });
      expect(humanResult.kind).toBe("claimed");
      const rows = await db.$queryRawUnsafe<Array<{ id: string; initiatedBy: string; initiationKey: string }>>(`
        SELECT "id","initiatedBy"::text,"initiationKey" FROM "commerce"."RecoveryOutreachAttempt"
        WHERE "checkoutRecoveryId"=$1 AND "sequence"=2`, f.recoveryId);
      expect(rows).toEqual([{ id: expect.any(String), initiatedBy: "HUMAN", initiationKey: humanKey }]);
      if (humanResult.kind === "claimed")
        expect(humanResult.billingSource).toBe(`recovery-outreach:${rows[0]!.id}`);
    } finally { unblock(); await f.cleanup(); await db.$disconnect(); }
  }, 60_000);

  it("scheduled claimant wins in AI mode while HUMAN takeover and merchant claim compete for the same slot", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const f = await fixture(db, "followup-auto-wins");
    let unblock = () => {};
    try {
      await initialOutreach(db, f.conversationId, f.recoveryId);
      await transitionControl(db, f.shopId, f.conversationId, "HUMAN", "AI", 1);
      // Pause inside the real scheduled claimant's open PostgreSQL transaction AFTER
      // it has checked AI ownership and locked sequence 1. This is not a mocked claim.
      let scheduledEligible!: () => void;
      let releaseScheduled!: () => void;
      const eligible = new Promise<void>((resolve) => { scheduledEligible = resolve; });
      const release = new Promise<void>((resolve) => { releaseScheduled = resolve; });
      unblock = releaseScheduled;
      const stagedDb = {
        $transaction: (work: (tx: SqlTransaction) => Promise<unknown>) => db.$transaction(async (tx) => {
          let paused = false;
          const stagedTx = {
            $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => {
              const result = await tx.$queryRawUnsafe(sql, ...parameters);
              if (!paused && sql.includes('FOR UPDATE OF initial')) {
                paused = true;
                scheduledEligible();
                await release;
              }
              return result;
            },
            $executeRawUnsafe: tx.$executeRawUnsafe.bind(tx),
          } as unknown as SqlTransaction;
          return work(stagedTx);
        }, { timeout: 20_000 }),
      } as unknown as RecoveryDatabase;
      const autoKey = `auto-${randomUUID()}`;
      const humanKey = `human-${randomUUID()}`;
      const scheduled = new RecoveryFollowUpPolicyService(stagedDb).claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "scheduled_no_response", initiationKey: autoKey,
        recipient: "15551234567", now: new Date(),
      });
      await eligible;
      let takeoverFinished = false;
      const takeover = transitionControl(db, f.shopId, f.conversationId, "AI", "HUMAN", 2)
        .then(() => { takeoverFinished = true; });
      // The merchant caller overlaps the scheduled PostgreSQL claim and takeover.
      const merchant = new RecoveryFollowUpPolicyService(db).claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", initiationKey: humanKey,
        recipient: "15551234567", now: new Date(), expectedRevision: 3,
      });
      await pause(100);
      expect(takeoverFinished).toBe(false);
      releaseScheduled();
      const autoResult = await scheduled;
      await takeover;
      const humanResult = await merchant;
      expect(autoResult.kind).toBe("claimed");
      expect(humanResult.kind).toBe("suppressed");
      const rows = await db.$queryRawUnsafe<Array<{ id: string; initiatedBy: string; initiationKey: string }>>(`
        SELECT "id","initiatedBy"::text,"initiationKey" FROM "commerce"."RecoveryOutreachAttempt"
        WHERE "checkoutRecoveryId"=$1 AND "sequence"=2`, f.recoveryId);
      expect(rows).toEqual([{ id: expect.any(String), initiatedBy: "AUTOMATION", initiationKey: autoKey }]);
      if (autoResult.kind === "claimed")
        expect(autoResult.billingSource).toBe(`recovery-outreach:${rows[0]!.id}`);
      // A later valid HUMAN claim cannot replace the committed AUTOMATION owner.
      expect(await new RecoveryFollowUpPolicyService(db).claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", initiationKey: humanKey,
        recipient: "15551234567", now: new Date(), expectedRevision: 3,
      })).toEqual({ kind: "suppressed", reason: "already-claimed" });
    } finally { unblock(); await f.cleanup(); await db.$disconnect(); }
  }, 60_000);

  it("a stale HUMAN claim cannot consume sequence two across a takeover lock", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const f = await fixture(db, "claim-fence");
    let unblock = () => {};
    try {
      await initialOutreach(db, f.conversationId, f.recoveryId);
      let takeoverReady!: () => void;
      let releaseTakeover!: () => void;
      const ready = new Promise<void>((resolve) => { takeoverReady = resolve; });
      const release = new Promise<void>((resolve) => { releaseTakeover = resolve; });
      unblock = releaseTakeover;
      const takeover = db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, f.shopId);
        await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, f.conversationId);
        await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation"
          SET "controlMode"='AI',"controlRevision"=2,"controlChangedAt"=statement_timestamp()
          WHERE "id"=$1`, f.conversationId);
        await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
          ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
          VALUES ($1,$2,'HUMAN','AI',1,2)`, randomUUID(), f.conversationId);
        takeoverReady();
        await release;
      }, { timeout: 20_000 });
      await ready;
      const service = new RecoveryFollowUpPolicyService(db);
      let finished = false;
      const pending = service.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", initiationKey: randomUUID(),
        recipient: "15551234567", now: new Date(), expectedRevision: 1,
      }).then((result) => { finished = true; return result; });
      await pause(100);
      expect(finished).toBe(false); // shop/conversation lock serializes the claim
      releaseTakeover();
      await takeover;
      expect(await pending).toEqual({ kind: "suppressed", reason: "human-inactive-or-stale" });
      const unused = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "commerce"."RecoveryOutreachAttempt"
        WHERE "checkoutRecoveryId"=$1 AND "sequence"=2`, f.recoveryId);
      expect(unused).toHaveLength(0);
      await db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, f.shopId);
        await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, f.conversationId);
        await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation"
          SET "controlMode"='HUMAN',"controlRevision"=3,"controlChangedAt"=statement_timestamp()
          WHERE "id"=$1`, f.conversationId);
        await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
          ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
          VALUES ($1,$2,'AI','HUMAN',2,3)`, randomUUID(), f.conversationId);
      });
      const oldRevision = await service.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", initiationKey: randomUUID(),
        recipient: "15551234567", now: new Date(), expectedRevision: 1,
      });
      expect(oldRevision).toEqual({ kind: "suppressed", reason: "human-inactive-or-stale" });
      const valid = await service.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", initiationKey: randomUUID(),
        recipient: "15551234567", now: new Date(), expectedRevision: 3,
      });
      expect(valid.kind).toBe("claimed");
      expect((await service.claimSequenceTwo({
        recoveryId: f.recoveryId, initiator: "merchant_post_window", initiationKey: randomUUID(),
        recipient: "15551234567", now: new Date(), expectedRevision: 3,
      })).kind).toBe("suppressed");
    } finally { unblock(); await f.cleanup(); await db.$disconnect(); }
  }, 60_000);

  it("only one worker can claim the same command under concurrent SKIP LOCKED calls", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const other = new PrismaClient({ datasourceUrl: url! });
    const f = await fixture(db, "same-command");
    let unblock = () => {};
    try {
      const commandId = await f.addCommand();
      let locked!: () => void;
      let unlock!: () => void;
      const ready = new Promise<void>((resolve) => { locked = resolve; });
      const release = new Promise<void>((resolve) => { unlock = resolve; });
      unblock = unlock;
      const blocker = db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."MerchantConversationSendCommand"
          WHERE "id"=$1 FOR UPDATE`, commandId);
        locked();
        await release;
      }, { timeout: 20_000 });
      await ready;
      const first = new MerchantSendCommandService(db);
      const second = new MerchantSendCommandService(other);
      const now = new Date();
      const skipped = await Promise.all([
        first.claimDueHumanCommands({ limit: 1, now }),
        second.claimDueHumanCommands({ limit: 1, now }),
      ]);
      expect(skipped.flat()).toEqual([]); // neither waits on the row lock
      unlock(); await blocker;
      const concurrent = await Promise.all([
        first.claimDueHumanCommands({ limit: 1, now }),
        second.claimDueHumanCommands({ limit: 1, now }),
      ]);
      expect(concurrent.flat()).toHaveLength(1);
      expect(concurrent.flat()[0]?.id).toBe(commandId);
      const persisted = await db.$queryRawUnsafe<Array<{ state: string; dispatchAttemptCount: number }>>(`
        SELECT "state"::text,"dispatchAttemptCount" FROM "whatsapp"."MerchantConversationSendCommand"
        WHERE "id"=$1`, commandId);
      expect(persisted).toEqual([{ state: "CLAIMED", dispatchAttemptCount: 1 }]);
      expect(await second.claimDueHumanCommands({ limit: 1, now })).toEqual([]);
    } finally { unblock(); await f.cleanup(); await other.$disconnect(); await db.$disconnect(); }
  }, 60_000);

  it("verified definitive provider rejection settles one message and never permits retry", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const f = await fixture(db, "definitive-failure");
    try {
      const commandId = await f.addCommand();
      const commandService = new MerchantSendCommandService(db);
      const claim = (await commandService.claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const permit = await new OutboundSendFenceService(db, async () => null).admitFinalSend({
        senderType: "HUMAN", conversationId: f.conversationId, recoveryId: f.recoveryId,
        shopId: f.shopId, commandId, leaseToken: claim.leaseToken,
        expectedControlRevision: 1, recipient: "15551234567", now: new Date(),
      });
      expect(permit.kind).toBe("admitted");
      if (permit.kind !== "admitted") throw new Error("provider admission was not granted");
      const reconciliation = new HumanSendReconciliationService(db);
      expect(await reconciliation.recordDefinitiveFailure({
        commandId, leaseToken: claim.leaseToken, reason: "meta_rejected", definitiveProviderEvidence: false,
      })).toEqual({ kind: "ignored", reason: "unverified-provider-outcome" });
      expect(await reconciliation.recordDefinitiveFailure({
        commandId, leaseToken: claim.leaseToken, reason: "meta_rejected", definitiveProviderEvidence: true,
      })).toEqual({ kind: "definitive-failure", messageId: permit.messageId, reason: "meta_rejected" });
      const persisted = await db.$queryRawUnsafe<Array<{
        commandState: string; messageStatus: string; failureCode: string; messageId: string;
      }>>(`SELECT c."state"::text AS "commandState",m."status"::text AS "messageStatus",
        m."providerFailureCode" AS "failureCode",m."id" AS "messageId"
        FROM "whatsapp"."MerchantConversationSendCommand" c
        JOIN "whatsapp"."ConversationMessage" m ON m."id"=c."outboundMessageId"
        WHERE c."id"=$1`, commandId);
      expect(persisted).toEqual([{
        commandState: "FAILED", messageStatus: "FAILED", failureCode: "meta_rejected", messageId: permit.messageId,
      }]);
      expect((await reconciliation.recordDefinitiveFailure({
        commandId, reason: "meta_rejected", definitiveProviderEvidence: true,
      })).kind).toBe("ignored");
      expect((await reconciliation.recordProviderAccepted({
        commandId, providerMessageId: "wa:late", providerVerified: true,
      })).kind).toBe("ignored");
      expect(await commandService.claimDueHumanCommands({ limit: 5, now: new Date(Date.now() + 3600_000) }))
        .toEqual([]);
      expect(await db.conversationMessage.count({ where: { id: permit.messageId } })).toBe(1);
    } finally { await f.cleanup(); await db.$disconnect(); }
  }, 60_000);

  it("UNKNOWN with verified definitive failure resolves to FAILED without a second send", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const f = await fixture(db, "unknown-failure");
    try {
      const commandId = await f.addCommand();
      const claim = (await new MerchantSendCommandService(db).claimDueHumanCommands({ limit: 1, now: new Date() }))[0]!;
      const permit = await new OutboundSendFenceService(db, async () => null).admitFinalSend({
        senderType: "HUMAN", conversationId: f.conversationId, recoveryId: f.recoveryId,
        shopId: f.shopId, commandId, leaseToken: claim.leaseToken,
        expectedControlRevision: 1, recipient: "15551234567", now: new Date(),
      });
      expect(permit.kind).toBe("admitted");
      expect((await new HumanSendReconciliationService(db).recordProviderUnknown({
        commandId, leaseToken: claim.leaseToken,
      })).kind).toBe("unknown");
      const reconciliation = new HumanSendReconciliationService(db);
      expect((await reconciliation.reconcileUnknown({
        commandId, outcome: { kind: "definitive-failure", reason: "meta_rejected" }, verified: false,
      })).kind).toBe("ignored");
      expect((await reconciliation.reconcileUnknown({
        commandId, outcome: { kind: "definitive-failure", reason: "meta_rejected" }, verified: true,
      })).kind).toBe("definitive-failure");
      expect(await db.$queryRawUnsafe(`SELECT "state"::text FROM "whatsapp"."MerchantConversationSendCommand"
        WHERE "id"=$1`, commandId)).toEqual([{ state: "FAILED" }]);
      expect(await new MerchantSendCommandService(db).claimDueHumanCommands({ limit: 1, now: new Date(Date.now() + 3600_000) }))
        .toEqual([]);
    } finally { await f.cleanup(); await db.$disconnect(); }
  }, 60_000);

  it("rate denial stops evaluation before final durable eligibility/billing admission", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    if (!process.env.REDIS_URL) throw new Error("Disposable Redis URL missing");
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    const f = await fixture(db, "rate-before-billing");
    try {
      const firstId = await f.addCommand();
      const secondId = await f.addCommand();
      const commands = new MerchantSendCommandService(db);
      const now = new Date();
      const leases = await commands.claimDueHumanCommands({ limit: 2, now });
      const firstLease = leases.find((lease) => lease.id === firstId);
      const secondLease = leases.find((lease) => lease.id === secondId);
      expect(firstLease).toBeDefined();
      expect(secondLease).toBeDefined();
      const policy = new HumanSendPolicyService(db, redis, {
        maxTextCharacters: 4000, shopPerMinute: 1,
        recipientPerHour: 100, repeatedIdenticalPerTenMinutes: 100,
      });
      const evaluator = new HumanCommandEvaluationService(commands, new RecoveryFollowUpPolicyService(db), policy);
      const durableEligibility = vi.fn(async () => null); // stand-in for BG002's billing and entitlement checks
      const fence = new OutboundSendFenceService(db, durableEligibility);
      // The BG002 orchestration contract: a non-ready screening result must never
      // invoke provider admission (and therefore cannot reach billing admission).
      const evaluateThenAdmit = async (commandId: string, leaseToken: string) => {
        const evaluated = await evaluator.evaluateHumanCommand(commandId, leaseToken, now);
        if (evaluated.kind !== "ready") return evaluated;
        return fence.admitFinalSend({ senderType: "HUMAN", conversationId: f.conversationId,
          recoveryId: f.recoveryId, shopId: f.shopId, commandId, leaseToken,
          expectedControlRevision: 1, recipient: "15551234567", now });
      };
      expect((await evaluateThenAdmit(firstId, firstLease!.leaseToken)).kind).toBe("admitted");
      expect(durableEligibility).toHaveBeenCalledTimes(1);
      expect(await evaluateThenAdmit(secondId, secondLease!.leaseToken))
        .toEqual({ kind: "terminal", reason: "human_rate_limited" });
      expect(durableEligibility).toHaveBeenCalledTimes(1);
      expect(await db.$queryRawUnsafe(`SELECT "state"::text,"providerDispatchKey"
        FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`, secondId))
        .toEqual([{ state: "CLAIMED", providerDispatchKey: null }]);
    } finally { await redis.quit(); await f.cleanup(); await db.$disconnect(); }
  }, 60_000);

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
