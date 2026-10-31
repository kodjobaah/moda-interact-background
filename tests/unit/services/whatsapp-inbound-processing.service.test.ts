import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

const h = vi.hoisted(() => ({
  optOut: vi.fn(),
  abuse: vi.fn(),
  route: vi.fn(),
  current: vi.fn(),
  guidance: vi.fn(),
  activity: vi.fn(),
  audioReserve: vi.fn(),
  audioProcess: vi.fn(),
  receive: vi.fn(),
  updateMessage: vi.fn(),
  reachability: vi.fn(),
  turnState: vi.fn(),
  turnOwnership: vi.fn(),
  sendText: vi.fn(),
  findMessage: vi.fn(),
  createMessage: vi.fn(),
}));

vi.mock("../../../src/lib/db.js", () => ({ default: { conversationMessage: { update: h.updateMessage, findUnique: h.findMessage, create: h.createMessage } } }));
vi.mock("../../../src/services/whatsapp-contact-opt-out.service.js", () => ({ whatsAppContactOptOutService: { handleInbound: h.optOut } }));
vi.mock("../../../src/services/inbound-whatsapp-abuse-admission.service.js", () => ({ inboundWhatsAppAbuseAdmissionService: { admitRaw: h.abuse } }));
vi.mock("../../../src/services/recovery-routing.service.js", () => ({ recoveryRoutingService: { resolveInboundMessage: h.route, isCurrentActiveRoute: h.current } }));
vi.mock("../../../src/services/routing-guidance.service.js", () => ({ sendRoutingGuidance: h.guidance }));
vi.mock("../../../src/services/checkout-recovery.service.js", () => ({ checkoutRecoveryService: { recordExternalActivity: h.activity } }));
vi.mock("../../../src/services/inbound-whatsapp-audio.service.js", () => ({ inboundWhatsAppAudioService: { reserve: h.audioReserve, process: h.audioProcess } }));
vi.mock("../../../src/services/conversation.service.js", () => ({ conversationService: { receiveMessage: h.receive, getTurnState: h.turnState } }));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js", () => ({ outboundWhatsAppAdmissionService: { sendText: h.sendText } }));
vi.mock("../../../src/services/recovery-conversation/ai-turn-ownership.service.js", () => ({ AiTurnOwnershipService: class { readTurnOwnership = h.turnOwnership; } }));
vi.mock("../../../src/services/recipient-reachability-positive.service.js", () => ({ recipientReachabilityPositiveService: { fromRoutedInbound: h.reachability } }));

import { processRoutedInboundMessage } from "../../../src/services/whatsapp-inbound-processing.service.js";
import type { WhatsAppInboundEvent } from "../../../src/integration/whatsapp/types.js";

const event = {
  schemaVersion: 1,
  provider: "whatsapp",
  providerAccountId: "account",
  providerPhoneNumberId: "sender",
  providerMessageId: "wamid.secret-ish",
  customerPhone: "+447700900123",
  contextMessageId: "outbound-context",
  occurredAt: "2026-10-30T09:00:00.000Z",
  content: { type: "text", text: "I have a question" },
} as WhatsAppInboundEvent;

const activeRoute = {
  kind: "resolved" as const,
  conversationId: "conversation-1",
  checkoutRecoveryId: "recovery-1",
  shopId: "shop-1",
  mode: "active" as const,
};
const historicalRoute = { ...activeRoute, mode: "historical" as const };
const logMock = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child() { return this; },
};
const logger = logMock as unknown as StructuredLogger;

beforeEach(() => {
  vi.resetAllMocks();
  h.optOut.mockResolvedValue(false);
  h.abuse.mockResolvedValue({ kind: "allowed" });
  h.route.mockResolvedValue(activeRoute);
  h.current.mockResolvedValue(true);
  h.guidance.mockResolvedValue({ kind: "sent" });
  h.activity.mockResolvedValue(undefined);
  h.audioReserve.mockResolvedValue({ conversationId: activeRoute.conversationId });
  h.audioProcess.mockResolvedValue({ kind: "completed" });
  h.receive.mockResolvedValue({ conversationId: activeRoute.conversationId, version: 2, duplicate: false });
  h.updateMessage.mockResolvedValue(undefined);
  h.findMessage.mockResolvedValue(null);
  h.createMessage.mockResolvedValue(undefined);
  h.reachability.mockResolvedValue(undefined);
  h.turnState.mockResolvedValue({ inboundVersion: 2 });
  h.turnOwnership.mockResolvedValue({ revision: 3 });
  h.sendText.mockResolvedValue(undefined);
});

