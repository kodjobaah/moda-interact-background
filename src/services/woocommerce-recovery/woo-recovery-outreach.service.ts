import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { CheckoutRecoveryStatus, RecoveryOutreachStatus } from "@prisma/client";
import type { WooRecoveryConsentReaderPort, WooRecoveryConsentSnapshot } from "../woocommerce-recovery-consent.service.js";
import type { RecoveryBillingAdmission, RecoveryBillingService } from "../recovery-billing.service.js";
import type { RecoveryPolicySnapshot } from "../recovery-policy.service.js";
import type { CurrentOutreachOfferAdmissionToken } from "../recovery-offers/current-outreach-offer-revalidation.service.js";
import type { SendTemplateInput } from "../../integration/whatsapp/types.js";
import { WhatsAppServiceError } from "../whatsapp.service.js";
import type {
  WooCheckoutCoordinator,
  WooCheckoutRef,
  WooObservedOrderStateReader,
  WooRecoveryOutreachDispatcher,
  WooOutreachEnqueueOutcome,
  WooOutreachDispatchOutcome,
} from "./contracts.js";
import type {
  WooResumedAttemptSettlement,
  WooResumedSettlementPort,
} from "./woo-resumed-outreach-settlement.adapter.js";

/** A committed, trusted recovery row. Source is verified against its Shop, not inferred from a token. */
export type WooOutreachRecovery = Readonly<{
  id: string;
  shopId: string;
  checkoutToken: string;
  customerId: string | null;
  status: CheckoutRecoveryStatus;
  completedAt: Date | null;
  shop: { platform: string; status: string };
}>;

export type WooInitialAttempt = Readonly<{
  id: string;
  sequence: number;
  recipient: string;
  status: RecoveryOutreachStatus;
  sentAt: Date | null;
  outboundMessageId: string | null;
  followUpDueAt: Date | null;
}>;

export type WooConfirmedMessage = Readonly<{
  id: string;
  conversationId: string;
  status: "SENT" | "DELIVERED" | "READ";
  sentAt: Date;
}>;

type PersistedMessage = Readonly<{
  id: string;
  conversationId: string;
  status: string;
  sentAt: Date | null;
  providerFailureCode?: string | null;
}>;

export type WooMarketingTemplate = Readonly<{
  name: string;
  languageCode: string;
  canonicalLanguageTag: string;
  verifiedCategory: "MARKETING";
  /** Exact Admin-frozen transport payload plus BG006 final admission identity. */
  sendFields?: Omit<SendTemplateInput, "to">;
  admissionToken?: CurrentOutreachOfferAdmissionToken;
}>;

/**
 * The *only* provider port permitted for Woo. Its implementation must reuse the
 * accepted ARCH-046 final SQL consent/STOP fence AND the latest observed order
 * terminal fence in the SAME durable provider-admission decision. A preflight or
 * bare OutboundWhatsAppAdmissionService.sendTemplate is NOT this interface.
 * The uploaded snapshot does not contain that complete Woo final-send wiring,
 * so BG005 must supply the reviewed implementation; there is no unsafe default.
 */
export interface WooGuardedInitialSender {
  sendInitial(input: {
    recovery: WooOutreachRecovery;
    attemptId: string;
    conversationId: string;
    recipient: string;
    consent: WooRecoveryConsentSnapshot;
    template: WooMarketingTemplate;
    idempotencyKey: string;
    recoveryCreditSourceKey: string;
  }): Promise<{ kind: "admitted" } | { kind: "suppressed"; reason: string }>;
  findExistingAdmission(idempotencyKey: string): Promise<PersistedMessage | null>;
}

