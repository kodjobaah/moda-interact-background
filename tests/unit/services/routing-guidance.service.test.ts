import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ set: vi.fn(), send: vi.fn() }));
vi.mock("../../../src/lib/redis.js", () => ({
  connectionRedis: { set: mocks.set },
}));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));
vi.mock("../../../src/services/whatsapp.service.js", () => ({
  whatsAppService: {
    sendWhatsAppText: mocks.send,
    resolveSender: () => ({
      providerAccountId: "waba",
      providerPhoneNumberId: "phone",
    }),
  },
}));
import { sendRoutingGuidance } from "../../../src/services/routing-guidance.service.js";
const event = {
  schemaVersion: 1,
  provider: "whatsapp",
  providerAccountId: "waba",
  providerPhoneNumberId: "phone",
  providerMessageId: "inbound",
  customerPhone: "4477",
  contextMessageId: null,
  occurredAt: "2026-09-20T12:00:00Z",
  content: { type: "text", text: "Hi" },
} as const;
const identify =
  "Please use WhatsApp's Reply option on the basket message you'd like help with, so I can identify the right checkout.";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.set.mockResolvedValue("OK");
});
it.each([
  ["MULTIPLE_RECOVERIES", identify],
  [
    "NO_RECOVERY",
    identify +
      " If you cannot find that message, please contact the store directly.",
  ],
  [
    "INVALID_REFERENCE",
    identify +
      " If you cannot find that message, please contact the store directly.",
  ],
  [
    "SHOP_UNAVAILABLE",
    "Please contact the store directly for help with your basket.",
  ],
] as const)(
  "sends exact fixed %s guidance with a 24-hour NX guard",
  async (reason, text) => {
    await sendRoutingGuidance(event, reason);
    expect(mocks.set).toHaveBeenCalledWith(
      `moda:test:whatsapp:clarification:${createHash("sha256").update("inbound").digest("hex")}`,
      "1",
      "EX",
      86400,
      "NX",
    );
    expect(mocks.send).toHaveBeenCalledWith(
      { to: "4477", text },
      expect.any(AbortSignal),
    );
  },
);
it("allows only one concurrent winner and retains guard after ambiguous send failure", async () => {
  let used = false;
  mocks.set.mockImplementation(async () => {
    if (used) return null;
    used = true;
    return "OK";
  });
  mocks.send.mockRejectedValue(new Error("ambiguous"));
  await Promise.all([
    sendRoutingGuidance(event, "NO_RECOVERY"),
    sendRoutingGuidance(event, "NO_RECOVERY"),
  ]);
  await sendRoutingGuidance(event, "NO_RECOVERY");
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it("suppresses on Redis error", async () => {
  mocks.set.mockRejectedValue(new Error("offline"));
  await sendRoutingGuidance(event, "NO_RECOVERY");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("ignores unsupported content and wrong sender", async () => {
  await sendRoutingGuidance(
    { ...event, content: { type: "unsupported", providerType: "image" } },
    "NO_RECOVERY",
  );
  await sendRoutingGuidance(
    { ...event, providerPhoneNumberId: "wrong" },
    "NO_RECOVERY",
  );
  expect(mocks.set).not.toHaveBeenCalled();
});
