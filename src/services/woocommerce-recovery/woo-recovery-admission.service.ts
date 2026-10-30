import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  recoveryPolicyService,
  type RecoveryPolicyService,
} from "../recovery-policy.service.js";
import {
  shopExecutionEligibilityService,
  type ShopExecutionEligibilityService,
} from "../shop-execution-eligibility.service.js";
import {
  wooRecoveryConsentReader,
  type WooRecoveryConsentReaderPort,
} from "../woocommerce-recovery-consent.service.js";
import type {
  WooAdmissionOutcome,
  WooCandidateManager,
  WooCheckoutCoordinator,
  WooCheckoutRef,
  WooObservedOrderStateReader,
  WooPendingCandidate,
  WooRecoveryAdmissionEvaluator,
} from "./contracts.js";
import { WooActivityWatermarkStore, type WooActivityWatermarkPort } from "./woo-activity-watermark.store.js";

import {
  anonymousId,
  confirmCurrentWooConsent,
  emailConflicts,
  sameAcceptedCandidate,
  SHOP_ID,
  SOURCE_ID,
  validActivity,
  validBasket,
  matchesAcceptedWatermark,
} from "./woo-recovery-admission-evidence.js";

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

/** Stable domain codes, never raw provider/DB reasons or recipient data. */
export type WooAdmissionDenialReason =
  | "INVALID_CANDIDATE"
  | "SHOP_NOT_ELIGIBLE"
  | "INSTALLATION_INACTIVE"
  | "BASKET_EMPTY"
  | "BASKET_INVALID"
  | "RECIPIENT_MISSING"
  | "RECIPIENT_INVALID"
  | "RECIPIENT_IDENTITY_MISMATCH"
  | "CONSENT_NOT_GRANTED"
  | "CONSENT_NO_CONTACT"
  | "CONSENT_AMBIGUOUS"
  | "CONSENT_RECIPIENT_UNVERIFIED"
  | "CONSENT_CHANGED";

/** ARCH-046-BACKGROUND-002 owns the implementation/idempotency of any Support notice. */
export type WooDeniedAdmission = Readonly<{
  shopId: string;
  checkoutToken: string;
  reason: WooAdmissionDenialReason;
}>;

/** Narrow DB boundary: no new schema and no Shopify-specific recovery helper. */
export type WooAdmissionDatabase = Pick<
  PrismaClient,
  "shop" | "wooCommerceInstallation" | "customer" | "checkoutRecovery" | "$transaction"
>;

export type WooRecoveryAdmissionDependencies = Readonly<{
  candidates: WooCandidateManager;
  orders: WooObservedOrderStateReader;
  coordinator: WooCheckoutCoordinator;
  database?: WooAdmissionDatabase;
  execution?: Pick<ShopExecutionEligibilityService, "evaluate">;
  policy?: Pick<RecoveryPolicyService, "resolve">;
  consent?: Pick<WooRecoveryConsentReaderPort, "evaluateRecipient">;
  /** Awaited, after the decision/transaction; a failed hook rejects the job. */
  onDeniedAdmission?: (denial: WooDeniedAdmission) => Promise<void>;
  logger?: StructuredLogger;
  watermarks?: Pick<WooActivityWatermarkPort, "read">;
  now?: () => Date;
}>;

type AdmissionHistory = { reason: string | null; source: string | null; toStatus: string; fromStatus: string | null; metadata: unknown };
type AdmissionRow = {
  id: string; status: string; generation: number; lastExternalActivityAt: Date;
  statusHistory: AdmissionHistory[];
};

function historyMetadata(history: AdmissionHistory): Record<string, unknown> | null {
  return history.metadata !== null && typeof history.metadata === "object" && !Array.isArray(history.metadata)
    ? history.metadata as Record<string, unknown> : null;
}

