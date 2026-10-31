import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import { connectionRedis } from "../lib/redis.js";
import prisma from "../lib/db.js";
import { hasLocalNoContact } from "./whatsapp-contact-opt-out/local-no-contact.js";
import { canonicalWhatsAppSender } from "./whatsapp-contact-opt-out/phone.js";
import { lockWhatsAppStopRecipient } from "./whatsapp-contact-opt-out/recipient-stop-serialization.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import type { RoutingGuidanceReason } from "./recovery-routing.service.js";
import { whatsAppService } from "./whatsapp.service.js";

const identify =
  "This number sends messages for different stores. For help with a basket, find the message from that store and use WhatsApp's Reply option on that message. Then type your question or send a voice note (up to 2 minutes).";
export const routingGuidanceText: Record<RoutingGuidanceReason, string> = {
  MULTIPLE_RECOVERIES: identify,
  NO_RECOVERY:
    `${identify} If you cannot find the message, contact the store directly.`,
  INVALID_REFERENCE:
    `${identify} If you cannot find the message, contact the store directly.`,
  SHOP_UNAVAILABLE:
    "Please contact the store directly for help with your basket.",
};

export type RoutingGuidanceOutcome =
  | { kind: "sent" }
  | { kind: "suppressed"; reason: "DUPLICATE" | "NO_CONTACT" | "INVALID_SENDER" | "UNSUPPORTED" }
  | { kind: "failed"; reason: "CACHE_UNAVAILABLE" | "DB_ADMISSION_FAILED" | "PROVIDER_SEND_FAILED" };

type GuidanceDependencies = {
  database?: Pick<PrismaClient, "$transaction">;
  cache?: Pick<typeof connectionRedis, "set">;
  provider?: Pick<typeof whatsAppService, "resolveSender" | "sendWhatsAppText">;
  logger?: Pick<StructuredLogger, "info" | "error">;
};

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

const MAX_ERROR_SOURCE_CHARS = 2048;
const MAX_ERROR_LOG_CHARS = 512;

function safeErrorField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}

