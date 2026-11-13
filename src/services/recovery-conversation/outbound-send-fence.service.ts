import { admitMultipartPart } from "../recovery-multipart/fence.js";
import { readFrozenBrandMedia, asMessageDeliveryReceipt } from "../conversation-delivery-plan.js";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import { currentBrandPlanMatches } from "../conversation-brand-media.js";
import { currentRecoveryShopHeaderMatches } from "./recovery-shop-header-verification.js";
import type { RecoveryShopHeaderReceipt } from "../conversation-wrappers/recovery-shop-header.js";
import { sameConversationPlan, validConversationPlan, matchesConversationReceipt, type ConversationDeliveryReceipt } from "../conversation-delivery-plan.js";
import type { ConversationMediaDeliveryPlan } from "@modainteract/moda-interact-shared/commerce/presentation";
import { commitAdmittedProductContext, ProductContextAdmissionError } from "../../commerce/product-context-repository.js";
import type { CommerceConversationProductContext } from "@modainteract/moda-interact-shared/commerce";
import { initialOutreachDiagnostic } from "../outbound-whatsapp-admission/outbound-provider-failure.service.js";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createHash, randomUUID } from "node:crypto";
import { FollowUpClaimKeyIntegrityError } from "./merchant-send-command.service.js";
import { first, rows, lockRecoveryContext, readRecoveryWindowEvidence, recoveryDatabase, terminalRecovery,
  type RecoveryContext, type RecoveryDatabase, type SqlTransaction } from "./recovery-conversation.sql.js";
import { customerWindow, followUpDue } from "./recovery-follow-up-policy.service.js";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";
import type { StoredRecoveryConsentSnapshot } from "./recovery-stored-consent.service.js";
import { checkFinalTemplateRegistration, type FinalTemplateEligibility,
  type FinalTemplateIdentity } from "../recovery-template-integration/final-template-registration.service.js";
import { currentHumanWrapperMatches, parsePreparedEvidence } from "./human-prepared-command.service.js";
import { moderationConfig } from "../conversation-moderation/moderation-policy.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";

const logger = createLogger({ serviceName: "moda-background-runtime", environment: resolveDeploymentEnvironmentName() });

export type DispatchActor = "HUMAN" | "AGENT" | "AUTOMATION";
export type DispatchPermit = { kind: "admitted"; messageId: string; dispatchKey: string; admittedAt: Date; messageContent?: string; deliveryPlan?: ConversationMediaDeliveryPlan }
  | { kind: "suppressed"; reason: string };
export type RecoveryMarketingPermit = {
  consent: StoredRecoveryConsentSnapshot | null;
  verifiedCategory: "MARKETING";
  templateName: string;
  languageCode: string;
  templateRegistration?: FinalTemplateIdentity;
};
export type DispatchInput = {
  /** Server-only persisted child identity; never a model payload. */
  multipartPartId?: string;
  multipartConsent?: StoredRecoveryConsentSnapshot | null;
  recoveryShopHeader?: RecoveryShopHeaderReceipt;
  senderType: DispatchActor;
  conversationId: string; shopId: string; recoveryId: string;
  expectedControlRevision: number;
  expectedInboundVersion?: number;
  productContextUpdate?: CommerceConversationProductContext;
  expectedContent?: string;
  commandId?: string; leaseToken?: string; messageId?: string;
  recipient: string; now: Date;
  /** Provider-verified BEFORE this SQL transaction, never fetched inside it. */
  proactive?: RecoveryMarketingPermit;
  /** Explicitly distinguish approved Meta templates from automated free text. */
  deliveryKind?: "TEXT" | "IMAGE" | "TEMPLATE";
  deliveryPlan?: ConversationMediaDeliveryPlan; presentationReceipt?: ConversationDeliveryReceipt;
  initialOutreach?: {
    outreachAttemptId: string;
    idempotencyKey: string;
    recoveryCreditSourceKey: string;
    expectedContent: string;
  };
};

/** BG002 injects synchronous, database-only checks for shop entitlement, recovery
 * capacity and billing admission. It MUST NOT perform HTTP/Redis/provider I/O.
 * Without the checker this service fails closed; preflight alone is insufficient.
 */
export type DurableEligibility = (tx: SqlTransaction, input: DispatchInput, context: RecoveryContext) =>
  Promise<null | string>;

