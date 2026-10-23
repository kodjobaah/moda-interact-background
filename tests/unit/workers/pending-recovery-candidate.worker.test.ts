import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: { name: string; data: unknown; id: string; attemptsMade: number; failedReason: string }) => Promise<unknown>),
  materialize: vi.fn(async (_candidate?: unknown, _options?: unknown) => ({
    outcome: "discarded-shop-unavailable",
    checkoutToken: "checkout_1",
  })),
  cleanup: vi.fn(async () => undefined),
  durableRecovery: null as Record<string, unknown> | null,
  createRecovery: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    hoisted.durableRecovery ??= {
      ...data,
      id: "recovery-1",
      customerId: null,
      admissionBlockReason: null,
      updatedAt: new Date("2026-10-11T00:00:00.000Z"),
    };
    return hoisted.durableRecovery;
  }),
  updateRecoveryMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (hoisted.durableRecovery) {
      hoisted.durableRecovery = {
        ...hoisted.durableRecovery,
        ...data,
        updatedAt: new Date(Math.max(
          Date.now(),
          (hoisted.durableRecovery.updatedAt as Date).getTime() + 1,
        )),
      };
    }
    return { count: 1 };
  }),
  findLatestRecovery: vi.fn(async () => hoisted.durableRecovery),
  findRecovery: vi.fn(async () => hoisted.durableRecovery),
  suppressUntil: new Date(),
  findSuppression: vi.fn(async () => ({ suppressUntil: new Date("2026-10-12T00:00:00Z") })),
  scheduleResume: vi.fn(async () => "resume-job"),
  redis: {
    set: vi.fn(async () => "OK"),
    get: vi.fn(async () => "lock-owner"),
    del: vi.fn(async () => 1),
  },
  resolveCustomer: vi.fn(async () => null),
  resolvePolicy: vi.fn(async () => ({
    recoveryDelayMinutes: 30,
    recoveryOfferMode: "NONE",
    fixedShopifyDiscountId: null,
    followUpEnabled: false,
    followUpDelayMinutes: null,
    source: "MERCHANT",
    offerSnapshot: null,
  })),
  attemptGetOrCreate: vi.fn(async () => ({ id: "attempt-1" })),
  billingAdmit: vi.fn(async () => ({ kind: "admitted", admission: { kind: "paid", sourceKey: "recovery:test" } })),
  providerSend: vi.fn(async () => ({ kind: "admitted" })),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_queue: string, processor: typeof hoisted.processor) {
      hoisted.processor = processor ?? undefined;
    }

    on() {
      return this;
    }
  },
}));
vi.mock("@modainteract/moda-interact-shared/observability/bullmq", () => ({
  createBullMQTelemetry: vi.fn(() => ({})),
}));
vi.mock("../../../src/lib/redis.js", () => ({ connectionRedis: hoisted.redis }));
vi.mock("../../../src/lib/db.js", () => ({
  default: {
    shop: { findUniqueOrThrow: vi.fn(async () => ({ id: "shop_1" })) },
    checkoutRecovery: {
      create: hoisted.createRecovery,
      findFirst: hoisted.findLatestRecovery,
      findUnique: hoisted.findRecovery,
      updateMany: hoisted.updateRecoveryMany,
    },
    whatsAppRecipientReachability: { findUnique: hoisted.findSuppression },
  },
}));
vi.mock("../../../src/services/customer.service.js", () => ({
  customerService: { resolveCustomer: hoisted.resolveCustomer },
}));
vi.mock("../../../src/services/recovery-policy.service.js", () => ({
  recoveryPolicyService: { resolve: hoisted.resolvePolicy },
}));
vi.mock("../../../src/services/recovery-outreach-attempt.service.js", () => ({
  recoveryOutreachAttemptService: { getOrCreate: hoisted.attemptGetOrCreate },
}));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: {
    getProviderAccountId: vi.fn(() => "provider-1"),
    sendTemplate: hoisted.providerSend,
    findExistingAdmission: vi.fn(),
  },
}));
vi.mock("../../../src/services/recovery-capacity-resume.service.js", () => ({
  recoveryCapacityResumeService: { schedule: hoisted.scheduleResume },
}));
vi.mock("../../../src/observability/worker-metrics.js", () => ({
  observeWorkerJob: vi.fn(async (_definition, _job, callback) => callback()),
}));
vi.mock("../../../src/services/checkout-recovery.service.js", () => ({
  checkoutRecoveryService: {
    materializeMaturedCandidate: hoisted.materialize,
  },
}));
vi.mock("../../../src/services/pending-recovery-candidate.service.js", () => ({
  pendingRecoveryCandidateService: {
    handleCandidateMatured: hoisted.cleanup,
  },
}));
vi.mock("../../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: {
    current: vi.fn(() => ({ version: 1, pendingRecoveryQueueGlobalConcurrency: 10 })),
    subscribe: vi.fn(() => () => undefined),
  },
}));

