import type { RecoveryShopHeaderReceipt } from "./conversation-wrappers/recovery-shop-header.js";
import { presentedProductContext } from "../commerce/product-context-write.js";
import { CommerceHostError } from "../commerce/mcp-client.js";
import type { CommerceConversationProductContext } from "@modainteract/moda-interact-shared/commerce";
import type { CommercePresentationInput } from "./conversation-wrappers/contracts.js";
import type {
  ConversationService,
  ConversationTurnState,
} from "./conversation.service.js";
import { DelayedError } from "bullmq";
import type { AiTurnOwnershipService } from "./recovery-conversation/ai-turn-ownership.service.js";
import { composeAiOutbound, type AiConversationWrapper } from "./conversation-wrappers/compose-ai-outbound.js";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import {
  runCommerceAgentAfterAdmission,
  type OutboundAdmissionResult,
} from "./outbound-whatsapp-admission.service.js";
import type {
  InboundAbuseAdmission,
  InboundAbuseConversationType,
} from "./inbound-whatsapp-abuse-admission.service.js";
import {
  backgroundRuntimeConfigService,
  type BackgroundRuntimeConfigSnapshot,
} from "../runtime/background-runtime-config.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { resolveEligibleAt } from "./conversation-ai-delay/eligibility.js";

export const PROCESSING_LEASE_MS = 120_000;

type RuntimeConfigReader = {
  current(): BackgroundRuntimeConfigSnapshot;
};

function currentConversationRuntimeConfig(
  reader: RuntimeConfigReader,
): Pick<
  BackgroundRuntimeConfigSnapshot,
  "conversationQuietWindowMs" | "conversationMaxSettleWindowMs"
> {
  return reader.current();
}

export type ConversationTurnJob = {
  conversationId: string;
  observedVersion: number;
};

type QueueLike = {
  add: (
    name: string,
    data: ConversationTurnJob,
    options: {
      jobId: string;
      delay: number;
      removeOnComplete?: boolean;
    },
  ) => Promise<unknown>;
};

type ActiveTurnJob = {
  id?: string;
  token?: string;
  moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
};

type Admitted = Extract<OutboundAdmissionResult, { kind: "admitted" }>;

export type LoadedConversationTurn<TContext> = {
  shopId: string;
  to: string;
  customerPhone: string;
  conversationType: InboundAbuseConversationType;
  checkoutRecoveryId: string | null;
  hasReplyContext: boolean;
  context: TContext | null;
  languageMessage: string;
  clarificationText?: string;
  handledWithoutAgent?: boolean;
  shopUnavailable?: boolean;
};

export type ConversationTurnProcessorDependencies<TContext, TResult> = {
  queue: QueueLike;
  conversation: Pick<
    ConversationService,
    | "getTurnState"
    | "claimTurn"
    | "completeTurn"
    | "releaseTurn"
    | "suppressStaleTurn"
    | "hasChanged"
    | "applyDetectedLanguage"
  >;
  admission: {
    reserve: (input: {
      shopId: string;
      conversationId: string;
      idempotencyKey: string;
      senderType: "AGENT" | "AUTOMATION";
      content?: string;
    }) => Promise<OutboundAdmissionResult>;
    sendPreparedText: (
      input: Admitted & {
        to: string;
        text: string;
        prepareRecoveryFooter?: true; recoveryShopHeader?: RecoveryShopHeaderReceipt;
        expectedControlRevision?: number;
        expectedInboundVersion?: number;
        productContextUpdate?: CommerceConversationProductContext;
      },
    ) => Promise<OutboundAdmissionResult>;
    sendPreparedConversation?: (
      input: Admitted & {
        brandMediaPolicy?: import("./conversation-brand-media.js").BrandMediaPolicyRef; deliveryPlan?: import("@modainteract/moda-interact-shared/commerce/presentation").ConversationMediaDeliveryPlan;
        presentationReceipt?: import("./conversation-delivery-plan.js").ConversationDeliveryReceipt;
        to: string;
        text: string;
        prepareRecoveryFooter?: true; recoveryShopHeader?: RecoveryShopHeaderReceipt;
        expectedControlRevision?: number;
        expectedInboundVersion?: number;
        productContextUpdate?: CommerceConversationProductContext;
      },
    ) => Promise<OutboundAdmissionResult>;
    failPrepared: (messageId: string) => Promise<void>;
  };
  ownership?: Pick<AiTurnOwnershipService, "readTurnOwnership" | "checkAutomatedTurn">;
  /** Installed by the production worker, before agent context loading. */
  moderation?: {
    moderatePending: (conversationId: string, pendingTurnStartedAt: Date) => Promise<"allowed" | "suppressed" | "retry">;
  };
  abuseAdmission: {
    admitSettledTurn: (input: {
      conversationId: string;
      observedVersion: number;
      shopId: string;
      customerPhone: string;
      conversationType: InboundAbuseConversationType;
      hasReplyContext: boolean;
      checkoutRecoveryId: string | null;
    }) => Promise<InboundAbuseAdmission>;
  };
  loadTurn: (
    conversationId: string,
    pendingTurnStartedAt: Date,
  ) => Promise<LoadedConversationTurn<TContext>>;
  runAgent: (context: TContext) => Promise<TResult>;
  /** BG005 prepared wrapper; required even when no active slot is configured. */
  aiWrapper: AiConversationWrapper;
  getResult: (result: TResult) => {
    replyText: string;
    detectedLanguageTag: string | null;
    detectedLanguageConfidence: number | null;
    hostComposedReplyCandidates?: readonly string[];
    commercePresentation?: CommercePresentationInput;
    productContextUpdate?: CommerceConversationProductContext;
  };
  now?: () => Date;
  runtimeConfig?: RuntimeConfigReader;
  logger?: StructuredLogger;
};

