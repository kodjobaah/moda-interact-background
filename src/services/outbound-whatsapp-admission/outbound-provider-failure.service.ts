import { PENDING_AUTOMATED_WHATSAPP_CONTENT, type UntouchedReservationIdentity } from "./outbound-whatsapp-admission.types.js";
import { MessageStatus, UsageMetric, Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import { isDefinitiveWhatsAppError, isSynchronousRecipientFailure } from "../whatsapp-provider-rejection.js";
import { synchronousRecipientFailureService } from "../synchronous-recipient-failure.service.js";

/** Provider-outcome adapter. Compensation/reachability belongs to existing owners. */
export class OutboundProviderFailureService {
  constructor(
    private readonly database: Pick<PrismaClient, "$transaction" | "conversationMessage" | "usageEvent"> = prisma,
    private readonly synchronousFailure: Pick<typeof synchronousRecipientFailureService, "afterAutomatedRejection"> =
      synchronousRecipientFailureService,
  ) {}

  async failPrepared(messageId: string, expectedReservation?: UntouchedReservationIdentity): Promise<void> {
    await this.database.$transaction(async (tx) => {
      const owned = await this.readOwnedUsage(tx, messageId);
      if (!owned) return;
      if (expectedReservation && (owned.shopId !== expectedReservation.shopId ||
          owned.message.conversationId !== expectedReservation.conversationId ||
          owned.message.content !== PENDING_AUTOMATED_WHATSAPP_CONTENT || owned.message.outboundPresentation !== null)) return;
      if (!owned.usage && owned.message.senderType === "AUTOMATION" && owned.message.conversation.checkoutRecoveryId) return;
      let initial: string | undefined;
      if (owned.usage?.idempotencyKey.startsWith("recovery-outreach:")) {
        const attemptId = /^recovery-outreach:([A-Za-z0-9_-]+)$/.exec(owned.usage.idempotencyKey)?.[1];
        const recoveryId = owned.message.conversation.checkoutRecoveryId;
        if (!attemptId || !recoveryId || owned.message.senderType !== "AUTOMATION" ||
            owned.usage.sourceType !== "OUTBOUND_AUTOMATED_MESSAGE") return;
        const attempt = await tx.recoveryOutreachAttempt.findUnique({
          where: { id: attemptId },
          select: { checkoutRecoveryId: true, sequence: true, trigger: true, outboundMessageId: true },
        });
        if (!attempt || attempt.checkoutRecoveryId !== recoveryId ||
            (attempt.outboundMessageId && attempt.outboundMessageId !== messageId) ||
            (owned.message.recoveryOutreachAttempt && owned.message.recoveryOutreachAttempt.id !== attemptId)) return;
        if (attempt.sequence === 1 && attempt.trigger === "INITIAL") {
          if (!await this.lockInitial(tx, owned, attemptId)) return;
          initial = attemptId;
        } else if (attempt.sequence !== 2 ||
            (attempt.trigger !== "NO_RESPONSE_FOLLOW_UP" && attempt.trigger !== "POST_WINDOW_FOLLOW_UP")) {
          return;
        }
      }
      const where: Prisma.ConversationMessageWhereInput = {
        id: messageId, conversationId: owned.message.conversationId, direction: "OUTBOUND",
        ...(expectedReservation ? {content: PENDING_AUTOMATED_WHATSAPP_CONTENT,
          outboundPresentation: {equals: Prisma.DbNull},
          moderationAssessments: {none: {}},
          conversation: {is: {id: expectedReservation.conversationId, OR: [
            {shopId: expectedReservation.shopId, checkoutRecovery: null},
            {checkoutRecovery: {is: {shopId: expectedReservation.shopId}}, OR: [{shopId: null}, {shopId: expectedReservation.shopId}]},
          ]}},
        } : {}),
        senderType: initial ? "AUTOMATION" : { in: ["AUTOMATION", "AGENT"] },
        providerDispatchKey: null, providerDispatchAdmittedAt: null,
        providerDispatchControlRevision: null, providerMessageId: null,
        sentAt: null, deliveredAt: null, readAt: null, failedAt: null, providerFailureCode: null,
      };
      const changed = await tx.conversationMessage.updateMany({
        where: { ...where, status: MessageStatus.PENDING }, data: { status: MessageStatus.FAILED },
      });
      if (!changed.count && !await tx.conversationMessage.findFirst({
        where: { ...where, status: MessageStatus.FAILED }, select: { id: true },
      })) return;
      if (initial) await this.closeInitial(tx, owned, initial, "PRE_PROVIDER_REFUSED");
      if (owned.usage) await this.deleteOwnedUsage(tx, owned.usage);
    });
  }

  private async readOwnedUsage(tx: Prisma.TransactionClient, messageId: string) {
    const message = await tx.conversationMessage.findUnique({
      where: { id: messageId },
      include: { merchantSendCommand: { select: { id: true } },
        recoveryOutreachAttempt: { select: { id: true } },
        conversation: { include: { checkoutRecovery: { select: { shopId: true } } } } },
    });
    if (!message || message.direction !== "OUTBOUND" || message.merchantSendCommand ||
        (message.senderType !== "AUTOMATION" && message.senderType !== "AGENT")) return null;
    const shopId = message.conversation.checkoutRecovery?.shopId ?? message.conversation.shopId;
    if (!shopId || (message.conversation.shopId && message.conversation.shopId !== shopId)) return null;
    const usage = await tx.usageEvent.findMany({
      where: { sourceId: messageId, metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE }, take: 2,
    });
    if (usage.length > 1 || (usage[0] && (usage[0].shopId !== shopId || Number(usage[0].quantity) !== 1)))
      return null;
    return { shopId, message, usage: usage[0] };
  }

  private async lockInitial(
    tx: Prisma.TransactionClient, owned: NonNullable<Awaited<ReturnType<OutboundProviderFailureService["readOwnedUsage"]>>>,
    attemptId: string, recipient?: string,
  ): Promise<boolean> {
    if (!owned.usage || owned.usage.sourceType !== "OUTBOUND_AUTOMATED_MESSAGE" || owned.message.senderType !== "AUTOMATION" || !owned.message.conversation.checkoutRecoveryId)
      return false;
    const shop = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "commerce"."Shop" WHERE "id"=${owned.shopId} FOR UPDATE`;
    if (shop.length !== 1) return false;
    const attempt = await tx.$queryRaw<Array<{ id: string; recipient: string }>>`
      SELECT "id","recipient" FROM "commerce"."RecoveryOutreachAttempt"
      WHERE "id"=${attemptId} AND "checkoutRecoveryId"=${owned.message.conversation.checkoutRecoveryId}
        AND "sequence"=1 AND "trigger"='INITIAL' AND "status" IN ('PENDING','CAPACITY_BLOCKED')
        AND "sentAt" IS NULL AND "followUpDueAt" IS NULL AND "outboundMessageId" IS NULL
      FOR UPDATE`;
    if (attempt.length !== 1 || (recipient !== undefined && attempt[0]?.recipient !== recipient)) return false;
    const message = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "whatsapp"."ConversationMessage"
      WHERE "id"=${owned.message.id} AND "conversationId"=${owned.message.conversationId}
      FOR UPDATE`;
    if (message.length !== 1) return false;
    const fresh = await this.readOwnedUsage(tx, owned.message.id);
    return fresh?.shopId === owned.shopId && fresh.usage?.id === owned.usage.id &&
      fresh.usage?.idempotencyKey === owned.usage.idempotencyKey &&
      fresh.message.conversation.checkoutRecoveryId === owned.message.conversation.checkoutRecoveryId;
  }

  private async closeInitial(
    tx: Prisma.TransactionClient, owned: NonNullable<Awaited<ReturnType<OutboundProviderFailureService["readOwnedUsage"]>>>,
    attemptId: string, failureCode: string,
  ) {
    const updated = await tx.recoveryOutreachAttempt.updateMany({
      where: {
        id: attemptId, checkoutRecoveryId: owned.message.conversation.checkoutRecoveryId!,
        sequence: 1, trigger: "INITIAL", status: { in: ["PENDING", "CAPACITY_BLOCKED"] },
        outboundMessageId: null, sentAt: null, followUpDueAt: null,
      },
      data: { outboundMessageId: owned.message.id, status: "FAILED", failureCode, closedAt: new Date() },
    });
    if (updated.count !== 1) throw new Error("INITIAL_OUTREACH_FAILURE_LINEAGE_CONFLICT");
  }

  private async deleteOwnedUsage(
    tx: Prisma.TransactionClient, usage: { id: string; shopId: string; sourceId: string | null; idempotencyKey: string },
  ) {
    const deleted = await tx.usageEvent.deleteMany({
      where: { id: usage.id, shopId: usage.shopId, sourceId: usage.sourceId,
        idempotencyKey: usage.idempotencyKey, metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE },
    });
    if (deleted.count !== 1) throw new Error("OUTBOUND_FAILURE_USAGE_LINEAGE_CONFLICT");
  }

  async afterProviderError(
    messageId: string, recipient: string, error: unknown,
    preserveInitialAdmission = false,
  ): Promise<void> {
    if (isSynchronousRecipientFailure(error)) {
      // Keep the exact usage row until compensation derives attempt/source lineage.
      await this.synchronousFailure.afterAutomatedRejection(messageId, recipient);
    } else if (isDefinitiveWhatsAppError(error)) {
      if (preserveInitialAdmission) {
        await this.database.$transaction(async (tx) => {
          const owned = await this.readOwnedUsage(tx, messageId);
          const initial = /^recovery-outreach:([A-Za-z0-9_-]+)$/.exec(owned?.usage?.idempotencyKey ?? "")?.[1];
          if (!owned?.usage || !initial || !await this.lockInitial(tx, owned, initial, recipient))
            throw new Error("INITIAL_OUTREACH_FAILURE_LINEAGE_CONFLICT");
          const changed = await tx.conversationMessage.updateMany({
            where: {
              id: messageId, conversationId: owned.message.conversationId, direction: "OUTBOUND",
              senderType: "AUTOMATION", status: MessageStatus.PENDING,
              providerDispatchKey: { not: null }, providerDispatchAdmittedAt: { not: null },
              providerDispatchControlRevision: { not: null }, providerMessageId: null,
              sentAt: null, deliveredAt: null, readAt: null, failedAt: null,
            },
            data: { status: MessageStatus.FAILED, failedAt: new Date(),
              ...(error.providerCode ? { providerFailureCode: error.providerCode } : {}) },
          });
          if (changed.count !== 1) throw new Error("INITIAL_OUTREACH_FAILURE_LINEAGE_CONFLICT");
          await this.closeInitial(tx, owned, initial, "PROVIDER_REJECTED");
          await this.deleteOwnedUsage(tx, owned.usage);
        });
      } else if (error.code === "provider-rejected" && error.providerCode) {
        await this.database.conversationMessage.update({
          where: { id: messageId },
          data: { status: MessageStatus.FAILED, failedAt: new Date(),
            providerFailureCode: error.providerCode },
        });
        await this.removeUsage(messageId);
      } else {
        await this.database.conversationMessage.update({
          where: { id: messageId }, data: { status: MessageStatus.FAILED },
        });
        await this.removeUsage(messageId);
      }
    }
    // No durable final disposition for timeout/unknown provider acceptance.
  }

  private async removeUsage(messageId: string): Promise<void> {
    await this.database.usageEvent.deleteMany({
      where: { sourceId: messageId, metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE },
    });
  }
}

type InitialOutreachErrorDiagnostic = {
  name: string;
  message: string;
  redactionApplied: boolean;
  truncated: boolean;
  code?: string;
  clientVersion?: string;
  meta?: Record<string, string>;
  cause?: InitialOutreachErrorDiagnostic;
};

/** Safe projection of initial-outreach failure evidence for the Shared sink. */
export function initialOutreachDiagnostic(error: unknown) {
  const project = (source: unknown, includeCause: boolean): InitialOutreachErrorDiagnostic => {
    const original = source instanceof Error ? source.message : typeof source === "string" ? source : "Non-Error failure";
    const redacted = original
      .replace(/\b(?:https?|postgres(?:ql)?|redis):\/\/[^\s<>]+/gi, "[REDACTED_URL]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:[a-z_-]*token|[a-z_-]*secret|password|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED_CREDENTIAL]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
      .replace(/(?<![A-Za-z0-9])\+?\d(?:[ ().-]*\d){6,14}(?![A-Za-z0-9])/g, "[REDACTED_PHONE]")
      .replace(/[\r\n\t]+/g, " ");
    const boundedIdentifier = (value: unknown) =>
      typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
    const properties = typeof source === "object" && source !== null
      ? source as Record<string, unknown> : {};
    const meta = typeof properties.meta === "object" && properties.meta !== null
      ? properties.meta as Record<string, unknown> : {};
    const code = boundedIdentifier(properties.code);
    const clientVersion = boundedIdentifier(properties.clientVersion);
    const safeMeta = Object.fromEntries(["modelName", "constraint", "field_name"].flatMap((key) => {
      const value = boundedIdentifier(meta[key]);
      return value ? [[key, value]] : [];
    }));
    return {
      name: boundedIdentifier(source instanceof Error ? source.name : undefined) ?? "UnknownError",
      message: redacted.slice(0, 384),
      redactionApplied: redacted !== original,
      truncated: redacted.length > 384,
      ...(code ? { code } : {}),
      ...(clientVersion ? { clientVersion, meta: safeMeta } : {}),
      ...(includeCause && properties.cause !== undefined
        ? { cause: project(properties.cause, false) }
        : {}),
    };
  };
  return project(error, true);
}
