import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import { EffectiveBillingPolicyResolver } from "./effective-billing-policy.service.js";
import type { BillingPolicyClient } from "./effective-billing-policy.service.js";
import { PostContractRecoveryPolicyResolver } from "./post-contract-recovery-policy.service.js";
import { shopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";
import type { ShopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";
import { whatsAppService } from "./whatsapp.service.js";
import type { SendTemplateInput, SendTextInput } from "../integration/whatsapp/types.js";
import { moderationAssessmentService, type ModerationAssessmentService } from "./conversation-moderation/moderation-assessment.service.js";
import { AiTurnOwnershipService } from "./recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "./recovery-conversation/outbound-send-fence.service.js";
import { recoveryRuntimeEligibility } from "./recovery-conversation/recovery-runtime-eligibility.service.js";
import { OutboundAdmissionReservationService } from "./outbound-whatsapp-admission/outbound-admission-reservation.service.js";
import {
  OutboundMessageDeliveryService,
  TERMINAL_MESSAGE,
  OutboundPreparationRetryError,
} from "./outbound-whatsapp-admission/outbound-message-delivery.service.js";
import type {
  InitialOutreachAdmissionScope,
  OutboundAdmissionInput,
  OutboundAdmissionResult,
} from "./outbound-whatsapp-admission/outbound-whatsapp-admission.types.js";
export type {
  InitialOutreachAdmissionScope, InitialOutreachMessageEvidence, InitialOutreachAdmissionLookup,
  OutboundAdmissionInput,
  OutboundAdmissionResult,
  OutboundSuppressionReason,
} from "./outbound-whatsapp-admission/outbound-whatsapp-admission.types.js";

import { recoveryStoredConsentService, type StoredRecoveryConsentReader } from "./recovery-conversation/recovery-stored-consent.service.js";

const MAX_TRANSACTION_RETRIES = 3;
type AdmissionDatabase = Pick<
  PrismaClient,
  | "$transaction"
  | "$queryRawUnsafe"
  | "conversation"
  | "conversationMessage"
  | "usageEvent"
  | "usageReservation"
  | "recoveryOutreachAttempt"
>;
type PolicyResolverFactory = (
  client: BillingPolicyClient,
) => Pick<EffectiveBillingPolicyResolver, "resolve">;

export class OutboundWhatsAppAdmissionService {
  private readonly reservation: OutboundAdmissionReservationService;
  private readonly delivery: OutboundMessageDeliveryService;

  constructor(
    database: AdmissionDatabase = prisma,
    createPolicyResolver: PolicyResolverFactory = (client) =>
      new EffectiveBillingPolicyResolver(client),
    provider = whatsAppService,
    maxRetries = MAX_TRANSACTION_RETRIES,
    executionEligibility: Pick<ShopExecutionEligibilityService, "evaluate"> =
      shopExecutionEligibilityService,
    createPostContractPolicyResolver = (client: Prisma.TransactionClient) =>
      new PostContractRecoveryPolicyResolver(client),
    moderation: ModerationAssessmentService = moderationAssessmentService,
    ownership = new AiTurnOwnershipService(),
    recoveryFence = new OutboundSendFenceService(undefined, recoveryRuntimeEligibility),
    recoveryConsent: StoredRecoveryConsentReader = recoveryStoredConsentService,
  ) {
    this.reservation = new OutboundAdmissionReservationService(
      database,
      createPolicyResolver,
      maxRetries,
      createPostContractPolicyResolver,
    );
    this.delivery = new OutboundMessageDeliveryService(
      database,
      provider,
      executionEligibility,
      ownership,
      recoveryFence,
      moderation,
      undefined,
      undefined,
      recoveryConsent,
    );
  }

  async getProviderAccountId(): Promise<string> {
    return this.delivery.getProviderAccountId();
  }

  async findExistingAdmission(idempotencyKey: string) {
    return this.reservation.findExistingAdmission(idempotencyKey);
  }

  inspectInitialOutreachAdmission(
    scope: InitialOutreachAdmissionScope,
  ) {
    return this.reservation.inspectInitialOutreachAdmission(scope);
  }

  async reserve(input: OutboundAdmissionInput): Promise<OutboundAdmissionResult> {
    return this.reservation.reserve(input);
  }

  async sendText(
    input: OutboundAdmissionInput & Omit<SendTextInput, "to"> & { to: string; expectedControlRevision?: number },
  ): Promise<OutboundAdmissionResult> {
    const admission = await this.reserve({ ...input, content: input.text });
    if (admission.kind !== "admitted") return admission;

    return this.sendPreparedText({
      ...admission,
      to: input.to,
      text: admission.terminal ? TERMINAL_MESSAGE : input.text,
      ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
      ...(input.expectedControlRevision === undefined ? {} : { expectedControlRevision: input.expectedControlRevision }),
      ...(input.replyToProviderMessageId
        ? { replyToProviderMessageId: input.replyToProviderMessageId }
        : {}),
    });
  }

  async resumeInitialTemplate(input: InitialOutreachAdmissionScope & {
    messageId: string;
    recoveryCreditSourceKey: string;
    template: Omit<SendTemplateInput, "to"> & { to: string; expectedControlRevision?: number };
  }): Promise<OutboundAdmissionResult> {
    const existing = await this.inspectInitialOutreachAdmission(input);
    if (existing.kind !== "prepared" || existing.message.id !== input.messageId)
      return { kind: "suppressed", reason: "duplicate" };
    return this.delivery.sendPreparedTemplate({
      kind: "admitted", shopId: input.shopId, messageId: existing.message.id,
      conversationId: existing.message.conversationId, terminal: false, executionScope: "recovery",
    }, { ...input.template, initialOutreach: input, recoveryCreditSourceKey: input.recoveryCreditSourceKey });
  }

  async sendTemplate(
    input: OutboundAdmissionInput &
      Omit<SendTemplateInput, "to"> & { to: string; expectedControlRevision?: number },
  ): Promise<OutboundAdmissionResult> {
    if (input.initialOutreach && (
      input.senderType !== "AUTOMATION" || input.shopId !== input.initialOutreach.shopId ||
      input.idempotencyKey !== `recovery-outreach:${input.initialOutreach.outreachAttemptId}` ||
      !input.recoveryCreditSourceKey
    )) return { kind: "suppressed", reason: "conversation-invalid" };
    const admission = await this.reserve(input);
    if (admission.kind !== "admitted") return admission;

    return this.delivery.sendPreparedTemplate(admission, input);
  }

  async sendPreparedText(
    input: Extract<OutboundAdmissionResult, { kind: "admitted" }> & {
      to: string;
      text: string;
      previewUrl?: boolean;
      replyToProviderMessageId?: string;
      expectedControlRevision?: number;
      expectedInboundVersion?: number;
    },
  ): Promise<OutboundAdmissionResult> {
    return this.delivery.sendPreparedText(input);
  }

  async failPrepared(messageId: string): Promise<void> {
    await this.delivery.failPrepared(messageId);
  }
}

export const outboundWhatsAppAdmissionService =
  new OutboundWhatsAppAdmissionService();

export async function runCommerceAgentAfterAdmission<TContext, TResult>({
  admission,
  to,
  context,
  runAgent,
  sendPreparedText,
  failPrepared,
}: {
  admission: Extract<OutboundAdmissionResult, { kind: "admitted" }>;
  to: string;
  context: TContext;
  runAgent: (context: TContext) => Promise<TResult>;
  sendPreparedText: (
    input: Extract<OutboundAdmissionResult, { kind: "admitted" }> & {
      to: string;
      text: string;
    },
  ) => Promise<OutboundAdmissionResult>;
  failPrepared: (messageId: string) => Promise<void>;
}): Promise<TResult | null> {
  if (admission.terminal) {
    await sendPreparedText({
      ...admission,
      to,
      text: TERMINAL_MESSAGE,
    });
    return null;
  }

  try {
    return await runAgent(context);
  } catch (error) {
    await failPrepared(admission.messageId);
    throw error;
  }
}

export { TERMINAL_MESSAGE, OutboundPreparationRetryError };
