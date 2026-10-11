import type { PrismaClient } from "@prisma/client";

export async function terminalizeUnrecoverableBlockedRecovery(
  database: PrismaClient,
  recoveryId: string,
  reason: string,
  allowUnblockedSuppressionWakeup = false,
): Promise<void> {
  await database.$transaction(async (transaction) => {
    const updated = await transaction.checkoutRecovery.updateMany({
      where: {
        id: recoveryId,
        status: "DETECTED",
        ...(allowUnblockedSuppressionWakeup
          ? {
              OR: [
                { admissionBlockReason: null },
                { admissionBlockReason: { in: ["RECOVERY_CAPACITY_EXHAUSTED", "WHATSAPP_RECIPIENT_SUPPRESSED"] } },
              ],
            }
          : {
              admissionBlockReason: { in: ["RECOVERY_CAPACITY_EXHAUSTED", "WHATSAPP_RECIPIENT_SUPPRESSED"] },
            }),
      },
      data: {
        status: "CANCELLED",
        expiredAt: new Date(),
        admissionBlockedAt: null,
        admissionBlockReason: null,
      },
    });
    if (updated.count === 1) {
      await transaction.checkoutRecoveryStatusHistory.create({
        data: {
          checkoutRecoveryId: recoveryId,
          fromStatus: "DETECTED",
          toStatus: "CANCELLED",
          reason,
          source: "recovery-capacity-resume",
        },
      });
    }
  });
}