import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import {
  purchasedRecoveryReservationService,
  type PurchasedRecoveryReservationInput,
} from "../purchased-recovery-reservation.service.js";
import type { PostContractRecoveryPolicy } from "../post-contract-recovery-policy.service.js";
import type {
  RecoveryBillingAdmissionResult,
  RecoveryPolicy,
} from "./recovery-billing.types.js";

type FreeDurableCreditReservationService = Pick<
  typeof freeRecoveryReservationService,
  "reserve" | "reservePostContract"
>;
type PurchasedDurableCreditReservationService = Pick<
  typeof purchasedRecoveryReservationService,
  "reserve"
>;

export class RecoveryDurableCreditAdmissionService {
  constructor(
    private readonly freeReservationService: FreeDurableCreditReservationService = freeRecoveryReservationService,
    private readonly purchasedReservationService: PurchasedDurableCreditReservationService = purchasedRecoveryReservationService,
  ) {}

  async admitPurchased(input: {
    shopId: string;
    sourceKey: string;
    policy: RecoveryPolicy;
  }): Promise<RecoveryBillingAdmissionResult | null> {
    const reservationInput: PurchasedRecoveryReservationInput = {
      shopId: input.shopId,
      sourceKey: input.sourceKey,
    };
    const reservation =
      await this.purchasedReservationService.reserve(reservationInput);

    if (
      reservation.kind === "reserved" ||
      isOwnedBy(reservation, "PURCHASED_RECOVERY_CREDITS")
    ) {
      if (isAmbiguous(reservation) || isReleased(reservation)) {
        return { kind: "blocked", reason: "reservation-in-flight" };
      }
      return {
        kind: "admitted",
        admission: {
          kind: "purchased",
          sourceKey: reservationInput.sourceKey,
          policy: input.policy,
        },
      };
    }

    if (reservation.kind === "credits-exhausted") return null;

    if (isOwnedBy(reservation, "LIFETIME_FREE_RECOVERY_CREDITS")) {
      if (isAmbiguous(reservation)) {
        return { kind: "blocked", reason: "reservation-in-flight" };
      }
      if (isReleased(reservation)) {
        const reactivated = isPostContractRecoveryPolicy(input.policy)
          ? await this.freeReservationService.reservePostContract({
              shopId: input.shopId,
              sourceKey: input.sourceKey,
            })
          : await this.freeReservationService.reserve({
              shopId: input.shopId,
              sourceKey: input.sourceKey,
            });
        if (
          !isAdmittedReplay(reactivated, "LIFETIME_FREE_RECOVERY_CREDITS")
        ) {
          return { kind: "blocked", reason: "reservation-in-flight" };
        }
      }
      return {
        kind: "admitted",
        admission: {
          kind: "lifetime-free",
          sourceKey: input.sourceKey,
          policy: input.policy,
        },
      };
    }

    return { kind: "blocked", reason: "reservation-in-flight" };
  }

  async admitLifetimeFree(input: {
    shopId: string;
    sourceKey: string;
    policy: RecoveryPolicy;
    postContract?: boolean;
  }): Promise<RecoveryBillingAdmissionResult | null> {
    const reservation = input.postContract
      ? await this.freeReservationService.reservePostContract({
          shopId: input.shopId,
          sourceKey: input.sourceKey,
        })
      : await this.freeReservationService.reserve({
          shopId: input.shopId,
          sourceKey: input.sourceKey,
        });

    if (
      reservation.kind === "reserved" ||
      isOwnedBy(reservation, "LIFETIME_FREE_RECOVERY_CREDITS")
    ) {
      if (isAmbiguous(reservation) || isReleased(reservation)) {
        return { kind: "blocked", reason: "reservation-in-flight" };
      }
      return {
        kind: "admitted",
        admission: {
          kind: "lifetime-free",
          sourceKey: input.sourceKey,
          policy: input.policy,
        },
      };
    }

    if (reservation.kind === "allowance-exhausted") return null;
    if (reservation.kind === "paused") {
      return { kind: "blocked", reason: "paused" };
    }

    if (isOwnedBy(reservation, "PURCHASED_RECOVERY_CREDITS")) {
      if (isAmbiguous(reservation)) {
        return { kind: "blocked", reason: "reservation-in-flight" };
      }
      if (isReleased(reservation)) {
        const reactivated = await this.purchasedReservationService.reserve({
          shopId: input.shopId,
          sourceKey: input.sourceKey,
        });
        if (!isAdmittedReplay(reactivated, "PURCHASED_RECOVERY_CREDITS")) {
          return { kind: "blocked", reason: "reservation-in-flight" };
        }
      }
      return {
        kind: "admitted",
        admission: {
          kind: "purchased",
          sourceKey: input.sourceKey,
          policy: input.policy,
        },
      };
    }

    return { kind: "blocked", reason: "reservation-in-flight" };
  }
}

function isPostContractRecoveryPolicy(
  policy: RecoveryPolicy,
): policy is PostContractRecoveryPolicy {
  return "mode" in policy && policy.mode === "POST_CONTRACT_DURABLE_CREDITS";
}

function isOwnedBy(
  reservation: { kind: string; counter?: string },
  counter: "PURCHASED_RECOVERY_CREDITS" | "LIFETIME_FREE_RECOVERY_CREDITS",
): boolean {
  return "counter" in reservation && reservation.counter === counter;
}

function isAmbiguous(reservation: { kind: string }): boolean {
  return (
    reservation.kind === "ambiguous" ||
    reservation.kind === "already-ambiguous"
  );
}

function isReleased(reservation: { kind: string }): boolean {
  return (
    reservation.kind === "released" || reservation.kind === "already-released"
  );
}

function isAdmittedReplay(
  reservation: { kind: string; counter?: string },
  counter: "PURCHASED_RECOVERY_CREDITS" | "LIFETIME_FREE_RECOVERY_CREDITS",
): boolean {
  return (
    isOwnedBy(reservation, counter) &&
    (reservation.kind === "reserved" ||
      reservation.kind === "already-reserved" ||
      reservation.kind === "already-committed")
  );
}
