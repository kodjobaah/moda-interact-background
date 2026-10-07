import { vi } from "vitest";

import { OutboundAdmissionReservationService } from "../../../../src/services/outbound-whatsapp-admission/outbound-admission-reservation.service.js";
import { OutboundWhatsAppAdmissionService } from "../../../../src/services/outbound-whatsapp-admission.service.js";

export const baseAdmissionInput = {
  shopId: "shop-1",
  conversationId: "conversation-1",
  idempotencyKey: "outbound-1",
  senderType: "AGENT" as const,
};

export function admissionHarness({
  policy = {},
  usageRows = [],
  conversationMessages = [
    { id: "message-existing-1", conversationId: "conversation-1" },
    { id: "message-existing-2", conversationId: "conversation-1" },
  ],
  existing = null,
  provider = {},
  executionEligibility = {
    evaluate: vi.fn(async () => ({ allowed: true as const, shopId: "shop-1" })),
  },
  recoveryLinked = false,
  recoveryStatus = "DETECTED",
  durableReservation = null,
  postContractPolicy = null,
}: {
  policy?: Record<string, unknown>;
  usageRows?: Array<{ sourceType: string; quantity: number; sourceId?: string }>;
  conversationMessages?: Array<{ id: string; conversationId: string }>;
  existing?: { sourceId: string } | null;
  provider?: Record<string, unknown>;
  executionEligibility?: { evaluate: ReturnType<typeof vi.fn> };
  recoveryLinked?: boolean;
  recoveryStatus?:
    | "DETECTED"
    | "MESSAGE_SENT"
    | "ENGAGED"
    | "COMPLETED"
    | "EXPIRED"
    | "CANCELLED";
  durableReservation?: Record<string, unknown> | null;
  postContractPolicy?: Record<string, unknown> | null;
} = {}) {
  const messages = new Map<string, { id: string; content: string; status: string }>();
  const usage = [...usageRows];
  let messageNumber = 0;
  const transaction = {
    usageEvent: {
      findUnique: vi.fn().mockResolvedValue(existing),
      groupBy: vi.fn().mockImplementation(
        async ({ where }: { where?: { sourceId?: { in: string[] } } }) =>
          [
            ...usage
              .filter(
                (row) =>
                  !row.sourceId ||
                  !where?.sourceId ||
                  where.sourceId.in.includes(row.sourceId),
              )
              .reduce(
                (totals, row) =>
                  totals.set(
                    row.sourceType,
                    (totals.get(row.sourceType) ?? 0) + row.quantity,
                  ),
                new Map<string, number>(),
              ),
          ].map(([sourceType, quantity]) => ({
            sourceType,
            _sum: { quantity },
          })),
      ),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        usage.push({
          sourceType: String(data.sourceType),
          quantity: Number(data.quantity),
          sourceId: String(data.sourceId),
        });
        return { id: `usage-${usage.length}` };
      }),
      deleteMany: vi.fn(),
    },
    usageReservation: {
      findUnique: vi.fn().mockResolvedValue(durableReservation),
    },
    conversation: {
      findUnique: vi.fn().mockResolvedValue({
        shopId: recoveryLinked ? null : "shop-1",
        checkoutRecovery: recoveryLinked
          ? { shopId: "shop-1", status: recoveryStatus }
          : null,
      }),
      update: vi.fn(),
    },
    conversationMessage: {
      findMany: vi.fn().mockImplementation(
        async ({ where }: { where: { conversationId: string } }) =>
          conversationMessages
            .filter((message) => message.conversationId === where.conversationId)
            .map(({ id }) => ({ id })),
      ),
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        conversationId: "conversation-1",
        status: "PENDING",
        sentAt: null,
      })),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        const message = {
          id: `message-${++messageNumber}`,
          content: String(data.content),
          status: String(data.status),
        };
        messages.set(message.id, message);
        conversationMessages.push({
          id: message.id,
          conversationId: String(data.conversationId),
        });
        return message;
      }),
      update: vi.fn().mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const message = messages.get(where.id);
          if (message) Object.assign(message, data);
          return message;
        },
      ),
    },
  };
  const database = {
    $transaction: vi.fn().mockImplementation(async (operation: unknown) =>
      typeof operation === "function" ? operation(transaction) : undefined,
    ),
    ...transaction,
  };
  const resolver = {
    resolve: vi.fn().mockResolvedValue({
      shopId: "shop-1",
      outboundHardLimit: 3,
      terminalMessageReservedSlots: 1,
      automatedWhatsappPaused: false,
      billingPeriod: null,
      ...policy,
    }),
  };
  const postContractResolver = {
    resolve: vi.fn().mockResolvedValue(
      postContractPolicy ?? {
        mode: "POST_CONTRACT_DURABLE_CREDITS",
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        subscriptionStatus: "NO_CONTRACT",
        newRecoveriesPaused: false,
        automatedWhatsappPaused: false,
        outboundSoftLimit: 3,
        outboundHardLimit: 3,
        terminalMessageReservedSlots: 1,
        billingPeriod: null,
      },
    ),
  };
  const providerMock = {
    getProviderAccountId: vi.fn().mockReturnValue("phone-number-id"),
    sendWhatsAppText: vi.fn().mockResolvedValue({ providerMessageId: "wamid-1" }),
    sendWhatsAppTemplate: vi.fn().mockResolvedValue({ providerMessageId: "wamid-template" }),
    ...provider,
  };
  const createPolicyResolver = () => resolver;
  const createPostContractPolicyResolver = () => postContractResolver;

  return {
    database,
    transaction,
    messages,
    usage,
    resolver,
    providerMock,
    executionEligibility,
    postContractResolver,
    reservation: new OutboundAdmissionReservationService(
      database as never,
      createPolicyResolver,
      3,
      createPostContractPolicyResolver as never,
    ),
    facade: new OutboundWhatsAppAdmissionService(
      database as never,
      createPolicyResolver,
      providerMock as never,
      3,
      executionEligibility as never,
      createPostContractPolicyResolver as never,
    ),
  };
}