export class ConversationTurnProcessor<TContext, TResult> {
  private readonly now: () => Date;
  private readonly runtimeConfig: RuntimeConfigReader;
  private readonly logger: StructuredLogger;

  constructor(
    private readonly dependencies: ConversationTurnProcessorDependencies<
      TContext,
      TResult
    >,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.runtimeConfig = dependencies.runtimeConfig ?? backgroundRuntimeConfigService;
    this.logger = dependencies.logger ?? createLogger({
      serviceName: "moda-messaging-worker",
      environment: resolveDeploymentEnvironmentName(),
    });
  }

  async enqueue(
    conversationId: string,
    observedVersion: number,
  ): Promise<void> {
    this.logger.debug("whatsapp.turn.enqueue_requested", {
      conversationId,
      observedVersion,
    });
    const state =
      await this.dependencies.conversation.getTurnState(conversationId);
    if (!state.pendingTurnStartedAt || !state.lastInboundAt) {
      this.logger.debug("whatsapp.turn.enqueue_skipped", {
        conversationId,
        observedVersion,
        inboundVersion: state.inboundVersion,
        lastProcessedVersion: state.lastProcessedVersion,
        reason: !state.pendingTurnStartedAt
          ? "no-pending-turn"
          : "no-last-inbound-at",
      });
      return;
    }

    const now = this.now().getTime();
    const delay = settleDelay(
      state,
      now,
      currentConversationRuntimeConfig(this.runtimeConfig),
    );
    await this.schedule(conversationId, observedVersion, delay);
  }

