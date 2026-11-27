import { createHash, randomUUID } from "node:crypto";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { moderationConfig } from "../../../src/services/conversation-moderation/moderation-policy.js";
import { OutboundSendFenceService } from "../../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { approvedMerchantFollowUpFixture } from "./arch047-human-follow-up.fixture.js";
import { seedApprovedInitialWooTemplateRegistration } from "./woo-approved-initial-template.fixture.js";

/** Disposable SQL permit fixture. Reuse the existing loopback infrastructure
 * and real persisted prerequisites; never submit a provider message here. */
export async function recoveryWindowFixture(name: string) {
  // Reuse the existing registered-sender, approved-template and funded
  // follow-up fixture. No provider submission is made by these SQL tests.
  const seeded = await approvedMerchantFollowUpFixture(`window-${name}`);
  const { f, identity } = seeded;
  const { db, shopId, conversationId, recoveryId, recipient, commands, followUps: policy } = f;
  const now = new Date(Date.now() - 2_000);
  const fence = new OutboundSendFenceService(db, async () => null, () => now);
  let initialTemplate: Awaited<ReturnType<typeof seedApprovedInitialWooTemplateRegistration>> | undefined;
  try {
    await db.conversation.update({ where: { id: conversationId }, data: { lastInboundAt: now } });
  } catch (error) {
    await seeded.cleanup();
    throw error;
  }

  async function seedInitial(sentAt: Date, followUpDueAt: Date | null) {
    const messageId = randomUUID();
    const initialId = randomUUID();
    await db.conversationMessage.create({ data: {
      id: messageId, conversationId, direction: "OUTBOUND", senderType: "AUTOMATION",
      status: "SENT", content: "initial", sentAt, createdAt: sentAt,
      providerMessageId: `wamid-window-${randomUUID()}`,
      dispatchProviderAccountId: identity.senderWabaId,
      dispatchProviderPhoneNumberId: f.whatsapp.phoneNumberId,
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
    if (kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
      if (!attemptId) throw new Error("Fixture follow-up attempt missing");
      await seeded.reserveFollowUp(attemptId);
    }
    await db.$executeRawUnsafe(`INSERT INTO "whatsapp"."MerchantConversationSendCommand"
      ("id","shopId","conversationId","idempotencyKey","payloadSha256",
       "expectedControlRevision","followUpClaimKey","kind","recipientSnapshot","textBody","templateName",
       "templateLanguageCode","recoveryOutreachAttemptId")
      VALUES ($1,$2,$3,$4,$5,1,$6,$7::"whatsapp"."MerchantConversationSendKind",
       $8,$9,$10,$11,$12)`, id, shopId, conversationId, initiationKey,
      createHash("sha256").update(id).digest("hex"),
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? initiationKey : null, kind, recipient,
      kind === "HUMAN_TEXT" ? "Hello" : null,
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? identity.providerTemplateName : null,
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? identity.providerLanguageCode : null, attemptId ?? null);
    const leased = (await commands.claimDueHumanCommands({ limit: 20, now: new Date() }))
      .find((candidate) => candidate.id === id);
    if (!leased) throw new Error(`Fixture failed to lease command ${id}`);
    if (kind === "HUMAN_TEXT") {
      const loaded = await commands.loadClaimedCommand(id, leased.leaseToken);
      if (loaded.kind !== "claimed") throw new Error(`Fixture command refused: ${loaded.reason}`);
      const frozen = await f.preparation.freeze(loaded.command, leased.leaseToken);
      if (frozen.kind !== "frozen") throw new Error(`Fixture preparation refused: ${frozen.reason}`);
      const assessed = await f.persistedAllowModeration().assessText({
        subject: { kind: "HUMAN_COMMAND", commandId: id }, shopId, conversationId,
        effectiveText: frozen.body, inputKind: "TEXT", policyVersion: moderationConfig().policyVersion,
        now: new Date(),
      });
      if (assessed.kind !== "allow") throw new Error(`Fixture moderation refused: ${assessed.kind}`);
    }
    return { id, token: leased.leaseToken, initiationKey };
  }
  async function permit(id: string, token: string) {
    const row = await db.merchantConversationSendCommand.findUniqueOrThrow({ where: { id } });
    return fence.admitFinalSend({ senderType: "HUMAN", conversationId, recoveryId,
      shopId, commandId: id, leaseToken: token, expectedControlRevision: 1, recipient, now,
      ...(row.kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? {
        deliveryKind: "TEMPLATE" as const, proactive: {
          consent: null, verifiedCategory: "MARKETING" as const,
          templateName: identity.providerTemplateName, languageCode: identity.providerLanguageCode,
          templateRegistration: identity,
        },
      } : {}),
    });
  }
  async function aiMode() { await f.changeOwner("HUMAN", "AI", 1); }
  // The existing test intentionally probes the verified-window gate with
  // AUTOMATION/TEXT. Supply valid marketing metadata to reach that gate,
  // then exercise actual initial template admission rather than a bare row.
  async function initialMarketing() {
    if (!initialTemplate) {
      initialTemplate = await seedApprovedInitialWooTemplateRegistration(
        db, shopId, `https://${shopId}.example.test`, true, identity.senderWabaId,
      );
    }
    return { consent: null, verifiedCategory: "MARKETING" as const,
      templateName: initialTemplate.providerTemplateName,
      languageCode: initialTemplate.providerLanguageCode,
      templateRegistration: initialTemplate };
  }
  async function fundInitialPermit(messageId: string) {
    return db.$transaction(async tx => {
      await tx.checkoutRecovery.update({ where: { id: recoveryId }, data: { status: "DETECTED" } });
      const attempt = await tx.recoveryOutreachAttempt.create({ data: {
        checkoutRecoveryId: recoveryId, sequence: 1, trigger: "INITIAL", recipient,
        status: "PENDING", configuredOfferMode: "NONE",
      } });
      const idempotencyKey = `recovery-outreach:${attempt.id}`;
      const sourceKey = createRecoveryIdempotencyKey(shopId, idempotencyKey);
      const counter = await tx.shopEntitlementCounter.create({ data: {
        shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 1, reservedQuantity: 1,
      } });
      await tx.usageReservation.create({ data: {
        shopId, counterId: counter.id, sourceKey, quantity: 1, status: "RESERVED",
      } });
      await tx.usageEvent.create({ data: {
        shopId, provider: "SHOPIFY", metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
        sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: messageId, idempotencyKey,
      } });
      const message = await tx.conversationMessage.findUniqueOrThrow({ where: { id: messageId } });
      return { outreachAttemptId: attempt.id, idempotencyKey,
        recoveryCreditSourceKey: sourceKey, expectedContent: message.content };
    });
  }
  async function close() {
    try {
      if (initialTemplate) {
        const registration = await db.whatsAppTemplateMetaRegistration.findUniqueOrThrow({ where: { id: initialTemplate.registrationId } });
        const definition = await db.whatsAppTemplateDefinition.findUniqueOrThrow({ where: { id: initialTemplate.definitionId } });
        await db.whatsAppTemplateVariant.delete({ where: { id: initialTemplate.variantId } });
        await db.whatsAppTemplateMetaRegistration.delete({ where: { id: registration.id } });
        await db.whatsAppTemplateLocale.delete({ where: { id: registration.localeId } });
        await db.whatsAppTemplateDefinition.delete({ where: { id: definition.id } });
        await db.platformAdmin.delete({ where: { id: definition.createdByAdminId } });
      }
    } finally { await seeded.cleanup(); }
  }
  return { db, shopId, recoveryId, conversationId, recipient, now, policy, fence,
    seedInitial, inbound, command, permit, aiMode, initialMarketing, fundInitialPermit, close,
  };
}