function admissionOrigin(row: AdmissionRow, candidate: WooPendingCandidate): boolean {
  return row.statusHistory.some((history) => {
    const metadata = historyMetadata(history);
    return history.fromStatus === null && history.toStatus === "DETECTED" &&
      history.source === "WOOCOMMERCE" &&
      (history.reason === "FIRST_MATURE_CHECKOUT_ADMISSION" || history.reason === "MATURE_CHECKOUT_REENTRY_ADMISSION") &&
      metadata?.generation === candidate.generation && metadata?.lastEventId === candidate.lastEventId;
  });
}

function resumedInto(row: AdmissionRow, generation: number): boolean {
  return row.status === "CANCELLED" && row.statusHistory.some((history) => {
    const metadata = historyMetadata(history);
    return history.reason === "CHECKOUT_RESUMED" && history.source === "woocommerce.checkout" &&
      Number.isSafeInteger(metadata?.nextGeneration) && metadata?.nextGeneration === generation;
  });
}

function isOrderLinked(row: AdmissionRow): boolean {
  return row.statusHistory.some((history) => history.source === "woocommerce.order");
}

function validateHistoryEvidence(row: AdmissionRow): void {
  for (const history of row.statusHistory) {
    if (history.reason === "CHECKOUT_RESUMED" && history.source === "woocommerce.checkout") {
      const metadata = historyMetadata(history);
      if (!metadata || !SOURCE_ID.test(String(metadata.eventId ?? "")) ||
        !Number.isSafeInteger(metadata.nextGeneration) || Number(metadata.nextGeneration) < 1) {
        throw new Error("Corrupt Woo checkout-resumption history metadata");
      }
    }
    if (history.source === "woocommerce.order") {
      const metadata = historyMetadata(history);
      if (!metadata || !SOURCE_ID.test(String(metadata.orderId ?? "")) ||
        !SOURCE_ID.test(String(metadata.eventId ?? "")) ||
        !["order-placed", "order-paid", "order-cancelled"].includes(String(metadata.orderKind))) {
        throw new Error("Corrupt Woo order history metadata");
      }
    }
  }
}

function consentReason(reason: string): WooAdmissionDenialReason {
  switch (reason) {
    case "LOCAL_NO_CONTACT": return "CONSENT_NO_CONTACT";
    case "WOO_MARKETING_CONSENT_NOT_GRANTED": return "CONSENT_NOT_GRANTED";
    case "RECIPIENT_SHARED_BY_CUSTOMERS":
    case "UNVERIFIED_LEGACY_RECIPIENTS": return "CONSENT_AMBIGUOUS";
    case "STALE_RECIPIENT_SNAPSHOT":
    case "CUSTOMER_IDENTITY_CHANGED":
    case "ACTIVE_RECIPIENT_CHANGED":
    case "WOO_INSTALLATION_CHANGED": return "CONSENT_CHANGED";
    case "WOO_SHOP_INACTIVE": return "SHOP_NOT_ELIGIBLE";
    case "WOO_INSTALLATION_INACTIVE": return "INSTALLATION_INACTIVE";
    default: return "CONSENT_RECIPIENT_UNVERIFIED";
  }
}

function isUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = error.meta?.target;
  return (Array.isArray(target) &&
    ["shopId", "checkoutToken", "generation"].every((key) => target.includes(key))) ||
    (typeof target === "string" && target.includes("CheckoutRecovery") &&
      target.includes("shopId") && target.includes("checkoutToken") && target.includes("generation"));
}

/**
 * BG003: admission only. This never creates Customer, attempt, conversation,
 * credit reservation, queue job or provider request. Order and candidate reads
 * describe events Moda received, NOT the live Woo checkout.
 */
export class WooRecoveryAdmissionService implements WooRecoveryAdmissionEvaluator {
  private readonly database: WooAdmissionDatabase;
  private readonly execution: Pick<ShopExecutionEligibilityService, "evaluate">;
  private readonly policy: Pick<RecoveryPolicyService, "resolve">;
  private readonly consent: Pick<WooRecoveryConsentReaderPort, "evaluateRecipient">;
  private readonly logger: StructuredLogger;
  private readonly watermarks: Pick<WooActivityWatermarkPort, "read">;
  private readonly now: () => Date;

