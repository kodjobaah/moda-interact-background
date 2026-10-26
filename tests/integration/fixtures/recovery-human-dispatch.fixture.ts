import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { vi } from "vitest";
import { allowModerationFixture } from "./arch040-allow-moderation.fixture.js";
import type { ModerationAssessmentService } from "../../../src/services/conversation-moderation/moderation-assessment.service.js";
import { startArch040BackgroundMocks } from "./arch040-background-mocks.fixture.js";
import { RecoveryOutreachAttemptService } from "../../../src/services/recovery-outreach-attempt.service.js";
import {
  HumanCommandDispatcherService, type HumanDispatcherDependencies,
} from "../../../src/services/recovery-conversation/human-command-dispatcher.service.js";
import { MerchantSendCommandService } from "../../../src/services/recovery-conversation/merchant-send-command.service.js";
import { HumanCommandEvaluationService } from "../../../src/services/recovery-conversation/human-command-evaluation.service.js";
import { HumanSendPolicyService, type HumanPolicyConfig } from "../../../src/services/recovery-conversation/human-send-policy.service.js";
import { RecoveryFollowUpPolicyService } from "../../../src/services/recovery-conversation/recovery-follow-up-policy.service.js";
import { OutboundSendFenceService } from "../../../src/services/recovery-conversation/outbound-send-fence.service.js";
import { HumanSendReconciliationService } from "../../../src/services/recovery-conversation/human-send-reconciliation.service.js";
import { FollowUpClaimCancellationService } from "../../../src/services/recovery-conversation/follow-up-claim-cancellation.service.js";
import { RecoveryFollowUpBillingService, type PersistedFollowUpReservation } from
  "../../../src/services/recovery-conversation/recovery-follow-up-billing.service.js";
import { FreeRecoveryReservationService } from "../../../src/services/free-recovery-reservation.service.js";