/** Each operation is a separately reviewable existing repository capability. */
export interface WooOutreachDependencies {
  recoveries: {
    get(recoveryId: string): Promise<WooOutreachRecovery | null>;
    currentRecipient(customerId: string, shopId: string): Promise<string | null>;
  };
  attempts: {
    findInitial(recoveryId: string): Promise<WooInitialAttempt | null>;
    getOrCreateInitial(input: {
      recoveryId: string;
      recipient: string;
      policy: RecoveryPolicySnapshot;
    }): Promise<WooInitialAttempt>;
    /** Only a provider-confirmed rejection or pre-permit denial can fail an attempt. */
    markFailed(attemptId: string, reason: string): Promise<void>;
  };
  coordinator: WooCheckoutCoordinator;
  orders: WooObservedOrderStateReader;
  consent: Pick<WooRecoveryConsentReaderPort, "evaluateStoredRecipient">;
  policies: { resolve(shopId: string): Promise<RecoveryPolicySnapshot> };
  templates: {
    select(shopId: string, recoveryId: string, attemptId: string, policy?: RecoveryPolicySnapshot): Promise<
      { kind: "selected"; template: WooMarketingTemplate } |
      { kind: "unavailable"; reason: string }
    >;
    validateAdmission(token: CurrentOutreachOfferAdmissionToken, signal: AbortSignal): Promise<boolean>;
  };
  conversations: { getOrCreate(recoveryId: string): Promise<{ id: string }> };
  billing: Pick<RecoveryBillingService,
    "admit" | "revalidateBeforeProvider" | "releaseBeforeProvider" | "commitSuccessfulInitiation">;
  providerFailure: {
    /** Existing billing disposition; keep special 131026 compensation with its owner. */
    compensate(admission: RecoveryBillingAdmission, error: unknown): Promise<void>;
    reconcileRecorded(input: {
      admission: RecoveryBillingAdmission;
      messageId: string;
      error: unknown;
    }): Promise<void>;
  };
  resumedSettlement: WooResumedSettlementPort;
  sender: WooGuardedInitialSender;
  finalize: {
    /** Finalize a confirmed initial only; MUST NOT schedule sequence 2. */
    confirmed(input: {
      recovery: WooOutreachRecovery;
      attempt: WooInitialAttempt;
      message: WooConfirmedMessage;
      admission: RecoveryBillingAdmission;
    }): Promise<void>;
  };
  enqueue: { initial(recoveryId: string, attemptId: string): Promise<void> };
  logger: StructuredLogger;
  /** Explicit test-only opt-in. Never permits production/development outbound. */
  enableTestOutbound?: () => boolean;
}

type GuardOutcome =
  | { kind: "allowed"; recipient: string; snapshot: WooRecoveryConsentSnapshot }
  | { kind: "suppressed" | "deferred"; reason: string };

type RunState = { recoveryId: string; shopId?: string; attemptId?: string; stage: string };
const confirmed = (message: PersistedMessage | null): message is WooConfirmedMessage =>
  !!message && (message.status === "SENT" || message.status === "DELIVERED" || message.status === "READ") &&
  !!message.sentAt;

/**
 * ARCH-048-BACKGROUND-004. No worker registration, recovery INSERT, new billing
 * ledger, follow-up or provider implementation lives here. A retry always uses
 * the unique (recoveryId, sequence=1) attempt and its durable send idempotency.
 */
export class WooRecoveryOutreachService implements WooRecoveryOutreachDispatcher {
  private readonly log: StructuredLogger;

  constructor(private readonly deps: WooOutreachDependencies) {
    this.log = deps.logger.child({ component: "woocommerce-recovery-outreach" });
  }

