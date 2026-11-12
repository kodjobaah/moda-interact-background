import {Prisma} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({ records: [] as unknown[] }));
vi.mock("@modainteract/moda-interact-shared/logging", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@modainteract/moda-interact-shared/logging")>();
  return { ...shared, createLogger: (options: Parameters<typeof shared.createLogger>[0]) =>
    shared.createLogger({ ...options, sink: (record) => {
      capture.records.push(JSON.parse(JSON.stringify(record)));
    } }) };
});

import {
  OutboundMessageDeliveryService, OutboundPreparationRetryError,
  TERMINAL_MESSAGE,
} from "../../../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { RECOVERY_CHECKOUT_SEPARATOR } from "../../../../src/services/conversation-wrappers/recovery-checkout-footer.js";
import { prepareAutomatedTemplateInput } from "../../../../src/services/conversation-moderation/automated-template-input.js";

function harness({
  provider = {},
  executionEligibility = {
    evaluate: vi.fn(async () => ({ allowed: true as const, shopId: "shop-1" })),
  },
  moderationOutcome = "allow",
  currentAllowance = true,
  generalFence,
  wooFence,
  recoveryFence,
  ownership,
  footerContext,
}: {
  provider?: Record<string, unknown>;
  executionEligibility?: { evaluate: ReturnType<typeof vi.fn> };
  moderationOutcome?: "allow" | "block" | "retry";
  currentAllowance?: boolean;
  generalFence?: { admitFinalSend: ReturnType<typeof vi.fn> };
  wooFence?: { admitFinalSend: ReturnType<typeof vi.fn> };
  recoveryFence?: { admitFinalSend: ReturnType<typeof vi.fn> };
  ownership?: { readTurnOwnership: ReturnType<typeof vi.fn> };
  footerContext?: { loadContext: ReturnType<typeof vi.fn> };
} = {}) {
  let currentText = "Hello";
  const conversationMessageUpdate = vi.fn().mockImplementation(async ({ data }: { data: { content?: string } }) => {
    if (typeof data.content === "string") currentText = data.content;
    return {};
  });
  const conversationMessageFindUnique = vi.fn().mockImplementation(async () => ({
    conversationId: "conversation-1", senderType: "AGENT", direction: "OUTBOUND", content: currentText,
    conversation: { shopId: "shop-1", checkoutRecovery: null },
    status: "PENDING", outboundPresentation: {equals:Prisma.DbNull}, providerDispatchKey: null, providerDispatchAdmittedAt: null,
  }));
  const conversationUpdate = vi.fn().mockResolvedValue({});
  const usageDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const queryRawUnsafe = vi.fn(async (statement: string): Promise<Array<Record<string, unknown>>> => {
    if (statement.includes('FROM "commerce"."Shop"') && statement.includes('FOR UPDATE'))
      return [{ status: "ACTIVE" }];
    if (statement.includes('FROM "whatsapp"."Conversation"'))
      return [{ controlRevision: 0 }];
    if (statement.includes('FROM "whatsapp"."ConversationMessage"'))
      return [{ status: "PENDING", content: currentText,
        providerDispatchKey: null, providerDispatchAdmittedAt: null }];
    if (statement.includes('UPDATE "whatsapp"."ConversationMessage"'))
      return [{ id: "message-1" }];
    return [];
  });
  const transaction = {
    $queryRawUnsafe: queryRawUnsafe,
    conversationMessage: {
      update: conversationMessageUpdate,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: conversationMessageFindUnique,
    },
    conversation: { update: conversationUpdate },
    usageEvent: { deleteMany: usageDeleteMany, findMany: vi.fn().mockResolvedValue([
      { id: "usage-1", shopId: "shop-1", sourceId: "message-1", quantity: 1, idempotencyKey: "general" },
    ]) },
  };
  const database = {
    $queryRawUnsafe: queryRawUnsafe,
    $transaction: vi.fn().mockImplementation(async (operation: unknown) =>
      typeof operation === "function" ? operation(transaction) : undefined,
    ),
    conversationMessage: { update: conversationMessageUpdate, findUnique: conversationMessageFindUnique },
    usageEvent: { deleteMany: usageDeleteMany },
    conversation: { update: conversationUpdate },
  };
  const providerMock = {
    getProviderAccountId: vi.fn().mockReturnValue("phone-number-id"),
    sendWhatsAppText: vi.fn().mockResolvedValue({ providerMessageId: "wamid-1" }),
    sendWhatsAppTemplate: vi
      .fn()
      .mockResolvedValue({ providerMessageId: "wamid-template" }),
    ...provider,
  };

  const moderationMock = {
    assessText: vi.fn(async () => moderationOutcome === "retry"
      ? { kind: moderationOutcome, assessmentId: "assessment-1", retryAt: new Date("2026-11-04T01:00:00Z") }
      : { kind: moderationOutcome }),
    requireCurrentAllowance: vi.fn(async () => currentAllowance),
  };
  return {
    database,
    transaction,
    providerMock,
    executionEligibility, moderationMock,
    service: new OutboundMessageDeliveryService(
      database as never,
      providerMock as never,
      executionEligibility as never,
      (ownership ?? { readTurnOwnership: vi.fn(async () => null) }) as never,
      recoveryFence as never,
      moderationMock as never,
      undefined, // providerFailure uses its production adapter
      generalFence as never, undefined, wooFence as never, footerContext as never,
    ),
  };
}