export class OutboundSendFenceService {
  constructor(
    private readonly database: RecoveryDatabase = recoveryDatabase,
    private readonly durableEligibility?: DurableEligibility,
    private readonly clock: () => Date = () => new Date(),
    private readonly checkTemplate: FinalTemplateEligibility = checkFinalTemplateRegistration,
  ) {}

  async admitProviderDispatch(input: DispatchInput): Promise<DispatchPermit> {
    return this.admitFinalSend(input);
  }

  async admitFinalSend(input: DispatchInput): Promise<DispatchPermit> {
    if ((input.deliveryKind === "IMAGE" && !input.deliveryPlan) ||
        (input.deliveryPlan && (input.deliveryKind !== (input.deliveryPlan.kind === "TEXT" ? "TEXT" : "IMAGE") ||
          (input.deliveryPlan.kind !== "BRAND_IMAGE" && input.senderType !== "AGENT" && input.senderType !== "HUMAN"))))
      return {kind: "suppressed", reason: "invalid-presentation"};
    if (input.senderType === "HUMAN" && (!input.commandId || !input.leaseToken))
      return { kind: "suppressed", reason: "invalid-lease" };
    if (input.senderType !== "HUMAN" && !input.messageId)
      return { kind: "suppressed", reason: "missing-prepared-message" };
    if (input.initialOutreach && (input.senderType !== "AUTOMATION" ||
        input.deliveryKind !== "TEMPLATE" || !input.proactive ||
        input.initialOutreach.idempotencyKey !== `recovery-outreach:${input.initialOutreach.outreachAttemptId}`))
      return { kind: "suppressed", reason: "invalid-initial-scope" };
    if (input.productContextUpdate && (input.senderType !== 'AGENT' || !['TEXT', 'IMAGE'].includes(input.deliveryKind ?? '') ||
        input.expectedInboundVersion === undefined || !input.expectedContent))
      return { kind: 'suppressed', reason: 'product-context-invalid-scope' };
    const durableEligibility = this.durableEligibility;
    if (!durableEligibility) return { kind: "suppressed", reason: "durable-eligibility-unavailable" };
    try {
    return await this.database.$transaction(async (tx) => {
      // Linearization point: the commit of this short transaction. Shop row
      // serializes initial restriction INSERT (restriction row may be absent).
      const context = await lockRecoveryContext(tx, input.conversationId);
      if (!context) return { kind: "suppressed", reason: "not-recovery-linked" } as const;
      // Sample after waiting for the Shop/Conversation lock, not when a queued
      // worker began preflight. An expired window cannot pass a delayed permit.
      const now = this.clock();
      if (!Number.isFinite(now.getTime())) return { kind: "suppressed", reason: "invalid-clock" } as const;
      if (context.shopId !== input.shopId || context.recoveryId !== input.recoveryId)
        return { kind: "suppressed", reason: "shop-mismatch" } as const;
      if (terminalRecovery(context.recoveryStatus))
        return { kind: "suppressed", reason: "terminal-recovery" } as const;
      if (context.revision !== input.expectedControlRevision)
        return { kind: "suppressed", reason: "stale-control-revision" } as const;
      if (context.mode !== (input.senderType === "HUMAN" ? "HUMAN" : "AI"))
        return { kind: "suppressed", reason: input.senderType === "HUMAN" ? "human-inactive" : "human-controlled" } as const;
      const shop = await first<{ status: string; platform: string }>(tx,
        `SELECT "status"::text,"platform"::text FROM "commerce"."Shop" WHERE "id"=$1`, context.shopId);
      if (shop?.status !== "ACTIVE") return { kind: "suppressed", reason: "shop-inactive" } as const;
      const restriction = await first<{ status: string; revision: number }>(tx, `
        SELECT "status"::text,"revision" FROM "commerce"."ShopHumanMessagingRestriction"
        WHERE "shopId"=$1`, context.shopId);
      if (input.senderType === "HUMAN" && restriction?.status === "SUSPENDED")
        return { kind: "suppressed", reason: "human_messaging_suspended" } as const;
      // STOP/merchant blocks apply to all outbound actors, even during the
      // customer-service window. Shop locking serialises this negative check
      // with committed STOP updates; no external I/O in the transaction.
      if (await hasLocalNoContact(tx, { shopId: context.shopId, recipient: input.recipient }))
        return { kind: "suppressed", reason: "local-no-contact" } as const;
      const recipient = await first<{ suppressUntil: Date | null }>(tx, `
        SELECT "suppressUntil" FROM "whatsapp"."WhatsAppRecipientReachability"
        WHERE "shopId"=$1 AND "recipient"=$2`, context.shopId, input.recipient);
      if (recipient?.suppressUntil && recipient.suppressUntil > now)
        return { kind: "suppressed", reason: "recipient-suppressed" } as const;
      let command: {
        state: string; leaseToken: string | null; leaseExpiresAt: Date | null;
        expectedControlRevision: number; kind: string; recipientSnapshot: string;
        textBody: string | null; preparedTextBody: string | null; preparedWrapperEvidence: unknown;
        preparedAt: Date | null; templateName: string | null; templateLanguageCode: string | null;
        followUpClaimKey: string | null;
        recoveryOutreachAttemptId: string | null; providerDispatchKey: string | null; outboundMessageId: string | null;
      } | null = null;
      if (input.senderType === "HUMAN") {
        command = await first(tx, `
          SELECT "state"::text, "leaseToken", "leaseExpiresAt", "expectedControlRevision",
            "kind"::text, "recipientSnapshot", "textBody", "preparedTextBody",
            "preparedWrapperEvidence", "preparedAt", "templateName", "templateLanguageCode",
            "followUpClaimKey", "recoveryOutreachAttemptId", "providerDispatchKey", "outboundMessageId"
          FROM "whatsapp"."MerchantConversationSendCommand"
          WHERE "id"=$1 AND "conversationId"=$2 AND "shopId"=$3 FOR UPDATE`,
          input.commandId, context.id, context.shopId);
        const multipartContinuation = !!input.multipartPartId && command?.state === "DISPATCH_ADMITTED" &&
          command.outboundMessageId === input.messageId && command.leaseToken === input.leaseToken && !!command.providerDispatchKey;
        if (!multipartContinuation && (!command || command.state !== "CLAIMED" || command.leaseToken !== input.leaseToken ||
            !command.leaseExpiresAt || command.leaseExpiresAt <= now || command.providerDispatchKey))
          return { kind: "suppressed", reason: "invalid-lease" } as const;
        if (!command) return {kind: "suppressed",reason: "invalid-lease"} as const;
        if (command.expectedControlRevision !== context.revision)
          return { kind: "suppressed", reason: "stale-control-revision" } as const;
        if (command.recipientSnapshot !== input.recipient)
          return { kind: "suppressed", reason: "recipient-mismatch" } as const;
        if (command.kind !== "HUMAN_TEXT" && command.kind !== "RECOVERY_FOLLOW_UP_TEMPLATE")
          return { kind: "suppressed", reason: "unsupported-human-command" } as const;
        if (command.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
          if (typeof command.followUpClaimKey !== "string" || !command.followUpClaimKey.trim()) {
            const integrityError = new FollowUpClaimKeyIntegrityError(input.commandId ?? "unknown");
            logger.error("arch055.follow_up_claim_key_integrity_failed", {
              commandId: input.commandId, shopId: input.shopId,
              errorType: integrityError.name, errorMessage: integrityError.message, error: integrityError,
              reasonCode: "persisted_claim_key_missing", source: "outbound_send_fence",
            });
            return { kind: "suppressed", reason: "follow-up-claim-key-integrity-failure" } as const;
          }
          if (!input.proactive || input.proactive.verifiedCategory !== "MARKETING" ||
              input.proactive.templateName !== command.templateName ||
              input.proactive.languageCode !== command.templateLanguageCode ||
              // BG007 makes the locked BG006 registration recheck mandatory for
              // HUMAN follow-ups, rather than optional metadata.
              !input.proactive.templateRegistration ||
              !input.proactive.templateRegistration.purpose.startsWith("FOLLOW_UP_"))
            return { kind: "suppressed", reason: "marketing-template-unverified" } as const;
          const attempt = await first<{ initiatedBy: string | null; initiationKey: string | null;
            outboundMessageId: string | null; sentAt: Date | null; status: string }>(tx, `
            SELECT "initiatedBy"::text,"initiationKey","outboundMessageId","sentAt","status"::text
            FROM "commerce"."RecoveryOutreachAttempt"
            WHERE "id"=$1 AND "checkoutRecoveryId"=$2 AND "sequence"=2 FOR UPDATE`,
            command.recoveryOutreachAttemptId, context.recoveryId);
          if (!attempt || attempt.initiatedBy !== "HUMAN" ||
              attempt.initiationKey !== command.followUpClaimKey ||
              attempt.outboundMessageId || attempt.sentAt || attempt.status !== "PENDING")
            return { kind: "suppressed", reason: "follow-up-already-used" } as const;
        }
      }
      // AUTOMATION recovery outreach must carry provider-verified Marketing
      // metadata; HUMAN_TEXT and customer-initiated AGENT replies are service
      // messages and need only the common STOP/control checks above.
      if (input.senderType === "AUTOMATION" && !input.proactive)
        return { kind: "suppressed", reason: "marketing-template-unverified" } as const;
      if (input.proactive && (input.proactive.verifiedCategory !== "MARKETING" ||
          !input.proactive.templateName || !input.proactive.languageCode))
        return { kind: "suppressed", reason: "marketing-template-unverified" } as const;
      if (input.proactive?.templateRegistration) {
        const reg = input.proactive.templateRegistration;
        if (reg.shopId !== context.shopId ||
            reg.providerTemplateName !== input.proactive.templateName ||
            reg.providerLanguageCode !== input.proactive.languageCode) {
          return { kind: "suppressed", reason: "TEMPLATE_REGISTRATION_UNAVAILABLE" } as const;
        }
        const templateDenial = await this.checkTemplate(tx, reg, now);
        if (templateDenial) return { kind: "suppressed", reason: templateDenial } as const;
      }
      const furtherDenial = await durableEligibility(tx, input, context);
      if (furtherDenial) return { kind: "suppressed", reason: furtherDenial } as const;

      const initial = input.initialOutreach;
      if (initial) {
        if (shop.platform !== "SHOPIFY") return { kind: "suppressed", reason: "invalid-initial-platform" } as const;
        const attempt = await first<{ id: string }>(tx, `
          SELECT "id" FROM "commerce"."RecoveryOutreachAttempt"
          WHERE "id"=$1 AND "checkoutRecoveryId"=$2 AND "sequence"=1
            AND "trigger"='INITIAL' AND "recipient"=$3 AND "status" IN ('PENDING','CAPACITY_BLOCKED')
            AND "sentAt" IS NULL AND "outboundMessageId" IS NULL AND "followUpDueAt" IS NULL
          FOR UPDATE`, initial.outreachAttemptId, input.recoveryId, input.recipient);
        if (!attempt || context.recoveryStatus !== "DETECTED")
          return { kind: "suppressed", reason: "initial-attempt-unavailable" } as const;
        const message = await first<{ id: string }>(tx, `
          SELECT "id" FROM "whatsapp"."ConversationMessage"
          WHERE "id"=$1 AND "conversationId"=$2 AND "direction"='OUTBOUND' AND "senderType"='AUTOMATION'
            AND "status"='PENDING' AND "content"=$3 AND "providerDispatchKey" IS NULL
            AND "providerDispatchAdmittedAt" IS NULL AND "providerDispatchControlRevision" IS NULL
            AND "providerMessageId" IS NULL AND "sentAt" IS NULL AND "deliveredAt" IS NULL
            AND "readAt" IS NULL AND "failedAt" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "whatsapp"."MerchantConversationSendCommand" cmd WHERE cmd."outboundMessageId"=$1)
            AND NOT EXISTS (SELECT 1 FROM "commerce"."RecoveryOutreachAttempt" other WHERE other."outboundMessageId"=$1)
          FOR UPDATE`, input.messageId!, context.id, initial.expectedContent);
        if (!message) return { kind: "suppressed", reason: "already-admitted-or-sent" } as const;
        const usage = await first<{ id: string }>(tx, `
          SELECT "id" FROM "billing"."UsageEvent"
          WHERE "idempotencyKey"=$1 AND "shopId"=$2 AND "sourceId"=$3 AND "quantity"=1
            AND "sourceType"='OUTBOUND_AUTOMATED_MESSAGE' AND "metric"='OUTBOUND_AUTOMATED_MESSAGE'`,
          initial.idempotencyKey, input.shopId, message.id);
        if (!usage || !(await hasExactInitialCredit(tx, {
          shopId: input.shopId, idempotencyKey: initial.idempotencyKey,
          sourceKey: initial.recoveryCreditSourceKey, allowPaid: true, clock: this.clock,
        }))) return { kind: "suppressed", reason: "initial-credit-unavailable" } as const;
      }

      // This is the last reversible policy decision before the irreversible
      // provider permit. Sample time after all potentially blocking row locks
      // and eligibility work; the queue's earlier input.now is only a hint.
      const permitNow = this.clock();
      if (!Number.isFinite(permitNow.getTime()))
        return { kind: "suppressed", reason: "invalid-clock" } as const;
      if (command?.state === "CLAIMED" && command.leaseExpiresAt && command.leaseExpiresAt <= permitNow)
        return { kind: "suppressed", reason: "invalid-lease" } as const;
      const freeText = input.senderType === "AGENT" ||
        (input.senderType === "AUTOMATION" && input.deliveryKind !== "TEMPLATE") ||
        command?.kind === "HUMAN_TEXT";
      if (freeText || command?.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
        const evidence = await readRecoveryWindowEvidence(tx, {
          recoveryId: context.recoveryId, conversationId: context.id, now: permitNow,
        });
        if (!evidence?.initialSentAt || evidence.initialSentAt > permitNow)
          return { kind: "suppressed", reason: "no-initial-outreach" } as const;
        const open = customerWindow(evidence.verifiedInboundAt, permitNow).open;
        if (freeText && !open)
          return { kind: "suppressed", reason: "customer-window-closed" } as const;
        if (command?.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
          if (open) return { kind: "suppressed", reason: "customer-window-open" } as const;
          if (!followUpDue(evidence, permitNow, "merchant_post_window"))
            return { kind: "suppressed", reason: "follow-up-not-due" } as const;
          if (evidence.recipient !== input.recipient)
            return { kind: "suppressed", reason: "recipient-mismatch" } as const;
        }
      }

      if (input.recoveryShopHeader && (input.deliveryKind === "TEMPLATE" || !context.shopId ||
          !(await currentRecoveryShopHeaderMatches(tx, input.recoveryShopHeader, input.expectedContent ?? null, context.shopId)))) {
        return {kind: "suppressed", reason: "recovery-shop-header-stale"} as const;
      }
      // BG009: the immutable complete body is the sole moderation/send identity.
      // Read the current wrapper slot and ALLOW record while inside this same
      // permit transaction; a stale/retired wrapper must never reach Meta.
      if (command?.kind === "HUMAN_TEXT") {
        if (!parsePreparedEvidence(command.preparedTextBody, command.preparedWrapperEvidence,
            command.preparedAt) || !(await currentHumanWrapperMatches(tx, command.preparedTextBody,
              command.preparedWrapperEvidence, command.preparedAt, {
                conversationId: context.id, commandId: input.commandId!, textBody: command.textBody, shopId: context.shopId,
              }))) {
          return { kind: "suppressed", reason: "human_wrapper_stale" } as const;
        }
        const hash = createHash("sha256").update(command.preparedTextBody!, "utf8").digest("hex");
        const assessment = await first<{ id: string }>(tx, `
          SELECT "id" FROM "whatsapp"."ConversationModerationAssessment"
          WHERE "merchantSendCommandId"=$1 AND "subject"='HUMAN_COMMAND'
            AND "inputKind"='TEXT' AND "decision"='ALLOW'
            AND "contentSha256"=$2 AND "policyVersion"=$3
          LIMIT 1`, input.commandId, hash, moderationConfig().policyVersion);
        if (!assessment) return { kind: "suppressed", reason: "moderation_content_stale" } as const;
      }

      if (input.expectedInboundVersion !== undefined &&
          context.inboundVersion !== input.expectedInboundVersion)
        return { kind: "suppressed", reason: "stale-inbound-version" } as const;

      if (input.multipartPartId) {
        if (!input.messageId || input.initialOutreach || input.proactive || input.deliveryKind === "TEMPLATE" || input.senderType === "AUTOMATION")
          return {kind: "suppressed",reason: "multipart-invalid-scope"} as const;
        return admitMultipartPart(tx,input,context,permitNow);
      }
      if (input.deliveryPlan?.kind === "BRAND_IMAGE") {
        const storedMedia = input.senderType === "HUMAN"
          ? parsePreparedEvidence(command!.preparedTextBody,command!.preparedWrapperEvidence,command!.preparedAt)?.mediaPreparation
          : readFrozenBrandMedia((await first<{outboundPresentation:unknown}>(tx,`SELECT "outboundPresentation" FROM "whatsapp"."ConversationMessage" WHERE "id"=$1 AND "conversationId"=$2 FOR UPDATE`,input.messageId,context.id))?.outboundPresentation);
        if(!storedMedia || !(await currentRecoveryShopHeaderMatches(tx,storedMedia.recoveryShopHeader,input.deliveryPlan.body,context.shopId)) || !(await currentBrandPlanMatches(tx,input.deliveryPlan,context.shopId,storedMedia.policyRef))) return {kind:"suppressed",reason:"brand-media-stale"} as const;
      }
      const dispatchKey = input.senderType === "HUMAN"
        ? `arch040-human-${createHash("sha256").update(input.commandId!).digest("hex")}`
        : `arch040-auto-${createHash("sha256").update(input.messageId!).digest("hex")}`;
      const messageId = input.senderType === "HUMAN" ? randomUUID() : input.messageId!;
      if (input.senderType === "HUMAN") {
        // Exactly one canonical HUMAN message, at the durable admission point.
        // Provider HTTP MUST occur after commit and never inside this callback.
        const content = command!.kind === "HUMAN_TEXT"
          ? command!.preparedTextBody! : `[Recovery template: ${command!.templateName ?? "unknown"}]`;
        const evidence = command!.kind === "HUMAN_TEXT" ? parsePreparedEvidence(command!.preparedTextBody, command!.preparedWrapperEvidence, command!.preparedAt) : null;
        if (evidence?.mediaPreparation && (evidence.mediaPreparation.receipt.sourceKind !== "HUMAN_COMMAND" ||
            evidence.mediaPreparation.receipt.sourceId !== input.commandId || evidence.mediaPreparation.receipt.shopId !== context.shopId ||
            evidence.mediaPreparation.receipt.conversationId !== context.id || evidence.mediaPreparation.receipt.controlRevision !== context.revision)) return {kind: "suppressed", reason: "invalid-presentation"} as const;
        if (canonicalJson(evidence?.mediaPreparation?.plan ?? null) !== canonicalJson(input.deliveryPlan ?? null) || (input.expectedContent !== undefined && input.expectedContent !== content)) return {kind: "suppressed", reason: "invalid-presentation"} as const;
        const admittedMessage = await rows<{ content: string; outboundPresentation: unknown }>(tx, `
          INSERT INTO "whatsapp"."ConversationMessage"
            ("id","conversationId","direction","senderType","status","content",
              "providerDispatchKey","providerDispatchAdmittedAt","providerDispatchControlRevision","outboundPresentation")
          VALUES ($1,$2,'OUTBOUND','HUMAN','PENDING',$3,$4,statement_timestamp(),$5,$6::jsonb)
          RETURNING "content","outboundPresentation"`,
          messageId, context.id, content, dispatchKey, context.revision, JSON.stringify(evidence?.mediaPreparation ?? null));
        if (admittedMessage.length !== 1 || admittedMessage[0]?.content !== content || canonicalJson(admittedMessage[0]?.outboundPresentation ?? null) !== canonicalJson(evidence?.mediaPreparation ?? null)) {
          throw new Error("ARCH047 admitted content mismatch");
        }
        const cmd = await rows<{ providerDispatchAdmittedAt: Date }>(tx, `
          UPDATE "whatsapp"."MerchantConversationSendCommand"
          SET "state"='DISPATCH_ADMITTED',"outboundMessageId"=$3,
            "providerDispatchKey"=$4,"providerDispatchAdmittedAt"=statement_timestamp(),
            "providerDispatchControlRevision"=$5,
            "providerDispatchRestrictionRevision"=$6,"updatedAt"=statement_timestamp()
          WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='CLAIMED'
          RETURNING "providerDispatchAdmittedAt"`,
          input.commandId, input.leaseToken, messageId, dispatchKey,
          context.revision, restriction?.revision ?? 0);
        if (!cmd.length) throw new Error("ARCH040 provider permit lost its lease");
        if (command!.recoveryOutreachAttemptId) {
          await rows(tx, `
            UPDATE "commerce"."RecoveryOutreachAttempt"
            SET "outboundMessageId"=$2,"updatedAt"=statement_timestamp()
            WHERE "id"=$1 AND "outboundMessageId" IS NULL`,
            command!.recoveryOutreachAttemptId, messageId);
        }
        return { kind: "admitted", messageId, dispatchKey,
          admittedAt: cmd[0]!.providerDispatchAdmittedAt,
          ...(command!.kind === "HUMAN_TEXT" ? { messageContent: admittedMessage[0]!.content } : {}),
          ...(evidence?.mediaPreparation?.plan ? {deliveryPlan: readFrozenBrandMedia(admittedMessage[0]!.outboundPresentation)!.plan} : {}),
        } as const;
      }
      if (input.deliveryPlan) {
        const stored = await rows<{content: string; outboundPresentation: unknown}>(tx, `
          SELECT "content","outboundPresentation" FROM "whatsapp"."ConversationMessage"
          WHERE "id"=$1 AND "conversationId"=$2 AND "direction"='OUTBOUND' AND "senderType"=$3::"whatsapp"."MessageSenderType" FOR UPDATE`, messageId, context.id, input.senderType);
        const frozenBrand = stored[0] ? readFrozenBrandMedia(stored[0].outboundPresentation) : null;
        if (input.deliveryPlan.kind === "BRAND_IMAGE" && (!frozenBrand || canonicalJson(asMessageDeliveryReceipt(frozenBrand.receipt)) !== canonicalJson(input.presentationReceipt))) return {kind: "suppressed", reason: "invalid-presentation"} as const;
        if (!matchesConversationReceipt(input.presentationReceipt, {...input, messageId}) || stored.length !== 1 || !sameConversationPlan(stored[0]!.outboundPresentation, input.deliveryPlan) ||
            !validConversationPlan(input.deliveryPlan, stored[0]!.content, context.shopId, input.presentationReceipt) ||
            input.expectedContent !== stored[0]!.content)
          return {kind: "suppressed", reason: "invalid-presentation"} as const;
      }
      const message = await rows<{ providerDispatchAdmittedAt: Date }>(tx, `
        UPDATE "whatsapp"."ConversationMessage"
        SET "providerDispatchKey"=$2,"providerDispatchAdmittedAt"=statement_timestamp(),
          "providerDispatchControlRevision"=$3
        WHERE "id"=$1 AND "conversationId"=$4 AND "direction"='OUTBOUND'
          AND "senderType"=$5::"whatsapp"."MessageSenderType"
          AND "providerDispatchKey" IS NULL AND "status"='PENDING'
          ${initial ? `AND "content"=$6 AND "providerDispatchAdmittedAt" IS NULL
            AND "providerDispatchControlRevision" IS NULL AND "providerMessageId" IS NULL
            AND "sentAt" IS NULL AND "deliveredAt" IS NULL AND "readAt" IS NULL AND "failedAt" IS NULL` : input.expectedContent !== undefined ? `AND "content"=$6` : ""}
        RETURNING "providerDispatchAdmittedAt"`,
        messageId, dispatchKey, context.revision, context.id, input.senderType,
        ...(initial ? [initial.expectedContent] : input.expectedContent !== undefined ? [input.expectedContent] : []));
      if (!message.length) return { kind: "suppressed", reason: "already-admitted-or-sent" } as const;
      if (input.productContextUpdate) {
        await commitAdmittedProductContext(tx, {
          shopId: input.shopId, conversationId: input.conversationId, now: permitNow,
          expectedInboundVersion: input.expectedInboundVersion!, context: input.productContextUpdate,
          messageId, body: input.expectedContent!, dispatchKey,
        });
      }
      return { kind: "admitted", messageId, dispatchKey, admittedAt: message[0]!.providerDispatchAdmittedAt } as const;
    });
    } catch (error) {
      // The transaction has rolled back both permit and context before suppression.
      if (error instanceof ProductContextAdmissionError)
        return { kind: 'suppressed', reason: 'product-context-conflict' };
      if (input.initialOutreach) logger.error("recovery.initial_outreach.sql_permit.failed", {
        shopId: input.shopId, recoveryId: input.recoveryId, conversationId: input.conversationId,
        attemptId: input.initialOutreach.outreachAttemptId, messageId: input.messageId,
        stage: "final_permit", sourceError: initialOutreachDiagnostic(error),
      });
      throw error;
    }
  }
}

