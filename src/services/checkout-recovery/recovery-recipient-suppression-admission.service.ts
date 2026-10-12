import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import prisma from "../../lib/db.js";
import { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";

export type RecoveryRecipientSuppression =
  | { kind: "allowed" }
  | { kind: "suppressed"; until: Date };

export const RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED =
  "RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED";
export const RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED =
  "RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED";

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
    wakeupTrigger?: string,
  ): Promise<boolean> {
    let current;
    try {
      current = await this.database.checkoutRecovery.findUnique({
        where: { id: recoveryId },
        select: { status: true, updatedAt: true },
      });
    } catch (error) {
      throw new Error(RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED, { cause: error });
    }
    try {
      const trigger = wakeupTrigger
        ? `recipient-suppression-${recoveryId}-${until.getTime()}-${createHash("sha256").update(wakeupTrigger).digest("hex").slice(0, 12)}`
        : `recipient-suppression-${recoveryId}-${until.getTime()}`;
      await recoveryCapacityResumeService.schedule(
        { shopId, recoveryId, trigger },
        until,
      );
    } catch (error) {
      throw new Error(RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED, { cause: error });
    }
    if (!current || current.status !== "DETECTED") return false;
    const blocked = await this.database.checkoutRecovery.updateMany({
      where: {
        id: recoveryId,
        status: "DETECTED",
        updatedAt: current.updatedAt,
      },
      data: {
        admissionBlockedAt: new Date(),
        admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED",
      },
    });
    if (blocked.count !== 1) return false;
    return true;
  }

  async clearDetectedSuppression(recoveryId: string): Promise<void> {
    const current = await this.database.checkoutRecovery.findUnique({
      where: { id: recoveryId },
      select: { status: true, admissionBlockReason: true, updatedAt: true },
    });
    if (
      !current ||
      current.status !== "DETECTED" ||
      ![null, "WHATSAPP_RECIPIENT_SUPPRESSED"].includes(current.admissionBlockReason)
    ) return;

    await this.database.checkoutRecovery.updateMany({
      where: {
        id: recoveryId,
        status: "DETECTED",
        updatedAt: current.updatedAt,
        OR: [
          { admissionBlockReason: null },
          { admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED" },
        ],
      },
      data: {
        admissionBlockedAt: null,
        admissionBlockReason: null,
        updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
      },
    });
  }
}

export const recoveryRecipientSuppressionAdmissionService =
  new RecoveryRecipientSuppressionAdmissionService();