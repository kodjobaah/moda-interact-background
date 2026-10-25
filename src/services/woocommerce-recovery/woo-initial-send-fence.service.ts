import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import type { WooRecoveryConsentSnapshot } from "../woocommerce-recovery-consent.service.js";
import { canonicalWhatsAppSender, matchesRegisteredPhone } from "../whatsapp-contact-opt-out/phone.js";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";
import { confirmCurrentWooConsent } from "./woo-recovery-admission-evidence.js";
import prisma from "../../lib/db.js";

export type WooInitialFinalPermitInput = Readonly<{
  shopId: string;
  recoveryId: string;
  checkoutToken: string;
  customerId: string;
  conversationId: string;
  attemptId: string;
  messageId: string;
  recipient: string;
  consent: WooRecoveryConsentSnapshot;
  idempotencyKey: string;
  recoveryCreditSourceKey: string;
  templateName: string;
  languageCode: string;
  verifiedCategory: "MARKETING";
  expectedContent: string;
}>;

export type WooInitialFinalPermit =
  | { kind: "admitted" }
  | { kind: "suppressed"; reason: string };

type WooFinalPermitDatabase = Pick<PrismaClient, "$transaction">;

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});
type WooFinalPermitTx = Prisma.TransactionClient;
type LockedShop = { status: string; platform: string };
type LockedRecovery = {
  shopId: string; checkoutToken: string; customerId: string | null;
  status: string; completedAt: Date | null; expiredAt: Date | null;
};
type LockedConversation = {
  shopId: string | null; checkoutRecoveryId: string | null;
  type: string; controlMode: string; controlRevision: number;
};
type LockedAttempt = {
  checkoutRecoveryId: string; sequence: number; status: string; recipient: string;
  sentAt: Date | null; outboundMessageId: string | null; followUpDueAt: Date | null;
};
type LockedMessage = {
  status: string; content: string; providerDispatchKey: string | null;
  providerDispatchAdmittedAt: Date | null;
};

/**
 * A Shop-first, SQL-only final permit. The caller holds BG002's checkout lease
 * and has checked Redis order observations OUTSIDE the transaction. The durable
 * Woo order/recovery evidence is independently checked under this SQL fence;
 * Redis-only observations cannot truthfully be described as SQL-locked.
 *
 * STOP writers take the same Shop lock before updating CustomerPhone. Therefore
 * a STOP committed first blocks this permit. Once the permit commits, a later
 * STOP cannot unsend a message already admitted for the provider.
 */
export class WooInitialSendFenceService {
  constructor(
    private readonly database: WooFinalPermitDatabase = prisma,
    private readonly confirmConsent: typeof confirmCurrentWooConsent = confirmCurrentWooConsent,
    private readonly noContact: typeof hasLocalNoContact = hasLocalNoContact,
    private readonly logger: StructuredLogger = defaultLogger,
  ) {}

