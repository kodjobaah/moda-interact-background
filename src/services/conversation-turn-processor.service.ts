import type {
  ConversationService,
  ConversationTurnState,
} from "./conversation.service.js";
import { DelayedError } from "bullmq";
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
      input: Admitted & { to: string; text: string },
    ) => Promise<OutboundAdmissionResult>;
    failPrepared: (messageId: string) => Promise<void>;
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
  getResult: (result: TResult) => {
    replyText: string;
    detectedLanguageTag: string | null;
    detectedLanguageConfidence: number | null;
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
      ))
    ) {
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

    let admission: Admitted | null = null;
    let providerSendAttempted = false;
    let reservationFailed = false;
    const failPrepared = async (messageId: string) => {
      reservationFailed = true;
      await this.dependencies.admission.failPrepared(messageId);
    };
    const sendPreparedText = async (
      input: Admitted & { to: string; text: string },
    ) => {
      providerSendAttempted = true;
      return this.dependencies.admission.sendPreparedText(input);
    };

    try {
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

      if (loaded.shopUnavailable) {
        await this.finishInactiveTurn(conversationId, observedVersion);
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "shop-unavailable",
        });
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
        await this.finishSuppressedTurn(conversationId, observedVersion);
        return;
      }

      if (loaded.handledWithoutAgent) {
        await this.dependencies.conversation.completeTurn(
          conversationId,
          observedVersion,
        );
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
          await this.dependencies.conversation.completeTurn(
            conversationId,
            observedVersion,
          );
          this.logger.debug("whatsapp.turn.completed", {
            conversationId,
            observedVersion,
            outcome: "clarification-suppressed",
          });
          return;
        }
        admission = clarification;
        await sendPreparedText({
          ...clarification,
          to: loaded.to,
          text: loaded.clarificationText,
        });
        await this.dependencies.conversation.completeTurn(
          conversationId,
          observedVersion,
        );
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "clarification-sent",
        });
        return;
      }

      const reserved = await this.dependencies.admission.reserve({
        shopId: loaded.shopId,
        conversationId,
        idempotencyKey: `agent:${conversationId}:${observedVersion}`,
        senderType: "AGENT",
      });
      if (reserved.kind !== "admitted") {
        await this.dependencies.conversation.completeTurn(
          conversationId,
          observedVersion,
        );
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "outbound-admission-suppressed",
        });
        return;
      }
      admission = reserved;

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
        await this.dependencies.conversation.completeTurn(
          conversationId,
          observedVersion,
        );
        this.logger.debug("whatsapp.turn.completed", {
          conversationId,
          observedVersion,
          outcome: "terminal-admission-response",
        });
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

      await sendPreparedText({
        ...reserved,
        to: loaded.to,
        text: agentResult.replyText,
      });
      await this.dependencies.conversation.completeTurn(
        conversationId,
        observedVersion,
      );
      this.logger.debug("whatsapp.turn.completed", {
        conversationId,
        observedVersion,
        outcome: "agent-response-sent",
      });
    } catch (error) {
      this.logger.error("whatsapp.turn.processing_failed", {
        conversationId,
        observedVersion,
        ...boundedError(error),
      });
      if (admission && !providerSendAttempted && !reservationFailed) {
        await failPrepared(admission.messageId).catch(() => undefined);
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
      });
      throw error;
    }
  }

  private async finishSuppressedTurn(
    conversationId: string,
    observedVersion: number,
  ): Promise<void> {
    const completed = await this.dependencies.conversation.completeTurn(
      conversationId,
      observedVersion,
    );
    if (completed) return;

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
  ): Promise<void> {
    const completed = await this.dependencies.conversation.completeTurn(
      conversationId,
      observedVersion,
    );
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
      errorMessage: error.message.slice(0, 256),
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error).slice(0, 256),
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