describe("processRoutedInboundMessage generation safety", () => {
  it("persists a historical text reply without activity or a turn", async () => {
    h.route.mockResolvedValue(historicalRoute);
    const enqueue = vi.fn();
    await processRoutedInboundMessage(event, {}, logger, enqueue);
    expect(h.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        conversationId: historicalRoute.conversationId,
        providerMessageId: event.providerMessageId,
        inReplyToProviderId: event.contextMessageId,
        content: "I have a question",
      }),
    }));
    expect(h.receive).not.toHaveBeenCalled();
    expect(h.activity).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("stores a historical audio message without transcription, fallback or turn enqueue", async () => {
    h.route.mockResolvedValue(historicalRoute);
    const enqueue = vi.fn();
    await processRoutedInboundMessage({ ...event, content: { type: "audio", mediaId: "media", mimeType: "audio/ogg", sha256: null } } as WhatsAppInboundEvent, {}, logger, enqueue);
    expect(h.audioReserve).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: event.providerMessageId }), historicalRoute.conversationId);
    expect(h.audioProcess).not.toHaveBeenCalled();
    expect(h.activity).not.toHaveBeenCalled();
    expect(h.sendText).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stores historical unsupported content without scheduling automation", async () => {
    h.route.mockResolvedValue(historicalRoute);
    const enqueue = vi.fn();
    await processRoutedInboundMessage({ ...event, content: { type: "unsupported", providerType: "sticker" } } as WhatsAppInboundEvent, {}, logger, enqueue);
    expect(h.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: "[Unsupported WhatsApp content: sticker]", contentType: "UNSUPPORTED" }),
    }));
    expect(h.receive).not.toHaveBeenCalled();
    expect(h.updateMessage).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.activity).not.toHaveBeenCalled();
  });

  it("keeps a persisted historical duplicate in its original conversation without changing turn state", async () => {
    h.route.mockResolvedValue(historicalRoute);
    h.findMessage.mockResolvedValue({ conversationId: historicalRoute.conversationId, direction: "INBOUND" });
    const enqueue = vi.fn();
    await processRoutedInboundMessage(event, {}, logger, enqueue);
    expect(h.createMessage).not.toHaveBeenCalled();
    expect(h.receive).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.activity).not.toHaveBeenCalled();
  });

  it("preserves active current-recovery activity and turn behavior", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await processRoutedInboundMessage(event, {}, logger, enqueue);
    expect(h.activity).toHaveBeenCalledWith(activeRoute.checkoutRecoveryId, new Date(event.occurredAt));
    expect(enqueue).toHaveBeenCalledWith(activeRoute.conversationId, 2);
  });

  it("suppresses enqueue when the active generation closes after persistence", async () => {
    h.current.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const enqueue = vi.fn();
    await processRoutedInboundMessage(event, {}, logger, enqueue);
    expect(h.receive).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledWith("whatsapp.inbound.turn_suppressed", expect.objectContaining({
      reason: "RECOVERY_CLOSED_OR_SUPERSEDED",
    }));
  });

  it("downgrades an active route that was superseded before persistence", async () => {
    h.current.mockResolvedValueOnce(false);
    const enqueue = vi.fn();
    await processRoutedInboundMessage(event, {}, logger, enqueue);
    expect(h.activity).not.toHaveBeenCalled();
    expect(h.receive).not.toHaveBeenCalled();
    expect(h.createMessage).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("suppresses audio fallback if its recovery closes during transcription", async () => {
    h.current.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    h.audioProcess.mockResolvedValue({ kind: "failed", fallback: "Try text instead" });
    const enqueue = vi.fn();
    await processRoutedInboundMessage({ ...event, content: { type: "audio", mediaId: "media", mimeType: "audio/ogg", sha256: null } } as WhatsAppInboundEvent, {}, logger, enqueue);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps STOP ahead of routing and abuse admission", async () => {
    h.optOut.mockResolvedValue(true);
    const enqueue = vi.fn();
    await processRoutedInboundMessage(event, {}, logger, enqueue);
    expect(h.abuse).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("logs guidance as sent only after confirmed delivery and never downloads ambiguous audio", async () => {
    h.route.mockResolvedValue({ kind: "guidance", reason: "MULTIPLE_RECOVERIES" });
    h.guidance.mockResolvedValue({ kind: "sent" });
    const enqueue = vi.fn();
    await processRoutedInboundMessage({
      ...event,
      content: { type: "audio", mediaId: "private-media", mimeType: "audio/ogg", sha256: null },
    } as WhatsAppInboundEvent, {}, logger, enqueue);
    expect(h.guidance).toHaveBeenCalledOnce();
    expect(h.audioReserve).not.toHaveBeenCalled();
    expect(h.audioProcess).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(logMock.info).toHaveBeenCalledWith("whatsapp.inbound.guidance_sent", expect.objectContaining({
      reason: "MULTIPLE_RECOVERIES", outcome: "sent",
    }));
    expect(logMock.debug).not.toHaveBeenCalledWith("whatsapp.inbound.guidance_sent", expect.anything());
  });

  it("does not report suppressed or failed guidance as sent", async () => {
    h.route.mockResolvedValue({ kind: "guidance", reason: "INVALID_REFERENCE" });
    h.guidance.mockResolvedValue({ kind: "failed", reason: "PROVIDER_SEND_FAILED" });
    await processRoutedInboundMessage(event, {}, logger, vi.fn());
    expect(logMock.info).not.toHaveBeenCalledWith("whatsapp.inbound.guidance_sent", expect.anything());
    expect(logMock.warn).toHaveBeenCalledWith("whatsapp.inbound.guidance_not_sent", expect.objectContaining({
      outcome: "failed", outcomeReason: "PROVIDER_SEND_FAILED",
    }));
  });

  it("logs unexpected failures with a hashed message identity and rethrows", async () => {
    const failure = new Error("routing unavailable");
    h.route.mockRejectedValue(failure);
    await expect(processRoutedInboundMessage(event, {}, logger, vi.fn())).rejects.toBe(failure);
    expect(logMock.error).toHaveBeenCalledWith("whatsapp.inbound.processing_failed", expect.objectContaining({
      stage: "processing", error: failure, messageDigest: expect.any(String),
    }));
    expect(JSON.stringify(logMock.error.mock.calls)).not.toContain(event.providerMessageId);
  });
});
