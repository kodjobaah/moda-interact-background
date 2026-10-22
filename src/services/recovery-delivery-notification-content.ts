import { createHash } from "node:crypto";
import type { RecoveryDeliveryCompensationOutcome } from "./recovery-delivery-compensation/types.js";

/** BG009 may supply its durable HELD_FOR_REFUND outcome after purchased correction. */
export type NotifiableCorrection = RecoveryDeliveryCompensationOutcome | "held-for-refund";
export type CorrectedDisposition = Extract<NotifiableCorrection,
  "released" | "already-released" | "restored-spendable" |
  "historical-only" | "held-for-refund">;

export const RECOVERY_DELIVERY_FAILURE_SYSTEM_CODE = "ARCH028_RECOVERY_DELIVERY_FAILED";
export const RECOVERY_DELIVERY_FAILURE_SYSTEM_VERSION = "1";

/** Shop + recovery + immutable outbound message: not provider event/retry identity. */
export function recoveryDeliveryNoticeSourceKey(
  shopId: string, recoveryId: string, messageId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([shopId, recoveryId, messageId]))
    .digest("hex");
  return `arch028-recovery-delivery-failed:v1:${digest}`;
}

/** Platform-owned, bounded copy. Never interpolate provider text or a phone. */
export function recoveryDeliveryNoticeBody(
  correction: CorrectedDisposition, recipientSuppressed: boolean,
): string {
  const credit = {
    released: "The reserved recovery credit was released and was not charged.",
    "already-released": "The reserved recovery credit had already been released; no additional credit was charged.",
    "restored-spendable": "The recovery credit was restored and is available for another recovery.",
    "historical-only": "The recovery usage was corrected historically; no spendable credit was added to your current allowance.",
    "held-for-refund": "The recovery credit correction is held for refund; no spendable credit was added.",
  }[correction];
  const reachability = recipientSuppressed
    ? "Further recovery messages to this recipient have been temporarily paused."
    : "";
  return ["A checkout recovery WhatsApp message could not be delivered.", credit, reachability]
    .filter(Boolean).join(" ");
}
