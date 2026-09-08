import type {
  ConversationService,
  ConversationTurnState,
} from "./conversation.service.js";
import { DelayedError } from "bullmq";
import {
  runCommerceAgentAfterAdmission,
  type OutboundAdmissionResult,
} from "./outbound-whatsapp-admission.service.js";
import type { InboundAbuseAdmission } from "./inbound-whatsapp-abuse-admission.service.js";

export const QUIET_WINDOW_MS = 3_000;
export const MAX_SETTLE_WINDOW_MS = 10_000;
export const PROCESSING_LEASE_MS = 120_000;

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
  customerPhone?: string;
  conversationType?: "PRODUCT_DISCOVERY" | "PRODUCT_SUPPORT";
  checkoutRecoveryId?: string | null;
  hasReplyContext?: boolean;
  context: TContext | null;
  languageMessage: string;
  clarificationText?: string;
  handledWithoutAgent?: boolean;
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
  abuseAdmission?: {
    admitSettledTurn: (input: {
      conversationId: string;
      observedVersion: number;
      shopId: string;
      customerPhone: string;
      conversationType: "PRODUCT_DISCOVERY" | "PRODUCT_SUPPORT";
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
};

export class ConversationTurnProcessor<TContext, TResult> {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: ConversationTurnProcessorDependencies<
      TContext,
      TResult
    >,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async enqueue(
    conversationId: string,
    observedVersion: number,
  ): Promise<void> {
    const state =
      await this.dependencies.conversation.getTurnState(conversationId);
    if (!state.pendingTurnStartedAt || !state.lastInboundAt) return;

    const now = this.now().getTime();
    const delay = settleDelay(state, now);
    await this.schedule(conversationId, observedVersion, delay);
  }

  async process(
    { conversationId, observedVersion }: ConversationTurnJob,
    activeJob?: ActiveTurnJob,
  ): Promise<void> {
    const state =
      await this.dependencies.conversation.getTurnState(conversationId);
    if (isStale(state, observedVersion)) return;

    const now = this.now();
    const delay = settleDelay(state, now.getTime());
    if (delay > 0) {
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
      await this.schedule(conversationId, observedVersion, 250, activeJob);
      return;
    }

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

      if (
        this.dependencies.abuseAdmission &&
        loaded.customerPhone &&
        loaded.conversationType
      ) {
        const abuse = await this.dependencies.abuseAdmission.admitSettledTurn({
          conversationId,
          observedVersion,
          shopId: loaded.shopId,
          customerPhone: loaded.customerPhone,
          conversationType: loaded.conversationType,
          hasReplyContext: loaded.hasReplyContext ?? false,
          checkoutRecoveryId: loaded.checkoutRecoveryId ?? null,
        });
        if (abuse.kind !== "allowed") {
          await this.dependencies.conversation.completeTurn(
            conversationId,
            observedVersion,
          );
          return;
        }
      }

      if (loaded.handledWithoutAgent) {
        await this.dependencies.conversation.completeTurn(
          conversationId,
          observedVersion,
        );
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
        return;
      }
      admission = reserved;

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
        return;
      }

      const agentResult = this.dependencies.getResult(result);
      await this.dependencies.conversation.applyDetectedLanguage({
        conversationId,
        version: observedVersion,
        message: loaded.languageMessage,
        detectedLanguageTag: agentResult.detectedLanguageTag,
        detectedLanguageConfidence: agentResult.detectedLanguageConfidence,
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
        await this.enqueue(conversationId, latest.inboundVersion);
        return;
      }

      await sendPreparedText({
        ...reserved,
        to: loaded.to,
        text: agentResult.replyText,
      });
      await this.dependencies.conversation.completeTurn(
        conversationId,
        observedVersion,
      );
    } catch (error) {
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
    if (activeJob?.id === jobId) {
      await activeJob.moveToDelayed(
        Date.now() + Math.max(0, delay),
        activeJob.token,
      );
      throw new DelayedError();
    }

    await this.dependencies.queue.add(
      "process-conversation-turn",
      { conversationId, observedVersion },
      {
        jobId,
        delay: Math.max(0, delay),
        removeOnComplete: true,
      },
    );
  }
}

function isStale(
  state: ConversationTurnState,
  observedVersion: number,
): boolean {
  return (
    observedVersion < state.inboundVersion ||
    observedVersion <= state.lastProcessedVersion ||
    state.pendingTurnStartedAt === null
  );
}

function settleDelay(state: ConversationTurnState, now: number): number {
  const quietDeadline =
    (state.lastInboundAt?.getTime() ?? now) + QUIET_WINDOW_MS;
  const maximumDeadline =
    (state.pendingTurnStartedAt?.getTime() ?? now) + MAX_SETTLE_WINDOW_MS;
  return Math.max(0, Math.min(quietDeadline, maximumDeadline) - now);
}