function redactDiagnosticMessage(value: unknown, event: WhatsAppInboundEvent): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  let message = value.slice(0, MAX_ERROR_SOURCE_CHARS);
  const privateValues = [
    event.customerPhone,
    event.providerMessageId,
    event.contextMessageId ?? "",
    event.content.type === "text" ? event.content.text : "",
    event.content.type === "audio" ? event.content.mediaId : "",
  ].filter((item) => item.length > 0);
  for (const privateValue of privateValues) {
    message = message.replaceAll(privateValue, "[redacted]");
  }
  const redacted = message
    .replace(/\b(?:postgres(?:ql)?|https?|redis(?:s)?|amqps?|mysql):\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu, "$1 [redacted]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_]{6,}|xox[baprs]-[^\s"']{6,})/giu, "[redacted-credential]")
    .replace(/\b((?:api[\s_-]?key|access[_-]?token|password|secret|authorization|client[_-]?secret|token)\s*[:=]\s*)\S+/giu, "$1[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, "[redacted-number]");
  const cleanMessage = Array.from(redacted, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim();
  if (!cleanMessage) return undefined;
  return cleanMessage.length > MAX_ERROR_LOG_CHARS
    ? `${cleanMessage.slice(0, MAX_ERROR_LOG_CHARS - 3)}...`
    : cleanMessage;
}

function safeErrorDiagnostic(error: unknown, event: WhatsAppInboundEvent): Record<string, string> {
  const name = safeErrorField(error, "name");
  const message = safeErrorField(error, "message") ?? (typeof error === "string" ? error : undefined);
  const cause = safeErrorField(error, "cause");
  const causeMessage = safeErrorField(cause, "message") ?? (typeof cause === "string" ? cause : undefined);
  const code = safeErrorField(error, "code");
  const status = safeErrorField(error, "status");
  const errorName = typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name)
    ? name
    : error instanceof Error ? "Error" : "NonErrorThrownValue";
  const sourceMessage = redactDiagnosticMessage(message, event);
  const sourceCause = redactDiagnosticMessage(causeMessage, event);
  const errorCode = typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(code) ? code : undefined;
  const statusCode = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? String(status)
    : undefined;
  return {
    errorName,
    ...(sourceMessage ? { errorMessage: sourceMessage } : {}),
    ...(sourceCause ? { causeMessage: sourceCause } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(statusCode ? { statusCode } : {}),
  };
}

function logSuppressed(
  log: Pick<StructuredLogger, "info">,
  event: WhatsAppInboundEvent,
  reason: Extract<RoutingGuidanceOutcome, { kind: "suppressed" }>["reason"],
): void {
  log.info("whatsapp.inbound.guidance_suppressed", {
    messageDigest: createHash("sha256").update(event.providerMessageId).digest("hex").slice(0, 16),
    reason,
  });
}

function logFailure(
  log: Pick<StructuredLogger, "error">,
  event: WhatsAppInboundEvent,
  operation: string,
  reason: Extract<RoutingGuidanceOutcome, { kind: "failed" }>["reason"],
  error: unknown,
): void {
  log.error("whatsapp.inbound.guidance_failed", {
    messageDigest: createHash("sha256").update(event.providerMessageId).digest("hex").slice(0, 16),
    operation,
    reason,
    ...safeErrorDiagnostic(error, event),
  });
}

// Called only after canonical inbound parsing and raw abuse admission. This
// platform reply has no merchant conversation, reservation, grant or usage.
export async function sendRoutingGuidance(
  event: WhatsAppInboundEvent,
  reason: RoutingGuidanceReason,
  {
    database = prisma,
    cache = connectionRedis,
    provider = whatsAppService,
    logger: log = logger,
  }: GuidanceDependencies = {},
): Promise<RoutingGuidanceOutcome> {
  if (event.content.type === "unsupported") {
    logSuppressed(log, event, "UNSUPPORTED");
    return { kind: "suppressed", reason: "UNSUPPORTED" };
  }

  let sender: Awaited<ReturnType<typeof provider.resolveSender>>;
  try {
    sender = await provider.resolveSender();
  } catch (error) {
    logFailure(log, event, "sender-resolution", "PROVIDER_SEND_FAILED", error);
    return { kind: "failed", reason: "PROVIDER_SEND_FAILED" };
  }
  if (
    event.providerAccountId !== sender.providerAccountId ||
    event.providerPhoneNumberId !== sender.providerPhoneNumberId
  ) {
    logSuppressed(log, event, "INVALID_SENDER");
    return { kind: "suppressed", reason: "INVALID_SENDER" };
  }

  const canonical = canonicalWhatsAppSender(event.customerPhone);
  if (!canonical) {
    logSuppressed(log, event, "NO_CONTACT");
    return { kind: "suppressed", reason: "NO_CONTACT" };
  }
  const digest = createHash("sha256").update(event.providerMessageId).digest("hex");
  const key = `moda:${resolveDeploymentEnvironmentName()}:whatsapp:clarification:${digest}`;
  try {
    if ((await cache.set(key, "1", "EX", 86400, "NX")) !== "OK") {
      logSuppressed(log, event, "DUPLICATE");
      return { kind: "suppressed", reason: "DUPLICATE" };
    }
  } catch (error) {
    logFailure(log, event, "redis-admission", "CACHE_UNAVAILABLE", error);
    return { kind: "failed", reason: "CACHE_UNAVAILABLE" };
  }

  let admitted: boolean;
  try {
    // There is no merchant conversation/Shop to use as a final fence. A short
    // PostgreSQL transaction acquires the same canonical recipient lock as STOP.
    admitted = await database.$transaction(async (tx) => {
      await lockWhatsAppStopRecipient(tx, canonical);
      return !(await hasLocalNoContact(tx, { recipient: event.customerPhone }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    logFailure(log, event, "database-admission", "DB_ADMISSION_FAILED", error);
    return { kind: "failed", reason: "DB_ADMISSION_FAILED" };
  }
  if (!admitted) {
    logSuppressed(log, event, "NO_CONTACT");
    return { kind: "suppressed", reason: "NO_CONTACT" };
  }

  try {
    await provider.sendWhatsAppText(
      { to: event.customerPhone, text: routingGuidanceText[reason] },
      AbortSignal.timeout(10_000),
    );
    return { kind: "sent" };
  } catch (error) {
    // Keep the guard after an ambiguous provider failure: never auto-resend.
    logFailure(log, event, "meta-send", "PROVIDER_SEND_FAILED", error);
    return { kind: "failed", reason: "PROVIDER_SEND_FAILED" };
  }
}
