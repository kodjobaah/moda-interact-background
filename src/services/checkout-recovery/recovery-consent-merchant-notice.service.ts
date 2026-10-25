import { MerchantSupportMessageKind, MerchantSupportMessageState } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type {
  RecoveryConsentMerchantNotifier,
  RecoveryConsentNoticeInput,
  RecoveryConsentNoticeResult,
} from "./recovery-consent-merchant-notice.contracts.js";
import {
  createRecoveryConsentNoticeSourceKey,
  formatRecoveryConsentMerchantNotice,
} from "./recovery-consent-merchant-notice.formatter.js";

type NoticeDatabase = Pick<PrismaClient, "$transaction">;
type NoticeLogger = Pick<StructuredLogger, "info" | "error">;
const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});

/** Single transactional Support writer for Shopify and Woo recovery-consent notices. */
export class RecoveryConsentMerchantNoticeService implements RecoveryConsentMerchantNotifier {
  constructor(
    private readonly database: NoticeDatabase = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: NoticeLogger = defaultLogger,
  ) {}

  async notify(input: RecoveryConsentNoticeInput): Promise<RecoveryConsentNoticeResult> {
    let validated = false;
    try {
      // Validate and prepare every byte before acquiring a DB transaction.
      const body = formatRecoveryConsentMerchantNotice(input);
      const sourceKey = createRecoveryConsentNoticeSourceKey(input);
      const at = this.now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
        throw new TypeError("Invalid now() date");
      }
      validated = true;
      const result = await this.database.$transaction(async (tx) => {
        // Avoid Prisma's read-then-insert upsert race when multiple workers
        // create the first Support thread for a shop concurrently.
        await tx.merchantSupportThread.createMany({
          data: [{ shopId: input.shopId }],
          skipDuplicates: true,
        });
        const thread = await tx.merchantSupportThread.findUniqueOrThrow({
          where: { shopId: input.shopId },
          select: { id: true },
        });
        const inserted = await tx.merchantSupportMessage.createMany({
          skipDuplicates: true,
          data: [{
            threadId: thread.id,
            kind: MerchantSupportMessageKind.SYSTEM,
            state: MerchantSupportMessageState.AVAILABLE,
            originalBody: body,
            sourceLanguageTag: "en-GB",
            systemCode: "RECOVERY_CONSENT_ADMISSION",
            systemVersion: "1",
            sourceKey,
            availableAt: at,
          }],
        });
        if (inserted.count === 1) {
          // A later insert, or a caller whose clock is behind, must not regress
          // the timestamp. The conditional update is evaluated by PostgreSQL.
          await tx.merchantSupportThread.updateMany({
            where: {
              id: thread.id,
              OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }],
            },
            data: { lastMessageAt: at },
          });
          return "created" as const;
        }
        if (inserted.count !== 0) throw new Error("Unexpected merchant Support insert count");
        const existing = await tx.merchantSupportMessage.findUnique({ where: { sourceKey } });
        if (!existing || existing.threadId !== thread.id ||
            existing.kind !== MerchantSupportMessageKind.SYSTEM ||
            existing.systemCode !== "RECOVERY_CONSENT_ADMISSION" || existing.systemVersion !== "1") {
          throw new Error("Recovery consent notice deduplication invariant failed");
        }
        return "duplicate" as const;
      });
      this.logSafely("recovery.consent_notice." + result, {
        shopId: input.shopId, platform: input.platform, reasonCode: input.reason,
        blockedOperation: input.blockedOperation, result,
      });
      return result;
    } catch (error) {
      this.logSafely("recovery.consent_notice.failed", validated ? {
        shopId: input.shopId, platform: input.platform, reasonCode: input.reason,
        blockedOperation: input.blockedOperation, result: "failed", errorCategory: "PERSISTENCE_FAILURE",
      } : { result: "failed", errorCategory: "INVALID_INPUT_OR_FORMAT" });
      // Never transform a Prisma/formatter failure into a positive/duplicate notice.
      throw error;
    }
  }

  private logSafely(event: string, fields: Record<string, string>): void {
    // A failing injected sink must not undo a transaction that already committed.
    try {
      if (event.endsWith(".failed")) this.logger.error(event, fields);
      else this.logger.info(event, fields);
    } catch { /* Observability is never a correctness dependency. */ }
  }
}

export const recoveryConsentMerchantNoticeService = new RecoveryConsentMerchantNoticeService();
