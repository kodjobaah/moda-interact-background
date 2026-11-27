import type { PrismaClient, RecoveryOutreachAttempt } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { connectionRedis } from "../../lib/redis.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { isInitialRetryId, isInitialOutreachIdentity, retryOutreachAttemptId } from "../../domain/recovery-outreach-identity.js";
import { WooCheckoutLeaseGuard, CheckoutOrderGuardService } from "../pending-recovery-candidate/checkout-order-guard.service.js";
import { WooOrderTerminalEvidenceStore } from "../woocommerce-recovery/woo-order-reconciliation.service.js";
import { createWooGuardedInitialSender } from "../woocommerce-recovery/woo-guarded-initial-sender.service.js";
import { wooRecoveryConsentReader } from "../woocommerce-recovery-consent.service.js";
import { recoveryStoredConsentService } from "../recovery-conversation/recovery-stored-consent.service.js";
import { lockRecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { isCanonicalRecoveryRecipient } from "../checkout-recovery/recovery-recipient-canonicalization.js";
import { recoveryRecipientResolverService } from "../checkout-recovery/recovery-recipient-resolver.service.js";
import { recoveryRecipientSuppressionAdmissionService } from "../checkout-recovery/recovery-recipient-suppression-admission.service.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";
import { automatedRecoveryTemplateService } from "../recovery-template-integration/automated-recovery-template.service.js";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import { recoveryBillingService } from "../recovery-billing.service.js";
import { RecoveryOutreachFinalizationService } from "../checkout-recovery/recovery-outreach-finalization.service.js";
import { InitialDeliveryRetryClaimService, listDueInitialRetryIntents } from "./claim.js";
import { checkInitialRetryPermit } from "./initial-permit.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";
import { releaseTerminalRetryCredit } from "./terminal-credit.js";
import { reclaimStrandedRetryCredit } from "./stranded-credit.js";
import { expectedInitialRetryDispatchKey } from "./provider-dispatch-key.js";

const logger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
type Database = Pick<PrismaClient, "$transaction" | "checkoutRecovery" | "recoveryOutreachAttempt" | "recoveryOutreachRetryIntent">;
type Scope = { shopId: string; recoveryId: string; outreachAttemptId: string };
type ExecutionResult = { kind: "held" | "failed"; reason: string } | { kind: "reconciled"; messageId: string };
const held = (reason: string): ExecutionResult => ({ kind: "held", reason });
const readRecovery = (db: Database, id: string) => db.checkoutRecovery.findUnique({ where: { id }, select: {
  id: true, shopId: true, checkoutToken: true, customerId: true, status: true, completedAt: true,
  shop: { select: { platform: true, status: true } }, conversation: { select: { id: true, languageTag: true } },
  customer: { select: { firstName: true } },
} });
type Recovery = NonNullable<Awaited<ReturnType<typeof readRecovery>>>;
type Attempt = RecoveryOutreachAttempt;
type Prepared = Extract<Awaited<ReturnType<typeof automatedRecoveryTemplateService.prepare>>, { kind: "prepared" }>;
type Progress = Awaited<ReturnType<typeof outboundWhatsAppAdmissionService.inspectInitialOutreachAdmission>>;

/** Existing owner services; no new agent, reservation model or transport. */
export function initialRetryExecutionPorts() {
  const orders = new WooOrderTerminalEvidenceStore(connectionRedis);
  return {
    checkoutLease: new WooCheckoutLeaseGuard(), shopifyOrders: new CheckoutOrderGuardService(), orders,
    wooSender: createWooGuardedInitialSender({ orders, logger }),
    wooConsent: wooRecoveryConsentReader, shopifyConsent: recoveryStoredConsentService,
    recipient: recoveryRecipientResolverService, suppression: recoveryRecipientSuppressionAdmissionService,
    execution: shopExecutionEligibilityService, policy: recoveryPolicyService, template: automatedRecoveryTemplateService,
    outbound: outboundWhatsAppAdmissionService, billing: recoveryBillingService,
    finalizer: new RecoveryOutreachFinalizationService(),
  };
}
type Ports = ReturnType<typeof initialRetryExecutionPorts>;

/** A retry intent is not a provider permit. Replay always inspects the exact
 * existing attempt first, including after cancellation or a terminal checkout.
 */
export class InitialDeliveryRetryExecutionService {
  constructor(private readonly db: Database = prisma, private readonly ports: Ports = initialRetryExecutionPorts(),
    private readonly log: StructuredLogger = logger, private readonly clock: () => Date = () => new Date()) {}

  async execute(intentId: string): Promise<ExecutionResult> {
    const attemptId = retryOutreachAttemptId(intentId);
    const fields: Record<string, unknown> = { retryIntentId: intentId, outreachAttemptId: attemptId };
    let stage = "load_owner";
    try {
      const pointer = await this.db.recoveryOutreachRetryIntent.findUnique({ where: { id: intentId }, select: {
        failedAttempt: { select: { checkoutRecoveryId: true } },
      } });
      if (!pointer) return this.outcome(fields, held("intent-missing"));
      const initial = await readRecovery(this.db, pointer.failedAttempt.checkoutRecoveryId);
      if (!initial?.conversation) return this.outcome(fields, held("owner-missing"));
      Object.assign(fields, { shopId: initial.shopId, checkoutRecoveryId: initial.id, conversationId: initial.conversation.id, platform: initial.shop.platform });
      stage = "checkout_lease";
      const result = await this.ports.checkoutLease.withCheckoutLock(initial.shopId, initial.checkoutToken, async () => {
        const recovery = await readRecovery(this.db, initial.id);
        if (!recovery?.conversation || recovery.shopId !== initial.shopId || recovery.checkoutToken !== initial.checkoutToken ||
            recovery.conversation.id !== initial.conversation!.id || !["SHOPIFY", "WOOCOMMERCE"].includes(recovery.shop.platform))
          return held("owner-changed");
        const scope = { shopId: recovery.shopId, recoveryId: recovery.id, outreachAttemptId: attemptId };
        stage = "inspect_progress";
        let attempt = await this.db.recoveryOutreachAttempt.findUnique({ where: { id: attemptId } });
        let progress: Progress = { kind: "absent" };
        if (attempt) {
          if (!isInitialOutreachIdentity(attempt) || attempt.checkoutRecoveryId !== recovery.id) return held("attempt-identity-conflict");
          progress = await this.ports.outbound.inspectInitialOutreachAdmission(scope);
          if (progress.kind !== "absent" && progress.kind !== "prepared") {
            stage = "reconcile_existing";
            return this.reconcile(scope, recovery, attempt, progress);
          }
        }
        // Both platforms may claim fresh retries. Provider-specific consent
        // and final-send fences remain authoritative; reconcile prior receipts first.
        stage = "policy_and_claim";
        const policy = await this.ports.policy.resolve(recovery.shopId);
        if (!attempt) {
          const claimed = await new InitialDeliveryRetryClaimService(this.db, this.clock, this.log).claim(intentId, policy);
          if (claimed.kind === "held") return held(claimed.reason);
          if (claimed.attemptId !== attemptId || claimed.recoveryId !== recovery.id || claimed.conversationId !== recovery.conversation.id)
            return held("claim-owner-conflict");
          attempt = await this.db.recoveryOutreachAttempt.findUnique({ where: { id: attemptId } });
          if (!attempt || !isInitialOutreachIdentity(attempt) || attempt.checkoutRecoveryId !== recovery.id) return held("claim-missing");
          progress = await this.ports.outbound.inspectInitialOutreachAdmission(scope);
          if (progress.kind !== "absent" && progress.kind !== "prepared") return this.reconcile(scope, recovery, attempt, progress);
        }
        stage = "checkout_and_consent";
        const first = await this.eligibility(scope, recovery, attempt);
        if (first.kind === "held") return first;
        stage = "offer_preparation";
        const selected = await this.ports.template.prepare({ ...scope, stage: "INITIAL", policy,
          conversationLanguageTag: null, customerFirstName: recovery.customer?.firstName ?? null });
        if (selected.kind !== "prepared") return held(`template:${selected.reason}`);
        // Never log payload, discount, customer phone, checkout URL or token.
        this.log.debug("recovery.delivery_retry.offer_revalidated", { ...fields, stage, outcome: "prepared" });
        stage = "credit_revalidation";
        const retained = await this.ports.billing.revalidateExistingInitialOutreach({ ...scope,
          outboundMessageId: progress.kind === "prepared" ? progress.message.id : null });
        if (retained.kind === "held") return held(`credit:${retained.reason}`);
        if (retained.kind === "absent" && progress.kind === "prepared") return held("prepared-credit-missing");
        // Re-evaluate order/consent/checkout and offer BEFORE reserving any new
        // credit. The platform SQL permit still owns the irreversible decision.
        stage = "final_preflight";
        const last = await this.eligibility(scope, recovery, attempt);
        if (last.kind === "held") return last;
        if (selected.admissionToken && !await this.ports.template.validateAdmission(selected.admissionToken, AbortSignal.timeout(15_000)))
          return held("offer-admission-stale");
        stage = "funding";
        const funded = retained.kind === "admitted" ? retained : await this.ports.billing.admit(scope);
        if (funded.kind === "blocked") return held(`credit:${funded.reason}`);
        stage = "dispatch";
        // Billing can wait on another worker. Check the short-lived offer
        // admission again before dispatch. A stale result is held, not sent.
        if (selected.admissionToken && !await this.ports.template.validateAdmission(selected.admissionToken, AbortSignal.timeout(15_000)))
          return held("offer-admission-stale-after-funding");
        try {
          const dispatched = await this.dispatch(scope, recovery, attempt, selected, funded.admission.sourceKey, progress, last);
          if (dispatched.kind === "suppressed") this.log.debug("recovery.delivery_retry.dispatch_held", { ...fields, stage, reason: dispatched.reason });
        } catch (error) {
          // The provider owner has persisted the definitive outcome where
          // possible. Never turn an unknown HTTP outcome into a new send.
          this.log.error("recovery.delivery_retry.execution_failed", { ...fields, stage, sourceError: initialOutreachDiagnostic(error) });
          try {
            const after = await this.ports.outbound.inspectInitialOutreachAdmission(scope);
            if (after.kind === "failed") await releaseTerminalRetryCredit(this.db, scope, recovery.conversation.id, after.message.id);
          } catch (reconcileError) {
            throw new AggregateError([error, reconcileError], "Retry dispatch and failure reconciliation failed", { cause: error });
          }
          throw error;
        }
        stage = "settlement";
        const after = await this.ports.outbound.inspectInitialOutreachAdmission(scope);
        return this.reconcile(scope, recovery, attempt, after);
      });
      return this.outcome(fields, result);
    } catch (error) {
      this.log.error("recovery.delivery_retry.execution_failed", { ...fields, stage, sourceError: initialOutreachDiagnostic(error) });
      throw error;
    }
  }

  /** A durable keyset page. Advance through held/failed historical intents so
   * they cannot starve newer due work. A later sweep starts at the beginning. */
  async runDuePage(input: { limit: number; after?: { notBeforeAt: Date; id: string } }) {
    const candidates = await listDueInitialRetryIntents(this.db, { ...input, now: this.clock() }, this.log);
    const outcomes: Array<{ intentId: string; kind: ExecutionResult["kind"] | "error" }> = [];
    for (const candidate of candidates) {
      try { outcomes.push({ intentId: candidate.id, kind: (await this.execute(candidate.id)).kind }); }
      catch (error) {
        this.log.error("recovery.delivery_retry.sweep_item_failed", { retryIntentId: candidate.id, sourceError: initialOutreachDiagnostic(error) });
        outcomes.push({ intentId: candidate.id, kind: "error" });
      }
    }
    const last = candidates.at(-1);
    return { outcomes, next: candidates.length === input.limit && last?.notBeforeAt ? { id: last.id, notBeforeAt: last.notBeforeAt } : null };
  }

  /** Reconcile claimed retries even if their source intent was later cancelled.
   * This page never creates a new claim or sends an unconfirmed message. */
  async reconcileClaimedPage(input: { limit: number; afterId?: string }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 250) throw new RangeError("Invalid retry reconciliation page size");
    const attempts = await this.db.recoveryOutreachAttempt.findMany({ where: {
      id: { startsWith: "retry_", ...(input.afterId ? { gt: input.afterId } : {}) }, sequence: { gte: 3 }, trigger: "INITIAL",
    }, orderBy: { id: "asc" }, take: input.limit });
    const outcomes: Array<{ attemptId: string; kind: ExecutionResult["kind"] | "error" }> = [];
    for (const attempt of attempts) {
      try {
        if (!isInitialRetryId(attempt.id)) continue;
        const initial = await readRecovery(this.db, attempt.checkoutRecoveryId);
        if (!initial?.conversation) continue;
        // Use the same checkout lease as execute(). Re-read after acquisition;
        // the page is a discovery snapshot, not authority to settle or release.
        const result = await this.ports.checkoutLease.withCheckoutLock(initial.shopId, initial.checkoutToken, async () => {
          const recovery = await readRecovery(this.db, initial.id);
          const current = await this.db.recoveryOutreachAttempt.findUnique({ where: { id: attempt.id } });
          if (!recovery?.conversation || recovery.shopId !== initial.shopId || recovery.checkoutToken !== initial.checkoutToken ||
              recovery.conversation.id !== initial.conversation!.id || !current || !isInitialOutreachIdentity(current) ||
              current.checkoutRecoveryId !== recovery.id) return held("reconciliation-owner-changed");
          const scope = { shopId: recovery.shopId, recoveryId: recovery.id, outreachAttemptId: current.id };
          const progress = await this.ports.outbound.inspectInitialOutreachAdmission(scope);
          if (progress.kind === "confirmed" || (progress.kind === "failed" && current.outboundMessageId))
            return this.reconcile(scope, recovery, current, progress);
          if (progress.kind === "failed" && progress.disposition !== "pre-permit-refused")
            return held("reconciliation-unlinked-provider-failure");
          if (progress.kind === "held" && progress.reason === "provider-outcome-unknown") return held(progress.reason);
          if (!["PENDING", "CAPACITY_BLOCKED", "CANCELLED"].includes(current.status)) return held("reconciliation-no-pending-work");
          const cleanup = await reclaimStrandedRetryCredit(this.db, { ...scope, conversationId: recovery.conversation.id }, this.log);
          return held(cleanup.kind === "cancelled" ? "obsolete-retry-cancelled" : cleanup.reason);
        });
        this.outcome({ shopId: initial.shopId, checkoutRecoveryId: initial.id, conversationId: initial.conversation.id,
          outreachAttemptId: attempt.id, retryIntentId: attempt.id.slice("retry_".length) }, result);
        outcomes.push({ attemptId: attempt.id, kind: result.kind });
      } catch (error) {
        this.log.error("recovery.delivery_retry.reconciliation_failed", { outreachAttemptId: attempt.id,
          checkoutRecoveryId: attempt.checkoutRecoveryId, sourceError: initialOutreachDiagnostic(error) });
        outcomes.push({ attemptId: attempt.id, kind: "error" });
      }
    }
    return { outcomes, next: attempts.length === input.limit ? attempts.at(-1)!.id : null };
  }

  private async eligibility(scope: Scope, recovery: Recovery, attempt: Attempt) {
    if (!recovery.conversation || !recovery.customerId) return { kind: "held", reason: "recipient-owner-missing" } as const;
    const check = await this.db.$transaction(async tx => {
      const owner = await lockRecoveryContext(tx, recovery.conversation!.id);
      if (!owner || owner.shopId !== scope.shopId || owner.recoveryId !== scope.recoveryId)
        return { kind: "held", reason: "owner-changed" } as const;
      return checkInitialRetryPermit(tx, { shopId: scope.shopId, recoveryId: scope.recoveryId,
        conversationId: recovery.conversation!.id, attemptId: attempt.id, recipient: attempt.recipient, now: this.clock() }, this.log);
    });
    if (check.kind === "held") return check;
    const execution = await this.ports.execution.evaluate(scope.shopId, recovery.shop.status, "recovery");
    if (!execution.allowed) return { kind: "held", reason: execution.reason } as const;
    const expectedRecipient = attempt.recipient.replace(/^\+/, "");
    // Woo has its own consent/recipient authority; the Shopify selector
    // requires SHOPIFY_NATIVE evidence and must not be used for Woo.
    const recipient = recovery.shop.platform === "WOOCOMMERCE" ? expectedRecipient
      : await this.ports.recipient.resolveForCustomerInShop(recovery.customerId, recovery.shopId);
    if (!isCanonicalRecoveryRecipient(recipient) || recipient !== expectedRecipient) return { kind: "held", reason: "recipient-changed" } as const;
    if ((await this.ports.suppression.evaluate(recovery.shopId, recipient, this.clock())).kind !== "allowed")
      return { kind: "held", reason: "recipient-suppressed" } as const;
    if (recovery.shop.platform === "WOOCOMMERCE") {
      if ((await this.ports.orders.read({ shopId: scope.shopId, checkoutToken: recovery.checkoutToken })).kind !== "none-observed")
        return { kind: "held", reason: "woo-observed-order-terminal" } as const;
      const consent = await this.ports.wooConsent.evaluateStoredRecipient({ shopId: scope.shopId, customerId: recovery.customerId, recipient: `+${recipient}` });
      if (consent.status !== "ALLOWED" || consent.canonicalRecipient !== recipient) return { kind: "held", reason: "woo-consent-unavailable" } as const;
      return { kind: "ready", platform: "WOOCOMMERCE", consent: consent.snapshot } as const;
    }
    if (await this.ports.shopifyOrders.hasOrderProcessed(scope.shopId, recovery.checkoutToken)) return { kind: "held", reason: "shopify-observed-order-terminal" } as const;
    const consent = await this.ports.shopifyConsent.preflight({ shopId: scope.shopId, recoveryId: scope.recoveryId, recipient });
    if (consent.kind !== "allowed" || !consent.snapshot) return { kind: "held", reason: "shopify-consent-unavailable" } as const;
    return { kind: "ready", platform: "SHOPIFY" } as const;
  }

  private async dispatch(scope: Scope, recovery: Recovery, attempt: Attempt, selected: Prepared, sourceKey: string,
    progress: Extract<Progress, { kind: "absent" | "prepared" }>, eligibility: Extract<Awaited<ReturnType<InitialDeliveryRetryExecutionService["eligibility"]>>, { kind: "ready" }>) {
    const conversationId = recovery.conversation!.id;
    const idempotencyKey = `recovery-outreach:${attempt.id}`;
    if (eligibility.platform === "WOOCOMMERCE") {
      return this.ports.wooSender.sendInitial({ recovery, attemptId: attempt.id, conversationId, recipient: attempt.recipient,
        consent: eligibility.consent, idempotencyKey, recoveryCreditSourceKey: sourceKey, template: {
          name: selected.prepared.providerTemplateName, languageCode: selected.prepared.providerLanguageCode,
          canonicalLanguageTag: selected.prepared.canonicalLanguageTag, verifiedCategory: "MARKETING", sendFields: selected.send,
        } });
    }
    const admission = progress.kind === "prepared" ? { kind: "admitted" as const, messageId: progress.message.id }
      : await this.ports.outbound.reserve({ shopId: scope.shopId, conversationId, senderType: "AUTOMATION", idempotencyKey,
        recoveryCreditSourceKey: sourceKey, initialOutreach: scope });
    if (admission.kind !== "admitted") return admission;
    return this.ports.outbound.resumeInitialTemplate({ ...scope, messageId: admission.messageId,
      recoveryCreditSourceKey: sourceKey, template: { ...selected.send, to: attempt.recipient } });
  }

  private async reconcile(scope: Scope, recovery: Recovery, attempt: Attempt, progress: Progress): Promise<ExecutionResult> {
    if (progress.kind === "failed") {
      await releaseTerminalRetryCredit(this.db, scope, recovery.conversation!.id, progress.message.id);
      return { kind: "failed", reason: progress.disposition };
    }
    if (progress.kind !== "confirmed") return held(progress.kind === "held" ? progress.reason : "no-confirmed-receipt");
    const key = expectedInitialRetryDispatchKey(recovery.shop.platform, scope.shopId, attempt.id);
    if (!key || progress.message.providerDispatchKey !== key || !progress.message.providerDispatchAdmittedAt || progress.message.providerDispatchControlRevision === null ||
        progress.message.conversationId !== recovery.conversation?.id) return held("retry-provider-permit-mismatch");
    // Woo retains its initial-only policy. For Shopify persist the normal
    // follow-up deadline; scheduling remains in the existing finalizer.
    const policy = recovery.shop.platform === "SHOPIFY" && !attempt.outboundMessageId ? await this.ports.policy.resolve(scope.shopId) : undefined;
    const result = await this.ports.finalizer.finalizeConfirmedInitialOutreach({ recovery, attempt,
      message: progress.message, ...(policy ? { policy } : {}) });
    if (result.kind === "held") return held(`settlement:${result.reason}`);
    return { kind: "reconciled", messageId: result.outboundMessageId };
  }

  private outcome(fields: Record<string, unknown>, result: ExecutionResult) {
    if (result.kind === "reconciled") this.log.info("recovery.delivery_retry.execution_reconciled", { ...fields, outboundMessageId: result.messageId });
    else this.log.debug("recovery.delivery_retry.execution_held", { ...fields, outcome: result.kind, reason: result.reason });
    return result;
  }
}