  async process(
    { conversationId, observedVersion }: ConversationTurnJob,
    activeJob?: ActiveTurnJob,
  ): Promise<void> {
    this.logger.debug("whatsapp.turn.processing_started", {
      conversationId,
      observedVersion,
      jobId: activeJob?.id ?? null,
    });
    const state =
      await this.dependencies.conversation.getTurnState(conversationId);
    const staleReason = turnStaleReason(state, observedVersion);
    if (staleReason) {
      this.logger.debug("whatsapp.turn.stale", {
        conversationId,
        observedVersion,
        inboundVersion: state.inboundVersion,
        lastProcessedVersion: state.lastProcessedVersion,
        reason: staleReason,
      });
      return;
    }

    const now = this.now();
    const delay = settleDelay(
      state,
      now.getTime(),
      currentConversationRuntimeConfig(this.runtimeConfig),
    );
    if (delay > 0) {
      this.logger.debug("whatsapp.turn.quiet_window_wait", {
        conversationId,
        observedVersion,
        delayMs: delay,
      });
      await this.schedule(conversationId, observedVersion, delay, activeJob);
      return;
    }

    if (
      !(await this.dependencies.conversation.claimTurn(
        conversationId,
        observedVersion,
        now,
        state.pendingAiControlRevision ?? undefined,
      ))
    ) {
      const current = await this.dependencies.conversation.getTurnState(conversationId);
      if (
        state.pendingAiControlRevision != null &&
        (current.controlMode !== "AI" ||
          current.controlRevision !== state.pendingAiControlRevision ||
          current.pendingAiControlRevision !== state.pendingAiControlRevision)
      ) {
        const suppressed = await this.dependencies.conversation.suppressStaleTurn(
          conversationId,
          observedVersion,
          state.pendingAiControlRevision,
        );
        if (!suppressed) {
          const latest = await this.dependencies.conversation.getTurnState(conversationId);
          if (
            latest.inboundVersion > observedVersion &&
            latest.lastProcessedVersion < latest.inboundVersion &&
            latest.pendingTurnStartedAt !== null
          ) {
            await this.enqueue(conversationId, latest.inboundVersion);
          }
        }
        return;
      }
      if (
        current.inboundVersion > observedVersion &&
        current.lastProcessedVersion < current.inboundVersion &&
        current.pendingTurnStartedAt !== null
      ) {
        await this.enqueue(conversationId, current.inboundVersion);
        return;
      }
      this.logger.debug("whatsapp.turn.claim_deferred", {
        conversationId,
        observedVersion,
        retryDelayMs: 250,
      });
      await this.schedule(conversationId, observedVersion, 250, activeJob);
      return;
    }

    this.logger.debug("whatsapp.turn.claimed", {
      conversationId,
      observedVersion,
      processingStartedAt: now.toISOString(),
    });

    // The pending snapshot is the original revision; never recapture ownership
    // after a delay or HUMAN -> AI cycle.
    const controlRevision = state.pendingAiControlRevision ?? undefined;
    const checkControl = async (phase: "before-agent" | "after-await" | "before-provider", shopId?: string) => {
      if (controlRevision === undefined || !this.dependencies.ownership) return true;
      const result = await this.dependencies.ownership.checkAutomatedTurn({
        conversationId, expectedRevision: controlRevision, phase,
        ...(shopId ? { shopId } : {}),
      });
      return result.kind === "allowed";
    };
    const completeOwnedTurn = async () => {
      const completed = controlRevision === undefined
        ? await this.dependencies.conversation.completeTurn(conversationId, observedVersion)
        : await this.dependencies.conversation.completeTurn(conversationId, observedVersion, controlRevision);
      if (completed) return;
      if (controlRevision !== undefined) {
        await this.dependencies.conversation.suppressStaleTurn(
          conversationId,
          observedVersion,
          controlRevision,
        );
      }
      await this.dependencies.conversation.releaseTurn(conversationId, observedVersion);
      const latest = await this.dependencies.conversation.getTurnState(conversationId);
      if (
        latest.inboundVersion > observedVersion &&
        latest.lastProcessedVersion < latest.inboundVersion &&
        latest.pendingTurnStartedAt !== null
      ) {
        await this.enqueue(conversationId, latest.inboundVersion);
      }
    };
    let admission: Admitted | null = null;
    let providerSendAttempted = false;
    let reservationFailed = false;
    let reservationCleanupSucceeded = false;
    const failPrepared = async (messageId: string) => {
      reservationFailed = true;
      await this.dependencies.admission.failPrepared(messageId);
      reservationCleanupSucceeded = true;
    };
    const sendPreparedText = async (
      input: Admitted & { to: string; text: string; prepareRecoveryFooter?: true; recoveryShopHeader?: RecoveryShopHeaderReceipt; productContextUpdate?: CommerceConversationProductContext; brandMediaPolicy?: import("./conversation-brand-media.js").BrandMediaPolicyRef; deliveryPlan?: import("@modainteract/moda-interact-shared/commerce/presentation").ConversationMediaDeliveryPlan; presentationReceipt?: import("./conversation-delivery-plan.js").ConversationDeliveryReceipt },
    ) => {
      if (!(await checkControl("before-provider", input.shopId))) {
        await failPrepared(input.messageId);
        return { kind: "suppressed", reason: "conversation-invalid" } as const;
      }
      providerSendAttempted = true;
      if (input.deliveryPlan && !this.dependencies.admission.sendPreparedConversation) {
        await failPrepared(input.messageId);
        return {kind: "suppressed", reason: "conversation-invalid"} as const;
      }
      const sender = input.deliveryPlan ? this.dependencies.admission.sendPreparedConversation!.bind(this.dependencies.admission)
        : this.dependencies.admission.sendPreparedText.bind(this.dependencies.admission);
      return sender({
        ...input,
        ...(controlRevision === undefined ? {} : { expectedControlRevision: controlRevision }),
        expectedInboundVersion: observedVersion,
      });
    };

    try {
      if (this.dependencies.moderation) {
        const gate = await this.dependencies.moderation.moderatePending(
          conversationId, state.pendingTurnStartedAt as Date,
        );
        if (gate === "retry") {
          await this.dependencies.conversation.releaseTurn(conversationId, observedVersion);
          await this.schedule(conversationId, observedVersion, 2_000, activeJob);
          return;
        }
        if (gate === "suppressed") {
          await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
          return;
        }
      }
      const loaded = await this.dependencies.loadTurn(
        conversationId,
        state.pendingTurnStartedAt as Date,
      );

      this.logger.debug("whatsapp.turn.context_loaded", {
        conversationId,
        observedVersion,
        conversationType: loaded.conversationType,
        checkoutRecoveryId: loaded.checkoutRecoveryId,
        handledWithoutAgent: loaded.handledWithoutAgent === true,
        clarificationRequired: Boolean(loaded.clarificationText),
        shopUnavailable: loaded.shopUnavailable === true,
      });

      if (!(await checkControl("before-agent", loaded.shopId))) {
        await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
        return;
      }

      if (loaded.shopUnavailable) {
        await this.finishInactiveTurn(conversationId, observedVersion, controlRevision);
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "shop-unavailable",
        });
        return;
      }

