import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";

import { connectionRedis } from "../lib/redis.js";

export type InboundAbuseAdmission =
  | { kind: "allowed" }
  | {
      kind: "denied";
      stage: "raw" | "settled-turn";
      reason:
        | "RAW_SENDER"
        | "RAW_GLOBAL"
        | "TURN_SENDER_SHORT"
        | "TURN_SENDER_LONG"
        | "TURN_CONVERSATION_SHORT"
        | "TURN_CONVERSATION_LONG"
        | "TURN_SHOP"
        | "TURN_GLOBAL"
        | "LIMITER_UNAVAILABLE";
    };

export type InboundAbuseConversationType =
  | "RECOVERY"
  | "PRODUCT_DISCOVERY"
  | "PRODUCT_SUPPORT"
  | "POST_PURCHASE";

type Scope = {
  key: string;
  windowMs: number;
  limit: number;
  reason: AdmissionReason;
};

type AdmissionReason = Extract<
  Extract<InboundAbuseAdmission, { kind: "denied" }>['reason'],
  string
>;

type RedisLike = Pick<Redis, "eval">;

type AdmissionTelemetry = {
  conversationType?: InboundAbuseConversationType;
  recoveryLinked?: boolean;
};

const RAW_SENDER_WINDOW_MS = 60_000;
const RAW_SENDER_LIMIT = 60;
const RAW_GLOBAL_WINDOW_MS = 60_000;
const RAW_GLOBAL_LIMIT = 20_000;

const TURN_SENDER_SHORT_WINDOW_MS = 60_000;
const TURN_SENDER_SHORT_LIMIT = 12;
const TURN_SENDER_LONG_WINDOW_MS = 600_000;
const TURN_SENDER_LONG_LIMIT = 60;
const TURN_CONVERSATION_SHORT_WINDOW_MS = 60_000;
const TURN_CONVERSATION_SHORT_LIMIT = 12;
const TURN_CONVERSATION_LONG_WINDOW_MS = 600_000;
const TURN_CONVERSATION_LONG_LIMIT = 60;
const TURN_SHOP_WINDOW_MS = 60_000;
const TURN_SHOP_LIMIT = 600;
const TURN_GLOBAL_WINDOW_MS = 60_000;
const TURN_GLOBAL_LIMIT = 5_000;
const DISCOVERY_SENDER_SHORT_LIMIT = 4;
const DISCOVERY_SENDER_LONG_LIMIT = 12;
const DISCOVERY_CONVERSATION_SHORT_LIMIT = 4;
const DISCOVERY_CONVERSATION_LONG_LIMIT = 12;

const ADMIT_SCRIPT = `
local nowReply = redis.call('TIME')
local nowMs = (nowReply[1] * 1000) + math.floor(nowReply[2] / 1000)
local member = ARGV[1]
local scopeCount = #KEYS
local offset = 2
local seenAnywhere = false

for index = 1, scopeCount do
  local windowMs = tonumber(ARGV[offset])
  redis.call('ZREMRANGEBYSCORE', KEYS[index], '-inf', nowMs - windowMs)
  if redis.call('ZSCORE', KEYS[index], member) ~= false then
    seenAnywhere = true
  end
  offset = offset + 2
end

if seenAnywhere then
  return 0
end

offset = 2
for index = 1, scopeCount do
  local limit = tonumber(ARGV[offset + 1])
  if redis.call('ZCARD', KEYS[index]) >= limit then
    return index
  end
  offset = offset + 2
end

offset = 2
for index = 1, scopeCount do
  local windowMs = tonumber(ARGV[offset])
  if redis.call('ZSCORE', KEYS[index], member) == false then
    redis.call('ZADD', KEYS[index], nowMs, member)
    redis.call('EXPIRE', KEYS[index], math.ceil(windowMs / 1000) + 1)
  end
  offset = offset + 2
end

return 0
`;

export class InboundWhatsAppAbuseAdmissionService {
  constructor(
    private readonly redis: RedisLike = connectionRedis,
    private readonly logger: StructuredLogger = createLogger({
      serviceName: "moda-messaging-worker",
      environment: process.env.NODE_ENV ?? "development",
    }),
  ) {}

  async admitRaw(input: {
    providerMessageId: string;
    customerPhone: string;
  }): Promise<InboundAbuseAdmission> {
    return this.admit("raw", input.providerMessageId, [
      {
        key: `raw:sender:${senderHash(input.customerPhone)}:60s`,
        windowMs: RAW_SENDER_WINDOW_MS,
        limit: RAW_SENDER_LIMIT,
        reason: "RAW_SENDER",
      },
      {
        key: "raw:global:60s",
        windowMs: RAW_GLOBAL_WINDOW_MS,
        limit: RAW_GLOBAL_LIMIT,
        reason: "RAW_GLOBAL",
      },
    ]);
  }