  /**
   * Reconcile only the closed Woo generation supplied by BG007. The SQL
   * adapter independently proves the durable resumption history and provider
   * permit state before it transitions an attempt or releases its reservation.
   */
  async settleResumed(previousRecoveryId: string): Promise<void> {
    const state: RunState = { recoveryId: previousRecoveryId, stage: "read-resumed-recovery" };
    try {
      const recovery = await this.deps.recoveries.get(previousRecoveryId);
      if (!this.isWoo(recovery) || recovery.status !== "CANCELLED") {
        this.logOutcome(state, "suppressed", "resumed-recovery-unavailable");
        return;
      }
      state.shopId = recovery.shopId;
      if (!await this.deps.resumedSettlement.hasResumedHistory(recovery.id, recovery.shopId)) {
        this.logOutcome(state, "suppressed", "checkout-resumed-history-missing");
        return;
      }

      await this.deps.coordinator.withCheckoutLock(this.ref(recovery), async () => {
        state.stage = "locked-resumed-recovery";
        const fresh = await this.requireSameRecovery(recovery);
        if (fresh.status !== "CANCELLED" ||
          !await this.deps.resumedSettlement.hasResumedHistory(fresh.id, fresh.shopId)) {
          this.logOutcome(state, "suppressed", "checkout-resumed-recovery-changed");
          return;
        }
        const attempts = await this.deps.resumedSettlement.findSettleableAttempts(fresh.id);
        for (const attempt of attempts) {
          state.attemptId = attempt.id;
          state.stage = "classify-resumed-attempt";
          const outcome = await this.deps.resumedSettlement.cancelIfPrePermit({
            recovery: fresh,
            attempt,
          });
          await this.applyResumedSettlement(fresh, attempt, outcome, state);
        }
        state.stage = "resumed-settlement-complete";
        this.logOutcome(state, "settled", "checkout-resumed");
      });
    } catch (error) {
      this.failed(state, error);
      throw error;
    }
  }

