import { describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({ records: [] as unknown[], throwFromSink: false }));
vi.mock("@modainteract/moda-interact-shared/logging", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@modainteract/moda-interact-shared/logging")>();
  return {
    ...shared,
    createLogger: (options: Parameters<typeof shared.createLogger>[0]) => shared.createLogger({
      ...options, sink: (record) => {
        captures.records.push(JSON.parse(JSON.stringify(record)));
        if (captures.throwFromSink) throw new Error("sink unavailable");
      },
    }),
  };
});
import { OutboundSendFenceService, type DispatchInput } from
  "../../../../src/services/recovery-conversation/outbound-send-fence.service.js";

const input: DispatchInput = {
  senderType: "AUTOMATION", deliveryKind: "TEMPLATE", shopId: "shop-1",
  conversationId: "conversation-1", recoveryId: "recovery-1", messageId: "message-1",
  recipient: "+447400123456", expectedControlRevision: 0, now: new Date(),
  proactive: { verifiedCategory: "MARKETING", consent: null, templateName: "recovery", languageCode: "en" },
  initialOutreach: {
    outreachAttemptId: "attempt-1", idempotencyKey: "recovery-outreach:attempt-1",
    recoveryCreditSourceKey: "credit-1", expectedContent: "prepared content",
  },
};

describe("initial Shopify permit logging", () => {
  it("emits actual bounded Prisma evidence and preserves identity when the sink throws", async () => {
    captures.records.length = 0;
    captures.throwFromSink = true;
    const failure = Object.assign(new Error("harmless permit source marker +447400123456"), {
      code: "P2034", clientVersion: "6.19.3", meta: { modelName: "UsageReservation", raw: "private" },
    });
    const db = { $transaction: vi.fn().mockRejectedValue(failure) };
    try {
      await expect(new OutboundSendFenceService(db as never, async () => null)
        .admitFinalSend(input)).rejects.toBe(failure);
    } finally {
      captures.throwFromSink = false;
    }
    expect(captures.records).toContainEqual(expect.objectContaining({
      event: "recovery.initial_outreach.sql_permit.failed",
      level: "error",
      "service.name": "moda-background-runtime",
      "deployment.environment.name": "test",
      data: expect.objectContaining({
        stage: "final_permit", attemptId: "attempt-1", messageId: "message-1",
        sourceError: expect.objectContaining({
          message: "harmless permit source marker [REDACTED_PHONE]", code: "P2034",
          clientVersion: "6.19.3", meta: { modelName: "UsageReservation" },
        }),
      }),
    }));
    expect(JSON.stringify(captures.records)).not.toMatch(/447400123456|private/);
  });

  it("suppresses invalid initial scope without inventing an error", async () => {
    captures.records.length = 0;
    const db = { $transaction: vi.fn() };
    await expect(new OutboundSendFenceService(db as never, async () => null)
      .admitFinalSend({ ...input, senderType: "AGENT" })).resolves.toEqual({
      kind: "suppressed", reason: "invalid-initial-scope",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(captures.records).toEqual([]);
  });
});
