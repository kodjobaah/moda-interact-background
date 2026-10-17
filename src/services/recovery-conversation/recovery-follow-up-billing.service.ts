import {
  recoveryBillingService,
  type RecoveryBillingService,
  type RecoveryBillingAdmission,
  type RecoveryBillingAdmissionResult,
} from "../recovery-billing.service.js";

/** Thin bridge, not a second credit ledger. The shared sequence-two attempt ID
 * is always the source identity used by RecoveryBillingService.
 */
export class RecoveryFollowUpBillingService {
  constructor(private readonly billing: Pick<RecoveryBillingService,
    "admit" | "revalidateBeforeProvider" | "commitSuccessfulInitiation" |
    "handleProviderFailure" | "releaseBeforeProvider"> = recoveryBillingService) {}

  async admitAndRevalidate(input: {
    shopId: string; recoveryId: string; sequenceTwoAttemptId: string;
  }): Promise<RecoveryBillingAdmissionResult> {
    const admitted = await this.billing.admit({shopId: input.shopId,
      recoveryId: input.recoveryId, outreachAttemptId: input.sequenceTwoAttemptId});
    if (admitted.kind !== "admitted") return admitted;
    return this.billing.revalidateBeforeProvider({admission: admitted.admission,
      recoveryId: input.recoveryId, outreachAttemptId: input.sequenceTwoAttemptId});
  }

  async onConfirmedProviderSend(input: {admission: RecoveryBillingAdmission; recoveryId: string; occurredAt: Date}) {
    await this.billing.commitSuccessfulInitiation(input);
  }

  async onDefinitiveProviderFailure(input: {admission: RecoveryBillingAdmission; error: unknown}) {
    // Always let the existing lifecycle classify definitive vs ambiguous; the
    // caller must not release/compensate an unproven provider failure.
    return this.billing.handleProviderFailure(input);
  }

  releaseBeforePermit(admission: RecoveryBillingAdmission) {
    return this.billing.releaseBeforeProvider(admission);
  }
}
