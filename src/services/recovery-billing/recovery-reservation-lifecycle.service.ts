import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "../paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import type {
  RecoveryBillingAdmission,
  RecoveryProviderFailureDisposition,
} from "./recovery-billing.types.js";

type FreeReservationLifecycleService = Pick<
  typeof freeRecoveryReservationService,
  "commit" | "release" | "markAmbiguous"
>;
type PurchasedReservationLifecycleService = Pick<
  typeof purchasedRecoveryReservationService,
  "commit" | "release" | "markAmbiguous"
>;
type PaidIncludedReservationLifecycleService = Pick<
  typeof paidIncludedRecoveryReservationService,
  "commit" | "release" | "markAmbiguous"
>;
type PromotionalReservationLifecycleService = Pick<
  typeof promotionalRecoveryReservationService,
  "commit" | "release" | "markAmbiguous"
>;

export class RecoveryReservationLifecycleService {
  constructor(
    private readonly freeReservationService: FreeReservationLifecycleService = freeRecoveryReservationService,
    private readonly purchasedReservationService: PurchasedReservationLifecycleService = purchasedRecoveryReservationService,
    private readonly paidIncludedReservationService: PaidIncludedReservationLifecycleService = paidIncludedRecoveryReservationService,
    private readonly promotionalReservationService: PromotionalReservationLifecycleService = promotionalRecoveryReservationService,
  ) {}

  async commit(input: {
    admission: RecoveryBillingAdmission;
    occurredAt: Date;
  }): Promise<void> {
    const { admission } = input;

    if (admission.kind === "promotional") {
      await this.promotionalReservationService.commit({
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
        planId: admission.policy.planId,
      });
      return;
    }

    if (admission.kind === "free" || admission.kind === "lifetime-free") {
      await this.freeReservationService.commit({
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
      });
      return;
    }

    if (admission.kind === "purchased") {
      await this.purchasedReservationService.commit({
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
      });
      return;
    }

    await this.paidIncludedReservationService.commit({
      shopId: admission.policy.shopId,
      sourceKey: admission.sourceKey,
      occurredAt: input.occurredAt,
    });
  }

  async handleProviderFailure(input: {
    admission: RecoveryBillingAdmission;
    error: unknown;
  }): Promise<RecoveryProviderFailureDisposition> {
    const disposition = isDefinitiveProviderFailure(input.error)
      ? "definitive"
      : "ambiguous";

    await this.applyProviderFailureDisposition(input.admission, disposition);
    return disposition;
  }

  async release(admission: RecoveryBillingAdmission): Promise<void> {
    if (admission.kind === "promotional") {
      await this.promotionalReservationService.release({
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
        planId: admission.policy.planId,
      });
      return;
    }

    const reservationInput = {
      shopId: admission.policy.shopId,
      sourceKey: admission.sourceKey,
    };

    if (admission.kind === "purchased") {
      await this.purchasedReservationService.release(reservationInput);
      return;
    }
    if (admission.kind === "paid") {
      await this.paidIncludedReservationService.release(reservationInput);
      return;
    }

    await this.freeReservationService.release(reservationInput);
  }

  private async applyProviderFailureDisposition(
    admission: RecoveryBillingAdmission,
    disposition: RecoveryProviderFailureDisposition,
  ): Promise<void> {
    if (admission.kind === "promotional") {
      const reservationInput = {
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
        planId: admission.policy.planId,
      };
      if (disposition === "definitive") {
        await this.promotionalReservationService.release(reservationInput);
      } else {
        await this.promotionalReservationService.markAmbiguous(reservationInput);
      }
      return;
    }

    const reservationInput = {
      shopId: admission.policy.shopId,
      sourceKey: admission.sourceKey,
    };

    if (admission.kind === "purchased") {
      if (disposition === "definitive") {
        await this.purchasedReservationService.release(reservationInput);
      } else {
        await this.purchasedReservationService.markAmbiguous(reservationInput);
      }
      return;
    }

    if (admission.kind === "paid") {
      if (disposition === "definitive") {
        await this.paidIncludedReservationService.release(reservationInput);
      } else {
        await this.paidIncludedReservationService.markAmbiguous(reservationInput);
      }
      return;
    }

    if (disposition === "definitive") {
      await this.freeReservationService.release(reservationInput);
    } else {
      await this.freeReservationService.markAmbiguous(reservationInput);
    }
  }
}

function isDefinitiveProviderFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "WhatsAppServiceError" &&
    "code" in error &&
    (error.code === "configuration-missing" ||
      error.code === "provider-rejected")
  );
}