const admission = {
  kind: "admitted" as const,
  shopId: "shop-1",
  messageId: "message-1",
  conversationId: "conversation-1",
  terminal: false,
  executionScope: "general" as const,
};

const wooTemplate = {
  to: "+447400123456", templateName: "recovery", languageCode: "en",
  bodyParameters: ["Fixture shop"],
  templateRegistration: {
    shopId: "shop-1", senderWabaId: "phone-number-id", purpose: "INITIAL_NO_OFFER" as const,
    variantId: "variant", registrationId: "registration", definitionId: "definition",
    providerTemplateId: "provider", providerTemplateName: "recovery", providerLanguageCode: "en",
    submittedContentHash: "a".repeat(64), bindingFingerprint: "b".repeat(64),
  },
};
const wooScope = { recoveryId: "recovery-1", attemptId: "attempt-1" } as
  Parameters<OutboundMessageDeliveryService["sendPreparedWooInitialTemplate"]>[2];

describe("scoped initial template diagnostics", () => {
  const permit = () => ({ admitFinalSend: vi.fn().mockResolvedValue({ kind: "admitted" }) });

  it.each(["preparation", "moderation"] as const)("emits the original %s failure safely", async (stage) => {
    capture.records.length = 0;
    const wooFence = permit();
    const test = harness({ wooFence });
    const marker = `distinct ${stage} failure marker`;
    const error = new Error(`${marker} +447400123456`);
    const template = { ...wooTemplate };
    if (stage === "preparation") {
      Object.defineProperty(template, "bodyParameters", { get: () => { throw error; } });
    } else {
      test.moderationMock.assessText.mockRejectedValueOnce(error);
    }
    await expect(test.service.sendPreparedWooInitialTemplate(admission, template, wooScope)).rejects.toBe(error);
    expect(wooFence.admitFinalSend).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(capture.records).toContainEqual(expect.objectContaining({
      event: `outbound.template.${stage}.failed`, level: "error",
      data: expect.objectContaining({
        stage, shopId: "shop-1", conversationId: "conversation-1", messageId: "message-1",
        recoveryId: "recovery-1", attemptId: "attempt-1",
        sourceError: expect.objectContaining({ message: expect.stringContaining(marker), redactionApplied: true }),
      }),
    }));
    expect(JSON.stringify(capture.records)).not.toMatch(/447400123456|provider_http|providerError/);
  });

  it("preserves the prepared message for typed moderation retry", async () => {
    capture.records.length = 0;
    const test = harness({ moderationOutcome: "retry", wooFence: permit() });
    await expect(test.service.sendPreparedWooInitialTemplate(admission, wooTemplate, wooScope))
      .rejects.toMatchObject({ name: OutboundPreparationRetryError.name, assessmentId: "assessment-1" });
    expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(JSON.stringify(capture.records)).toContain("assessment-1");
  });

  it("emits receipt failure without reclassifying it as provider HTTP rejection", async () => {
    capture.records.length = 0;
    const test = harness({ wooFence: permit() });
    const error = new Error("distinct receipt failure marker");
    test.database.$transaction.mockRejectedValueOnce(error);
    await expect(test.service.sendPreparedWooInitialTemplate(admission, wooTemplate, wooScope)).rejects.toBe(error);
    expect(test.providerMock.sendWhatsAppTemplate).toHaveBeenCalledOnce();
    expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(capture.records).toContainEqual(expect.objectContaining({
      event: "outbound.initial.send.failed", level: "error",
      data: expect.objectContaining({
        stage: "receipt_persistence", messageId: "message-1", attemptId: "attempt-1",
        sourceError: expect.objectContaining({ message: "distinct receipt failure marker" }),
      }),
    }));
    expect(JSON.stringify(capture.records)).not.toContain("provider_http");
  });

  it("preserves both original provider and reconciliation failures", async () => {
    capture.records.length = 0;
    const error = Object.assign(new Error("distinct provider failure marker"), {
      name: "WhatsAppServiceError", code: "provider-rejected", providerCode: "2",
    });
    const reconciliation = new Error("distinct reconciliation failure marker");
    const test = harness({
      wooFence: permit(), provider: { sendWhatsAppTemplate: vi.fn().mockRejectedValue(error) },
    });
    test.database.$transaction.mockRejectedValueOnce(reconciliation);
    await expect(test.service.sendPreparedWooInitialTemplate(admission, wooTemplate, wooScope))
      .rejects.toMatchObject({ errors: [error, reconciliation] });
    expect(capture.records).toContainEqual(expect.objectContaining({
      event: "outbound.initial.cleanup.failed",
      data: expect.objectContaining({
        sendError: expect.objectContaining({ message: "distinct provider failure marker" }),
        reconciliationError: expect.objectContaining({ message: "distinct reconciliation failure marker" }),
      }),
    }));
  });
});

