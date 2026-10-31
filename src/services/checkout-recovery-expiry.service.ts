import prisma from "../lib/db.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const MILLISECONDS_PER_DAY = 86_400_000n;
const MIN_POSTGRES_TIMESTAMP_MS = -210_866_803_200_000n;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000n;
const ACTIVE_STATUSES = ["DETECTED", "MESSAGE_SENT", "ENGAGED"] as const;

function expiryCutoff(now: Date, lifetimeDays: number): Date | null {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid checkout recovery expiry time.");
  if (!Number.isSafeInteger(lifetimeDays) || lifetimeDays < 0) {
    throw new RangeError("Invalid checkout recovery lifetime days.");
  }
  const cutoffMs = BigInt(nowMs) - BigInt(lifetimeDays) * MILLISECONDS_PER_DAY;
  if (cutoffMs < MIN_POSTGRES_TIMESTAMP_MS || cutoffMs > MAX_DATE_TIMESTAMP_MS) return null;
  return new Date(Number(cutoffMs));
}

export class CheckoutRecoveryExpiryService {
  async expireInactive(
    runtimeConfig: Pick<BackgroundRuntimeConfigSnapshot, "checkoutRecoveryLifetimeDays">,
    now = new Date(),
  ): Promise<number> {
    const cutoff = expiryCutoff(now, runtimeConfig.checkoutRecoveryLifetimeDays);
    if (cutoff === null) return 0;
    let expired = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const candidates = await prisma.checkoutRecovery.findMany({
        where: {
          status: { in: [...ACTIVE_STATUSES] },
          lastExternalActivityAt: { lte: cutoff },
        },
        orderBy: [{ lastExternalActivityAt: "asc" }, { id: "asc" }],
        take: PAGE_SIZE,
        select: { id: true, status: true },
      });
      if (candidates.length === 0) break;

      for (const candidate of candidates) {
        const changed = await prisma.$transaction(async (transaction) => {
          const update = await transaction.checkoutRecovery.updateMany({
            where: {
              id: candidate.id,
              status: candidate.status,
              lastExternalActivityAt: { lte: cutoff },
            },
            data: { status: "EXPIRED", expiredAt: now },
          });
          if (update.count !== 1) return false;

          await transaction.checkoutRecoveryStatusHistory.create({
            data: {
              checkoutRecoveryId: candidate.id,
              fromStatus: candidate.status,
              toStatus: "EXPIRED",
              reason: "checkout-recovery-inactivity-expired",
              source: "ARCH-016",
              occurredAt: now,
            },
          });
          await transaction.recoveryOutreachAttempt.updateMany({
            where: {
              checkoutRecoveryId: candidate.id,
              OR: [
                { status: "PENDING" },
                { status: "WAITING_FOR_RESPONSE", sentAt: null },
              ],
            },
            data: { status: "CANCELLED", closedAt: now },
          });
          return true;
        });
        if (changed) expired += 1;
      }

      if (candidates.length < PAGE_SIZE) break;
    }

    return expired;
  }
}

export const checkoutRecoveryExpiryService = new CheckoutRecoveryExpiryService();