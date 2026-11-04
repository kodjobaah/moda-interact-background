import {
  safeParseNormalizedWhatsAppStatus,
  type NormalizedWhatsAppStatus,
} from "@modainteract/moda-interact-shared/billing";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { MerchantConversationSendState, Prisma, UsageMetric } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  canApplyProviderStatus,
  statusForProviderEvent,
} from "../domain/whatsapp-provider-status-transition.js";
import { classifyWhatsAppProviderFailure } from "../domain/whatsapp-recipient-failure.js";
import { recoveryDeliveryCompensationService } from "./recovery-delivery-compensation/reconcile.service.js";
import {
  RecoveryDeliveryMerchantNotificationService,
} from "./recovery-delivery-merchant-notification.service.js";
import { RecoveryDeliverySupportMessageService } from "./recovery-delivery-support-message.service.js";
import {
  RecipientReachabilityFailureService,
} from "./recipient-reachability-failure.service.js";
import {
  RecipientReachabilityPositiveService,
} from "./recipient-reachability-positive.service.js";
import { RecipientReachabilityStore } from "./recipient-reachability-store.js";
import {
  ProviderStatusConcurrencyConflict, lifecycleUpdate, deliveredUsageKey,
  providerSummary, isRetryableConflict,
} from "./whatsapp-provider-status-lifecycle.js";

type Database = typeof prisma;
const MAX_TRANSACTION_RETRIES = 3;

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export type ProviderStatusOutcome =
  "invalid" | "unknown-message" | "ignored" | "applied";

export class WhatsAppProviderStatusService {
  constructor(
    private readonly database: Database = prisma,
    private readonly serviceLogger: StructuredLogger = logger,
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
    private readonly compensation: Pick<typeof recoveryDeliveryCompensationService, "reconcile"> = recoveryDeliveryCompensationService,
    private readonly failureReachability: Pick<RecipientReachabilityFailureService, "afterCorrection"> =
      new RecipientReachabilityFailureService(database, new RecipientReachabilityStore(database)),
    private readonly positiveReachability: Pick<RecipientReachabilityPositiveService, "fromProviderDelivery"> =
      new RecipientReachabilityPositiveService(database, new RecipientReachabilityStore(database)),
    private readonly notification: Pick<RecoveryDeliveryMerchantNotificationService, "notify"> =
      new RecoveryDeliveryMerchantNotificationService(
        database, new RecoveryDeliverySupportMessageService(database),
      ),
  ) {}

  async process(input: unknown): Promise<ProviderStatusOutcome> {
    const parsed = safeParseNormalizedWhatsAppStatus(input);
    if (!parsed.success) {
      this.serviceLogger.warn("whatsapp.provider_status.invalid", {
        reason: "schema-validation-failed",
      });
      return "invalid";
    }

    return this.apply(parsed.data);
  }