describe("OutboundMessageDeliveryService", () => {
  it("moderates all BG008 rendered text before admitting a provider send", async () => {
    const test = harness({ moderationOutcome: "block" });
    const composed = "Forbidden content from a published wrapper. Harmless AI answer.";
    const decision = await test.service.sendPreparedText({
      ...admission, to: "+14155552671", text: composed,
    });
    expect(test.moderationMock.assessText).toHaveBeenCalledWith(expect.objectContaining({
      effectiveText: composed, inputKind: "TEXT",
      subject: { kind: "AGENT_MESSAGE", messageId: "message-1" },
    }));
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
    expect(decision).toEqual({ kind: "suppressed", reason: "conversation-invalid" });
    expect(test.database.conversationMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { content: composed },
    }));
  });

  it("sends exactly the approved full BG008 message, not only the model fragment", async () => {
    const test = harness();
    const composed = "Welcome. Harmless AI answer. Thank you.";
    await test.service.sendPreparedText({ ...admission, to: "+14155552671", text: composed });
    expect(test.moderationMock.assessText).toHaveBeenCalledWith(expect.objectContaining({
      effectiveText: composed,
    }));
    expect(test.moderationMock.requireCurrentAllowance).toHaveBeenCalledWith(expect.objectContaining({
      effectiveText: composed,
    }));
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledExactlyOnceWith({
      to: "+14155552671", text: composed,
    });
  });
  it("blocks prepared AI/automation messages when the recipient has locally stopped", async () => {
    const test = harness();
    test.database.$queryRawUnsafe.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM "commerce"."Shop"')) return [{ status: "ACTIVE" }];
      if (statement.includes('FROM "whatsapp"."Conversation"')) return [{ controlRevision: 0 }];
      if (statement.includes('FROM "whatsapp"."ConversationMessage"')) return [{
        status: "PENDING", content: "Don't send this",
        providerDispatchKey: null, providerDispatchAdmittedAt: null,
      }];
      if (statement.includes('FROM "commerce"."CustomerPhone"')) return [{
        phone: "+447400123456", whatsappCanonicalPhone: "447400123456",
        defaultCountryCode: "GB",
      }];
      return [];
    });
    await expect(test.service.sendPreparedText({
      ...admission, to: "+447400123456", text: "Don't send this",
    })).resolves.toEqual({ kind: "suppressed", reason: "conversation-invalid" });
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
    expect(test.transaction.conversationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "message-1", status: "PENDING" }), data: { status: "FAILED" },
    }));
  });

  it.each(["text", "template"])(
    "serializes general %s provider admission with STOP using Shop-first SQL",
    async (kind) => {
      const test = harness();
      const result = kind === "text"
        ? await test.service.sendPreparedText({ ...admission, to: "+14155552671", text: "Hello" })
        : await test.service.sendPreparedTemplate(admission, {
          to: "+14155552671", templateName: "support", languageCode: "en",
        });
      expect(result.kind).toBe("admitted");
      const statements = test.database.$queryRawUnsafe.mock.calls.map(([sql]) => String(sql));
      const shop = statements.findIndex((sql) => sql.includes('"commerce"."Shop"') && sql.includes("FOR UPDATE"));
      const conversation = statements.findIndex((sql) => sql.includes('"whatsapp"."Conversation"') && sql.includes("FOR UPDATE"));
      const message = statements.findIndex((sql) => sql.includes('FROM "whatsapp"."ConversationMessage"') && sql.includes("FOR UPDATE"));
      const stopCheck = statements.findIndex((sql) => sql.includes('"commerce"."CustomerPhone"'));
      const permit = statements.findIndex((sql) => sql.includes('UPDATE "whatsapp"."ConversationMessage"'));
      expect([shop, conversation, message, stopCheck, permit].every((i) => i >= 0)).toBe(true);
      expect(shop).toBeLessThan(conversation);
      expect(conversation).toBeLessThan(message);
      expect(message).toBeLessThan(stopCheck);
      expect(stopCheck).toBeLessThan(permit);
      expect(test.database.$transaction).toHaveBeenCalled();
      expect(kind === "text" ? test.providerMock.sendWhatsAppText : test.providerMock.sendWhatsAppTemplate)
        .toHaveBeenCalledOnce();
    },
  );

  it.each(["text", "template"])(
    "does not re-prepare or release an already admitted %s message", async (kind) => {
      const test = harness();
      test.database.conversationMessage.findUnique.mockResolvedValue({
        conversationId: "conversation-1", senderType: "AGENT", content: "Original approved text",
        status: "PENDING", providerDispatchKey: "arch045-general-existing",
        providerDispatchAdmittedAt: new Date(),
      });
      const result = kind === "text"
        ? await test.service.sendPreparedText({
          ...admission, to: "+447400123456", text: "Changed text",
        })
        : await test.service.sendPreparedTemplate(admission, {
          to: "+447400123456", templateName: "changed", languageCode: "en",
        });
      expect(result).toEqual({ kind: "suppressed", reason: "duplicate" });
      expect(test.database.conversationMessage.update).not.toHaveBeenCalled();
      expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
      expect(test.moderationMock.assessText).not.toHaveBeenCalled();
      expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
      expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    },
  );

  it("uses the injected general fence and preserves an already-admitted message", async () => {
    const generalFence = { admitFinalSend: vi.fn(async () => ({
      kind: "suppressed", reason: "already-admitted-or-sent",
    })) };
    const test = harness({ generalFence });
    expect(await test.service.sendPreparedText({
      ...admission, to: "+447400123456", text: "Prepared text",
    })).toEqual({ kind: "suppressed", reason: "duplicate" });
    expect(generalFence.admitFinalSend).toHaveBeenCalledOnce();
    expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("forwards the original inbound version into the final general send permit", async () => {
    const generalFence = { admitFinalSend: vi.fn(async () => ({ kind: "admitted" as const })) };
    const test = harness({ generalFence });

    await test.service.sendPreparedText({
      ...admission, to: "+14155552671", text: "Prepared text", expectedInboundVersion: 3,
    });

    expect(generalFence.admitFinalSend).toHaveBeenCalledWith(expect.objectContaining({
      expectedInboundVersion: 3,
    }));
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledOnce();
  });

  it("suppresses a prepared text when admission wins the content-update race", async () => {
    const test = harness();
    test.database.conversationMessage.update.mockRejectedValueOnce(
      Object.assign(new Error("no matching unadmitted message"), { code: "P2025" }),
    );
    expect(await test.service.sendPreparedText({
      ...admission, to: "+447400123456", text: "Stale response",
    })).toEqual({ kind: "suppressed", reason: "duplicate" });
    expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("delegates provider account identity", async () => {
    const test = harness();

    await expect(test.service.getProviderAccountId()).resolves.toBe("phone-number-id");
    expect(test.providerMock.getProviderAccountId).toHaveBeenCalledOnce();
  });

  it("revalidates and forwards prepared text context before persisting SENT", async () => {
    const test = harness();

    await expect(
      test.service.sendPreparedText({
        ...admission,
        to: "+15551234567",
        text: "Hello",
        previewUrl: true,
        replyToProviderMessageId: "wamid-inbound",
      }),
    ).resolves.toMatchObject({ kind: "admitted", terminal: false });

    expect(test.executionEligibility.evaluate).toHaveBeenCalledWith("shop-1");
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(1, {
      where: { id: "message-1", AND: {
        status: "PENDING", outboundPresentation: {equals:Prisma.DbNull}, providerDispatchKey: null, providerDispatchAdmittedAt: null,
      } },
      data: { content: "Hello" },
    });
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: "+15551234567",
      text: "Hello",
      previewUrl: true,
      replyToProviderMessageId: "wamid-inbound",
    });
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "message-1", AND: expect.objectContaining({
          conversationId: "conversation-1", status: "PENDING",
          providerDispatchAdmittedAt: { not: null },
        }) },
        data: expect.objectContaining({
          providerMessageId: "wamid-1",
          status: "SENT",
          sentAt: expect.any(Date),
        }),
      }),
    );
    expect(test.transaction.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { lastMessageAt: expect.any(Date) },
    });
  });

  it("propagates receipt persistence failure without treating it as provider rejection", async () => {
    const test = harness();
    const failure = new Error("receipt database write failed");
    test.database.conversationMessage.update.mockResolvedValueOnce({});
    test.database.conversationMessage.update.mockRejectedValueOnce(failure);

    await expect(test.service.sendPreparedText({
      ...admission, to: "+15551234567", text: "Hello",
    })).rejects.toBe(failure);
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(test.database.conversationMessage.update).toHaveBeenCalledTimes(2);
    expect(test.transaction.conversation.update.mock.invocationCallOrder[0])
      .toBeLessThan(test.database.conversationMessage.update.mock.invocationCallOrder[1]!);
  });

  it("uses recovery execution scope immediately before provider delivery", async () => {
    const test = harness();

    await test.service.sendPreparedText({
      ...admission,
      executionScope: "recovery",
      to: "+15551234567",
      text: "Recovery reply",
    });

    expect(test.executionEligibility.evaluate).toHaveBeenCalledWith(
      "shop-1",
      undefined,
      "recovery",
    );
  });

  it("does not fall back to general dispatch when recovery ownership is missing", async () => {
    const test = harness();
    await expect(test.service.sendPreparedText({
      ...admission, executionScope: "recovery", to: "+15551234567", text: "Recovery reply",
    })).resolves.toEqual({ kind: "suppressed", reason: "conversation-invalid" });
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("forces deterministic terminal text for prepared text", async () => {
    const test = harness();

    await test.service.sendPreparedText({
      ...admission,
      terminal: true,
      to: "+15551234567",
      text: "ordinary agent reply",
    });

    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: "+15551234567",
      text: TERMINAL_MESSAGE,
    });
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(1, {
      where: { id: "message-1", AND: {
        status: "PENDING", outboundPresentation: {equals:Prisma.DbNull}, providerDispatchKey: null, providerDispatchAdmittedAt: null,
      } },
      data: { content: TERMINAL_MESSAGE },
    });
  });

  it("moderates a prepared AUTOMATION template's exact persisted parameters before Meta", async () => {
    const test = harness();
    const input = { to: "+15551234567", templateName: "recovery", languageCode: "en",
      bodyParameters: ["Cart details", "Customer supplied offer"], dynamicUrlButton: { index: 0, text: "cart-7" } };
    const effectiveText = prepareAutomatedTemplateInput(input).effectiveText;
    await expect(test.service.sendPreparedTemplate(admission, input))
      .resolves.toMatchObject({ kind: "admitted" });
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(1, {
      where: { id: "message-1", AND: {
        status: "PENDING", outboundPresentation: {equals:Prisma.DbNull}, providerDispatchKey: null, providerDispatchAdmittedAt: null,
      } }, data: { content: effectiveText },
    });
    expect(test.moderationMock.assessText).toHaveBeenCalledWith(expect.objectContaining({
      subject: { kind: "AGENT_MESSAGE", messageId: "message-1" },
      effectiveText, inputKind: "TEXT", shopId: "shop-1", conversationId: "conversation-1",
    }));
    expect(test.moderationMock.requireCurrentAllowance).toHaveBeenCalledWith(expect.objectContaining({
      effectiveText, subject: { kind: "AGENT_MESSAGE", messageId: "message-1" },
    }));
    expect(test.providerMock.sendWhatsAppTemplate).toHaveBeenCalledOnce();
    expect(test.providerMock.sendWhatsAppTemplate).toHaveBeenCalledWith(input);
    expect(test.database.conversationMessage.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SENT" }),
    }));
  });

  it("persists the ordered target-bearing checkout offer set on the provider-confirmed receipt", async () => {
    const test = harness();
    const recoveryPromise = {
      kind: "CHECKOUT_DISCOUNT" as const,
      promotionTarget: "CHECKOUT" as const,
      offerSet: {
        schemaVersion: "moda.outreach.checkout-offers.v1" as const,
        offers: [
          { offerId: "offer-1", providerDiscountId: "provider-1", method: "CODE" as const, code: "SAVE10" },
          { offerId: "offer-2", providerDiscountId: "provider-2", method: "CODE" as const, code: "SHIPFREE" },
        ],
      },
    };
    const input = {
      to: "+15551234567", templateName: "recovery", languageCode: "en",
      bodyParameters: ["Cart details"], recoveryPromise,
      templateRegistration: {
        shopId: "shop-1", senderWabaId: "phone-number-id", purpose: "INITIAL_CODE_OFFER" as const,
        variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
        providerTemplateId: "provider-template-1", providerTemplateName: "recovery",
        providerLanguageCode: "en", submittedContentHash: "a".repeat(64), bindingFingerprint: "b".repeat(64),
      },
    };
    const effectiveText = prepareAutomatedTemplateInput(input).effectiveText;

    await expect(test.service.sendPreparedTemplate(admission, input)).resolves.toMatchObject({ kind: "admitted" });

    expect(JSON.parse(effectiveText).recoveryPromise).toEqual(recoveryPromise);
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: { content: effectiveText },
    }));
    expect(test.providerMock.sendWhatsAppTemplate).toHaveBeenCalledOnce();
    expect(test.database.conversationMessage.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SENT", providerMessageId: "wamid-template" }),
    }));
  });

  it("suppresses a blocked automated template and releases its reserved usage", async () => {
    const test = harness({ moderationOutcome: "block" });
    const result = await test.service.sendPreparedTemplate(admission, {
      to: "+15551234567", templateName: "recovery", languageCode: "en", bodyParameters: ["flagged"] });
    expect(result).toMatchObject({ kind: "suppressed" });
    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
    expect(test.database.usageEvent.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceId: "message-1" }),
    }));
  });

  it("does not reuse stale ALLOW when the template parameters are changed", async () => {
    const test = harness({ currentAllowance: false });
    const result = await test.service.sendPreparedTemplate(admission, {
      to: "+15551234567", templateName: "recovery", languageCode: "en", bodyParameters: ["changed after approval"] });
    expect(result).toMatchObject({ kind: "suppressed" });
    expect(test.moderationMock.assessText).toHaveBeenCalledOnce();
    expect(test.moderationMock.requireCurrentAllowance).toHaveBeenCalledOnce();
    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("rejects an unmoderated image-header template without Meta admission", async () => {
    const test = harness();
    const result = await test.service.sendPreparedTemplate(admission, {
      to: "+15551234567", templateName: "recovery", languageCode: "en",
      imageHeader: { link: "https://example.test/image" },
    });
    expect(result).toMatchObject({ kind: "suppressed" });
    expect(test.moderationMock.assessText).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("uses text transport instead of template transport for a terminal admission", async () => {
    const test = harness();

    await test.service.sendPreparedTemplate(
      { ...admission, terminal: true },
      {
        to: "+15551234567",
        templateName: "recovery",
        languageCode: "en",
      },
    );

    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: "+15551234567",
      text: TERMINAL_MESSAGE,
    });
  });

  it("suppresses and releases a prepared intent when execution freezes", async () => {
    const executionEligibility = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: false,
        shopId: "shop-1",
        reason: "SUBSCRIPTION_FROZEN",
      }),
    };
    const test = harness({ executionEligibility });

    await expect(
      test.service.sendPreparedText({
        ...admission,
        to: "+15551234567",
        text: "Hello",
      }),
    ).resolves.toEqual({ kind: "suppressed", reason: "subscription-frozen" });

    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
    expect(test.transaction.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "message-1", status: "PENDING" }),
      data: { status: "FAILED" },
    });
    expect(test.database.usageEvent.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ sourceId: "message-1", metric: "OUTBOUND_AUTOMATED_MESSAGE" }),
    });
  });

  it("suppresses a template when the contract disappears before provider delivery", async () => {
    const executionEligibility = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: false,
        shopId: "shop-1",
        reason: "CONTRACT_REQUIRED",
      }),
    };
    const test = harness({ executionEligibility });

    await expect(
      test.service.sendPreparedTemplate(admission, {
        to: "+15551234567",
        templateName: "recovery",
        languageCode: "en",
      }),
    ).resolves.toEqual({ kind: "suppressed", reason: "contract-required" });

    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it.each(["configuration-missing", "provider-rejected"])(
    "cleans up definitive provider failure %s",
    async (code) => {
      const error = Object.assign(new Error("rejected"), {
        name: "WhatsAppServiceError",
        code,
      });
      const test = harness({
        provider: { sendWhatsAppText: vi.fn().mockRejectedValue(error) },
      });

      await expect(
        test.service.sendPreparedText({
          ...admission,
          to: "+15551234567",
          text: "Hello",
        }),
      ).rejects.toThrow("rejected");

      expect(test.database.conversationMessage.update).toHaveBeenCalledWith({
        where: { id: "message-1" },
        data: { status: "FAILED" },
      });
      expect(test.database.usageEvent.deleteMany).toHaveBeenCalledOnce();
    },
  );

  it.each([
    Object.assign(new Error("unknown"), {
      name: "WhatsAppServiceError",
      code: "invalid-provider-response",
    }),
    new Error("socket closed"),
  ])("preserves pending intent for ambiguous provider failure", async (error) => {
    const test = harness({
      provider: { sendWhatsAppText: vi.fn().mockRejectedValue(error) },
    });

    await expect(
      test.service.sendPreparedText({
        ...admission,
        to: "+15551234567",
        text: "Hello",
      }),
    ).rejects.toThrow();

    expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(test.database.conversationMessage.update).toHaveBeenCalledTimes(1);
    expect(test.database.conversationMessage.update).toHaveBeenCalledWith({
      where: { id: "message-1", AND: {
        status: "PENDING", outboundPresentation: {equals:Prisma.DbNull}, providerDispatchKey: null, providerDispatchAdmittedAt: null,
      } },
      data: { content: "Hello" },
    });
  });

  it("converges synchronous 131026 through compensation and reachability owners", async () => {
    const error = Object.assign(new Error("rejected"), {
      name: "WhatsAppServiceError", code: "provider-rejected", providerCode: "131026",
    });
    const failureAdapter = { afterProviderError: vi.fn(async () => undefined),
      failPrepared: vi.fn(async () => undefined) };
    const test = harness({ provider: { sendWhatsAppText: vi.fn().mockRejectedValue(error) } });
    const service = new OutboundMessageDeliveryService(
      test.database as never, test.providerMock as never, test.executionEligibility as never,
      { readTurnOwnership: vi.fn(async () => null) } as never, undefined,
      test.moderationMock as never, failureAdapter as never,
    );

    await expect(service.sendPreparedText({ ...admission, to: "+15551234567", text: "Hello" }))
      .rejects.toBe(error);
    expect(failureAdapter.afterProviderError).toHaveBeenCalledWith(
      "message-1", "+15551234567", error,
    );
  });
});


