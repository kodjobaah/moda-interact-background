import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OutboundWhatsAppAdmissionService,
  TERMINAL_MESSAGE,
  runCommerceAgentAfterAdmission,
} from "../../../src/services/outbound-whatsapp-admission.service.js";

function harness({
  policy = {},
  usageRows = [],
  conversationMessages = [
    { id: "message-existing-1", conversationId: "conversation-1" },
    { id: "message-existing-2", conversationId: "conversation-1" },
  ],
  existing = null,
  provider = {},
}: {
  policy?: Record<string, unknown>;
  usageRows?: Array<{ sourceType: string; quantity: number; sourceId?: string }>;
  conversationMessages?: Array<{ id: string; conversationId: string }>;
  existing?: { sourceId: string } | null;
  provider?: Record<string, unknown>;
} = {}) {
  const messages = new Map<string, { id: string; content: string; status: string }>();
  const usage = [...usageRows];
  let messageNumber = 0;
  const transaction = {
    usageEvent: {
      findUnique: vi.fn().mockResolvedValue(existing),
      groupBy: vi.fn().mockImplementation(async ({ where }: { where?: { sourceId?: { in: string[] } } }) =>
        [...usage
          .filter((row) => !row.sourceId || !where?.sourceId || where.sourceId.in.includes(row.sourceId))
          .reduce((totals, row) => totals.set(
            row.sourceType,
            (totals.get(row.sourceType) ?? 0) + row.quantity,
          ), new Map<string, number>())]
          .map(([sourceType, quantity]) => ({
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
    conversation: {
      findUnique: vi.fn().mockResolvedValue({
        shopId: "shop-1",
        checkoutRecovery: null,
      }),
      update: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "conversation-new" }),
    },
    conversationMessage: {
      findMany: vi.fn().mockImplementation(async ({ where }: { where: { conversationId: string } }) =>
        conversationMessages
          .filter((message) => message.conversationId === where.conversationId)
          .map(({ id }) => ({ id })),
      ),
      findUnique: vi.fn().mockResolvedValue({ conversationId: "conversation-1" }),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        const message = { id: `message-${++messageNumber}`, content: String(data.content), status: String(data.status) };
        messages.set(message.id, message);
        conversationMessages.push({ id: message.id, conversationId: String(data.conversationId) });
        return message;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const message = messages.get(where.id);
        if (message) Object.assign(message, data);
        return message;
      }),
    },
  };
  const database = {
    $transaction: vi.fn().mockImplementation(async (operation: unknown) =>
      typeof operation === "function" ? operation(transaction) : undefined,
    ),
    ...transaction,
  };
  const resolver = { resolve: vi.fn().mockResolvedValue({
    shopId: "shop-1",
    outboundHardLimit: 3,
    terminalMessageReservedSlots: 1,
    automatedWhatsappPaused: false,
    billingPeriod: null,
    ...policy,
  }) };
  const providerMock = {
    sendWhatsAppText: vi.fn().mockResolvedValue({ providerMessageId: "wamid-1" }),
    sendWhatsAppTemplate: vi.fn().mockResolvedValue({ providerMessageId: "wamid-template" }),
    ...provider,
  };

  return {
    database,
    transaction,
    messages,
    usage,
    resolver,
    providerMock,
    service: new OutboundWhatsAppAdmissionService(
      database as never,
      () => resolver,
      providerMock as never,
    ),
  };
}

const baseInput = {
  shopId: "shop-1",
  conversationId: "conversation-1",
  idempotencyKey: "outbound-1",
  senderType: "AGENT" as const,
  to: "+15551234567",
  text: "Hello",
};

describe("OutboundWhatsAppAdmissionService", () => {
  it("keeps low-level WhatsApp transport imports inside the admission boundary", () => {
    for (const relativePath of [
      "src/workers/whatsapp.worker.ts",
      "src/services/checkout-recovery.service.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source).not.toMatch(/from ["'][.\/]+whatsapp\.service\.js["']/);
      expect(source).not.toMatch(/whatsAppService\.sendWhatsApp(?:Text|Template)/);
    }
  });

  it("persists a normal intent before sending and records success", async () => {
    const test = harness();

    const result = await test.service.sendText(baseInput);

    expect(result).toMatchObject({ kind: "admitted", terminal: false });
    expect(test.transaction.conversationMessage.create).toHaveBeenCalledBefore(
      test.providerMock.sendWhatsAppText,
    );
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: baseInput.to,
      text: baseInput.text,
    });
    expect(test.messages.get("message-1")).toMatchObject({ status: "SENT", content: "Hello" });
  });

  it("does not count inbound or other metrics and reserves the terminal slot exactly once", async () => {
    const test = harness({
      usageRows: [
        { sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 2 },
        { sourceType: "CUSTOMER_INBOUND", quantity: 99 },
      ],
    });

    const terminal = await test.service.sendText(baseInput);
    const duplicateTerminal = await test.service.sendText({
      ...baseInput,
      idempotencyKey: "outbound-2",
    });

    expect(terminal).toMatchObject({ kind: "admitted", terminal: true });
    expect(test.messages.get("message-1")?.content).toBe(TERMINAL_MESSAGE);
    expect(duplicateTerminal).toEqual({ kind: "suppressed", reason: "terminal-already-used" });
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledTimes(1);
  });

  it("forces terminal prepared text even when the caller supplies an ordinary reply", async () => {
    const test = harness();

    await test.service.sendPreparedText({
      kind: "admitted",
      messageId: "message-existing-1",
      conversationId: "conversation-1",
      terminal: true,
      to: baseInput.to,
      text: "ordinary agent reply",
    });

    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: baseInput.to,
      text: TERMINAL_MESSAGE,
    });
    expect(test.database.conversationMessage.update).toHaveBeenCalledWith({
      where: { id: "message-existing-1" },
      data: { content: TERMINAL_MESSAGE },
    });
  });

  it("uses deterministic terminal text instead of a template transport", async () => {
    const test = harness({
      usageRows: [
        { sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 2 },
      ],
    });

    await test.service.sendTemplate({
      ...baseInput,
      idempotencyKey: "terminal-template",
      templateName: "recovery",
      languageCode: "en",
    });

    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: baseInput.to,
      text: TERMINAL_MESSAGE,
    });
  });

  it.each([
    ["recovery", { recovery: true }],
    ["product", { recovery: false }],
  ])("does not invoke the CommerceAgent for a terminal %s admission", async (_label, context) => {
    const runAgent = vi.fn().mockResolvedValue({ replyText: "ordinary reply" });
    const sendPreparedText = vi.fn().mockResolvedValue({
      kind: "admitted",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: true,
    });
    const admission = {
      kind: "admitted" as const,
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: true,
    };

    await expect(runCommerceAgentAfterAdmission({
      admission,
      to: baseInput.to,
      context,
      runAgent,
      sendPreparedText,
      failPrepared: vi.fn(),
    })).resolves.toBeNull();

    expect(runAgent).not.toHaveBeenCalled();
    expect(sendPreparedText).toHaveBeenCalledWith({
      ...admission,
      to: baseInput.to,
      text: TERMINAL_MESSAGE,
    });
  });

  it("keeps outbound capacity independent between conversations", async () => {
    const test = harness({
      policy: { outboundHardLimit: 3, terminalMessageReservedSlots: 1 },
      conversationMessages: [
        { id: "a-1", conversationId: "conversation-a" },
        { id: "a-2", conversationId: "conversation-a" },
        { id: "b-1", conversationId: "conversation-b" },
      ],
      usageRows: [
        { sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1, sourceId: "a-1" },
        { sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1, sourceId: "a-2" },
      ],
    });
    test.transaction.conversation.findUnique.mockResolvedValue({
      shopId: "shop-1",
      checkoutRecovery: null,
    });

    const conversationA = await test.service.sendText({
      ...baseInput,
      conversationId: "conversation-a",
      idempotencyKey: "conversation-a-next",
    });
    const conversationB = await test.service.sendText({
      ...baseInput,
      conversationId: "conversation-b",
      idempotencyKey: "conversation-b-first",
    });

    expect(conversationA).toMatchObject({ kind: "admitted", terminal: true });
    expect(conversationB).toMatchObject({ kind: "admitted", terminal: false });
  });

  it("accumulates repeated sends only within one conversation", async () => {
    const test = harness({
      policy: { outboundHardLimit: 4, terminalMessageReservedSlots: 1 },
    });

    const results = [];
    for (const idempotencyKey of ["repeat-1", "repeat-2", "repeat-3", "repeat-4"]) {
      results.push(await test.service.sendText({ ...baseInput, idempotencyKey }));
    }

    expect(results.slice(0, 3)).toEqual([
      expect.objectContaining({ kind: "admitted", terminal: false }),
      expect.objectContaining({ kind: "admitted", terminal: false }),
      expect.objectContaining({ kind: "admitted", terminal: false }),
    ]);
    expect(results[3]).toMatchObject({ kind: "admitted", terminal: true });
  });

  it("suppresses paused and duplicate sends before provider invocation", async () => {
    const paused = harness({ policy: { automatedWhatsappPaused: true } });
    expect(await paused.service.sendText(baseInput)).toEqual({ kind: "suppressed", reason: "paused" });
    expect(paused.providerMock.sendWhatsAppText).not.toHaveBeenCalled();

    const duplicate = harness({ existing: { sourceId: "message-existing" } });
    expect(await duplicate.service.sendText(baseInput)).toEqual({ kind: "suppressed", reason: "duplicate" });
    expect(duplicate.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("counts only usage sourced from the target conversation and rejects another shop", async () => {
    const test = harness({
      policy: { outboundHardLimit: 4, terminalMessageReservedSlots: 1 },
      usageRows: [{ sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 2 }],
    });

    await test.service.sendText(baseInput);

    expect(test.transaction.usageEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: { in: ["message-existing-1", "message-existing-2"] },
        }),
      }),
    );

    test.transaction.conversation.findUnique.mockResolvedValue({
      shopId: "shop-other",
      checkoutRecovery: null,
    });
    const rejected = await test.service.sendText({
      ...baseInput,
      idempotencyKey: "outbound-other-shop",
    });
    expect(rejected).toEqual({ kind: "suppressed", reason: "conversation-invalid" });
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledTimes(1);
  });

  it("removes definitive failures but preserves ambiguous pending intent", async () => {
    const definitiveError = Object.assign(new Error("rejected"), {
      name: "WhatsAppServiceError",
      code: "provider-rejected",
    });
    const definitive = harness({
      provider: { sendWhatsAppText: vi.fn().mockRejectedValue(definitiveError) },
    });
    await expect(definitive.service.sendText(baseInput)).rejects.toThrow("rejected");
    expect(definitive.transaction.usageEvent.deleteMany).toHaveBeenCalled();
    expect(definitive.messages.get("message-1")).toMatchObject({ status: "FAILED" });

    const ambiguousError = Object.assign(new Error("unknown"), {
      name: "WhatsAppServiceError",
      code: "invalid-provider-response",
    });
    const ambiguous = harness({
      provider: { sendWhatsAppText: vi.fn().mockRejectedValue(ambiguousError) },
    });
    await expect(ambiguous.service.sendText(baseInput)).rejects.toThrow("unknown");
    expect(ambiguous.transaction.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(ambiguous.messages.get("message-1")).toMatchObject({ status: "PENDING" });

    const unknown = harness({
      provider: { sendWhatsAppText: vi.fn().mockRejectedValue(new Error("socket closed")) },
    });
    await expect(unknown.service.sendText(baseInput)).rejects.toThrow("socket closed");
    expect(unknown.transaction.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(unknown.messages.get("message-1")).toMatchObject({ status: "PENDING" });
  });
});