  async admitFinalSend(input: WooInitialFinalPermitInput): Promise<WooInitialFinalPermit> {
    try {
    // Reject forged/reused attempt keys and mismatched source attribution before
    // opening a transaction. This is a synchronous identity check, not a grant.
    if (!input.shopId || !input.recoveryId || !input.customerId || !input.checkoutToken ||
      !input.conversationId || !input.attemptId || !input.messageId ||
      !input.templateName || !input.languageCode || !input.expectedContent ||
      input.verifiedCategory !== "MARKETING" ||
      input.idempotencyKey !== `recovery-outreach:${input.attemptId}` ||
      input.recoveryCreditSourceKey !== createRecoveryIdempotencyKey(
        input.shopId, input.idempotencyKey,
      ) ||
      canonicalWhatsAppSender(input.recipient) !== input.consent.canonicalRecipient ||
      input.consent.shopId !== input.shopId || input.consent.customerId !== input.customerId) {
      return { kind: "suppressed", reason: "invalid-woo-initial-scope" };
    }

    return await this.database.$transaction(async (tx): Promise<WooInitialFinalPermit> => {
      // Same lock order as the accepted STOP writer and recovery sender:
      // Shop -> Conversation -> recovery -> attempt -> message. No I/O beyond
      // PostgreSQL is allowed in this callback.
      const shops = await tx.$queryRawUnsafe<LockedShop[]>(`
        SELECT "status"::text,"platform"::text FROM "commerce"."Shop"
        WHERE "id"=$1 FOR UPDATE`, input.shopId);
      if (shops[0]?.status !== "ACTIVE" || shops[0]?.platform !== "WOOCOMMERCE")
        return { kind: "suppressed", reason: "woo-shop-inactive" };

      const conversations = await tx.$queryRawUnsafe<LockedConversation[]>(`
        SELECT "shopId","checkoutRecoveryId","type"::text,
          "controlMode"::text,"controlRevision"
        FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, input.conversationId);
      const conversation = conversations[0];
      if (!conversation || conversation.checkoutRecoveryId !== input.recoveryId ||
        (conversation.shopId !== null && conversation.shopId !== input.shopId) ||
        conversation.type !== "RECOVERY" || conversation.controlMode !== "AI")
        return { kind: "suppressed", reason: "woo-conversation-mismatch" };

      const recoveries = await tx.$queryRawUnsafe<LockedRecovery[]>(`
        SELECT "shopId","checkoutToken","customerId","status"::text,"completedAt","expiredAt"
        FROM "commerce"."CheckoutRecovery" WHERE "id"=$1 FOR UPDATE`, input.recoveryId);
      const recovery = recoveries[0];
      if (!recovery || recovery.shopId !== input.shopId ||
        recovery.checkoutToken !== input.checkoutToken || recovery.customerId !== input.customerId ||
        recovery.status !== "DETECTED" || recovery.completedAt || recovery.expiredAt)
        return { kind: "suppressed", reason: "woo-recovery-terminal-or-mismatched" };

      // A persisted Woo order transition suppresses sending even when the
      // original BullMQ checkout candidate is already gone. Redis observation
      // is read at the caller's checkout-locked boundary, never here.
      const terminalHistory = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT "id" FROM "commerce"."CheckoutRecoveryStatusHistory"
        WHERE "checkoutRecoveryId"=$1 AND "source"='woocommerce.order'
        LIMIT 1`, input.recoveryId);
      if (terminalHistory.length)
        return { kind: "suppressed", reason: "woo-observed-order-terminal" };

      const attempts = await tx.$queryRawUnsafe<LockedAttempt[]>(`
        SELECT "checkoutRecoveryId","sequence","status"::text,"recipient",
          "sentAt","outboundMessageId","followUpDueAt"
        FROM "commerce"."RecoveryOutreachAttempt" WHERE "id"=$1 FOR UPDATE`, input.attemptId);
      const attempt = attempts[0];
      if (!attempt || attempt.checkoutRecoveryId !== input.recoveryId || attempt.sequence !== 1 ||
        !["PENDING", "CAPACITY_BLOCKED"].includes(attempt.status) ||
        attempt.recipient !== input.recipient || attempt.sentAt ||
        attempt.outboundMessageId || attempt.followUpDueAt)
        return { kind: "suppressed", reason: "woo-initial-attempt-ineligible" };

      // Reuses ARCH-048's accepted consent projection/revision checker. This
      // locks installation, Customer and CustomerPhone through the permit;
      // a later Woo grant cannot override STOP or a changed recipient.
      if (!await this.confirmConsent(tx, input.shopId, input.consent, undefined))
        return { kind: "suppressed", reason: "woo-consent-changed" };
      if (await this.noContact(tx, { shopId: input.shopId, recipient: input.recipient }))
        return { kind: "suppressed", reason: "woo-local-no-contact" };

      // CustomerPhone has no shop+canonical uniqueness constraint. A second
      // matching active registration cannot borrow this recipient's opt-in.
      // Include legacy null-canonical numbers, bounded as in BG001's reader.
      const candidates = await tx.$queryRawUnsafe<Array<{
        id: string; phone: string; whatsappCanonicalPhone: string | null;
        defaultCountryCode: string | null;
      }>>(`
        SELECT cp."id",cp."phone",cp."whatsappCanonicalPhone",s."defaultCountryCode"
        FROM "commerce"."CustomerPhone" cp
        JOIN "commerce"."Customer" c ON c."id"=cp."customerId"
        JOIN "commerce"."Shop" s ON s."id"=c."shopId"
        WHERE c."shopId"=$1 AND cp."endedAt" IS NULL
          AND (cp."whatsappCanonicalPhone"=$2 OR cp."whatsappCanonicalPhone" IS NULL
               OR cp."phone" IN ($3,$2))
        ORDER BY cp."id" LIMIT 251 FOR SHARE OF cp`,
        input.shopId, input.consent.canonicalRecipient, `+${input.consent.canonicalRecipient}`);
      if (candidates.length > 250) return { kind: "suppressed", reason: "woo-recipient-ambiguous" };
      const matching = candidates.filter((candidate) =>
        matchesRegisteredPhone(candidate, input.consent.canonicalRecipient, candidate.defaultCountryCode));
      if (matching.length !== 1 || matching[0]?.id !== input.consent.customerPhoneId)
        return { kind: "suppressed", reason: "woo-recipient-ambiguous" };

      // The checkout-recovery credit reservation is separate from outbound
      // message usage. A released/foreign credit must not admit Meta delivery.
      const credit = await tx.$queryRawUnsafe<Array<{
        shopId: string; quantity: number; status: string;
      }>>(`
        SELECT "shopId","quantity","status"::text FROM "billing"."UsageReservation"
        WHERE "sourceKey"=$1 FOR SHARE`, input.recoveryCreditSourceKey);
      if (credit.length !== 1 || credit[0]?.shopId !== input.shopId ||
        credit[0]?.quantity !== 1 || credit[0]?.status !== "RESERVED")
        return { kind: "suppressed", reason: "woo-recovery-credit-not-reserved" };

      const usage = await tx.$queryRawUnsafe<Array<{ sourceId: string | null; shopId: string; metric: string }>>(`
        SELECT "sourceId","shopId","metric"::text FROM "billing"."UsageEvent"
        WHERE "idempotencyKey"=$1`, input.idempotencyKey);
      if (usage.length !== 1 || usage[0]?.shopId !== input.shopId ||
        usage[0]?.sourceId !== input.messageId ||
        usage[0]?.metric !== "OUTBOUND_AUTOMATED_MESSAGE")
        return { kind: "suppressed", reason: "woo-outbound-reservation-mismatch" };

      const messages = await tx.$queryRawUnsafe<LockedMessage[]>(`
        SELECT "status"::text,"content","providerDispatchKey","providerDispatchAdmittedAt"
        FROM "whatsapp"."ConversationMessage"
        WHERE "id"=$1 AND "conversationId"=$2 AND "direction"='OUTBOUND'
          AND "senderType"='AUTOMATION' FOR UPDATE`, input.messageId, input.conversationId);
      const message = messages[0];
      if (!message) return { kind: "suppressed", reason: "woo-message-mismatch" };
      if (message.status !== "PENDING" || message.providerDispatchKey || message.providerDispatchAdmittedAt)
        return { kind: "suppressed", reason: "already-admitted-or-sent" };
      if (message.content !== input.expectedContent)
        return { kind: "suppressed", reason: "woo-prepared-content-changed" };

      const key = `arch046-woo-initial-${createHash("sha256")
        .update(input.shopId).update("\0").update(input.attemptId).digest("hex")}`;
      // The unique provider-dispatch key outlives an accidentally deleted
      // UsageEvent: still refuse a second provider call for this attempt.
      const priorPermit = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT "id" FROM "whatsapp"."ConversationMessage"
        WHERE "providerDispatchKey"=$1 LIMIT 1`, key);
      if (priorPermit.length)
        return { kind: "suppressed", reason: "already-admitted-or-sent" };
      const permitted = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
        UPDATE "whatsapp"."ConversationMessage"
        SET "providerDispatchKey"=$2,
          "providerDispatchAdmittedAt"=statement_timestamp(),
          "providerDispatchControlRevision"=$3
        WHERE "id"=$1 AND "conversationId"=$4
          AND "direction"='OUTBOUND' AND "senderType"='AUTOMATION'
          AND "status"='PENDING' AND "providerDispatchKey" IS NULL
          AND "providerDispatchAdmittedAt" IS NULL AND "content"=$5
        RETURNING "id"`, input.messageId, key, conversation.controlRevision,
        input.conversationId, input.expectedContent);
      return permitted.length === 1
        ? { kind: "admitted" }
        : { kind: "suppressed", reason: "already-admitted-or-sent" };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      // Technical SQL/permit exceptions are never converted into consumer
      // refusals. Record safe error identity and propagate the original cause.
      this.logger.error("woocommerce.recovery.initial.sql_permit.failed", {
        shopId: input.shopId, recoveryId: input.recoveryId, attemptId: input.attemptId,
        errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
          ? error.name : "UnknownError",
        ...(
          typeof error === "object" && error !== null && "code" in error &&
          typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
            ? { errorCode: error.code } : {}
        ),
      });
      throw error;
    }
  }
}
