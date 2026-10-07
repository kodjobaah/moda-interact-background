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
