import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import prisma from "../../../src/lib/db.js";
import { RecoveryRoutingService } from "../../../src/services/recovery-routing.service.js";

vi.mock("../../../src/lib/db.js", () => ({
  default: {
    conversationMessage: {
      findUnique: vi.fn(),
    },
    conversation: {
      findMany: vi.fn(),
    },
  },
}));

describe("RecoveryRoutingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns product-only when the customer has no active checkout recoveries", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);

    const service = new RecoveryRoutingService();
    const route = await service.resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "msg-1",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Do you have this in black?",
    });

    expect(route).toMatchObject({
      kind: "product-only",
      customerPhone: "+447700900000",
    });
  });

  it("returns the only active recovery when there is exactly one match", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        id: "conversation-1",
        checkoutRecoveryId: "recovery-1",
        checkoutRecovery: {
          id: "recovery-1",
          status: "ENGAGED",
          checkoutToken: "checkout-1",
          totalPrice: "42.00",
          customer: {
            phone: "+447700900000",
          },
        },
      },
    ] as any);

    const service = new RecoveryRoutingService();
    const route = await service.resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "msg-2",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Can you tell me if the red one is still available?",
    });

    expect(route).toMatchObject({
      kind: "resolved",
      conversationId: "conversation-1",
      checkoutRecoveryId: "recovery-1",
    });
  });

  it("asks for clarification when the customer has multiple active recoveries", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        id: "conversation-1",
        checkoutRecoveryId: "recovery-1",
        checkoutRecovery: {
          id: "recovery-1",
          status: "ENGAGED",
          checkoutToken: "checkout-1",
          totalPrice: "42.00",
          customer: {
            phone: "+447700900000",
          },
        },
      },
      {
        id: "conversation-2",
        checkoutRecoveryId: "recovery-2",
        checkoutRecovery: {
          id: "recovery-2",
          status: "MESSAGE_SENT",
          checkoutToken: "checkout-2",
          totalPrice: "18.00",
          customer: {
            phone: "+447700900000",
          },
        },
      },
    ] as any);

    const service = new RecoveryRoutingService();
    const route = await service.resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "msg-3",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "I want to know more about the basket?",
    });

    expect(route).toMatchObject({
      kind: "clarify",
      customerPhone: "+447700900000",
    });
    expect((route as any).recoveries).toHaveLength(2);
  });
});
