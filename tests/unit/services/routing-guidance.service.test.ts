import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({
  set: vi.fn(), send: vi.fn(), noContact: vi.fn(), query: vi.fn(), transaction: vi.fn(),
  info: vi.fn(), error: vi.fn(),
}));
vi.mock("../../../src/services/whatsapp-contact-opt-out/local-no-contact.js", () => ({
  hasLocalNoContact: mocks.noContact,
}));
vi.mock("../../../src/lib/db.js", () => ({
  default: { $transaction: mocks.transaction },
}));
vi.mock("../../../src/lib/redis.js", () => ({
  connectionRedis: { set: mocks.set },
}));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));
vi.mock("../../../src/services/whatsapp.service.js", () => ({
  whatsAppService: {
    sendWhatsAppText: mocks.send,
    resolveSender: () => ({ providerAccountId: "waba", providerPhoneNumberId: "phone" }),
  },
}));
import { sendRoutingGuidance } from "../../../src/services/routing-guidance.service.js";

const event = {
  schemaVersion: 1,
  provider: "whatsapp",
  providerAccountId: "waba",
  providerPhoneNumberId: "phone",
  providerMessageId: "inbound",
  customerPhone: "447400123456",
  contextMessageId: null,
  occurredAt: "2026-09-20T12:00:00Z",
  content: { type: "text", text: "Hi" },
} as const;
const identify =
  "This number sends messages for different stores. For help with a basket, find the message from that store and use WhatsApp's Reply option on that message. Then type your question or send a voice note (up to 2 minutes).";
const logger = { info: mocks.info, error: mocks.error };

function send(reason: "MULTIPLE_RECOVERIES" | "NO_RECOVERY" | "INVALID_REFERENCE" | "SHOP_UNAVAILABLE", input = event) {
  return sendRoutingGuidance(input as never, reason, { logger });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.set.mockResolvedValue("OK");
  mocks.noContact.mockResolvedValue(false);
  mocks.query.mockResolvedValue([{ acquired: 1 }]);
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run({ $queryRawUnsafe: mocks.query }));
});

it.each([
  ["MULTIPLE_RECOVERIES", identify],
  ["NO_RECOVERY", `${identify} If you cannot find the message, contact the store directly.`],
  ["INVALID_REFERENCE", `${identify} If you cannot find the message, contact the store directly.`],
  ["SHOP_UNAVAILABLE", "Please contact the store directly for help with your basket."],
] as const)("sends exact %s guidance with a 24-hour NX guard", async (reason, text) => {
  await expect(send(reason)).resolves.toEqual({ kind: "sent" });
  expect(mocks.set).toHaveBeenCalledWith(
    `moda:test:whatsapp:clarification:${createHash("sha256").update("inbound").digest("hex")}`,
    "1", "EX", 86400, "NX",
  );
  expect(mocks.send).toHaveBeenCalledWith({ to: "447400123456", text }, expect.any(AbortSignal));
  expect(mocks.transaction).toHaveBeenCalledOnce();
  expect(mocks.query.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
  expect(mocks.noContact).toHaveBeenCalledOnce();
  expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(mocks.noContact.mock.invocationCallOrder[0]!);
  expect(mocks.noContact.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]!);
});

it("allows only one concurrent winner and retains guard after ambiguous send failure", async () => {
  let used = false;
  mocks.set.mockImplementation(async () => {
    if (used) return null;
    used = true;
    return "OK";
  });
  const providerError = new Error("Meta Graph API 400: recipient +447400123456 said Hi; access_token=super-secret");
  providerError.cause = new Error("ECONNRESET at https://graph.facebook.com/private/path");
  mocks.send.mockRejectedValue(providerError);
  await Promise.all([send("NO_RECOVERY"), send("NO_RECOVERY")]);
  await expect(send("NO_RECOVERY")).resolves.toEqual({ kind: "suppressed", reason: "DUPLICATE" });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.error).toHaveBeenCalledWith("whatsapp.inbound.guidance_failed", expect.objectContaining({
    operation: "meta-send", reason: "PROVIDER_SEND_FAILED",
    errorMessage: expect.stringContaining("Meta Graph API 400"),
    causeMessage: expect.stringContaining("ECONNRESET"),
  }));
  const logged = JSON.stringify(mocks.error.mock.calls);
  expect(logged).not.toContain("+447400123456");
  expect(logged).not.toContain("said Hi");
  expect(logged).not.toContain("super-secret");
  expect(logged).not.toContain("private/path");
});

it("logs the original cache failure with bounded redaction and fails closed", async () => {
  mocks.set.mockRejectedValue(new Error("Redis offline at redis://user:password@cache.example/0; +447400123456 said Hi token=secret-value"));
  await expect(send("NO_RECOVERY")).resolves.toEqual({ kind: "failed", reason: "CACHE_UNAVAILABLE" });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith("whatsapp.inbound.guidance_failed", expect.objectContaining({
    operation: "redis-admission", reason: "CACHE_UNAVAILABLE", errorMessage: expect.stringContaining("Redis offline"),
  }));
  const logged = JSON.stringify(mocks.error.mock.calls);
  expect(logged).not.toContain("+447400123456");
  expect(logged).not.toContain("said Hi");
  expect(logged).not.toContain("password@cache");
  expect(logged).not.toContain("secret-value");
});

it("classifies unsupported, wrong-sender, duplicate and no-contact outcomes", async () => {
  await expect(send("NO_RECOVERY", { ...event, content: { type: "unsupported", providerType: "image" } }))
    .resolves.toEqual({ kind: "suppressed", reason: "UNSUPPORTED" });
  await expect(send("NO_RECOVERY", { ...event, providerPhoneNumberId: "wrong" }))
    .resolves.toEqual({ kind: "suppressed", reason: "INVALID_SENDER" });
  mocks.set.mockResolvedValueOnce(null);
  await expect(send("NO_RECOVERY")).resolves.toEqual({ kind: "suppressed", reason: "DUPLICATE" });
  mocks.noContact.mockResolvedValue(true);
  await expect(send("NO_RECOVERY")).resolves.toEqual({ kind: "suppressed", reason: "NO_CONTACT" });
  expect(mocks.send).not.toHaveBeenCalled();
});

it("fails closed and logs the original database admission exception", async () => {
  await expect(send("NO_RECOVERY", { ...event, customerPhone: "not-a-number" }))
    .resolves.toEqual({ kind: "suppressed", reason: "NO_CONTACT" });
  expect(mocks.set).not.toHaveBeenCalled();
  mocks.transaction.mockRejectedValue(new Error("database unavailable"));
  await expect(send("NO_RECOVERY")).resolves.toEqual({ kind: "failed", reason: "DB_ADMISSION_FAILED" });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith("whatsapp.inbound.guidance_failed", expect.objectContaining({
    operation: "database-admission", reason: "DB_ADMISSION_FAILED", errorMessage: "database unavailable",
  }));
});

it("does not send until recipient lock and no-contact checks complete", async () => {
  let release!: () => void;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  mocks.query.mockImplementation(async () => { await pause; return [{ acquired: 1 }]; });
  const guidance = send("NO_RECOVERY");
  await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledOnce());
  expect(mocks.send).not.toHaveBeenCalled();
  release();
  await guidance;
  expect(mocks.send).toHaveBeenCalledOnce();
});