  private async apply(
    event: NormalizedWhatsAppStatus,
  ): Promise<ProviderStatusOutcome> {
    const occurredAt = new Date(event.occurredAt);
    let appliedInfo: { messageId: string; status: string; outcome: string } | null = null;

    const outcome = await this.withRetry(event, () => this.database.$transaction(async (transaction) => {
      appliedInfo = null;
      const pointer = await transaction.conversationMessage.findUnique({
        where: { providerMessageId: event.providerMessageId },
        select: { id: true, providerMessageId: true, conversation: { select: { shopId: true, checkoutRecovery: { select: { shopId: true } } } } },
      });
      if (!pointer) {
        this.serviceLogger.warn("whatsapp.provider_status.unknown_message", { providerMessageId: event.providerMessageId });
        return "unknown-message";
      }
      const pointerShopId = pointer.conversation.shopId ?? pointer.conversation.checkoutRecovery?.shopId;
      if (!pointerShopId) {
        this.serviceLogger.warn("whatsapp.provider_status.unowned_message", { providerMessageId: event.providerMessageId, messageId: pointer.id });
        return "ignored";
      }
      const lockedShop = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${pointerShopId} FOR KEY SHARE`;
      if (lockedShop.length !== 1) throw new ProviderStatusConcurrencyConflict();
      await transaction.$queryRaw`SELECT "id" FROM "whatsapp"."ConversationMessage" WHERE "id"=${pointer.id} FOR UPDATE`;
      const message = await transaction.conversationMessage.findUnique({
        where: { id: pointer.id },
        select: {
          id: true,
          providerMessageId: true,
          direction: true,
          status: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          providerFailureCode: true,
          failedAt: true,
          merchantSendCommand: { select: { id: true, state: true } },
          recoveryOutreachAttempt: { select: { id: true, status: true } },
          conversation: {
            select: {
              shopId: true,
              checkoutRecovery: { select: { shopId: true } },
            },
          },
        },
      });

      if (!message) {
        throw new ProviderStatusConcurrencyConflict();
      }

      if (message.providerMessageId !== pointer.providerMessageId || pointer.providerMessageId !== event.providerMessageId ||
        (message.conversation.shopId && message.conversation.shopId !== pointerShopId) ||
        message.conversation.checkoutRecovery && message.conversation.checkoutRecovery.shopId !== pointerShopId) {
        throw new ProviderStatusConcurrencyConflict();
      }
      const actualShopId = message.conversation.shopId ?? message.conversation.checkoutRecovery?.shopId;
      if (actualShopId !== pointerShopId) throw new ProviderStatusConcurrencyConflict();

      if (message.direction !== "OUTBOUND") {
        this.serviceLogger.warn("whatsapp.provider_status.non_outbound_message", {
          providerMessageId: event.providerMessageId,
          messageId: message.id,
        });
        return "ignored";
      }

      const shopId =
        message.conversation.shopId ??
        message.conversation.checkoutRecovery?.shopId;
      if (!shopId) {
        this.serviceLogger.warn("whatsapp.provider_status.unowned_message", {
          providerMessageId: event.providerMessageId,
          messageId: message.id,
        });
        return "ignored";
      }

      const canApplyStatus = canApplyProviderStatus(message.status, event.status);
      const nextStatus = statusForProviderEvent(message.status, event.status);
      const shouldRecordDelivered =
        canApplyStatus && (event.status === "DELIVERED" || event.status === "READ");
      const becameDelivered =
        shouldRecordDelivered &&
        message.status !== "DELIVERED" && message.status !== "READ";

      const lifecycleData = lifecycleUpdate(
        message,
        nextStatus,
        occurredAt,
        event.status,
        canApplyStatus,
        event,
      );
      const lifecycleChanged = Object.keys(lifecycleData).length > 0;
      if (lifecycleChanged) {
        const updated = await transaction.conversationMessage.updateMany({
          where: {
            id: message.id,
            direction: "OUTBOUND",
            status: message.status,
          },
          data: lifecycleData,
        });
        if (updated.count !== 1) throw new ProviderStatusConcurrencyConflict();
      }

      let commandConverged = false;
      if (message.merchantSendCommand && canApplyStatus) {
        if (event.status === "FAILED") {
          const updated = await transaction.merchantConversationSendCommand.updateMany({
            where: {
              id: message.merchantSendCommand.id,
              state: { in: [MerchantConversationSendState.DISPATCH_ADMITTED, MerchantConversationSendState.UNKNOWN] },
            },
            data: {
              state: MerchantConversationSendState.FAILED,
              failureCode: event.schemaVersion === 3 && event.failure
                ? event.failure.providerCode
                : "provider_failed",
              completedAt: occurredAt,
            },
          });
          commandConverged = updated.count === 1;
        } else if (event.status === "SENT" || event.status === "DELIVERED" || event.status === "READ") {
          const updated = await transaction.merchantConversationSendCommand.updateMany({
            where: {
              id: message.merchantSendCommand.id,
              state: { in: [MerchantConversationSendState.DISPATCH_ADMITTED, MerchantConversationSendState.UNKNOWN] },
            },
            data: {
              state: MerchantConversationSendState.SENT,
              completedAt: occurredAt,
            },
          });
          commandConverged = updated.count === 1;
        }
      }

      const updatedFailureCode = lifecycleData.providerFailureCode;
      const persistedFailureCode = typeof updatedFailureCode === "string"
        ? updatedFailureCode
        : message.providerFailureCode;
      const terminalRecipientFailure =
        canApplyStatus &&
        event.status === "FAILED" &&
        classifyWhatsAppProviderFailure(persistedFailureCode) === "RECIPIENT_UNDELIVERABLE";
      let attemptConverged = false;
      if (
        terminalRecipientFailure &&
        message.recoveryOutreachAttempt?.status === "WAITING_FOR_RESPONSE"
      ) {
        const converged = await transaction.recoveryOutreachAttempt.updateMany({
          where: {
            id: message.recoveryOutreachAttempt.id,
            status: "WAITING_FOR_RESPONSE",
          },
          data: {
            status: "FAILED",
            failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE",
            closedAt: occurredAt,
          },
        });
        attemptConverged = converged.count === 1;
      }

      if (becameDelivered) {
        await transaction.usageEvent.upsert({
          where: { idempotencyKey: deliveredUsageKey(message.id) },
          create: {
            shopId,
            metric: UsageMetric.DELIVERED_WHATSAPP_MESSAGE,
            quantity: 1,
            idempotencyKey: deliveredUsageKey(message.id),
            sourceType: "WHATSAPP_PROVIDER_STATUS",
            sourceId: message.id,
            occurredAt,
            shopifyReportState: "NOT_APPLICABLE",
            providerResponseSummary: providerSummary(event),
          },
          update: {},
        });
      }

      appliedInfo = {
        messageId: message.id,
        status: event.status,
        outcome:
          !lifecycleChanged && !becameDelivered && !attemptConverged && !commandConverged
            ? "ignored"
            : "applied",
      };
      return !lifecycleChanged && !becameDelivered && !attemptConverged && !commandConverged
        ? "ignored"
        : "applied";
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));

    if (appliedInfo) this.serviceLogger.info("whatsapp.provider_status.applied", appliedInfo);

    // Never perform credit accounting inside provider-status convergence. Retry
    // even if the FAILED row was already persisted in an earlier job attempt.
    if (event.status === "FAILED" && outcome !== "unknown-message") {
      const corrected = await this.runAfterCommit(event, "compensation", () => this.compensation.reconcile(event.providerMessageId), true);
      const reachability = await this.runAfterCommit(event, "failure_reachability", () => this.failureReachability.afterCorrection(
        { providerMessageId: event.providerMessageId }, corrected,
      ));
      const notice = await this.runAfterCommit(event, "merchant_notification", () => this.notification.notify(
        { providerMessageId: event.providerMessageId }, corrected, reachability,
      ));
      this.serviceLogger.info("whatsapp.reachability.failure_converged", {
        providerMessageId: event.providerMessageId, correction: corrected, outcome: reachability, notice,
      });
    } else if ((event.status === "DELIVERED" || event.status === "READ") &&
      outcome !== "unknown-message") {
      const reachability = await this.runAfterCommit(event, "positive_reachability", () => this.positiveReachability.fromProviderDelivery(event.providerMessageId));
      this.serviceLogger.info("whatsapp.reachability.positive_converged", {
        providerMessageId: event.providerMessageId, outcome: reachability,
      });
    }
    return outcome;
  }

  private async runAfterCommit<T>(event: NormalizedWhatsAppStatus, stage: string, operation: () => Promise<T>, sourceOwned = false): Promise<T> {
    try { return await operation(); }
    catch (error) {
      this.serviceLogger.error("whatsapp.provider_status.downstream_failed", {
        operation: "processProviderStatus", stage, providerMessageId: event.providerMessageId,
        statusTransactionCommitted: true,
        ...(sourceOwned ? { sourceDiagnosticEvent: "recovery.delivery_compensation.failed" } : { error, ...databaseErrorContext(error) }),
      });
      throw error;
    }
  }

  private async withRetry<T>(event: NormalizedWhatsAppStatus, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const fields = { operation: "processProviderStatus", stage: "status_transaction", providerMessageId: event.providerMessageId, status: event.status, attempt, maxAttempts: this.maxRetries, retryExhausted: isRetryableConflict(error) && attempt === this.maxRetries };
        if (isRetryableConflict(error) && attempt < this.maxRetries) {
          this.serviceLogger.warn("whatsapp.provider_status.retry", { ...fields, reasonCode: providerConflictCode(error), error, ...databaseErrorContext(error) });
          continue;
        }
        this.serviceLogger.error("whatsapp.provider_status.failed", { ...fields, error, ...databaseErrorContext(error) });
        throw error;
      }
    }
    throw new Error("Provider status retry limit exceeded");
  }
}

function providerConflictCode(error: unknown): string {
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

export const whatsappProviderStatusService =
  new WhatsAppProviderStatusService();