  private async applyResumedSettlement(
    recovery: WooOutreachRecovery,
    attempt: WooInitialAttempt,
    outcome: WooResumedAttemptSettlement,
    state: RunState,
  ): Promise<void> {
    if (outcome.kind === "not-resumed" || outcome.kind === "ignored") return;
    if (outcome.kind === "provider-uncertain")
      throw new Error("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
    if (outcome.kind === "provider-confirmed") {
      if (attempt.followUpDueAt !== null) throw new Error("WOO_FOLLOW_UP_NOT_ALLOWED");
      const message = outcome.message;
      if (!message.sentAt || !["SENT", "DELIVERED", "READ"].includes(message.status))
        throw new Error("WOO_CONFIRMED_PROVIDER_MESSAGE_INVALID");
      state.stage = "finalize-resumed-confirmed-send";
      await this.finalizeExisting(recovery, attempt, {
        id: message.id, conversationId: message.conversationId,
        status: message.status as WooConfirmedMessage["status"], sentAt: message.sentAt,
      }, state);
      return;
    }
    if (outcome.kind === "provider-failed") {
      state.stage = "reconcile-resumed-provider-failure";
      if (outcome.reservationStatus === "RELEASED") {
        await this.deps.attempts.markFailed(attempt.id, "PROVIDER_FAILED");
        return;
      }
      if (outcome.reservationStatus === null)
        throw new Error("WOO_FAILED_PROVIDER_RESERVATION_MISSING");
      // The adapter has already proved this exact shop/source reservation
      // exists; this call reuses it to obtain the existing owner's typed
      // admission for its canonical definitive-failure compensation path.
      const billing = await this.deps.billing.admit({
        shopId: recovery.shopId, recoveryId: recovery.id, outreachAttemptId: attempt.id,
      });
      if (billing.kind !== "admitted") throw new Error("WOO_FAILED_PROVIDER_CREDIT_RECONCILIATION_BLOCKED");
      const failure = new WhatsAppServiceError(
        "provider-rejected", "Persisted provider failure", outcome.message.providerFailureCode ?? undefined,
      );
      await this.deps.providerFailure.reconcileRecorded({
        admission: billing.admission, messageId: outcome.message.id, error: failure,
      });
      await this.deps.attempts.markFailed(attempt.id, "PROVIDER_FAILED");
      return;
    }
    if (outcome.kind === "cancelled") {
      if (outcome.sourceKey && outcome.owner) {
        state.stage = "release-resumed-reservation";
        await this.deps.resumedSettlement.releaseReservedCredit({
          shopId: recovery.shopId, sourceKey: outcome.sourceKey, owner: outcome.owner,
        });
      }
      this.logOutcome(state, "cancelled", "pre-permit-resumption");
    }
  }

  async enqueueInitial(recoveryId: string): Promise<WooOutreachEnqueueOutcome> {
    const state: RunState = { recoveryId, stage: "read-recovery" };
    try {
      const recovery = await this.deps.recoveries.get(recoveryId);
      if (!this.isWoo(recovery)) return this.enqueueOutcome(state, "suppressed", "woo-recovery-unavailable");
      state.shopId = recovery.shopId;
      return await this.deps.coordinator.withCheckoutLock(this.ref(recovery), async () => {
        state.stage = "locked-eligibility";
        const fresh = await this.requireSameRecovery(recovery);
        const previous = await this.deps.attempts.findInitial(recoveryId);
        if (previous) {
          state.attemptId = previous.id;
          const persisted = await this.deps.sender.findExistingAdmission(this.key(previous.id));
          if (confirmed(persisted)) {
            if (previous.status === "FAILED" || previous.status === "CANCELLED")
              throw new Error("WOO_CONFIRMED_PROVIDER_WITH_TERMINAL_ATTEMPT");
            if (previous.outboundMessageId === persisted.id && previous.sentAt &&
              ["WAITING_FOR_RESPONSE", "ENGAGED", "NO_RESPONSE"].includes(previous.status) &&
              fresh.status !== "DETECTED")
              return this.enqueueOutcome(state, "already-initialized");
            // Meta has already sent: enqueue ONLY to finish durable credit/attempt
            // finalization. processInitial finds SENT before consulting rollout.
            state.stage = "enqueue-confirmed-finalization";
            await this.deps.enqueue.initial(recoveryId, previous.id);
            return this.enqueueOutcome(state, "queued");
          }
          if (persisted?.status === "PENDING")
            throw new Error("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
          if (persisted?.status === "FAILED" && previous.status !== "FAILED")
            throw new Error("WOO_INITIAL_PROVIDER_FAILURE_UNRECONCILED");
          if (persisted?.status === "FAILED" || previous.status === "FAILED" || previous.status === "CANCELLED")
            return this.enqueueOutcome(state, "suppressed", "initial-attempt-terminal");
          if (persisted) throw new Error("WOO_INITIAL_PROVIDER_OUTCOME_UNRECOGNISED");
          if (previous.sentAt || previous.outboundMessageId || previous.followUpDueAt ||
            ["WAITING_FOR_RESPONSE", "ENGAGED", "NO_RESPONSE"].includes(previous.status))
            throw new Error("WOO_INITIAL_ATTEMPT_WITHOUT_CONFIRMED_MESSAGE");
        }
        if (!this.enabled()) return this.enqueueOutcome(state, "suppressed", "woo-outbound-disabled");
        const guard = await this.guard(fresh);
        if (guard.kind !== "allowed") return this.enqueueOutcome(state, guard.kind, guard.reason);
        if (previous && previous.recipient !== guard.recipient)
          return this.enqueueOutcome(state, "suppressed", "recipient-changed");
        state.stage = "persist-initial-attempt";
        const attempt = previous ?? await this.deps.attempts.getOrCreateInitial({
          recoveryId,
          recipient: guard.recipient,
          policy: await this.deps.policies.resolve(fresh.shopId),
        });
        this.requireInitial(attempt, guard.recipient);
        state.attemptId = attempt.id;
        // The queue job may have been deleted or enqueue may have failed after
        // the attempt committed: ALWAYS republish a still-pending same attempt.
        state.stage = "enqueue-initial";
        await this.deps.enqueue.initial(recoveryId, attempt.id);
        return this.enqueueOutcome(state, "queued");
      });
    } catch (error) {
      this.failed(state, error);
      throw error;
    }
  }

  async processInitial(recoveryId: string): Promise<WooOutreachDispatchOutcome> {
    const state: RunState = { recoveryId, stage: "read-recovery" };
    try {
      const recovery = await this.deps.recoveries.get(recoveryId);
      if (!this.isWoo(recovery)) return this.dispatchOutcome(state, "suppressed", "woo-recovery-unavailable");
      state.shopId = recovery.shopId;
      return await this.deps.coordinator.withCheckoutLock(this.ref(recovery), async () => {
        state.stage = "locked-eligibility";
        const fresh = await this.requireSameRecovery(recovery);
        let attempt = await this.deps.attempts.findInitial(recoveryId);
        if (attempt) {
          state.attemptId = attempt.id;
          const prior = await this.deps.sender.findExistingAdmission(this.key(attempt.id));
          if (confirmed(prior)) {
            if (attempt.status === "FAILED" || attempt.status === "CANCELLED")
              throw new Error("WOO_CONFIRMED_PROVIDER_WITH_TERMINAL_ATTEMPT");
            if (attempt.outboundMessageId === prior.id && attempt.sentAt &&
              ["WAITING_FOR_RESPONSE", "ENGAGED", "NO_RESPONSE"].includes(attempt.status) &&
              fresh.status !== "DETECTED")
              return this.dispatchOutcome(state, "already-initialized");
            // A confirmed send MUST be charged even if a paid order arrived
            // afterwards; replays finalize it, never re-send it.
            await this.finalizeExisting(fresh, attempt, prior, state);
            return this.dispatchOutcome(state, "already-initialized");
          }
          if (prior?.status === "PENDING") {
            // A durable provider permit may already have been committed. The
            // current admission read does not expose whether Meta was called.
            // Reconciling, not a second call, is required for an unknown outcome.
            throw new Error("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
          }
          // A FAILED provider message does not prove the credit release was
          // persisted. A previous compensation exception leaves the attempt
          // pending: keep the BullMQ job failed until reconciliation succeeds.
          if (prior?.status === "FAILED" && attempt.status !== "FAILED")
            throw new Error("WOO_INITIAL_PROVIDER_FAILURE_UNRECONCILED");
          if (prior?.status === "FAILED")
            return this.dispatchOutcome(state, "suppressed", "initial-provider-failed");
          if (prior) throw new Error("WOO_INITIAL_PROVIDER_OUTCOME_UNRECOGNISED");
          if (attempt.status === "FAILED" || attempt.status === "CANCELLED")
            return this.dispatchOutcome(state, "suppressed", "initial-attempt-terminal");
          if (attempt.sentAt || attempt.outboundMessageId ||
            ["WAITING_FOR_RESPONSE", "ENGAGED", "NO_RESPONSE"].includes(attempt.status))
            throw new Error("WOO_INITIAL_ATTEMPT_WITHOUT_CONFIRMED_MESSAGE");
        }
        if (!this.enabled()) return this.dispatchOutcome(state, "suppressed", "woo-outbound-disabled");
        const guard = await this.guard(fresh);
        if (guard.kind !== "allowed") return this.dispatchOutcome(state, guard.kind, guard.reason);
        if (attempt && attempt.recipient !== guard.recipient)
          return this.dispatchOutcome(state, "suppressed", "recipient-changed");
        const policy = await this.deps.policies.resolve(fresh.shopId);
        if (!attempt) {
          state.stage = "persist-initial-attempt";
          attempt = await this.deps.attempts.getOrCreateInitial({
            recoveryId, recipient: guard.recipient, policy,
          });
        }
        this.requireInitial(attempt, guard.recipient);
        state.attemptId = attempt.id;
        state.stage = "select-marketing-template";
        const selected = await this.deps.templates.select(fresh.shopId, recoveryId, attempt.id, policy);
        if (selected.kind !== "selected" || selected.template.verifiedCategory !== "MARKETING")
          return this.dispatchOutcome(state, "suppressed", "marketing-template-unavailable");
        state.stage = "resolve-conversation";
        const conversation = await this.deps.conversations.getOrCreate(recoveryId);
        state.stage = "reserve-recovery-credit";
        let billing = await this.deps.billing.admit({
          shopId: fresh.shopId, recoveryId, outreachAttemptId: attempt.id,
        });
        if (billing.kind === "blocked") return this.dispatchOutcome(state, "deferred", billing.reason);

        // Everything up to the provider's durable final permit is reversible.
        // This second observed-order and consent read closes a long preflight;
        // the injected sender additionally MUST check both under the atomic
        // ARCH-046/ARCH-048 pre-provider fence, not just this read.
        state.stage = "revalidate-final-preflight";
        let repeat: GuardOutcome;
        try {
          repeat = await this.guard(await this.requireSameRecovery(fresh), guard.snapshot);
        } catch (error) {
          await this.releaseOrThrow(billing.admission, error);
          throw error;
        }
        if (repeat.kind !== "allowed" || repeat.recipient !== attempt.recipient) {
          await this.deps.billing.releaseBeforeProvider(billing.admission);
          return this.dispatchOutcome(state, repeat.kind === "allowed" ? "suppressed" : repeat.kind,
            repeat.kind === "allowed" ? "recipient-changed" : repeat.reason);
        }
        state.stage = "revalidate-credit";
        let revalidated: Awaited<ReturnType<WooOutreachDependencies["billing"]["revalidateBeforeProvider"]>>;
        try {
          revalidated = await this.deps.billing.revalidateBeforeProvider({
            admission: billing.admission, recoveryId, outreachAttemptId: attempt.id,
          });
        } catch (error) {
          await this.releaseOrThrow(billing.admission, error);
          throw error;
        }
        if (revalidated.kind === "blocked") return this.dispatchOutcome(state, "deferred", revalidated.reason);
        billing = revalidated;
        if (selected.template.admissionToken) {
          let offerAdmissionValid: boolean;
          try {
            offerAdmissionValid = await this.deps.templates.validateAdmission(
              selected.template.admissionToken, AbortSignal.timeout(15_000),
            );
          } catch (error) {
            await this.releaseOrThrow(billing.admission, error);
            throw error;
          }
          if (!offerAdmissionValid) {
            await this.deps.billing.releaseBeforeProvider(billing.admission);
            return this.dispatchOutcome(state, "suppressed", "offer-source-changed");
          }
        }
        state.stage = "durable-provider-permit-and-send";
        const source = billing.admission;
        let result: Awaited<ReturnType<WooGuardedInitialSender["sendInitial"]>>;
        try {
          result = await this.deps.sender.sendInitial({
            recovery: fresh, attemptId: attempt.id, conversationId: conversation.id,
            recipient: attempt.recipient, consent: repeat.snapshot, template: selected.template,
            idempotencyKey: this.key(attempt.id), recoveryCreditSourceKey: source.sourceKey,
          });
        } catch (error) {
          // The error may be a timeout AFTER provider admission. Existing
          // canonical billing decides definitive vs ambiguous; a confirmed
          // send must never be refunded. Never mark this attempt FAILED on an
          // uncertain outcome, and never acknowledge the failed job.
          state.stage = "provider-failure-reconciliation";
          await this.compensateProviderError(attempt.id, source, error);
          throw error;
        }
        state.stage = "verify-durable-provider-result";
        const message = await this.deps.sender.findExistingAdmission(this.key(attempt.id));
        if (result.kind === "suppressed") {
          if (result.reason === "duplicate") {
            if (confirmed(message)) {
              await this.deps.finalize.confirmed({ recovery: fresh, attempt, message, admission: source });
              return this.dispatchOutcome(state, "already-initialized");
            }
            if (message?.status === "FAILED") {
              await this.deps.billing.releaseBeforeProvider(source);
              await this.deps.attempts.markFailed(attempt.id, "PROVIDER_FAILED");
              return this.dispatchOutcome(state, "suppressed", "initial-provider-failed");
            }
            throw new Error("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
          }
          // The guarded sender contract allows nonduplicate suppression only
          // BEFORE the irreversible provider permit. Credit may be released.
          await this.deps.billing.releaseBeforeProvider(source);
          // A definitive denial BEFORE provider dispatch is reversible. Keep
          // sequence one eligible for a later newly-consented checkout event;
          // only confirmed provider failures can permanently close an attempt.
          return this.dispatchOutcome(state, "suppressed", "final-send-denied");
        }
        if (!confirmed(message) || message.conversationId !== conversation.id)
          throw new Error("WOO_INITIAL_SENT_WITHOUT_CONFIRMED_DURABLE_MESSAGE");
        state.stage = "finalize-confirmed-send";
        await this.deps.finalize.confirmed({ recovery: fresh, attempt, message, admission: source });
        return this.dispatchOutcome(state, "sent");
      });
    } catch (error) {
      this.failed(state, error);
      throw error;
    }
  }

  private enabled(): boolean {
    return process.env.NODE_ENV === "test" && this.deps.enableTestOutbound?.() === true;
  }

  private isWoo(recovery: WooOutreachRecovery | null): recovery is WooOutreachRecovery {
    return !!recovery && recovery.shop.platform === "WOOCOMMERCE" && !!recovery.checkoutToken && !!recovery.shopId;
  }

  private ref(recovery: WooOutreachRecovery): WooCheckoutRef {
    return { shopId: recovery.shopId, checkoutToken: recovery.checkoutToken };
  }

  private key(attemptId: string): string { return `recovery-outreach:${attemptId}`; }

  private async requireSameRecovery(original: WooOutreachRecovery): Promise<WooOutreachRecovery> {
    const current = await this.deps.recoveries.get(original.id);
    if (!this.isWoo(current) || current.shopId !== original.shopId ||
      current.checkoutToken !== original.checkoutToken)
      throw new Error("WOO_RECOVERY_IDENTITY_CHANGED");
    return current;
  }

  private requireInitial(attempt: WooInitialAttempt, recipient: string): void {
    if (attempt.sequence !== 1 || attempt.recipient !== recipient || attempt.followUpDueAt !== null)
      throw new Error("WOO_INITIAL_ATTEMPT_CONFLICT");
    if (attempt.status !== "PENDING" && attempt.status !== "CAPACITY_BLOCKED")
      throw new Error("WOO_INITIAL_ATTEMPT_NOT_PENDING");
  }

  private async guard(recovery: WooOutreachRecovery, expected?: WooRecoveryConsentSnapshot): Promise<GuardOutcome> {
    if (recovery.shop.status !== "ACTIVE" || recovery.status !== "DETECTED" || recovery.completedAt)
      return { kind: "suppressed", reason: "recovery-terminal-or-inactive" };
    const order = await this.deps.orders.read(this.ref(recovery));
    if (order.kind === "ambiguous") return { kind: "deferred", reason: "order-evidence-ambiguous" };
    if (order.kind !== "none-observed") return { kind: "suppressed", reason: "observed-order-terminal" };
    if (!recovery.customerId) return { kind: "suppressed", reason: "recipient-customer-missing" };
    const recipient = await this.deps.recoveries.currentRecipient(recovery.customerId, recovery.shopId);
    if (!recipient) return { kind: "suppressed", reason: "current-recipient-missing" };
    const permission = await this.deps.consent.evaluateStoredRecipient({
      shopId: recovery.shopId, customerId: recovery.customerId, recipient,
      ...(expected ? { expected } : {}),
    });
    if (permission.status === "UNAVAILABLE") throw new Error("WOO_CONSENT_READ_UNAVAILABLE");
    if (permission.status !== "ALLOWED")
      return { kind: permission.status === "AMBIGUOUS" ? "deferred" : "suppressed",
        reason: "woo-consent-not-authorised" };
    return { kind: "allowed", recipient, snapshot: permission.snapshot };
  }

  private async finalizeExisting(
    recovery: WooOutreachRecovery, attempt: WooInitialAttempt,
    message: WooConfirmedMessage, state: RunState,
  ): Promise<void> {
    if (attempt.followUpDueAt !== null) throw new Error("WOO_FOLLOW_UP_NOT_ALLOWED");
    state.stage = "verify-confirmed-message-owner";
    const conversation = await this.deps.conversations.getOrCreate(recovery.id);
    if (message.conversationId !== conversation.id)
      throw new Error("WOO_CONFIRMED_MESSAGE_OWNERSHIP_MISMATCH");
    state.stage = "replay-confirmed-credit";
    const billing = await this.deps.billing.admit({
      shopId: recovery.shopId, recoveryId: recovery.id, outreachAttemptId: attempt.id,
    });
    if (billing.kind !== "admitted") throw new Error("WOO_CONFIRMED_MESSAGE_CREDIT_UNAVAILABLE");
    state.stage = "replay-confirmed-finalization";
    await this.deps.finalize.confirmed({ recovery, attempt, message, admission: billing.admission });
  }

  private async releaseOrThrow(admission: RecoveryBillingAdmission, original: unknown): Promise<void> {
    let compensationFailure: { error: unknown } | undefined;
    try {
      await this.deps.billing.releaseBeforeProvider(admission);
    } catch (compensation) {
      compensationFailure = { error: compensation };
    }
    if (compensationFailure) {
      throw new AggregateError(
        [original, compensationFailure.error], "WOO_PRE_SEND_RELEASE_FAILED", { cause: original },
      );
    }
  }

  private async compensateProviderError(
    attemptId: string, admission: RecoveryBillingAdmission, original: unknown,
  ): Promise<void> {
    let compensationFailure: { error: unknown } | undefined;
    try {
      const message = await this.deps.sender.findExistingAdmission(this.key(attemptId));
      if (confirmed(message)) return; // message sent; never refund
      await this.deps.providerFailure.compensate(admission, original);
      // Pending/unknown provider permits remain locked by durable idempotency.
      // Only a definitively FAILED provider message may be terminalised.
      if (message?.status === "FAILED") await this.deps.attempts.markFailed(attemptId, "PROVIDER_FAILED");
    } catch (compensation) {
      compensationFailure = { error: compensation };
    }
    if (compensationFailure) {
      throw new AggregateError(
        [original, compensationFailure.error], "WOO_PROVIDER_COMPENSATION_FAILED", { cause: original },
      );
    }
  }

  private enqueueOutcome(
    state: RunState,
    kind: WooOutreachEnqueueOutcome["kind"], reason?: string,
  ): WooOutreachEnqueueOutcome {
    this.logOutcome(state, kind, reason);
    if (kind === "queued" || kind === "already-initialized")
      return { kind, ...(state.attemptId ? { attemptId: state.attemptId } : {}) };
    return { kind, reason: reason ?? "unknown" };
  }

  private dispatchOutcome(
    state: RunState,
    kind: WooOutreachDispatchOutcome["kind"], reason?: string,
  ): WooOutreachDispatchOutcome {
    this.logOutcome(state, kind, reason);
    if (kind === "sent" || kind === "already-initialized") {
      if (!state.attemptId) throw new Error("WOO_CONFIRMED_ATTEMPT_MISSING");
      return { kind, attemptId: state.attemptId };
    }
    return { kind, reason: reason ?? "unknown" };
  }

  private logOutcome(state: RunState, kind: string, reason?: string): void {
    const context = { shopId: state.shopId, recoveryId: state.recoveryId,
      attemptId: state.attemptId, stage: state.stage, outcome: kind, ...(reason ? { reason } : {}) };
    this.log[kind === "suppressed" || kind === "deferred" ? "warn" : "info"](
      kind === "queued" ? "woocommerce.recovery.outreach.enqueued" :
        kind === "sent" ? "woocommerce.recovery.outreach.dispatched" :
          "woocommerce.recovery.outreach.suppressed", context,
    );
  }

  private failed(state: RunState, error: unknown): void {
    // Error messages often carry phone numbers, provider bodies or SQL. Log
    // only bounded metadata. Do not pass the original Error to the shared
    // serializer: even its message and stack can contain sensitive details.
    this.log.error("woocommerce.recovery.outreach.failed", {
      shopId: state.shopId, recoveryId: state.recoveryId, attemptId: state.attemptId,
      stage: state.stage,
      errorClass: error instanceof AggregateError ? "aggregate" :
        error instanceof Error ? "exception" : "unknown",
      errorCode: "WOO_RECOVERY_OUTREACH_FAILED",
    });
  }
}
