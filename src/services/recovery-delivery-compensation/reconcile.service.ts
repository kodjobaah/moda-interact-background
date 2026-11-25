import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import prisma from "../../lib/db.js";
import { isRecoveryReservationRetryableConflict } from "../recovery-reservation/reservation-lifecycle.js";
import { classifyWhatsAppProviderFailure, isConfirmedProviderNonDelivery } from "../../domain/whatsapp-recipient-failure.js";
import { readExactAutomatedUsage, removeExactAutomatedUsage } from "./automated-usage.js";
import { compensateCommittedSource } from "./committed.js";
import { resolveExactRecoverySource } from "./lineage.js";
import { releaseReservedSource } from "./reserved.js";
import { requireLineage, type CompensationTransaction, type RecoveryDeliveryCompensationOutcome } from "./types.js";

export type { RecoveryDeliveryCompensationOutcome } from "./types.js";

const logger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });

// Compensation can acquire several related accounting locks in one transaction.
// Bound this owner independently of Prisma's global five-second default.
const COMPENSATION_TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * Correct a terminal failure using the durable provider-message identity. This
 * entrypoint intentionally owns no reachability writes or merchant messaging.
 */
export class RecoveryDeliveryCompensationService {
  constructor(
    private readonly database: Pick<PrismaClient, "$transaction"> = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly serviceLogger: StructuredLogger = logger,
  ) {}

  async reconcile(providerMessageId: string): Promise<RecoveryDeliveryCompensationOutcome> {
    return this.withRetry({ providerMessageId });
  }

  /** For a future confirmed synchronous failure without a Meta message ID. */
  async reconcileMessage(messageId: string): Promise<RecoveryDeliveryCompensationOutcome> {
    return this.withRetry({ messageId });
  }

  private async withRetry(identity: { providerMessageId: string } | { messageId: string }) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const context = { stage: "identity" };
      try {
        return await this.database.$transaction(
          (tx) => this.reconcileLocked(tx, identity, context),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: COMPENSATION_TRANSACTION_TIMEOUT_MS,
          },
        );
      } catch (error) {
        const retryable = isRetryableCompensationError(error);
        const fields = { operation: "reconcile", ...identity, stage: context.stage, attempt, maxAttempts,
          retryExhausted: retryable && attempt === maxAttempts };
        if (retryable && attempt < maxAttempts) {
          this.serviceLogger.warn("recovery.delivery_compensation.retry", { ...fields, reasonCode: conflictCode(error), error, ...databaseErrorContext(error) });
          continue;
        }
        this.serviceLogger.error("recovery.delivery_compensation.failed", { ...fields, error, ...databaseErrorContext(error) });
        throw error;
      }
    }
    throw new Error("Recovery delivery compensation retry limit reached");
  }

  private async reconcileLocked(
    tx: CompensationTransaction,
    identity: { providerMessageId: string } | { messageId: string },
    context: { stage: string },
  ): Promise<RecoveryDeliveryCompensationOutcome> {
    context.stage = "identity";
    const pointer = await tx.conversationMessage.findUnique({
      where: "messageId" in identity ? { id: identity.messageId } : { providerMessageId: identity.providerMessageId },
      select: {
        id: true, providerMessageId: true, conversationId: true, status: true,
        conversation: { select: { shopId: true, checkoutRecovery: { select: { id: true, shopId: true } } } },
      },
    });
    if (!pointer || pointer.status !== "FAILED") return "not-terminal";
    const pointerShopId = pointer.conversation.checkoutRecovery?.shopId ?? pointer.conversation.shopId;
    if (pointerShopId) {
      const shop = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${pointerShopId} FOR KEY SHARE`;
      if (shop.length !== 1) requireLineage(false, "provider message Shop is unavailable");
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "whatsapp"."ConversationMessage"
      WHERE "id"=${pointer.id} FOR UPDATE`;
    if (!locked.length) return "not-terminal";
    const message = await tx.conversationMessage.findUnique({
      where: { id: locked[0]!.id },
      select: {
        id: true, providerMessageId: true, conversationId: true, direction: true, senderType: true,
        status: true, providerFailureCode: true, allowanceBlockId: true,
        failedAt: true, sentAt: true, deliveredAt: true, readAt: true,
        conversation: {
          select: {
            shopId: true, checkoutRecovery: { select: { id: true, shopId: true } },
          },
        },
      },
    });
    const rereadShopId = message?.conversation.checkoutRecovery?.shopId ?? message?.conversation.shopId;
    requireLineage(message && message.id === pointer.id && message.providerMessageId === pointer.providerMessageId &&
      message.conversationId === pointer.conversationId && rereadShopId === pointerShopId,
    "provider message ownership changed while locking");
    if (!message || message.direction !== "OUTBOUND" || message.status !== "FAILED" ||
      message.deliveredAt || message.readAt) return "not-terminal";
    const recipientFailure = classifyWhatsAppProviderFailure(message.providerFailureCode) === "RECIPIENT_UNDELIVERABLE";
    // A provider-status FAILED receipt is financial authority irrespective of
    // its error code (including legacy code-less receipts). Preserve the
    // existing explicitly recorded synchronous 131026 rejection entrypoint.
    if (!isConfirmedProviderNonDelivery(message) &&
        !("messageId" in identity && !message.providerMessageId && recipientFailure && message.failedAt)) {
      return "not-terminal";
    }
    const reason = recipientFailure ? "WHATSAPP_RECIPIENT_UNDELIVERABLE" : "WHATSAPP_DELIVERY_FAILED";
    const shopId = message.conversation.checkoutRecovery?.shopId ?? message.conversation.shopId;
    requireLineage(shopId && (!message.conversation.shopId ||
      message.conversation.shopId === shopId), "provider message has conflicting Shop ownership");
    context.stage = "source_lookup";
    const automatedUsage = await readExactAutomatedUsage(tx, shopId, message.id);
    const source = await resolveExactRecoverySource(tx, message, shopId, automatedUsage);
    let result: RecoveryDeliveryCompensationOutcome = "not-recovery";
    if (source) {
      switch (source.reservation.status) {
        case "AMBIGUOUS":
        case "RESERVED":
          requireLineage(!source.reservation.committedUsageEventId && !source.reservation.releaseReason &&
            !source.reservation.compensationUsageEventId && !source.reservation.compensationReason &&
            !source.reservation.compensationDisposition && !source.reservation.compensatedAt,
            "uncommitted source has committed compensation or release evidence");
          context.stage = "source_release";
          if (source.reservation.status === "AMBIGUOUS") {
            // Only locked definitive non-delivery can resolve an ambiguous
            // reservation. Its reserved capacity is still held by the original
            // source; normalize and release atomically via that source owner.
            requireLineage(isConfirmedProviderNonDelivery(message), "ambiguous reservation lacks definitive provider receipt");
            const resolved = await tx.usageReservation.updateMany({
              where: { id: source.reservation.id, shopId, status: "AMBIGUOUS",
                committedUsageEventId: null, compensationUsageEventId: null },
              data: { status: "RESERVED" },
            });
            requireLineage(resolved.count === 1, "ambiguous reservation resolution conflict");
          }
          result = await releaseReservedSource(tx, source);
          break;
        case "COMMITTED":
          context.stage = "source_correction";
          result = await compensateCommittedSource(tx, source, this.now(), reason);
          break;
        case "RELEASED":
          requireLineage(!source.reservation.committedUsageEventId &&
            !source.reservation.compensationUsageEventId,
            "released source still has committed usage");
          result = "already-released";
          break;
        default:
          requireLineage(false, "ambiguous recovery reservation");
      }
    }
    if(source&&message.allowanceBlockId){
      const opening=await tx.conversationMessage.findFirst({where:{allowanceBlockId:message.allowanceBlockId,direction:"OUTBOUND"},orderBy:[{createdAt:"asc"},{id:"asc"}],select:{id:true}});
      if(opening?.id===message.id)await tx.conversationAllowanceBlock.updateMany({where:{id:message.allowanceBlockId,creditReservationId:source.reservation.id,state:{in:["PENDING","ACTIVE"]}},data:{state:"CANCELLED",repairAt:null,repairLeaseToken:null,repairLeaseUntil:null}});
    }
    context.stage = "outbound_usage_cleanup";
    await removeExactAutomatedUsage(tx, shopId, message.id, automatedUsage);
    return result;
  }
}

