import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "../paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import type {
  RecoveryBillingAdmission,
  RecoveryProviderFailureDisposition,
} from "./recovery-billing.types.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

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
    private readonly serviceLogger: StructuredLogger = logger,
  ) {}

  async commit(input: {
    admission: RecoveryBillingAdmission;
    occurredAt: Date;
  }): Promise<void> {
    const { admission } = input;
    const expected = {
      shopId: admission.policy.shopId,
      sourceKey: admission.sourceKey,
      sourceKind: admission.kind,
    };

    let outcome: unknown;
    try {
      if (admission.kind === "promotional") {
        outcome = await this.promotionalReservationService.commit({
          shopId: admission.policy.shopId,
          sourceKey: admission.sourceKey,
          planId: admission.policy.planId,
        });
      } else if (admission.kind === "free" || admission.kind === "lifetime-free") {
        outcome = await this.freeReservationService.commit({
          shopId: admission.policy.shopId,
          sourceKey: admission.sourceKey,
        });
      } else if (admission.kind === "purchased") {
        outcome = await this.purchasedReservationService.commit({
          shopId: admission.policy.shopId,
          sourceKey: admission.sourceKey,
        });
      } else {
        outcome = await this.paidIncludedReservationService.commit({
          shopId: admission.policy.shopId,
          sourceKey: admission.sourceKey,
          occurredAt: input.occurredAt,
        });
      }
      requireCommittedOutcome(outcome, expected);
    } catch (error) {
      this.serviceLogger.error("recovery.credit_commit.failed", {
        operation: "commitSuccessfulInitiation",
        ...expected,
        ...(readOutcomeContext(outcome)),
        error,
      });
      throw error;
    }
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

export class RecoveryCreditNotCommittedError extends Error {
  readonly sourceKind: RecoveryBillingAdmission["kind"];
  readonly shopId: string;
  readonly sourceKey: string;
  readonly outcomeKind: string | null;
  readonly reservationStatus: string | null;

  constructor(input: {
    sourceKind: RecoveryBillingAdmission["kind"];
    shopId: string;
    sourceKey: string;
    outcomeKind: string | null;
    reservationStatus: string | null;
  }) {
    super("Recovery reservation owner did not confirm a committed credit");
    this.name = "RecoveryCreditNotCommittedError";
    this.sourceKind = input.sourceKind;
    this.shopId = input.shopId;
    this.sourceKey = input.sourceKey;
    this.outcomeKind = input.outcomeKind;
    this.reservationStatus = input.reservationStatus;
  }
}

function requireCommittedOutcome(
  outcome: unknown,
  expected: {
    shopId: string;
    sourceKey: string;
    sourceKind: RecoveryBillingAdmission["kind"];
  },
): void {
  const record = typeof outcome === "object" && outcome !== null
    ? outcome as { kind?: unknown; reservation?: Record<string, unknown> }
    : undefined;
  const reservation = record?.reservation;
  const outcomeKind = typeof record?.kind === "string" ? record.kind : null;
  const reservationStatus = typeof reservation?.status === "string"
    ? reservation.status
    : null;
  const valid =
    (outcomeKind === "committed" || outcomeKind === "already-committed") &&
    reservationStatus === "COMMITTED" &&
    reservation?.shopId === expected.shopId &&
    reservation?.sourceKey === expected.sourceKey &&
    Number(reservation?.quantity) === 1 &&
    typeof reservation?.committedUsageEventId === "string" &&
    reservation.committedUsageEventId.length > 0;

  if (!valid) {
    throw new RecoveryCreditNotCommittedError({
      ...expected,
      outcomeKind,
      reservationStatus,
    });
  }
}

function readOutcomeContext(outcome: unknown): Record<string, unknown> {
  if (typeof outcome !== "object" || outcome === null) return {};
  const record = outcome as { kind?: unknown; reservation?: { status?: unknown } };
  return {
    ...(typeof record.kind === "string" ? { observedOutcome: record.kind } : {}),
    ...(typeof record.reservation?.status === "string"
      ? { observedStatus: record.reservation.status }
      : {}),
  };
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
