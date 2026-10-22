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

    const outcome = await this.withRetry(() => this.database.$transaction(async (transaction) => {
      const message = await transaction.conversationMessage.findUnique({
        where: { providerMessageId: event.providerMessageId },
        select: {
          id: true,
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
        this.serviceLogger.warn("whatsapp.provider_status.unknown_message", {
          providerMessageId: event.providerMessageId,
        });
        return "unknown-message";
      }

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

      this.serviceLogger.info("whatsapp.provider_status.applied", {
        messageId: message.id,
        status: event.status,
        outcome:
          !lifecycleChanged && !becameDelivered && !attemptConverged && !commandConverged
            ? "ignored"
            : "applied",
      });
      return !lifecycleChanged && !becameDelivered && !attemptConverged && !commandConverged
        ? "ignored"
        : "applied";
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));

    // Never perform credit accounting inside provider-status convergence. Retry
    // even if the FAILED row was already persisted in an earlier job attempt.
    if (event.status === "FAILED" && outcome !== "unknown-message") {
      const corrected = await this.compensation.reconcile(event.providerMessageId);
      const reachability = await this.failureReachability.afterCorrection(
        { providerMessageId: event.providerMessageId }, corrected,
      );
      this.serviceLogger.info("whatsapp.reachability.failure_converged", {
        providerMessageId: event.providerMessageId, correction: corrected, outcome: reachability,
      });
    } else if ((event.status === "DELIVERED" || event.status === "READ") &&
      outcome !== "unknown-message") {
      const reachability = await this.positiveReachability.fromProviderDelivery(
        event.providerMessageId,
      );
      this.serviceLogger.info("whatsapp.reachability.positive_converged", {
        providerMessageId: event.providerMessageId, outcome: reachability,
      });
    }
    return outcome;
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableConflict(error) || attempt === this.maxRetries - 1) {
          throw error;
        }
      }
    }
    throw new Error("Provider status retry limit exceeded");
  }
}

export const whatsappProviderStatusService =
  new WhatsAppProviderStatusService();