/** P2028 can mean an expired or lost transaction, not a failed credit lineage.
 * Replay the entire idempotent transaction with fresh reads/locks. Never retry
 * an individual query on the old transaction client or a provider send.
 */
function isRetryableCompensationError(error: unknown): boolean {
  return isRecoveryReservationRetryableConflict(error) ||
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028");
}

function conflictCode(error: unknown): string {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "internal-concurrency-conflict";
}

function databaseErrorContext(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const record = error as { code?: unknown; clientVersion?: unknown; meta?: unknown };
  const isPrismaError = error instanceof Prisma.PrismaClientKnownRequestError;
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
    ? record.meta as Record<string, unknown>
    : undefined;
  const hasSqlState = typeof meta?.code === "string" && /^[A-Za-z0-9]{5}$/.test(meta.code);
  if (!isPrismaError && !hasSqlState) return {};
  const databaseError: Record<string, unknown> = {};
  if (isPrismaError && typeof record.code === "string" && record.code.length <= 32) databaseError.code = record.code;
  if (isPrismaError && typeof record.clientVersion === "string" && record.clientVersion.length <= 64) databaseError.clientVersion = record.clientVersion;
  if (meta) {
    const safeMeta: Record<string, unknown> = {};
    for (const key of ["modelName", "target", "constraint", "field_name"] as const) {
      const value = meta[key];
      if (typeof value === "string" && /^[A-Za-z0-9_.$:-]{1,128}$/.test(value)) safeMeta[key] = value;
      else if (Array.isArray(value) && value.length <= 16 && value.every((part) => typeof part === "string" && /^[A-Za-z0-9_.$:-]{1,128}$/.test(part))) safeMeta[key] = value;
    }
    if (hasSqlState) safeMeta.code = meta.code;
    if (Object.keys(safeMeta).length) databaseError.meta = safeMeta;
  }
  return Object.keys(databaseError).length ? { databaseError } : {};
}

export const recoveryDeliveryCompensationService = new RecoveryDeliveryCompensationService();
