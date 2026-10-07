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
import { OutboundAdmissionReservationService } from "./outbound-whatsapp-admission/outbound-admission-reservation.service.js";
import {
  OutboundMessageDeliveryService,
  TERMINAL_MESSAGE,
} from "./outbound-whatsapp-admission/outbound-message-delivery.service.js";
import type {
  OutboundAdmissionInput,
  OutboundAdmissionResult,
} from "./outbound-whatsapp-admission/outbound-whatsapp-admission.types.js";
export type {
  OutboundAdmissionInput,
  OutboundAdmissionResult,
  OutboundSuppressionReason,
} from "./outbound-whatsapp-admission/outbound-whatsapp-admission.types.js";

const MAX_TRANSACTION_RETRIES = 3;
type AdmissionDatabase = Pick<
  PrismaClient,
  | "$transaction"
  | "conversation"
  | "conversationMessage"
  | "usageEvent"
  | "usageReservation"
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
    );
  }

  getProviderAccountId(): string {
    return this.delivery.getProviderAccountId();
  }

  async findExistingAdmission(idempotencyKey: string) {
    return this.reservation.findExistingAdmission(idempotencyKey);
  }

  async reserve(input: OutboundAdmissionInput): Promise<OutboundAdmissionResult> {
    return this.reservation.reserve(input);
  }

  async sendText(
    input: OutboundAdmissionInput & Omit<SendTextInput, "to"> & { to: string },
  ): Promise<OutboundAdmissionResult> {
    const admission = await this.reserve({ ...input, content: input.text });
    if (admission.kind !== "admitted") return admission;

    return this.sendPreparedText({
      ...admission,
      to: input.to,
      text: admission.terminal ? TERMINAL_MESSAGE : input.text,
      ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
      ...(input.replyToProviderMessageId
        ? { replyToProviderMessageId: input.replyToProviderMessageId }
        : {}),
    });
  }

  async sendTemplate(
    input: OutboundAdmissionInput &
      Omit<SendTemplateInput, "to"> & { to: string },
  ): Promise<OutboundAdmissionResult> {
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

export { TERMINAL_MESSAGE };