import {
  EVALUATE_PENDING_RECOVERY_JOB,
} from "../../../src/domain/pending-recovery-candidate.js";
import { createPendingRecoveryCandidateWorker } from "../../../src/workers/pending-recovery-candidate.worker.js";
import { RecoveryMaterializationService } from "../../../src/services/checkout-recovery/recovery-materialization.service.js";
import { RecoveryInitiationService } from "../../../src/services/checkout-recovery/recovery-initiation.service.js";
import {
  RecoveryRecipientSuppressionAdmissionService,
  RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED,
  RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED,
} from "../../../src/services/checkout-recovery/recovery-recipient-suppression-admission.service.js";
import { findLatestRecovery } from "../../../src/services/checkout-recovery/latest-recovery.js";
import { CheckoutOrderGuardService } from "../../../src/services/pending-recovery-candidate/checkout-order-guard.service.js";

createPendingRecoveryCandidateWorker();

describe("pending recovery candidate worker", () => {
  beforeEach(() => {
    hoisted.durableRecovery = null;
    hoisted.createRecovery.mockClear();
    hoisted.updateRecoveryMany.mockClear();
    hoisted.findLatestRecovery.mockClear();
    hoisted.findRecovery.mockReset().mockImplementation(async () => hoisted.durableRecovery);
    hoisted.suppressUntil = new Date(Date.now() + 60 * 60_000);
    hoisted.findSuppression.mockReset().mockResolvedValue({
      suppressUntil: hoisted.suppressUntil,
    });
    hoisted.scheduleResume.mockReset().mockResolvedValue("resume-job");
    hoisted.scheduleResume.mockRejectedValueOnce(new Error("Redis temporarily unavailable"));
    hoisted.redis.set.mockReset().mockResolvedValue("OK");
    hoisted.redis.get.mockReset().mockResolvedValue("lock-owner");
    hoisted.redis.del.mockReset().mockResolvedValue(1);
    hoisted.resolveCustomer.mockReset().mockResolvedValue(null);
    hoisted.resolvePolicy.mockClear();
    hoisted.attemptGetOrCreate.mockClear();
    hoisted.billingAdmit.mockClear();
    hoisted.providerSend.mockClear();
    hoisted.materialize.mockReset().mockResolvedValue({
      outcome: "discarded-shop-unavailable",
      checkoutToken: "checkout_1",
    });
    hoisted.cleanup.mockClear();
  });

  it("cleans up an inactive matured candidate in finally", async () => {
    const job = {
      name: EVALUATE_PENDING_RECOVERY_JOB,
      id: "job-1",
      data: { shopId: "shop_1", checkoutToken: "checkout_1" },
      attemptsMade: 0,
      failedReason: "",
    };

    await hoisted.processor?.(job);

    expect(hoisted.materialize).toHaveBeenCalledWith(job.data, {
      jobId: job.id,
      retrySuppressionAdmission: false,
    });
    expect(hoisted.cleanup).toHaveBeenCalledWith(job.data, job.id);
  });

  it("retries a persisted DETECTED recovery after enqueue and version-read failures", async () => {
    const admission = new RecoveryRecipientSuppressionAdmissionService({
      whatsAppRecipientReachability: { findUnique: hoisted.findSuppression },
      checkoutRecovery: {
        findUnique: hoisted.findRecovery,
        updateMany: hoisted.updateRecoveryMany,
      },
    } as never);
    const billing = {
      admit: hoisted.billingAdmit,
      revalidateBeforeProvider: vi.fn(),
      releaseBeforeProvider: vi.fn(),
      handleProviderFailure: vi.fn(),
      commitSuccessfulInitiation: vi.fn(),
    } as never;
    const initiation = new RecoveryInitiationService(
      billing,
      { ensureScheduledInitialFollowUp: vi.fn() } as never,
      {
        upsertRecovery: (event, generation) => initiation.upsertRecovery(event, generation),
        resolveRecipient: (event) => event.customer.phone ?? "",
        markRecoveryCapacityBlocked: vi.fn(),
      },
      admission,
      // This is a recipient reachability/retry test. Keep verified consent
      // independent so the STOP/consent tests exercise real denial policy.
      {
        evaluateFirst: vi.fn(async () => true),
        evaluateReentry: vi.fn(async () => true),
        notifyMissingRecipient: vi.fn(async () => undefined),
      },
    );
    const freshCheckout = {
      createdAt: "2026-09-01T00:00:00.000Z",
      completedAt: null,
      currencyCode: "GBP",
      totalPrice: "42.00",
      abandonedCheckoutUrl: "https://checkout/current",
      customer: { shopifyCustomerId: null, phone: "15551234567", email: null, firstName: null, lastName: null },
      lineItems: [],
      internationalContext: null,
    };
    const checkoutOrderGuard = new CheckoutOrderGuardService();
    const materializer = new RecoveryMaterializationService({
      executionEligibility: { evaluate: vi.fn(async () => ({ allowed: true, shopId: "shop_1" })) },
      abandonedCheckoutLookup: {
        resolveShopDomain: vi.fn(async () => "shop.example"),
        lookup: vi.fn(async () => ({ kind: "found" as const, checkout: freshCheckout })),
      },
      pendingRecoveryCandidate: {
        withCheckoutLock: checkoutOrderGuard.withCheckoutLock.bind(checkoutOrderGuard),
        hasOrderProcessed: vi.fn(async () => false),
        findCandidateJobIdByCheckout: vi.fn(async () => "candidate-job-1"),
      },
      findLatestRecovery: (shopId, checkoutToken) => findLatestRecovery(shopId, checkoutToken),
      snapshotBuilder: {
        build: vi.fn(async () => ({
          shop: "shop.example",
          checkoutToken: "checkout_1",
          cartToken: "cart_1",
          detectedAt: "2026-09-01T00:00:00.000Z",
          currency: "GBP",
          totalPrice: "42.00",
          checkoutUrl: "https://checkout/current",
          completedAt: null,
          customer: freshCheckout.customer,
          lineItems: [],
        })),
      },
      recipientResolver: { resolve: vi.fn(async () => "15551234567") },
      initiate: (seed, generation, recipient) => initiation.handleCheckoutCreated(seed, generation, recipient),
    });
    hoisted.materialize.mockImplementation(async (candidate, options) =>
      materializer.materialize(candidate as never, options as never));

    const candidate = {
      shopId: "shop_1",
      shopDomain: "shop.example",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: "https://checkout/current",
      checkoutCreatedAt: "2026-09-01T00:00:00.000Z",
    };
    const firstJob = {
      name: EVALUATE_PENDING_RECOVERY_JOB,
      id: "candidate-job-1",
      data: candidate,
      attemptsMade: 0,
      failedReason: "",
    };
    // Reachability becomes suppressed only after the first admission gate,
    // allowing a DETECTED recovery to exist before the resume enqueue fails.
    hoisted.findSuppression
      .mockResolvedValueOnce({ suppressUntil: null })
      .mockResolvedValue({ suppressUntil: hoisted.suppressUntil });
    // hasOrderProcessed() is stubbed by this materialization fixture, so the
    // first Redis GET is the checkout-lock cleanup, not an order tombstone read.
    // Fail that GET; later cleanup during the retry can succeed normally.
    hoisted.redis.get.mockReset().mockResolvedValue(null)
      .mockRejectedValueOnce(new Error("Redis lock cleanup unavailable"));
    hoisted.cleanup.mockRejectedValueOnce(new Error("Redis candidate index cleanup unavailable"));

    let failedReason: string;
    try {
      await hoisted.processor?.(firstJob);
      throw new Error("Expected first candidate attempt to fail");
    } catch (error) {
      failedReason = error instanceof Error ? error.message : String(error);
    }
    expect(failedReason).toMatch(new RegExp(`^${RECIPIENT_SUPPRESSION_RESUME_ENQUEUE_FAILED}:`));
    expect(failedReason).toContain("checkout lock cleanup failed: Redis lock cleanup unavailable");
    expect(failedReason).toContain("candidate index cleanup unavailable");
    expect(hoisted.durableRecovery).toMatchObject({
      id: "recovery-1",
      status: "DETECTED",
      admissionBlockReason: null,
    });
    expect(hoisted.cleanup).toHaveBeenCalledWith(candidate, firstJob.id);

    const retryJob = {
      ...firstJob,
      attemptsMade: 1,
      failedReason,
    };
    await hoisted.processor?.(retryJob);

    expect(hoisted.materialize).toHaveBeenLastCalledWith(candidate, {
      jobId: firstJob.id,
      retrySuppressionAdmission: true,
    });
    expect(hoisted.createRecovery).toHaveBeenCalledTimes(2);
    expect(hoisted.createRecovery.mock.calls[1]?.[0].data.generation).toBe(
      hoisted.createRecovery.mock.calls[0]?.[0].data.generation,
    );
    expect(hoisted.scheduleResume).toHaveBeenCalledTimes(2);
    expect(hoisted.durableRecovery).toMatchObject({
      id: "recovery-1",
      status: "DETECTED",
      admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED",
    });
    expect(hoisted.attemptGetOrCreate).not.toHaveBeenCalled();
    expect(hoisted.billingAdmit).not.toHaveBeenCalled();
    expect(hoisted.providerSend).not.toHaveBeenCalled();

    hoisted.durableRecovery = null;
    hoisted.scheduleResume.mockReset().mockResolvedValue("resume-job");
    hoisted.cleanup.mockClear();
    hoisted.createRecovery.mockClear();
    hoisted.updateRecoveryMany.mockClear();
    const versionReadError = new Error("database version read unavailable");
    // A fresh first admission must be allowed before the stored
    // reachability changes to suppressed. Keep the order tombstone absent.
    hoisted.findSuppression
      .mockReset()
      .mockResolvedValueOnce({ suppressUntil: null })
      .mockResolvedValue({ suppressUntil: hoisted.suppressUntil });
    hoisted.redis.get.mockReset().mockResolvedValue(null);
    hoisted.findRecovery
      .mockReset()
      .mockRejectedValueOnce(versionReadError)
      .mockImplementation(async () => hoisted.durableRecovery);

    let versionReadFailure: unknown;
    try {
      await hoisted.processor?.(firstJob);
      throw new Error("Expected version read attempt to fail");
    } catch (error) {
      versionReadFailure = error;
    }

    expect(versionReadFailure).toMatchObject({
      message: RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED,
      cause: versionReadError,
    });
    expect(hoisted.scheduleResume).not.toHaveBeenCalled();
    expect(hoisted.updateRecoveryMany).not.toHaveBeenCalled();
    expect(hoisted.durableRecovery).toMatchObject({
      id: "recovery-1",
      status: "DETECTED",
      admissionBlockReason: null,
    });

    const versionReadRetryJob = {
      ...firstJob,
      attemptsMade: 1,
      failedReason: RECIPIENT_SUPPRESSION_ADMISSION_RETRY_REQUIRED,
    };
    await hoisted.processor?.(versionReadRetryJob);

    expect(hoisted.materialize).toHaveBeenLastCalledWith(candidate, {
      jobId: firstJob.id,
      retrySuppressionAdmission: true,
    });
    expect(hoisted.createRecovery).toHaveBeenCalledTimes(2);
    expect(hoisted.createRecovery.mock.calls[1]?.[0].data.generation).toBe(
      hoisted.createRecovery.mock.calls[0]?.[0].data.generation,
    );
    expect(hoisted.scheduleResume).toHaveBeenCalledOnce();
    expect(hoisted.scheduleResume).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryId: "recovery-1" }),
      hoisted.suppressUntil,
    );
    expect(hoisted.durableRecovery).toMatchObject({
      id: "recovery-1",
      status: "DETECTED",
      admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED",
    });
    expect(hoisted.attemptGetOrCreate).not.toHaveBeenCalled();
    expect(hoisted.billingAdmit).not.toHaveBeenCalled();
    expect(hoisted.providerSend).not.toHaveBeenCalled();
  });
});