  constructor(private readonly deps: WooRecoveryAdmissionDependencies) {
    this.database = deps.database ?? prisma;
    this.execution = deps.execution ?? shopExecutionEligibilityService;
    this.policy = deps.policy ?? recoveryPolicyService;
    this.consent = deps.consent ?? wooRecoveryConsentReader;
    this.logger = deps.logger ?? defaultLogger;
    this.watermarks = deps.watermarks ?? new WooActivityWatermarkStore();
    this.now = deps.now ?? (() => new Date());
  }

  async evaluateMatured(
    candidate: WooPendingCandidate,
    context: { jobId?: string } = {},
  ): Promise<WooAdmissionOutcome> {
    const fields = {
      operation: "evaluateMatured",
      ...(typeof candidate?.shopId === "string" && SHOP_ID.test(candidate.shopId)
        ? { shopId: candidate.shopId } : {}),
      ...(typeof candidate?.lastEventId === "string" ? { eventIdHash: anonymousId(candidate.lastEventId) } : {}),
      ...(Number.isSafeInteger(candidate?.generation) ? { generation: candidate.generation } : {}),
      ...(context.jobId ? { jobIdHash: anonymousId(context.jobId) } : {}),
    };
    try {
      const result = await this.evaluate(candidate);
      if (result.kind === "denied") {
        // Missing-consent notification is owned by ARCH-046-BACKGROUND-002.
        // Await a future adapter; its failures cannot be silently acknowledged.
        if (this.deps.onDeniedAdmission && SHOP_ID.test(candidate.shopId) && SOURCE_ID.test(candidate.checkoutToken)) {
          await this.deps.onDeniedAdmission({
            shopId: candidate.shopId,
            checkoutToken: candidate.checkoutToken,
            reason: result.reason as WooAdmissionDenialReason,
          });
        }
      }
      const logFields = {
        ...fields, stage: "evaluation", decision: result.kind, outcome: result.kind,
        ...(result.kind === "created" || result.kind === "already-exists"
          ? { recoveryId: result.recoveryId } : { reason: result.reason }),
      };
      if (result.kind === "deferred") {
        this.logger.warn("woocommerce.recovery.admission.deferred", logFields);
      } else {
        this.logger.info("woocommerce.recovery.admission.evaluated", logFields);
      }
      return result;
    } catch (error) {
      this.logger.error("woocommerce.recovery.admission.failed", {
        ...fields, stage: "evaluation", decision: "retryable_error", outcome: "failed", reason: "unexpected_error",
        errorType: error instanceof Prisma.PrismaClientKnownRequestError
          ? "PrismaClientKnownRequestError" : error instanceof Error ? "Error" : "UnknownError",
      });
      throw error;
    }
  }

