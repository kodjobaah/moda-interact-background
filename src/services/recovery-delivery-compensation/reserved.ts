import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "../paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { requireLineage, type CompensationTransaction, type RecoverySource } from "./types.js";

/** Keep RESERVED release in its original accounting owner, inside the message lock. */
export async function releaseReservedSource(
  tx: CompensationTransaction, source: RecoverySource,
): Promise<"released"> {
  const { reservation, kind } = source;
  const values = {
    shopId: reservation.shopId,
    sourceKey: reservation.sourceKey,
    quantity: reservation.quantity,
  };
  const result = kind === "free"
    ? await freeRecoveryReservationService.releaseInExistingTransaction(tx, values)
    : kind === "paid"
      ? await paidIncludedRecoveryReservationService.releaseInExistingTransaction(tx, values)
      : kind === "promotional"
        ? await promotionalRecoveryReservationService.releaseInExistingTransaction(tx, values)
        : await purchasedRecoveryReservationService.releaseInExistingTransaction(tx, values);
  requireLineage(result.kind === "released", "source owner did not release reservation");
  return "released";
}