// Called only after the initial attempt and prepared message have been locked.
export async function hasExactInitialCredit(tx: SqlTransaction, input: {
  shopId: string; idempotencyKey: string; sourceKey: string; allowPaid: boolean;
  clock: () => Date;
}): Promise<boolean> {
  const logical = createRecoveryIdempotencyKey(input.shopId, input.idempotencyKey);
  const candidates = await rows<{ id: string; sourceKey: string }>(tx, `
    SELECT "id","sourceKey" FROM "billing"."UsageReservation"
    WHERE "sourceKey"=$1 OR (
      "shopId"=$2 AND "sourceKey" LIKE 'paid-included:%' AND right("sourceKey", length($1::text)+1)=':'||$1
    )
    ORDER BY "id" LIMIT 2 FOR SHARE`, logical, input.shopId);
  if (candidates.length !== 1 || candidates[0]?.sourceKey !== input.sourceKey) return false;
  const now = input.clock();
  if (!Number.isFinite(now.getTime())) return false;
  const valid = await first<{ id: string }>(tx, `
    SELECT r."id" FROM "billing"."UsageReservation" r
    LEFT JOIN "billing"."ShopEntitlementCounter" c ON c."id"=r."counterId"
    LEFT JOIN "billing"."RecoveryCreditPurchase" l ON l."id"=r."purchasedCreditPurchaseId"
    LEFT JOIN "billing"."BillingPeriodEntitlementCounter" pc ON pc."id"=r."billingPeriodEntitlementCounterId"
    LEFT JOIN "billing"."BillingPeriod" p ON p."id"=pc."billingPeriodId"
    LEFT JOIN "billing"."Subscription" sub ON sub."shopId"=r."shopId"
    LEFT JOIN "billing"."PromotionalCreditGrant" g ON g."id"=r."promotionalCreditGrantId"
    LEFT JOIN "billing"."PromotionCampaign" campaign ON campaign."id"=g."campaignId"
    LEFT JOIN "billing"."MerchantPromotionSelection" sel ON sel."shopId"=r."shopId"
    WHERE r."id"=$1 AND r."shopId"=$2 AND r."status"='RESERVED' AND r."quantity"=1
      AND r."committedUsageEventId" IS NULL AND r."compensationUsageEventId" IS NULL
      AND r."compensationReason" IS NULL AND r."compensationDisposition" IS NULL AND r."compensatedAt" IS NULL
      AND (r."expiresAt" IS NULL OR r."expiresAt">$3)
      AND (
        (r."sourceKey"=$4 AND (
          (r."billingPeriodEntitlementCounterId" IS NULL AND r."promotionalCreditGrantId" IS NULL
            AND c."shopId"=$2 AND (
              (c."counter"='LIFETIME_FREE_RECOVERY_CREDITS' AND r."purchasedCreditPurchaseId" IS NULL)
              OR (c."counter"='PURCHASED_RECOVERY_CREDITS' AND l."shopId"=$2 AND l."status"='ACTIVE')
            ))
          OR (r."counterId" IS NULL AND r."purchasedCreditPurchaseId" IS NULL
            AND r."billingPeriodEntitlementCounterId" IS NULL AND g."shopId"=$2
            AND sel."promotionalCreditGrantId"=g."id" AND campaign."status"='ACTIVE'
            AND campaign."startsAt"<=$3 AND campaign."expiresAt">$3
            AND ((campaign."scope"='SHOP' AND campaign."targetShopId"=$2)
              OR (campaign."scope"='PLAN' AND campaign."targetPlanId"=sub."planId")
              OR (campaign."scope"='GLOBAL' AND campaign."targetShopId" IS NULL AND campaign."targetPlanId" IS NULL)))
        ))
        OR ($5 AND r."counterId" IS NULL AND r."purchasedCreditPurchaseId" IS NULL
          AND r."promotionalCreditGrantId" IS NULL AND pc."shopId"=$2
          AND pc."counter"='INCLUDED_RECOVERY_CREDITS' AND p."shopId"=$2
          AND p."subscriptionId"=sub."id" AND sub."billingPeriodId"=p."id"
          AND p."status"='OPEN' AND p."periodStart"<=$3 AND p."periodEnd">$3
          AND r."sourceKey"='paid-included:'||p."id"||':'||$4)
      )`, candidates[0].id, input.shopId, now, logical, input.allowPaid);
  return valid !== null;
}