describe("unified known-recovery service and limit notice bodies",()=>{
 const checkoutUrl="https://shop.example/checkouts/recover?key=synthetic";
 const context={conversationId:"conversation-1",shopId:"shop-1",conversationLanguageTag:"en",merchantLanguageTag:"en",variables:{"checkout.url":checkoutUrl},checkoutAvailable:true};
 function noticeHarness(value:unknown=context) {
  const footerContext={loadContext:vi.fn(async()=>value)};
  const recoveryFence={admitFinalSend:vi.fn(async()=>({kind:"admitted"}))};
  const ownership={readTurnOwnership:vi.fn(async()=>({recoveryId:"recovery-1",revision:7}))};
  return {...harness({footerContext,recoveryFence,ownership}),footerContext,recoveryFence};
 }
 it.each(["text","template"])("uses exact prepared/moderated/fenced terminal %s body at the provider",async mode=>{
  const test=noticeHarness();const input={...admission,executionScope:"recovery" as const,terminal:true};
  const expected=TERMINAL_MESSAGE+RECOVERY_CHECKOUT_SEPARATOR+checkoutUrl;
  const result=mode==="text"?await test.service.sendPreparedText({...input,to:"15551234567",text:"Ignored cap reply"}):
   await test.service.sendPreparedTemplate(input,{to:"15551234567",templateName:"approved_template",languageCode:"en"});
  expect(result.kind).toBe("admitted");
  expect(test.database.conversationMessage.update.mock.calls[0]![0].data.content).toBe(expected);
  expect(test.moderationMock.assessText).toHaveBeenCalledWith(expect.objectContaining({effectiveText:expected}));
  expect(test.recoveryFence.admitFinalSend).toHaveBeenCalledWith(expect.objectContaining({expectedContent:expected,deliveryKind:"TEXT"}));
  expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({to:"15551234567",text:expected});
  expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
  expect(test.database.conversationMessage.update.mock.invocationCallOrder[0]).toBeLessThan(test.moderationMock.assessText.mock.invocationCallOrder[0]!);
  expect(test.moderationMock.assessText.mock.invocationCallOrder[0]).toBeLessThan(test.recoveryFence.admitFinalSend.mock.invocationCallOrder[0]!);
 });
 it("prepares explicit audio/clarification service text, not ordinary already-prepared text",async()=>{
  const test=noticeHarness();const text="Please send a shorter question.";
  await test.service.sendPreparedText({...admission,executionScope:"recovery",prepareRecoveryFooter:true,to:"15551234567",text});
  expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({to:"15551234567",text:text+RECOVERY_CHECKOUT_SEPARATOR+checkoutUrl});
  const untouched=noticeHarness();await untouched.service.sendPreparedText({...admission,executionScope:"recovery",to:"15551234567",text});
  expect(untouched.footerContext.loadContext).not.toHaveBeenCalled();
  expect(untouched.providerMock.sendWhatsAppText).toHaveBeenCalledWith({to:"15551234567",text});
 });
 it.each([null,"TENANT_MISMATCH",{...context,shopId:"other-shop"},{...context,variables:{"checkout.url":"http://shop.example/unsafe"}}])("refuses untrusted terminal context %#",async value=>{
  const test=noticeHarness(value);
  expect(await test.service.sendPreparedText({...admission,executionScope:"recovery",terminal:true,to:"15551234567",text:"ignored"})).toMatchObject({kind:"suppressed"});
  expect(test.moderationMock.assessText).not.toHaveBeenCalled();expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
 });
 it("does not fabricate URLs for expired context or resolve unbound general sends",async()=>{
  const expired=noticeHarness({...context,checkoutAvailable:false,variables:{}});
  await expired.service.sendPreparedText({...admission,executionScope:"recovery",terminal:true,to:"15551234567",text:"ignored"});
  expect(expired.providerMock.sendWhatsAppText).toHaveBeenCalledWith({to:"15551234567",text:TERMINAL_MESSAGE});
  const general=noticeHarness();await general.service.sendPreparedText({...admission,terminal:true,to:"15551234567",text:"ignored"});
  expect(general.footerContext.loadContext).not.toHaveBeenCalled();
 });
 it.each(["terminal", "audio", "oversize"])("prepares trusted identity before moderation/fence for %s notices",async kind=>{
  const recoveryShopHeader={schemaVersion:1 as const,shopId:"shop-1",name:"Fixture Store",websiteUrl:"https://shop.example"};
  const test=noticeHarness({...context,recoveryShopHeader});
  const text=kind==="terminal"?TERMINAL_MESSAGE:"Please send a shorter question.";
  const expected="Fixture Store\nhttps://shop.example\n──────────\n\n"+text+RECOVERY_CHECKOUT_SEPARATOR+checkoutUrl;
  await test.service.sendPreparedText({...admission,executionScope:"recovery",terminal:kind==="terminal",prepareRecoveryFooter:true,to:"15551234567",text});
  expect(test.moderationMock.assessText).toHaveBeenCalledWith(expect.objectContaining({effectiveText:expected}));
  expect(test.recoveryFence.admitFinalSend).toHaveBeenCalledWith(expect.objectContaining({expectedContent:expected,recoveryShopHeader}));
  expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({to:"15551234567",text:expected});
 });
 it("does not send when prepared-content final permit is refused after a race",async()=>{
  const test=noticeHarness();test.recoveryFence.admitFinalSend.mockResolvedValue({kind:"suppressed",reason:"already-admitted-or-sent"} as any);
  expect(await test.service.sendPreparedText({...admission,executionScope:"recovery",terminal:true,to:"15551234567",text:"ignored"})).toMatchObject({kind:"suppressed"});
  expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
 });
});
