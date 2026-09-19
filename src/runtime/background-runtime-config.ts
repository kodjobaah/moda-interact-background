import type { BackgroundRuntimeConfig, PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "./deployment-environment.js";

import prisma from "../lib/db.js";

export type BackgroundRuntimeConfigSnapshot = BackgroundRuntimeConfig;
export type RuntimeConfigListener = (
  current: BackgroundRuntimeConfigSnapshot,
  previous: BackgroundRuntimeConfigSnapshot | null,
) => void | Promise<void>;

type ConfigDatabase = Pick<PrismaClient, "backgroundRuntimeConfig">;

const REFRESH_INTERVAL_MS = 5_000;
const NUMERIC_BOUNDS: Record<string, readonly [number, number]> = {
  billingReconciliationIntervalSeconds: [10, 3600], billingReconciliationShopBatchSize: [1, 200],
  shopifyUsagePublishBatchSize: [1, 200], recoveryRepairIntervalSeconds: [30, 3600], recoveryRepairShopBatchSize: [1, 500],
  recoveryResumeBatchSize: [1, 100], translationReconciliationIntervalSeconds: [30, 3600], translationBatchMaxRequests: [1, 500],
  conversationQuietWindowMs: [250, 10000], conversationMaxSettleWindowMs: [1000, 30000], billingFrozenRecheckSeconds: [300, 86400],
  billingProviderRetrySeconds: [30, 3600], shopifyUsageRetryBaseSeconds: [10, 3600], shopifyUsageRetryMaxSeconds: [60, 86400],
  translationReconciliationPageSize: [1, 500], translationClaimTimeoutSeconds: [60, 86400], translationSubmitRetrySeconds: [30, 86400],
  translationInitialPollSeconds: [30, 86400], translationPollIntervalSeconds: [30, 86400], translationResultRetrySeconds: [30, 86400],
  translationSubmitMaxAttempts: [1, 10], translationMaxAutoRetries: [0, 10], checkoutQueueGlobalConcurrency: [1, 100],
  orderQueueGlobalConcurrency: [1, 100], pendingRecoveryQueueGlobalConcurrency: [1, 100], recoveryResumeQueueGlobalConcurrency: [1, 100],
  whatsappQueueGlobalConcurrency: [1, 100], merchantCommunicationsQueueGlobalConcurrency: [1, 100], billingSubscriptionQueueGlobalConcurrency: [1, 100],
  rawSenderLimitPerMinute: [1, 10000], rawGlobalLimitPerMinute: [1, 1000000], turnSenderLimitPerMinute: [1, 10000],
  turnSenderLimitPerTenMinutes: [1, 100000], turnConversationLimitPerMinute: [1, 10000], turnConversationLimitPerTenMinutes: [1, 100000],
  turnShopLimitPerMinute: [1, 100000], turnGlobalLimitPerMinute: [1, 1000000], discoverySenderLimitPerMinute: [1, 10000],
  discoverySenderLimitPerTenMinutes: [1, 100000], discoveryConversationLimitPerMinute: [1, 10000], discoveryConversationLimitPerTenMinutes: [1, 100000],
  checkoutRecoveryLifetimeDays: [1, 90],
};
const CROSS_FIELD_RULES: readonly [string, string, string, "gte" | "lte"][] = [
  ["conversationMaxSettleWindowMs", "conversationQuietWindowMs", "must be at least the quiet window", "gte"],
  ["shopifyUsageRetryMaxSeconds", "shopifyUsageRetryBaseSeconds", "usage retry max must be at least the base", "gte"],
  ["rawGlobalLimitPerMinute", "rawSenderLimitPerMinute", "must be at least the sender limit", "gte"],
  ["turnSenderLimitPerTenMinutes", "turnSenderLimitPerMinute", "10-minute sender limit must be at least the 1-minute limit", "gte"],
  ["turnConversationLimitPerTenMinutes", "turnConversationLimitPerMinute", "10-minute conversation limit must be at least the 1-minute limit", "gte"],
  ["turnGlobalLimitPerMinute", "turnShopLimitPerMinute", "global turn limit must be at least the shop limit", "gte"],
  ["turnShopLimitPerMinute", "turnSenderLimitPerMinute", "shop turn limit must be at least the sender limit", "gte"],
  ["discoverySenderLimitPerTenMinutes", "discoverySenderLimitPerMinute", "10-minute discovery sender limit must be at least the 1-minute limit", "gte"],
  ["discoveryConversationLimitPerTenMinutes", "discoveryConversationLimitPerMinute", "10-minute discovery conversation limit must be at least the 1-minute limit", "gte"],
  ["discoverySenderLimitPerMinute", "turnSenderLimitPerMinute", "discovery sender limit must not exceed the turn sender limit", "lte"],
  ["discoverySenderLimitPerTenMinutes", "turnSenderLimitPerTenMinutes", "10-minute discovery sender limit must not exceed the turn sender limit", "lte"],
  ["discoveryConversationLimitPerMinute", "turnConversationLimitPerMinute", "discovery conversation limit must not exceed the turn conversation limit", "lte"],
  ["discoveryConversationLimitPerTenMinutes", "turnConversationLimitPerTenMinutes", "discovery conversation limit must not exceed the turn conversation limit", "lte"],
];
const CONFIG_FIELDS = [
  "id", "version", "billingReconciliationIntervalSeconds", "billingReconciliationShopBatchSize",
  "shopifyUsagePublishBatchSize", "recoveryRepairIntervalSeconds", "recoveryRepairShopBatchSize",
  "recoveryResumeBatchSize", "translationReconciliationIntervalSeconds", "translationBatchMaxRequests",
  "conversationQuietWindowMs", "conversationMaxSettleWindowMs", "billingFrozenRecheckSeconds",
  "billingProviderRetrySeconds", "shopifyUsageRetryBaseSeconds", "shopifyUsageRetryMaxSeconds",
  "translationReconciliationPageSize", "translationClaimTimeoutSeconds", "translationSubmitRetrySeconds",
  "translationInitialPollSeconds", "translationPollIntervalSeconds", "translationResultRetrySeconds",
  "translationSubmitMaxAttempts", "translationMaxAutoRetries", "rawSenderLimitPerMinute",
  "rawGlobalLimitPerMinute", "turnSenderLimitPerMinute", "turnSenderLimitPerTenMinutes",
  "turnConversationLimitPerMinute", "turnConversationLimitPerTenMinutes", "turnShopLimitPerMinute",
  "turnGlobalLimitPerMinute", "discoverySenderLimitPerMinute", "discoverySenderLimitPerTenMinutes",
  "discoveryConversationLimitPerMinute", "discoveryConversationLimitPerTenMinutes", "checkoutQueueGlobalConcurrency",
  "orderQueueGlobalConcurrency",
  "pendingRecoveryQueueGlobalConcurrency", "recoveryResumeQueueGlobalConcurrency", "whatsappQueueGlobalConcurrency",
  "merchantCommunicationsQueueGlobalConcurrency", "billingSubscriptionQueueGlobalConcurrency", "createdAt", "updatedAt",
  "checkoutRecoveryLifetimeDays",
] as const;

const logger = createLogger({ serviceName: "moda-background-runtime", environment: resolveDeploymentEnvironmentName() });

class ImmutableDate extends Date {
  override setDate(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setFullYear(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setHours(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setMilliseconds(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setMinutes(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setMonth(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setSeconds(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setTime(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setUTCDate(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setUTCFullYear(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setUTCHours(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setUTCMilliseconds(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setUTCMinutes(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setUTCMonth(): number { throw new TypeError("Immutable runtime configuration date."); }
  override setUTCSeconds(): number { throw new TypeError("Immutable runtime configuration date."); }
  setYear(): number { throw new TypeError("Immutable runtime configuration date."); }
}

function immutableDate(value: Date): Date {
  return Object.freeze(new ImmutableDate(value.getTime()));
}

function validateConfig(row: unknown): BackgroundRuntimeConfigSnapshot {
  if (!row || typeof row !== "object") throw new Error("Invalid background runtime configuration.");
  const value = row as Record<string, unknown>;
  for (const field of CONFIG_FIELDS) {
    if (!(field in value)) throw new Error(`Invalid background runtime configuration: missing ${field}.`);
  }
  if (value.id !== "default" || !Number.isSafeInteger(value.version) || (value.version as number) < 0) {
    throw new Error("Invalid background runtime configuration.");
  }
  for (const [field, [minimum, maximum]] of Object.entries(NUMERIC_BOUNDS)) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < minimum || (value[field] as number) > maximum) {
      throw new Error(`Invalid background runtime configuration: invalid ${field}.`);
    }
  }
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (!(value[field] instanceof Date) || Number.isNaN(value[field].getTime())) {
      throw new Error(`Invalid background runtime configuration: invalid ${field}.`);
    }
  }
  for (const [firstField, secondField, message, relation] of CROSS_FIELD_RULES) {
    const invalid = relation === "gte"
      ? (value[firstField] as number) < (value[secondField] as number)
      : (value[firstField] as number) > (value[secondField] as number);
    if (invalid) {
      throw new Error(`Invalid background runtime configuration: ${message}.`);
    }
  }
  return Object.freeze({
    ...value,
    createdAt: immutableDate(value.createdAt as Date),
    updatedAt: immutableDate(value.updatedAt as Date),
  }) as BackgroundRuntimeConfigSnapshot;
}

export class BackgroundRuntimeConfigService {
  private snapshot: BackgroundRuntimeConfigSnapshot | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshInFlight: Promise<BackgroundRuntimeConfigSnapshot> | undefined;
  private closed = false;
  private readonly listeners = new Set<RuntimeConfigListener>();

  constructor(
    private readonly database: ConfigDatabase = prisma,
    private readonly log: StructuredLogger = logger,
    private readonly refreshIntervalMs = REFRESH_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    this.closed = false;
    await this.refresh(true);
    this.scheduleRefresh();
  }

  current(): BackgroundRuntimeConfigSnapshot {
    if (!this.snapshot) throw new Error("Background runtime configuration has not started.");
    return this.snapshot;
  }

  async getFresh(): Promise<BackgroundRuntimeConfigSnapshot> {
    return this.refresh(false);
  }

  subscribe(listener: RuntimeConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.refreshInFlight;
  }

  private async refresh(startup: boolean): Promise<BackgroundRuntimeConfigSnapshot> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        const row = await this.database.backgroundRuntimeConfig.findUnique({ where: { id: "default" } });
        if (!row) {
          if (startup || !this.snapshot) throw new Error("Background runtime configuration is missing.");
          throw new Error("Background runtime configuration is missing.");
        }
        const next = validateConfig(row);
        const previous = this.snapshot;
        if (!previous || next.version > previous.version) {
          this.snapshot = next;
          if (previous) await this.notify(next, previous);
        }
        return this.current();
      } catch (error) {
        if (startup || !this.snapshot) throw error;
        this.log.warn("background.runtime_config.refresh_failed", { error });
        return this.snapshot;
      } finally {
        this.refreshInFlight = undefined;
      }
    })();
    return this.refreshInFlight;
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(false).catch(() => undefined).finally(() => this.scheduleRefresh());
    }, this.refreshIntervalMs);
    this.timer.unref();
  }

  private async notify(current: BackgroundRuntimeConfigSnapshot, previous: BackgroundRuntimeConfigSnapshot): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => {
      try {
        await listener(current, previous);
      } catch (error) {
        this.log.warn("background.runtime_config.listener_failed", { error });
      }
    }));
  }
}

export const backgroundRuntimeConfigService = new BackgroundRuntimeConfigService();