  private async evaluate(
    candidate: WooPendingCandidate,
  ): Promise<WooAdmissionOutcome> {
    if (!candidate || candidate.source !== "woocommerce" ||
      !SHOP_ID.test(candidate.shopId) || !SOURCE_ID.test(candidate.checkoutToken) ||
      !SOURCE_ID.test(candidate.lastEventId) || !validActivity(candidate.lastActivityAt) ||
      !Number.isSafeInteger(candidate.generation) || (candidate.generation ?? 0) < 1) {
      return { kind: "denied", reason: "INVALID_CANDIDATE" };
    }
    const generation = candidate.generation!;
    if (candidate.basket?.kind === "empty") return { kind: "denied", reason: "BASKET_EMPTY" };
    if (!validBasket(candidate.basket)) {
      return candidate.basket?.kind === "unknown"
        ? { kind: "deferred", reason: "BASKET_EVIDENCE_UNKNOWN" }
        : { kind: "denied", reason: "BASKET_INVALID" };
    }
    const ref: WooCheckoutRef = { shopId: candidate.shopId, checkoutToken: candidate.checkoutToken };
    return this.deps.coordinator.withCheckoutLock<WooAdmissionOutcome>(ref, async (): Promise<WooAdmissionOutcome> => {
      const [shop, installation, eligibility] = await Promise.all([
        this.database.shop.findUnique({
          where: { id: ref.shopId },
          select: { id: true, platform: true, status: true, onboardingCompleted: true, defaultCountryCode: true },
        }),
        this.database.wooCommerceInstallation.findUnique({
          where: { shopId: ref.shopId },
          select: { id: true, status: true, revokedAt: true, credentialVersion: true },
        }),
        this.execution.evaluate(ref.shopId, undefined, "recovery"),
      ]);
      if (!shop || shop.id !== ref.shopId || shop.platform !== "WOOCOMMERCE" || shop.status !== "ACTIVE" ||
        !shop.onboardingCompleted || !eligibility.allowed) {
        return { kind: "denied", reason: "SHOP_NOT_ELIGIBLE" };
      }
      if (!installation || installation.status !== "ACTIVE" || installation.revokedAt) {
        return { kind: "denied", reason: "INSTALLATION_INACTIVE" };
      }

      // A removed job/index is not evidence of no recovery. Exact admission
      // history is the only basis for repairing the INSERT→enqueue gap.
      const prior = await this.findLatest(ref);
      if (prior) {
        const classification = this.classifyPrior(prior, candidate);
        if (classification) return classification;
      } else if (generation !== 1) {
        return { kind: "superseded", reason: "GENERATION_GAP" };
      }

      const latest = await this.deps.candidates.getPending(ref, generation);
      if (!latest) return { kind: "deferred", reason: "CANDIDATE_NOT_AVAILABLE" };
      if (!sameAcceptedCandidate(candidate, latest)) {
        return { kind: "superseded", reason: "EVENT_WATERMARK_CHANGED" };
      }
      if (!matchesAcceptedWatermark(candidate, await this.watermarks.read(ref))) {
        return { kind: "superseded", reason: "ACTIVITY_WATERMARK_CHANGED" };
      }

      const policy = await this.policy.resolve(ref.shopId, this.now());
      const activity = validActivity(candidate.lastActivityAt)!;
      const clock = this.now();
      if (activity.getTime() > clock.getTime()) {
        return { kind: "deferred", reason: "ACTIVITY_IN_FUTURE" };
      }
      if (clock.getTime() - activity.getTime() < policy.recoveryDelayMinutes * 60_000) {
        return { kind: "deferred", reason: "CANDIDATE_NOT_MATURE" };
      }

      const observedOrder = await this.deps.orders.read(ref);
      if (observedOrder.kind === "ambiguous") return { kind: "deferred", reason: "ORDER_EVIDENCE_AMBIGUOUS" };
      if (observedOrder.kind !== "none-observed") {
        return { kind: "superseded", reason: "ORDER_EVENT_OBSERVED" };
      }

      if (candidate.basket?.kind === "empty") return { kind: "denied", reason: "BASKET_EMPTY" };
      if (!validBasket(candidate.basket)) {
        return candidate.basket?.kind === "unknown" &&
          ["items-omitted", "conflicting-events", "incomplete-snapshot"].includes(candidate.basket.reason)
          ? { kind: "deferred", reason: "BASKET_EVIDENCE_UNKNOWN" }
          : { kind: "denied", reason: "BASKET_INVALID" };
      }
      const checkout = candidate.basket.checkout;
      const recipient = checkout.contact?.phone;
      if (!recipient) return { kind: "denied", reason: "RECIPIENT_MISSING" };
      const canonical = normalizeRecipientPhone(recipient, recipient.trim().startsWith("+")
        ? {} : shop.defaultCountryCode ? { verifiedCountryCode: shop.defaultCountryCode.toUpperCase() } : {});
      if (!canonical.ok) return { kind: "denied", reason: "RECIPIENT_INVALID" };

      const consent = await this.consent.evaluateRecipient({
        context: { kind: "JOB", shopId: ref.shopId }, recipient,
      });
      if (consent.status === "UNAVAILABLE") return { kind: "deferred", reason: "CONSENT_UNAVAILABLE" };
      if (consent.status === "AMBIGUOUS") return { kind: "denied", reason: "CONSENT_AMBIGUOUS" };
      if (consent.status === "NOT_AUTHORISED") {
        return { kind: "denied", reason: consentReason(consent.reason) };
      }
      // The denial type groups several statuses in one union member; testing
      // each denied value does not narrow that member to the ALLOWED variant.
      if (consent.status !== "ALLOWED") {
        throw new Error("Unexpected Woo consent eligibility status");
      }
      const snapshot = consent.snapshot;
      if (snapshot.shopId !== ref.shopId || snapshot.installationId !== installation.id ||
        snapshot.credentialVersion !== installation.credentialVersion ||
        consent.canonicalRecipient !== canonical.e164.slice(1) ||
        snapshot.canonicalRecipient !== consent.canonicalRecipient ||
        consent.customerPhoneId !== snapshot.customerPhoneId ||
        consent.consentRevision !== snapshot.consentRevision ||
        consent.noContactRevision !== snapshot.noContactRevision) {
        return { kind: "denied", reason: "RECIPIENT_IDENTITY_MISMATCH" };
      }

      const customer = await this.database.customer.findUnique({
        where: { id: snapshot.customerId }, select: { id: true, shopId: true, email: true },
      });
      if (!customer || customer.shopId !== ref.shopId ||
        emailConflicts(checkout.contact?.email, customer.email)) {
        return { kind: "denied", reason: "RECIPIENT_IDENTITY_MISMATCH" };
      }

      // No Redis/network operation inside this transaction. The shared checkout
      // lock excludes BG001/002, while PostgreSQL's unique key handles competing
      // or expired leases. A SHARE row lock fences concurrent STOP/revocation.
      const stillLatest = await this.deps.candidates.getPending(ref, generation);
      if (!stillLatest || !sameAcceptedCandidate(candidate, stillLatest)) {
        return { kind: "superseded", reason: "EVENT_WATERMARK_CHANGED" };
      }
      if (!matchesAcceptedWatermark(candidate, await this.watermarks.read(ref))) {
        return { kind: "superseded", reason: "ACTIVITY_WATERMARK_CHANGED" };
      }
      const terminalNow = await this.deps.orders.read(ref);
      if (terminalNow.kind === "ambiguous") return { kind: "deferred", reason: "ORDER_EVIDENCE_AMBIGUOUS" };
      if (terminalNow.kind !== "none-observed") {
        return { kind: "superseded", reason: "ORDER_EVENT_OBSERVED" };
      }

      const result: WooAdmissionOutcome = await this.database.$transaction(
        async (tx): Promise<WooAdmissionOutcome> => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "commerce"."CheckoutRecovery"
          WHERE "shopId" = ${ref.shopId} AND "checkoutToken" = ${ref.checkoutToken}
          ORDER BY "generation" DESC, "id" DESC LIMIT 1 FOR UPDATE
        `);
        const existing = await this.findLatest(tx, ref);
        if (existing) {
          const classification = this.classifyPrior(existing, candidate);
          if (classification) return classification;
        } else if (generation !== 1) {
          return { kind: "superseded", reason: "GENERATION_GAP" };
        }

        if (!await confirmCurrentWooConsent(tx, ref.shopId, snapshot, checkout.contact?.email)) {
          return { kind: "denied", reason: "CONSENT_CHANGED" };
        }

        const recovery = await tx.checkoutRecovery.create({
          data: {
            shopId: ref.shopId,
            checkoutToken: ref.checkoutToken,
            generation,
            status: "DETECTED",
            cartToken: null,
            customerId: snapshot.customerId,
            currency: checkout.currency,
            totalPrice: new Prisma.Decimal(checkout.total),
            checkoutUrl: null, // No Woo restore URL in the authenticated wire contract.
            lineItems: checkout.items.map((item) => ({
              productId: item.productId ?? null,
              variantId: item.variationId ?? null,
              sku: item.sku ?? null,
              title: item.title ?? null,
              quantity: item.quantity,
              price: item.unitPrice ?? null,
              total: item.total ?? null,
            })),
            detectedAt: clock,
            lastExternalActivityAt: activity,
          },
          select: { id: true },
        });
        await tx.checkoutRecoveryStatusHistory.create({
          data: {
            checkoutRecoveryId: recovery.id,
            fromStatus: null,
            toStatus: "DETECTED",
            source: "WOOCOMMERCE",
            reason: generation === 1 ? "FIRST_MATURE_CHECKOUT_ADMISSION" : "MATURE_CHECKOUT_REENTRY_ADMISSION",
            metadata: { generation, lastEventId: candidate.lastEventId },
            occurredAt: clock,
          },
        });
        return { kind: "created", recoveryId: recovery.id, generation };
        },
      );
      return result;
    }).catch(async (error: unknown) => {
      if (!isUniqueConflict(error)) throw error;
      // Recover ONLY a proven CheckoutRecovery unique collision. A different
      // P2002 target remains a real failure, not a fabricated success.
      const raced = await this.findLatest(ref);
      if (!raced) throw error;
      const classified = this.classifyPrior(raced, candidate);
      if (!classified || classified.kind !== "already-exists") throw error;
      return classified;
    });
  }

  private async findLatest(
    database: Pick<PrismaClient, "checkoutRecovery"> | Prisma.TransactionClient,
    ref: WooCheckoutRef,
  ): Promise<AdmissionRow | null>;
  private async findLatest(ref: WooCheckoutRef): Promise<AdmissionRow | null>;
  private async findLatest(
    databaseOrRef: Pick<PrismaClient, "checkoutRecovery"> | Prisma.TransactionClient | WooCheckoutRef,
    maybeRef?: WooCheckoutRef,
  ): Promise<AdmissionRow | null> {
    const database = maybeRef ? databaseOrRef as Pick<PrismaClient, "checkoutRecovery"> | Prisma.TransactionClient : this.database;
    const ref = maybeRef ?? databaseOrRef as WooCheckoutRef;
    return database.checkoutRecovery.findFirst({
      where: { shopId: ref.shopId, checkoutToken: ref.checkoutToken },
      orderBy: [{ generation: "desc" }, { id: "desc" }],
      select: { id: true, status: true, generation: true, lastExternalActivityAt: true,
        statusHistory: { where: { OR: [
          { toStatus: "DETECTED" }, { reason: "CHECKOUT_RESUMED", source: "woocommerce.checkout" },
          { source: "woocommerce.order" },
        ] }, select: { fromStatus: true, toStatus: true, source: true, reason: true, metadata: true },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 32 },
      },
    }) as Promise<AdmissionRow | null>;
  }

  private classifyPrior(row: AdmissionRow, candidate: WooPendingCandidate): WooAdmissionOutcome | null {
    const generation = candidate.generation!;
    validateHistoryEvidence(row);
    if (generation < row.generation) return { kind: "superseded", reason: "GENERATION_SUPERSEDED" };
    if (generation === row.generation) {
      if (!admissionOrigin(row, candidate)) return { kind: "superseded", reason: "ADMISSION_PROVENANCE_MISMATCH" };
      if (row.status === "DETECTED") {
        return { kind: "already-exists", recoveryId: row.id, status: row.status,
          generation, repairInitial: true };
      }
      if (row.status === "MESSAGE_SENT" || row.status === "ENGAGED") {
        return { kind: "already-exists", recoveryId: row.id, status: row.status,
          generation, repairInitial: false };
      }
      return { kind: "superseded", reason: "GENERATION_TERMINAL" };
    }
    if (generation !== row.generation + 1) return { kind: "superseded", reason: "GENERATION_GAP" };
    if (row.status === "CANCELLED" && resumedInto(row, generation)) return null;
    const activity = validActivity(candidate.lastActivityAt)!;
    if (row.status === "EXPIRED" && !isOrderLinked(row) && activity > row.lastExternalActivityAt) return null;
    if (["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(row.status)) {
      return { kind: "deferred", reason: "PRIOR_GENERATION_ACTIVE" };
    }
    return { kind: "superseded", reason: "PRIOR_GENERATION_NOT_REENTERABLE" };
  }
}
