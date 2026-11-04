import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import prisma from "../../lib/db.js";
import { isRecoveryReservationRetryableConflict } from "../recovery-reservation/reservation-lifecycle.js";
import { classifyWhatsAppProviderFailure } from "../../domain/whatsapp-recipient-failure.js";
import { readExactAutomatedUsage, removeExactAutomatedUsage } from "./automated-usage.js";
import { compensateCommittedSource } from "./committed.js";
import { resolveExactRecoverySource } from "./lineage.js";
import { releaseReservedSource } from "./reserved.js";
import { requireLineage, type CompensationTransaction, type RecoveryDeliveryCompensationOutcome } from "./types.js";

export type { RecoveryDeliveryCompensationOutcome } from "./types.js";

const logger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });

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
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        const fields = { operation: "reconcile", ...identity, stage: context.stage, attempt, maxAttempts, retryExhausted: isRecoveryReservationRetryableConflict(error) && attempt === maxAttempts };
        if (isRecoveryReservationRetryableConflict(error) && attempt < maxAttempts) {
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
        status: true, providerFailureCode: true,
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
      classifyWhatsAppProviderFailure(message.providerFailureCode) !== "RECIPIENT_UNDELIVERABLE") {
      return "not-terminal";
    }
    const shopId = message.conversation.checkoutRecovery?.shopId ?? message.conversation.shopId;
    requireLineage(shopId && (!message.conversation.shopId ||
      message.conversation.shopId === shopId), "provider message has conflicting Shop ownership");
    context.stage = "source_lookup";
    const automatedUsage = await readExactAutomatedUsage(tx, shopId, message.id);
    const source = await resolveExactRecoverySource(tx, message, shopId, automatedUsage);
    let result: RecoveryDeliveryCompensationOutcome = "not-recovery";
    if (source) {
      switch (source.reservation.status) {
        case "RESERVED":
          requireLineage(!source.reservation.committedUsageEventId &&
            !source.reservation.compensationUsageEventId && !source.reservation.compensationReason,
            "reserved source has committed compensation evidence");
          context.stage = "source_release";
          result = await releaseReservedSource(tx, source);
          break;
        case "COMMITTED":
          context.stage = "source_correction";
          result = await compensateCommittedSource(tx, source, this.now());
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
    context.stage = "outbound_usage_cleanup";
    await removeExactAutomatedUsage(tx, shopId, message.id, automatedUsage);
    return result;
  }
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