      if (loaded.checkoutRecoveryId !== null && controlRevision === undefined) {
        await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
        return;
      }

      const abuse = await this.dependencies.abuseAdmission.admitSettledTurn({
        conversationId,
        observedVersion,
        shopId: loaded.shopId,
        customerPhone: loaded.customerPhone,
        conversationType: loaded.conversationType,
        hasReplyContext: loaded.hasReplyContext,
        checkoutRecoveryId: loaded.checkoutRecoveryId,
      });
      if (abuse.kind !== "allowed") {
        this.logger.debug("whatsapp.turn.suppressed", {
          conversationId,
          observedVersion,
          reason: abuse.reason,
        });
        await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
        return;
      }

      if (await this.dependencies.conversation.hasChanged(conversationId, observedVersion)) {
        await this.dependencies.conversation.releaseTurn(conversationId, observedVersion);
        const latest = await this.dependencies.conversation.getTurnState(conversationId);
        if (latest.inboundVersion > observedVersion && latest.lastProcessedVersion < latest.inboundVersion &&
            latest.pendingTurnStartedAt !== null) {
          await this.enqueue(conversationId, latest.inboundVersion);
        }
        return;
      }

      if (!(await checkControl("before-agent", loaded.shopId))) {
        await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
        return;
      }

      if (loaded.handledWithoutAgent) {
        await completeOwnedTurn();
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "handled-without-agent",
        });
        return;
      }

      if (loaded.clarificationText) {
        const clarification = await this.dependencies.admission.reserve({
          shopId: loaded.shopId,
          conversationId,
          idempotencyKey: `clarification:${conversationId}:${observedVersion}`,
          senderType: "AUTOMATION",
          content: loaded.clarificationText,
        });
        if (clarification.kind !== "admitted") {
          await completeOwnedTurn();
          this.logger.debug("whatsapp.turn.completed", {
            conversationId,
            observedVersion,
            outcome: "clarification-suppressed",
          });
          return;
        }
        admission = clarification;
        if (!(await checkControl("after-await", loaded.shopId))) {
          await failPrepared(clarification.messageId);
          await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
          return;
        }
        await sendPreparedText({
          ...clarification,
          to: loaded.to,
          text: loaded.clarificationText,
          prepareRecoveryFooter: true,
        });
        await completeOwnedTurn();
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "clarification-sent",
        });
        return;
      }

      const eligibilityNow = this.now().getTime();
      const eligibleAt = resolveEligibleAt({
        pendingAiNotBeforeAt: state.pendingAiNotBeforeAt,
        lastInboundAt: state.lastInboundAt ?? state.pendingTurnStartedAt as Date,
        pendingTurnStartedAt: state.pendingTurnStartedAt as Date,
        quietMs: currentConversationRuntimeConfig(this.runtimeConfig).conversationQuietWindowMs,
        maxMs: currentConversationRuntimeConfig(this.runtimeConfig).conversationMaxSettleWindowMs,
      });
      const eligibilityDelay = Math.max(0, eligibleAt - eligibilityNow);
      if (eligibilityDelay > 0) {
        await this.dependencies.conversation.releaseTurn(conversationId, observedVersion);
        await this.schedule(conversationId, observedVersion, eligibilityDelay, activeJob);
        return;
      }

      const reserved = await this.dependencies.admission.reserve({
        shopId: loaded.shopId,
        conversationId,
        idempotencyKey: `agent:${conversationId}:${observedVersion}`,
        senderType: "AGENT",
      });
      if (reserved.kind !== "admitted") {
        await completeOwnedTurn();
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "outbound-admission-suppressed",
        });
        return;
      }
      admission = reserved;

      if (!(await checkControl("after-await", loaded.shopId))) {
        await failPrepared(reserved.messageId);
        await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
        return;
      }

      this.logger.debug("whatsapp.turn.agent_started", {
        conversationId,
        observedVersion,
      });

      const result = await runCommerceAgentAfterAdmission({
        admission: reserved,
        to: loaded.to,
        context: loaded.context as TContext,
        runAgent: this.dependencies.runAgent,
        sendPreparedText,
        failPrepared,
      });
      if (result === null) {
        await completeOwnedTurn();
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "terminal-admission-response",
        });
        return;
      }

      if (!(await checkControl("after-await", loaded.shopId))) {
        await failPrepared(reserved.messageId);
        await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
        return;
      }

      const agentResult = this.dependencies.getResult(result);

      this.logger.debug("whatsapp.turn.agent_completed", {
        conversationId,
        observedVersion,
      });

      if (
        await this.dependencies.conversation.hasChanged(
          conversationId,
          observedVersion,
        )
      ) {
        await failPrepared(reserved.messageId);
        await this.dependencies.conversation.releaseTurn(
          conversationId,
          observedVersion,
        );
        const latest =
          await this.dependencies.conversation.getTurnState(conversationId);
        this.logger.debug("whatsapp.turn.changed_during_processing", {
          conversationId,
          observedVersion,
          latestInboundVersion: latest.inboundVersion,
        });
        await this.enqueue(conversationId, latest.inboundVersion);
        return;
      }

      await this.dependencies.conversation.applyDetectedLanguage({
        conversationId,
        version: observedVersion,
        message: loaded.languageMessage,
        detectedLanguageTag: agentResult.detectedLanguageTag,
        detectedLanguageConfidence: agentResult.detectedLanguageConfidence,
      });
      if (!(await checkControl("after-await", loaded.shopId))) {
        await failPrepared(reserved.messageId);
        await this.finishSuppressedTurn(conversationId, observedVersion, controlRevision);
        return;
      }

      // Compose exactly once for this reserved outbound message. The original
      // model result is unchanged, and only the composed customer-visible text
      // enters the existing durable preparation / whole-message moderation /
      // final provider permit in sendPreparedText.
      const composed = await composeAiOutbound(this.dependencies.aiWrapper, {
        conversationId,
        messageId: reserved.messageId,
        generatedResponse: agentResult.replyText,
        ...(agentResult.commercePresentation ? { commercePresentation: agentResult.commercePresentation } : {}),
        ...(agentResult.hostComposedReplyCandidates
          ? { hostComposedReplyCandidates: agentResult.hostComposedReplyCandidates }
          : {}),
      });
      if (agentResult.commercePresentation?.signal?.aborted) {
        await failPrepared(reserved.messageId);
        await this.finishSuppressedTurn(conversationId, observedVersion);
        return;
      }
      if (composed.kind === "refused") {
        this.logger.warn("whatsapp.turn.ai_wrapper_refused", {
          conversationId, observedVersion, messageId: reserved.messageId,
          reason: composed.reason,
        });
        await failPrepared(reserved.messageId);
        await this.finishSuppressedTurn(conversationId, observedVersion);
        return;
      }
      if (composed.wrapper) {
        this.logger.info("whatsapp.turn.ai_wrapper_composed", {
          conversationId, observedVersion, messageId: reserved.messageId,
          wrapperDefinitionId: composed.wrapper.wrapperDefinitionId,
          localeId: composed.wrapper.localeId,
          contentHash: composed.wrapper.contentHash,
          slotEditVersion: composed.wrapper.slotEditVersion,
          applicationKey: composed.wrapper.applicationKey,
          replayed: composed.wrapper.replayed,
        });
      }

      // The BG005 database projection is asynchronous. A customer fragment or
      // takeover during rendering must not revive this obsolete response.
      if (!(await checkControl("after-await", loaded.shopId))) {
        await failPrepared(reserved.messageId);
        await this.finishSuppressedTurn(conversationId, observedVersion);
        return;
      }
      if (await this.dependencies.conversation.hasChanged(conversationId, observedVersion)) {
        await failPrepared(reserved.messageId);
        await this.dependencies.conversation.releaseTurn(conversationId, observedVersion);
        const latest = await this.dependencies.conversation.getTurnState(conversationId);
        await this.enqueue(conversationId, latest.inboundVersion);
        return;
      }

      // Carry the proposed snapshot only. The final permit transaction commits it
      // after moderation/control checks, atomically with durable message admission.
      const productContextUpdate = agentResult.productContextUpdate && agentResult.commercePresentation && !composed.wrapper?.replayed
        ? (composed.presentedPairs ? presentedProductContext(agentResult.productContextUpdate, composed.presentedPairs, this.now()) : agentResult.productContextUpdate)
        : undefined;

      const deliveryResult = await sendPreparedText({
        ...reserved,
        to: loaded.to,
        text: composed.text,
        ...(composed.recoveryShopHeader ? {recoveryShopHeader: composed.recoveryShopHeader} : {}),
        ...(composed.brandMediaPolicy ? {brandMediaPolicy:composed.brandMediaPolicy} : {}), ...(composed.deliveryPlan ? {deliveryPlan: composed.deliveryPlan,
          presentationReceipt: {shopId: loaded.shopId, conversationId, messageId: reserved.messageId, inboundVersion: observedVersion, controlRevision: controlRevision ?? -1, firstPair: composed.presentedPairs?.[0] ?? null}} : {}),
        ...(productContextUpdate ? { productContextUpdate } : {}),
      });
      await completeOwnedTurn();
      this.logger.debug("whatsapp.turn.completed", {
        conversationId,
        observedVersion,
        outcome: deliveryResult.kind === "suppressed" ? "agent-response-suppressed" : "agent-response-sent",
        ...(deliveryResult.kind === "suppressed" ? {reason: deliveryResult.reason} : {}),
      });
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      this.logger.error("whatsapp.turn.processing_failed", {
        conversationId,
        observedVersion,
        ...boundedError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
      if (admission && !providerSendAttempted && !reservationFailed) {
        try {
          await failPrepared(admission.messageId);
        } catch (cleanupError) {
          this.logger.error("whatsapp.turn.cleanup_failed", {
            conversationId, observedVersion, ...boundedError(cleanupError),
            errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            error: cleanupError,
          });
          await this.dependencies.conversation.releaseTurn(conversationId, observedVersion);
          throw new AggregateError([error, cleanupError], "AI_TURN_CLEANUP_FAILED", { cause: cleanupError });
        }
      }
      // A terminal host refusal cannot improve by replaying the same inbound.
      // The agent admission helper may already have cleaned up its reservation;
      // require confirmed cleanup, and never consume an uncertain provider send.
      if (error instanceof CommerceHostError && !error.retryable &&
          !providerSendAttempted && (!admission || reservationCleanupSucceeded)) {
        try {
          await completeOwnedTurn();
        } catch (completionError) {
          await this.dependencies.conversation.releaseTurn(conversationId, observedVersion);
          throw new AggregateError([error, completionError], "AI_TURN_TERMINAL_COMPLETION_FAILED", { cause: completionError });
        }
        this.logger.warn("whatsapp.turn.terminal_failure", {
          conversationId, observedVersion, errorCode: error.code,
          outcome: "non-retryable-agent-failure",
        });
        return;
      }
      await this.dependencies.conversation.releaseTurn(
        conversationId,
        observedVersion,
      );
      throw error;
    }
  }

  private async schedule(
    conversationId: string,
    observedVersion: number,
    delay: number,
    activeJob?: ActiveTurnJob,
  ): Promise<void> {
    const jobId = `conversation-turn__${conversationId}__${observedVersion}`;
    const boundedDelay = Math.max(0, delay);
    try {
      if (activeJob?.id === jobId) {
        await activeJob.moveToDelayed(
          Date.now() + boundedDelay,
          activeJob.token,
        );
        this.logger.debug("whatsapp.turn.rescheduled", {
          conversationId,
          observedVersion,
          jobId,
          delayMs: boundedDelay,
          schedulingMode: "active-job",
        });
        throw new DelayedError();
      }

      await this.dependencies.queue.add(
        "process-conversation-turn",
        { conversationId, observedVersion },
        {
          jobId,
          delay: boundedDelay,
          removeOnComplete: true,
        },
      );
      this.logger.debug("whatsapp.turn.scheduled", {
        conversationId,
        observedVersion,
        jobId,
        delayMs: boundedDelay,
        schedulingMode: "queue-add",
      });
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      this.logger.error("whatsapp.turn.schedule_failed", {
        conversationId,
        observedVersion,
        jobId,
        delayMs: boundedDelay,
        ...boundedError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
      throw error;
    }
  }

  private async finishSuppressedTurn(
    conversationId: string,
    observedVersion: number,
    expectedControlRevision?: number,
  ): Promise<void> {
    const completed = expectedControlRevision === undefined
      ? await this.dependencies.conversation.completeTurn(conversationId, observedVersion)
      : await this.dependencies.conversation.completeTurn(conversationId, observedVersion, expectedControlRevision);
    if (completed) return;

    if (expectedControlRevision !== undefined) {
      await this.dependencies.conversation.suppressStaleTurn(
        conversationId,
        observedVersion,
        expectedControlRevision,
      );
    }

    await this.dependencies.conversation.releaseTurn(
      conversationId,
      observedVersion,
    );
    const latest = await this.dependencies.conversation.getTurnState(
      conversationId,
    );
    if (
      latest.inboundVersion > observedVersion &&
      latest.lastProcessedVersion < latest.inboundVersion &&
      latest.pendingTurnStartedAt !== null
    ) {
      await this.enqueue(conversationId, latest.inboundVersion);
    }
  }

  private async finishInactiveTurn(
    conversationId: string,
    observedVersion: number,
    expectedControlRevision?: number,
  ): Promise<void> {
    const completed = expectedControlRevision === undefined
      ? await this.dependencies.conversation.completeTurn(conversationId, observedVersion)
      : await this.dependencies.conversation.completeTurn(conversationId, observedVersion, expectedControlRevision);
    if (!completed) {
      await this.dependencies.conversation.releaseTurn(
        conversationId,
        observedVersion,
      );
    }
  }
}

function turnStaleReason(
  state: ConversationTurnState,
  observedVersion: number,
): "newer-version-exists" | "already-processed" | "no-pending-turn" | null {
  if (observedVersion < state.inboundVersion) return "newer-version-exists";
  if (observedVersion <= state.lastProcessedVersion) return "already-processed";
  if (state.pendingTurnStartedAt === null) return "no-pending-turn";
  return null;
}

function boundedError(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return {
      errorName: error.name.slice(0, 64),
      errorMessage: error.message,
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error),
  };
}

function settleDelay(
  state: ConversationTurnState,
  now: number,
  runtimeConfig: Pick<
    BackgroundRuntimeConfigSnapshot,
    "conversationQuietWindowMs" | "conversationMaxSettleWindowMs"
  >,
): number {
  if (
    runtimeConfig.conversationMaxSettleWindowMs <
    runtimeConfig.conversationQuietWindowMs
  ) {
    throw new Error("Invalid background runtime configuration: max settle window must be at least the quiet window.");
  }
  const quietDeadline =
    (state.lastInboundAt?.getTime() ?? now) + runtimeConfig.conversationQuietWindowMs;
  const maximumDeadline =
    (state.pendingTurnStartedAt?.getTime() ?? now) + runtimeConfig.conversationMaxSettleWindowMs;
  return Math.max(0, Math.min(quietDeadline, maximumDeadline) - now);
}