  async admitSettledTurn(input: {
    conversationId: string;
    observedVersion: number;
    shopId: string;
    customerPhone: string;
    conversationType: InboundAbuseConversationType;
    hasReplyContext: boolean;
    checkoutRecoveryId: string | null;
  }): Promise<InboundAbuseAdmission> {
    const discoveryOnly =
      input.conversationType === "PRODUCT_DISCOVERY" && !input.hasReplyContext;
    const senderHashValue = senderHash(input.customerPhone);
    const scopes: Scope[] = [
      {
        key: `turn:sender:${senderHashValue}:60s`,
        windowMs: TURN_SENDER_SHORT_WINDOW_MS,
        limit: discoveryOnly
          ? DISCOVERY_SENDER_SHORT_LIMIT
          : TURN_SENDER_SHORT_LIMIT,
        reason: "TURN_SENDER_SHORT",
      },
      {
        key: `turn:sender:${senderHashValue}:600s`,
        windowMs: TURN_SENDER_LONG_WINDOW_MS,
        limit: discoveryOnly
          ? DISCOVERY_SENDER_LONG_LIMIT
          : TURN_SENDER_LONG_LIMIT,
        reason: "TURN_SENDER_LONG",
      },
      {
        key: `turn:conversation:${input.conversationId}:60s`,
        windowMs: TURN_CONVERSATION_SHORT_WINDOW_MS,
        limit: discoveryOnly
          ? DISCOVERY_CONVERSATION_SHORT_LIMIT
          : TURN_CONVERSATION_SHORT_LIMIT,
        reason: "TURN_CONVERSATION_SHORT",
      },
      {
        key: `turn:conversation:${input.conversationId}:600s`,
        windowMs: TURN_CONVERSATION_LONG_WINDOW_MS,
        limit: discoveryOnly
          ? DISCOVERY_CONVERSATION_LONG_LIMIT
          : TURN_CONVERSATION_LONG_LIMIT,
        reason: "TURN_CONVERSATION_LONG",
      },
      {
        key: `turn:shop:${input.shopId}:60s`,
        windowMs: TURN_SHOP_WINDOW_MS,
        limit: TURN_SHOP_LIMIT,
        reason: "TURN_SHOP",
      },
      {
        key: "turn:global:60s",
        windowMs: TURN_GLOBAL_WINDOW_MS,
        limit: TURN_GLOBAL_LIMIT,
        reason: "TURN_GLOBAL",
      },
    ];
    return this.admit(
      "settled-turn",
      `${input.conversationId}:${input.observedVersion}`,
      scopes,
      {
        conversationType: input.conversationType,
        recoveryLinked: input.checkoutRecoveryId !== null,
      },
    );
  }

  private async admit(
    stage: "raw" | "settled-turn",
    member: string,
    scopes: Scope[],
    telemetry: AdmissionTelemetry = {},
  ): Promise<InboundAbuseAdmission> {
    try {
      const result = Number(
        await this.redis.eval(
          ADMIT_SCRIPT,
          scopes.length,
          ...scopes.map((scope) => `arch007:wa-abuse:v1:${scope.key}`),
          member,
          ...scopes.flatMap((scope) => [
            String(scope.windowMs),
            String(scope.limit),
          ]),
        ),
      );
      if (result === 0) {
        this.recordAdmission(stage, "allowed", undefined, telemetry);
        return { kind: "allowed" };
      }
      const denied = scopes[result - 1];
      const reason = denied?.reason ?? "LIMITER_UNAVAILABLE";
      this.recordAdmission(stage, "denied", reason, telemetry);
      return { kind: "denied", stage, reason };
    } catch {
      this.recordAdmission(
        stage,
        "denied",
        "LIMITER_UNAVAILABLE",
        telemetry,
      );
      return { kind: "denied", stage, reason: "LIMITER_UNAVAILABLE" };
    }
  }

  private recordAdmission(
    stage: "raw" | "settled-turn",
    outcome: "allowed" | "denied",
    reason?: AdmissionReason,
    telemetry: AdmissionTelemetry = {},
  ): void {
    const fields = {
      stage,
      outcome,
      ...telemetry,
      ...(reason ? { reason } : {}),
    };
    try {
      if (outcome === "denied") {
        this.logger.warn("whatsapp.abuse_admission", fields);
      } else {
        this.logger.info("whatsapp.abuse_admission", fields);
      }
    } catch {
      // Admission telemetry must never change the admission decision.
    }
  }
}
export const inboundWhatsAppAbuseAdmissionService =
  new InboundWhatsAppAbuseAdmissionService();

function senderHash(phone: string): string {
  return createHash("sha256").update(normalizePhone(phone)).digest("hex");
}

function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  return `${plus}${trimmed.replace(/\D/g, "")}`;
}
