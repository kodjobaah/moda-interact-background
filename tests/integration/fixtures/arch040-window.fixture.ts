import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { MerchantSendCommandService } from "../../../src/services/recovery-conversation/merchant-send-command.service.js";
import { OutboundSendFenceService } from "../../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { RecoveryFollowUpPolicyService } from "../../../src/services/recovery-conversation/recovery-follow-up-policy.service.js";

/** Disposable PostgreSQL fixture; no provider, Redis or synthetic fake rows. */
export async function recoveryWindowFixture(name: string) {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
  const shopId = `arch040-b008-${name}-${randomUUID()}`;
  const conversationId = randomUUID();
  const recoveryId = randomUUID();
  const recipient = "15551234567";
  const now = new Date(Date.now() - 2_000);
  await db.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
  await db.checkoutRecovery.create({ data: {
    id: recoveryId, shopId, checkoutToken: `checkout-${recoveryId}`,
    lastExternalActivityAt: now, status: "MESSAGE_SENT",
  } });
  await db.conversation.create({ data: { id: conversationId, checkoutRecoveryId: recoveryId,
    type: "RECOVERY", lastInboundAt: now } });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation"
      SET "controlMode"='HUMAN',"controlRevision"=1,"controlChangedAt"=statement_timestamp()
      WHERE "id"=$1`, conversationId);
    await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
      ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
      VALUES ($1,$2,'AI','HUMAN',0,1)`, randomUUID(), conversationId);
  });
  const policy = new RecoveryFollowUpPolicyService(db);
  const commands = new MerchantSendCommandService(db);
  const fence = new OutboundSendFenceService(db, async () => null, () => now);

  async function seedInitial(sentAt: Date, followUpDueAt: Date | null) {
    const messageId = randomUUID();
    const initialId = randomUUID();
    await db.conversationMessage.create({ data: {
      id: messageId, conversationId, direction: "OUTBOUND", senderType: "AUTOMATION",
      status: "SENT", content: "initial", sentAt, createdAt: sentAt,
    } });
    await db.$executeRawUnsafe(`INSERT INTO "commerce"."RecoveryOutreachAttempt"
      ("id","checkoutRecoveryId","recipient","sequence","trigger","status",
       "configuredOfferMode","sentAt","outboundMessageId","followUpDueAt","updatedAt")
      VALUES ($1,$2,$3,1,'INITIAL','WAITING_FOR_RESPONSE','NONE',$4,$5,$6,statement_timestamp())`,
      initialId, recoveryId, recipient, sentAt, messageId, followUpDueAt);
    return initialId;
  }
  async function inbound(at: Date, verified = true) {
    return db.conversationMessage.create({ data: {
      conversationId, direction: "INBOUND", senderType: "CUSTOMER", status: "DELIVERED",
      content: "customer reply", createdAt: at,
      ...(verified ? { providerMessageId: `wa:${randomUUID()}` } : {}),
    } });
  }
  async function command(kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE", attemptId?: string,
    initiationKey = randomUUID()) {
    const id = randomUUID();
    await db.$executeRawUnsafe(`INSERT INTO "whatsapp"."MerchantConversationSendCommand"
      ("id","shopId","conversationId","idempotencyKey","payloadSha256",
       "expectedControlRevision","kind","recipientSnapshot","textBody","templateName",
       "templateLanguageCode","recoveryOutreachAttemptId")
      VALUES ($1,$2,$3,$4,$5,1,$6::"whatsapp"."MerchantConversationSendKind",
       $7,$8,$9,$10,$11)`, id, shopId, conversationId, initiationKey,
      createHash("sha256").update(id).digest("hex"), kind, recipient,
      kind === "HUMAN_TEXT" ? "Hello" : null,
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? "followup_template" : null,
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? "en" : null, attemptId ?? null);
    const leased = (await commands.claimDueHumanCommands({ limit: 20, now: new Date() }))
      .find((candidate) => candidate.id === id);
    if (!leased) throw new Error(`Fixture failed to lease command ${id}`);
    return { id, token: leased.leaseToken, initiationKey };
  }
  async function permit(id: string, token: string) {
    return fence.admitFinalSend({ senderType: "HUMAN", conversationId, recoveryId,
      shopId, commandId: id, leaseToken: token, expectedControlRevision: 1, recipient, now });
  }
  async function aiMode() {
    await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, shopId);
      await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, conversationId);
      await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation"
        SET "controlMode"='AI',"controlRevision"=2,"controlChangedAt"=statement_timestamp()
        WHERE "id"=$1`, conversationId);
      await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
        ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
        VALUES ($1,$2,'HUMAN','AI',1,2)`, randomUUID(), conversationId);
    });
  }
  return { db, shopId, recoveryId, conversationId, recipient, now, policy, fence,
    seedInitial, inbound, command, permit, aiMode,
    async close() { try { await db.shop.delete({ where: { id: shopId } }); } finally { await db.$disconnect(); } },
  };
}
