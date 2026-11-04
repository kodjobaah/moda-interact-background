import type { EffectiveBillingPolicy } from "../effective-billing-policy.service.js";
import type { PostContractRecoveryPolicy } from "../post-contract-recovery-policy.service.js";

export type RecoveryPolicy =
  | EffectiveBillingPolicy
  | PostContractRecoveryPolicy;

export type RecoveryBillingAdmission =
  | {
      kind: "free";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "paid";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "purchased";
      sourceKey: string;
      policy: RecoveryPolicy;
    }
  | {
      kind: "promotional";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "lifetime-free";
      sourceKey: string;
      policy: RecoveryPolicy;
    };

export type RecoveryBillingAdmissionResult =
  | { kind: "admitted"; admission: RecoveryBillingAdmission }
  | {
      kind: "blocked";
      reason:
        | "paused"
        | "capacity-exhausted"
        | "reservation-in-flight"
        | "billing-period-closing"
        | "billing-period-reconciliation"
        | "contract-required"
        | "subscription-frozen"
        | "feature-unavailable";
    };

export type RecoveryProviderFailureDisposition = "definitive" | "ambiguous";

export type InitialOutreachCreditIdentity = {
  shopId: string;
  recoveryId: string;
  outreachAttemptId: string;
};

export type ConfirmedInitialOutreachCreditInput = InitialOutreachCreditIdentity & {
  outboundMessageId: string;
};

export type ExistingInitialOutreachCreditInput = InitialOutreachCreditIdentity & {
  outboundMessageId: string | null;
};

export type ConfirmedInitialOutreachSettlement =
  | {
      kind: "settled";
      disposition: "committed" | "already-committed";
      sourceKind: "free" | "paid" | "purchased" | "promotional";
      sourceKey: string;
      reservationId: string;
      committedUsageEventId: string;
      outboundMessageId: string;
      sentAt: Date;
    }
  | {
      kind: "held";
      reason:
        | "message-not-confirmed"
        | "lineage-conflict"
        | "reservation-ambiguous"
        | "reservation-released"
        | "reservation-compensated"
        | "paid-period-not-current"
        | "settlement-not-committed";
      reservationId?: string;
      sourceKey?: string;
    };

export type ExistingInitialOutreachCredit =
  | {
      kind: "admitted";
      admission: RecoveryBillingAdmission;
      reservationId: string;
    }
  | { kind: "absent" }
  | {
      kind: "held";
      reason:
        | "message-not-pre-permit"
        | "lineage-conflict"
        | "reservation-not-reserved"
        | "reservation-expired"
        | "source-policy-mismatch"
        | "paused"
        | "feature-unavailable"
        | "contract-required"
        | "subscription-frozen"
        | "paid-period-not-current";
      reservationId?: string;
      sourceKey?: string;
    };
