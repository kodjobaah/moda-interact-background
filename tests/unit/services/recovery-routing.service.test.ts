import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  conversationMessage: { findUnique: vi.fn() },
  conversation: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
}));
const active = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/db.js", () => ({ default: db }));
vi.mock("../../../src/services/shop-execution-eligibility.service.js", () => ({
  shopExecutionEligibilityService: { isShopExecutionActive: active },
}));
vi.mock("../../../src/services/whatsapp.service.js", () => ({
  whatsAppService: {
    resolveSender: () => ({
      providerAccountId: "waba",
      providerPhoneNumberId: "phone",
    }),
  },
}));
import { RecoveryRoutingService } from "../../../src/services/recovery-routing.service.js";
const event = {
  schemaVersion: 1,
  provider: "whatsapp",
  providerAccountId: "waba",
  providerPhoneNumberId: "phone",
  providerMessageId: "incoming",
  customerPhone: "+4477",
  contextMessageId: null,
  occurredAt: "2026-09-20T12:00:00Z",
  content: { type: "text", text: "help" },
} as const;
const recovery = { id: "r1", shopId: "shop1", customer: { phone: "  +4477 " } };
beforeEach(() => {
  vi.resetAllMocks();
  active.mockResolvedValue(true);
  db.conversationMessage.findUnique.mockResolvedValue(null);
  db.conversation.findUnique.mockResolvedValue({ checkoutRecovery: recovery });
});
describe("C2 strict recovery routing", () => {
  it.each([1, 10])(
    "retains explicit outreach ownership after %i hours, including later FAILED status",
    async (hours) => {
      db.conversationMessage.findUnique.mockImplementation(async ({ where }) =>
        where.providerMessageId === "old"
          ? {
              direction: "OUTBOUND",
              sentAt: new Date(Date.now() - hours * 3600000),
              status: "FAILED",
              conversationId: "c1",
              conversation: { checkoutRecovery: recovery },
            }
          : null,
      );
      expect(
        await new RecoveryRoutingService().resolveInboundMessage({
          ...event,
          contextMessageId: "old",
        }),
      ).toEqual({
        kind: "resolved",
        conversationId: "c1",
        checkoutRecoveryId: "r1",
        shopId: "shop1",
      });
      expect(db.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it.each([0, 1, 2])(
    "counts %i distinct recoveries before checking shop eligibility",
    async (count) => {
      db.$queryRaw.mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({
          conversationId: `c${i + 1}`,
        })),
      );
      const result = await new RecoveryRoutingService().resolveInboundMessage(
        event,
      );
      expect(result.kind).toBe(count === 1 ? "resolved" : "guidance");
      if (count !== 1) expect(active).not.toHaveBeenCalled();
      const query = db.$queryRaw.mock.calls[0][0].strings.join("?");
      expect(query).toContain("SELECT DISTINCT");
      expect(query).toContain("LIMIT 2");
      expect(query).not.toContain("status");
      expect(query).not.toContain("ORDER BY");
      expect(query).toContain('commerce."Customer"');
      expect(query).toContain('"sentAt" IS NOT NULL');
    },
  );
  it.each([
    null,
    { direction: "OUTBOUND", sentAt: null },
    { direction: "INBOUND", sentAt: new Date() },
    {
      direction: "OUTBOUND",
      sentAt: new Date(),
      conversation: { checkoutRecovery: { customer: { phone: "999" } } },
    },
  ])("never falls back from invalid explicit reference", async (original) => {
    db.conversationMessage.findUnique.mockImplementation(async ({ where }) =>
      where.providerMessageId === "bad" ? original : null,
    );
    expect(
      await new RecoveryRoutingService().resolveInboundMessage({
        ...event,
        contextMessageId: "bad",
      }),
    ).toEqual({ kind: "guidance", reason: "INVALID_REFERENCE" });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
  });
  it("rejects wrong provider before database access", async () => {
    expect(
      await new RecoveryRoutingService().resolveInboundMessage({
        ...event,
        providerAccountId: "other",
      }),
    ).toEqual({ kind: "ignored" });
    expect(db.conversationMessage.findUnique).not.toHaveBeenCalled();
  });
  it("reuses the stored inbound conversation despite newer ambiguous outreach", async () => {
    db.conversationMessage.findUnique.mockResolvedValue({
      direction: "INBOUND",
      conversationId: "original",
    });
    expect(
      await new RecoveryRoutingService().resolveInboundMessage(event),
    ).toMatchObject({ kind: "resolved", conversationId: "original" });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it("rejects reference disagreement with stored inbound ownership", async () => {
    db.conversationMessage.findUnique.mockImplementation(async ({ where }) =>
      where.providerMessageId === "incoming"
        ? { direction: "INBOUND", conversationId: "other" }
        : {
            direction: "OUTBOUND",
            sentAt: new Date(),
            conversationId: "c1",
            conversation: { checkoutRecovery: recovery },
          },
    );
    expect(
      await new RecoveryRoutingService().resolveInboundMessage({
        ...event,
        contextMessageId: "old",
      }),
    ).toEqual({ kind: "guidance", reason: "INVALID_REFERENCE" });
  });
  it("does not manufacture ownership from a missing recovery", async () => {
    db.$queryRaw.mockResolvedValue([{ conversationId: "c1" }]);
    db.conversation.findUnique.mockResolvedValue({ checkoutRecovery: null });
    expect(
      await new RecoveryRoutingService().resolveInboundMessage(event),
    ).toMatchObject({ reason: "INVALID_REFERENCE" });
  });
  it("checks availability only after selecting the one recovery", async () => {
    db.$queryRaw.mockResolvedValue([{ conversationId: "c1" }]);
    active.mockResolvedValue(false);
    expect(
      await new RecoveryRoutingService().resolveInboundMessage(event),
    ).toEqual({ kind: "guidance", reason: "SHOP_UNAVAILABLE" });
  });
});

it.each(["initial template", "follow-up template", "later agent reply"])(
  "C13 routes a reply to the %s into the same recovery conversation",
  async (category) => {
    db.conversationMessage.findUnique.mockImplementation(async ({ where }) =>
      where.providerMessageId === category
        ? {
            direction: "OUTBOUND",
            sentAt: new Date(),
            conversationId: "one-recovery-conversation",
            conversation: { checkoutRecovery: recovery },
          }
        : null,
    );
    expect(
      await new RecoveryRoutingService().resolveInboundMessage({
        ...event,
        contextMessageId: category,
      }),
    ).toMatchObject({
      kind: "resolved",
      conversationId: "one-recovery-conversation",
      checkoutRecoveryId: "r1",
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  },
);
it("terminal candidates in different shops remain ambiguous before eligibility", async () => {
  db.$queryRaw.mockResolvedValue([
    { conversationId: "completed-shop-a" },
    { conversationId: "expired-shop-b" },
  ]);
  active.mockResolvedValue(false);
  expect(
    await new RecoveryRoutingService().resolveInboundMessage(event),
  ).toEqual({ kind: "guidance", reason: "MULTIPLE_RECOVERIES" });
  expect(active).not.toHaveBeenCalled();
  expect(db.conversation.findUnique).not.toHaveBeenCalled();
});
