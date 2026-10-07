import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { TERMINAL_MESSAGE } from "../../../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import {
  admissionHarness,
  baseAdmissionInput,
} from "./outbound-admission.test-support.js";

describe("OutboundAdmissionReservationService", () => {
  it("rejects an incomplete admission identity", async () => {
    const test = admissionHarness();

    await expect(
      test.reservation.reserve({
        ...baseAdmissionInput,
        shopId: " ",
      }),
    ).rejects.toThrow(
      "Outbound WhatsApp admission requires shopId, conversationId and idempotencyKey",
    );
  });


  it("retries a serializable P2034 conflict without widening the retry scope", async () => {
    const test = admissionHarness();
    const conflict = new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "test",
    });
    const execute = test.database.$transaction.getMockImplementation();
    test.database.$transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementation(execute!);

    await expect(test.reservation.reserve(baseAdmissionInput)).resolves.toMatchObject({
      kind: "admitted",
      messageId: "message-1",
    });
    expect(test.database.$transaction).toHaveBeenCalledTimes(2);
  });

  it("finds an existing durable admission by idempotency key", async () => {
    const test = admissionHarness({ existing: { sourceId: "message-existing" } });

    await expect(
      test.reservation.findExistingAdmission("outbound-existing"),
    ).resolves.toMatchObject({
      id: "message-existing",
      conversationId: "conversation-1",
      status: "PENDING",
    });
  });

  it("suppresses a duplicate before creating another message", async () => {
    const test = admissionHarness({ existing: { sourceId: "message-existing" } });

    await expect(test.reservation.reserve(baseAdmissionInput)).resolves.toEqual({
      kind: "suppressed",
      reason: "duplicate",
    });

    expect(test.transaction.conversationMessage.create).not.toHaveBeenCalled();
    expect(test.transaction.usageEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a conversation owned by another shop", async () => {
    const test = admissionHarness();
    test.transaction.conversation.findUnique.mockResolvedValue({
      shopId: "shop-other",
      checkoutRecovery: null,
    });

    await expect(test.reservation.reserve(baseAdmissionInput)).resolves.toEqual({
      kind: "suppressed",
      reason: "conversation-invalid",
    });
  });

  it("suppresses admission while automated WhatsApp is paused", async () => {
    const test = admissionHarness({ policy: { automatedWhatsappPaused: true } });

    await expect(test.reservation.reserve(baseAdmissionInput)).resolves.toEqual({
      kind: "suppressed",
      reason: "paused",
    });
    expect(test.transaction.conversationMessage.create).not.toHaveBeenCalled();
  });

  it("persists PENDING message and usage intent in the same serializable admission", async () => {
    const test = admissionHarness({
      policy: { billingPeriod: { id: "billing-period-1" } },
    });

    await expect(
      test.reservation.reserve({ ...baseAdmissionInput, content: "Hello" }),
    ).resolves.toMatchObject({
      kind: "admitted",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: false,
      executionScope: "general",
    });

    expect(test.database.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    );
    expect(test.transaction.conversationMessage.create).toHaveBeenCalledWith({
      data: {
        conversationId: "conversation-1",
        direction: "OUTBOUND",
        senderType: "AGENT",
        status: "PENDING",
        content: "Hello",
      },
      select: { id: true },
    });
    expect(test.transaction.usageEvent.create).toHaveBeenCalledWith({
      data: {
        shopId: "shop-1",
        metric: "OUTBOUND_AUTOMATED_MESSAGE",
        quantity: 1,
        idempotencyKey: "outbound-1",
        sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
        sourceId: "message-1",
        billingPeriodId: "billing-period-1",
      },
    });
  });

  it("reserves the terminal slot once and persists deterministic terminal content", async () => {
    const test = admissionHarness({
      usageRows: [
        { sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 2 },
      ],
    });

    const terminal = await test.reservation.reserve(baseAdmissionInput);
    const duplicateTerminal = await test.reservation.reserve({
      ...baseAdmissionInput,
      idempotencyKey: "outbound-2",
    });

    expect(terminal).toMatchObject({ kind: "admitted", terminal: true });
    expect(test.messages.get("message-1")?.content).toBe(TERMINAL_MESSAGE);
    expect(duplicateTerminal).toEqual({
      kind: "suppressed",
      reason: "terminal-already-used",
    });
  });

  it("counts automated outbound usage only for the target conversation", async () => {
    const test = admissionHarness({
      policy: { outboundHardLimit: 4, terminalMessageReservedSlots: 1 },
      conversationMessages: [
        { id: "a-1", conversationId: "conversation-a" },
        { id: "a-2", conversationId: "conversation-a" },
        { id: "b-1", conversationId: "conversation-b" },
      ],
      usageRows: [
        { sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1, sourceId: "a-1" },
        { sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1, sourceId: "a-2" },
        { sourceType: "CUSTOMER_INBOUND", quantity: 100, sourceId: "b-1" },
      ],
    });
    test.transaction.conversation.findUnique.mockResolvedValue({
      shopId: "shop-1",
      checkoutRecovery: null,
    });

    const conversationA = await test.reservation.reserve({
      ...baseAdmissionInput,
      conversationId: "conversation-a",
      idempotencyKey: "conversation-a-next",
    });
    const conversationB = await test.reservation.reserve({
      ...baseAdmissionInput,
      conversationId: "conversation-b",
      idempotencyKey: "conversation-b-first",
    });

    expect(conversationA).toMatchObject({ kind: "admitted", terminal: false });
    expect(conversationB).toMatchObject({ kind: "admitted", terminal: false });
    expect(test.transaction.usageEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: { in: ["a-1", "a-2"] },
        }),
      }),
    );
  });
});
