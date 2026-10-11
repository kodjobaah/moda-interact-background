import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";

export type RecoveryRecipientSuppression =
  | { kind: "allowed" }
  | { kind: "suppressed"; until: Date };

type SuppressionDatabase = Pick<
  PrismaClient,
  "whatsAppRecipientReachability" | "checkoutRecovery"
>;

export class RecoveryRecipientSuppressionAdmissionService {
  constructor(
    private readonly database: SuppressionDatabase = prisma,
  ) {}

  async evaluate(
    shopId: string,
    recipient: string,
    now = new Date(),
  ): Promise<RecoveryRecipientSuppression> {
    const row = await this.database.whatsAppRecipientReachability.findUnique({
      where: { shopId_recipient: { shopId, recipient } },
      select: { suppressUntil: true },
    });
    if (!row?.suppressUntil || row.suppressUntil <= now) return { kind: "allowed" };
    return { kind: "suppressed", until: row.suppressUntil };
  }

  async deferDetectedRecovery(
    recoveryId: string,
    shopId: string,
    until: Date,
  ): Promise<boolean> {
    await recoveryCapacityResumeService.schedule(
      {
        shopId,
        recoveryId,
        trigger: `recipient-suppression-${recoveryId}-${until.getTime()}`,
      },
      until,
    );
    const blocked = await this.database.checkoutRecovery.updateMany({
      where: { id: recoveryId, status: "DETECTED" },
      data: {
        admissionBlockedAt: new Date(),
        admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED",
      },
    });
    if (blocked.count !== 1) return false;
    return true;
  }

  async clearDetectedSuppression(recoveryId: string): Promise<void> {
    await this.database.checkoutRecovery.updateMany({
      where: {
        id: recoveryId,
        status: "DETECTED",
        admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED",
      },
      data: { admissionBlockedAt: null, admissionBlockReason: null },
    });
  }
}

export const recoveryRecipientSuppressionAdmissionService =
  new RecoveryRecipientSuppressionAdmissionService();