export async function humanDispatchFixture(label: string) {
  const url = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!url || !redisUrl || process.env.MODA_DISPOSABLE_INTEGRATION !== "1") {
    throw new Error("ARCH-040 HUMAN dispatcher requires disposable PostgreSQL and Redis");
  }
  const db = new PrismaClient({ datasourceUrl: url });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const shopId = `arch040-b002-${label}-${randomUUID()}`;
  const recoveryId = randomUUID();
  const conversationId = randomUUID();
  const recipient = "15551234567";
  const administratorIds: string[] = [];
  await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.test`, status: "ACTIVE" } });
  await db.checkoutRecovery.create({ data: {
    id: recoveryId, shopId, checkoutToken: `${recoveryId}-checkout`,
    lastExternalActivityAt: new Date(), status: "MESSAGE_SENT",
  } });
  await db.conversation.create({ data: {
    id: conversationId, type: "RECOVERY", checkoutRecoveryId: recoveryId,
    lastInboundAt: new Date(Date.now() - 60_000),
  } });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation"
      SET "controlMode"='HUMAN',"controlRevision"=1,"controlChangedAt"=statement_timestamp()
      WHERE "id"=$1`, conversationId);
    await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
      ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
      VALUES ($1,$2,'AI','HUMAN',0,1)`, randomUUID(), conversationId);
  });

  const mocks = await startArch040BackgroundMocks();
  const commands = new MerchantSendCommandService(db);
  const followUps = new RecoveryFollowUpPolicyService(db);
  const reconciliation = new HumanSendReconciliationService(db);
  const durableEligibility = vi.fn(async () => null);
  const provider = mocks.provider;
  const billing = {
    admitAndRevalidate: vi.fn(async (input: { shopId: string; recoveryId: string; sequenceTwoAttemptId: string }) => ({
      kind: "admitted", admission: { sourceKey: `recovery-outreach:${input.sequenceTwoAttemptId}` },
    } as const)),
    onConfirmedProviderSend: vi.fn(async () => {}),
    onDefinitiveProviderFailure: vi.fn(async () => {}),
    releaseBeforePermit: vi.fn(async () => {}),
  };
  const execution = { evaluate: vi.fn(async () => ({ allowed: true } as const)) };
  const releaseExistingCredit = vi.fn(async (admission: PersistedFollowUpReservation) => {
    if (admission.capacity !== "free") throw new Error("Unsupported fixture credit type");
    const released = await new FreeRecoveryReservationService(db).release(admission);
    if (released.kind !== "released" && released.kind !== "already-released") {
      throw new Error("Fixture release did not release credit");
    }
  });
  function cancellationService(
    release: (admission: PersistedFollowUpReservation) => Promise<void> = releaseExistingCredit,
  ) {
    return new FollowUpClaimCancellationService(db, commands,
      new RecoveryFollowUpBillingService(undefined, release));
  }

  function dispatcher(limits?: HumanPolicyConfig, moderation: ModerationAssessmentService = allowModerationFixture(), incidents?: HumanDispatcherDependencies["incidents"], senderPreflight?: HumanDispatcherDependencies["senderPreflight"]) {
    const screening = new HumanSendPolicyService(db, redis, limits);
    const evaluator = new HumanCommandEvaluationService(commands, followUps, screening);
    const deps = {
      database: db,
      outreach: new RecoveryOutreachAttemptService(db),
      commands, followUps, evaluator,
      fence: new OutboundSendFenceService(db, durableEligibility, () => new Date(),
        async () => null), // Existing ARCH040 suites test policy; BG007 SQL tests cover registration independently.
      reconciliation, billing, provider, execution,
      followUpCancellations: cancellationService(),
      now: () => new Date(), moderation, incidents, senderPreflight,
      storedConsent: { preflight: vi.fn(async () => ({ kind: "allowed", snapshot: null })) },
      followUpTemplates: { resolve: vi.fn(async () => ({
        kind: "prepared", prepared: { purpose: "FOLLOW_UP_NO_OFFER" },
        send: { templateName: "recovery_follow_up", languageCode: "en_US",
          bodyParameters: [], templateRegistration: {
            shopId, senderWabaId: "123456789", purpose: "FOLLOW_UP_NO_OFFER",
            variantId: "arch040-variant", registrationId: "arch040-reg",
            definitionId: "arch040-definition", providerTemplateId: "arch040-provider",
            providerTemplateName: "recovery_follow_up", providerLanguageCode: "en_US",
            submittedContentHash: "a".repeat(64), bindingFingerprint: "a".repeat(64),
          },
        },
      })) },
    } as unknown as HumanDispatcherDependencies;
    return new HumanCommandDispatcherService(deps);
  }

  async function addCommand(input: {
    kind?: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE";
    idempotencyKey?: string; attemptId?: string; textBody?: string;
    seedVerifiedInbound?: boolean;
    /** The accepted command payload is immutable; select the template at creation. */
    templateName?: string;
  } = {}) {
    const id = randomUUID();
    const key = input.idempotencyKey ?? id;
    const kind = input.kind ?? "HUMAN_TEXT";
    // A real recovery text reply needs sent sequence 1 and a verified customer
    // inbound after it. lastInboundAt alone must never open the service window.
    if (kind === "HUMAN_TEXT") {
      const initial = await db.recoveryOutreachAttempt.findFirst({
        where: { checkoutRecoveryId: recoveryId, sequence: 1 }, select: { id: true },
      });
      if (!initial) await addInitialOutreach();
      if (input.seedVerifiedInbound !== false) {
        const incomingAt = new Date(Date.now() - 5_000);
        await db.conversationMessage.create({ data: {
          conversationId, direction: "INBOUND", senderType: "CUSTOMER", status: "DELIVERED",
          providerMessageId: `arch040-inbound-${randomUUID()}`, content: "Customer requested a reply",
          createdAt: incomingAt,
        } });
        await db.conversation.update({ where: { id: conversationId }, data: { lastInboundAt: incomingAt } });
      }
    }
    const text = kind === "HUMAN_TEXT" ? input.textBody ?? `Hello ${id}` : null;
    const digest = createHash("sha256").update(`${key}:${kind}`).digest("hex");
    await db.$executeRawUnsafe(`INSERT INTO "whatsapp"."MerchantConversationSendCommand"
      ("id","shopId","conversationId","idempotencyKey","payloadSha256", "expectedControlRevision",
       "kind","recipientSnapshot","textBody","templateName","templateLanguageCode","recoveryOutreachAttemptId")
      VALUES ($1,$2,$3,$4,$5,1,$6::"whatsapp"."MerchantConversationSendKind",$7,$8,$9,$10,$11)`,
      id, shopId, conversationId, key, digest, kind, recipient, text,
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? (input.templateName ?? "recovery_follow_up") : null,
      kind === "RECOVERY_FOLLOW_UP_TEMPLATE" ? "en_US" : null, input.attemptId ?? null);
    return id;
  }

  async function addInitialOutreach() {
    // HUMAN_TEXT fixtures may already have seeded sequence 1; a later
    // follow-up must reuse that durable initial attempt rather than insert it twice.
    const existing = await db.recoveryOutreachAttempt.findFirst({
      where: { checkoutRecoveryId: recoveryId, sequence: 1 }, select: { id: true },
    });
    if (existing) return;
    const sentAt = new Date(Date.now() - 48 * 60 * 60_000);
    const messageId = randomUUID();
    await db.conversationMessage.create({ data: {
      id: messageId, conversationId, direction: "OUTBOUND", senderType: "AUTOMATION",
      status: "SENT", content: "Initial recovery outreach", createdAt: sentAt, sentAt,
    } });
    await db.$executeRawUnsafe(`INSERT INTO "commerce"."RecoveryOutreachAttempt"
      ("id","checkoutRecoveryId","recipient","sequence","trigger","status",
       "configuredOfferMode","outboundMessageId","sentAt","followUpDueAt","updatedAt")
      VALUES ($1,$2,$3,1,'INITIAL','WAITING_FOR_RESPONSE','NONE',$4,$5,$6,statement_timestamp())`,
      randomUUID(), recoveryId, recipient, messageId, sentAt,
      new Date(sentAt.getTime() + 60 * 60_000));
    await db.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation" SET "lastInboundAt"=$2 WHERE "id"=$1`,
      conversationId, sentAt);
  }

  async function addMerchantFollowUpCommand(templateName = "recovery_follow_up") {
    await addInitialOutreach();
    const idempotencyKey = `merchant-${recoveryId}`;
    const claim = await followUps.claimSequenceTwo({
      recoveryId, initiator: "merchant_post_window", expectedRevision: 1,
      initiationKey: idempotencyKey, recipient, now: new Date(),
    });
    if (claim.kind !== "claimed") throw new Error(`Expected an eligible HUMAN follow-up: ${claim.reason}`);
    const commandId = await addCommand({ kind: "RECOVERY_FOLLOW_UP_TEMPLATE",
      idempotencyKey, attemptId: claim.attemptId, templateName });
    return { commandId, attemptId: claim.attemptId };
  }

  async function changeOwner(fromMode: "AI" | "HUMAN", toMode: "AI" | "HUMAN", revision: number) {
    await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, shopId);
      await tx.$queryRawUnsafe(`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, conversationId);
      await tx.$executeRawUnsafe(`UPDATE "whatsapp"."Conversation"
        SET "controlMode"=$2::"whatsapp"."ConversationControlMode",
          "controlRevision"=$3,"controlChangedAt"=statement_timestamp() WHERE "id"=$1`,
        conversationId, toMode, revision + 1);
      await tx.$executeRawUnsafe(`INSERT INTO "whatsapp"."ConversationControlEvent"
        ("id","conversationId","fromMode","toMode","fromRevision","toRevision")
        VALUES ($1,$2,$3::"whatsapp"."ConversationControlMode",
          $4::"whatsapp"."ConversationControlMode",$5,$6)`,
        randomUUID(), conversationId, fromMode, toMode, revision, revision + 1);
    });
  }

  async function suspendShop() {
    const adminId = randomUUID();
    administratorIds.push(adminId);
    await db.platformAdmin.create({ data: { id: adminId, email: `${adminId}@example.test` } });
    await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, shopId);
      await tx.$executeRawUnsafe(`INSERT INTO "commerce"."ShopHumanMessagingRestriction"
        ("shopId","status","revision","reasonCode","suspendedAt")
        VALUES ($1,'SUSPENDED',1,'manual_review',statement_timestamp())`, shopId);
      await tx.$executeRawUnsafe(`INSERT INTO "commerce"."ShopHumanMessagingRestrictionEvent"
        ("id","shopId","fromStatus","toStatus","revision","reasonCode","platformAdminId")
        VALUES ($1,$2,'ACTIVE','SUSPENDED',1,'manual_review',$3)`, randomUUID(), shopId, adminId);
    });
  }

  async function commandState(id: string) {
    const [record] = await db.$queryRawUnsafe<Array<{
      state: string; providerDispatchKey: string | null; outboundMessageId: string | null;
      dispatchAttemptCount: number;
    }>>(`SELECT "state"::text,"providerDispatchKey","outboundMessageId","dispatchAttemptCount"
      FROM "whatsapp"."MerchantConversationSendCommand" WHERE "id"=$1`, id);
    return record;
  }

  return {
    db, redis, shopId, recoveryId, conversationId, recipient,
    commands, followUps, reconciliation, billing, execution, provider,
    releaseExistingCredit, cancellationService,
    whatsapp: mocks.whatsapp, providerHttpRequests: mocks.requests,
    failNextProviderHttp: mocks.failNextHttp, holdNextProviderHttp: mocks.holdNextHttp,
    startAimock: mocks.startAimock,
    durableEligibility, dispatcher, addCommand, addInitialOutreach, addMerchantFollowUpCommand, changeOwner, suspendShop, commandState,
    async close() {
      await db.shop.delete({ where: { id: shopId } });
      for (const id of administratorIds) await db.platformAdmin.delete({ where: { id } });
      try {
        await mocks.close();
      } finally {
        await redis.quit();
        await db.$disconnect();
      }
    },
  };
}
