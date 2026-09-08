import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

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

for index = 1, scopeCount do
  local windowMs = tonumber(ARGV[offset])
  local limit = tonumber(ARGV[offset + 1])
  redis.call('ZREMRANGEBYSCORE', KEYS[index], '-inf', nowMs - windowMs)
  if redis.call('ZSCORE', KEYS[index], member) == false and redis.call('ZCARD', KEYS[index]) >= limit then
    return index
  end
  offset = offset + 2
end

offset = 2
for index = 1, scopeCount do
  local windowMs = tonumber(ARGV[offset])
  redis.call('ZADD', KEYS[index], nowMs, member)
  redis.call('EXPIRE', KEYS[index], math.ceil(windowMs / 1000) + 1)
  offset = offset + 2
end

return 0
`;

export class InboundWhatsAppAbuseAdmissionService {
  constructor(private readonly redis: RedisLike = connectionRedis) {}

  async admitRaw(input: {
    providerMessageId: string;
    customerPhone: string;
  }): Promise<InboundAbuseAdmission> {
    return this.admit("raw", input.providerMessageId, input.customerPhone, [
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
    conversationType: "PRODUCT_DISCOVERY" | "PRODUCT_SUPPORT";
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
      input.customerPhone,
      scopes,
    );
  }

  private async admit(
    stage: "raw" | "settled-turn",
    member: string,
    customerPhone: string,
    scopes: Scope[],
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
        recordAdmission(stage, "allowed");
        return { kind: "allowed" };
      }
      const denied = scopes[result - 1];
      const reason = denied?.reason ?? "LIMITER_UNAVAILABLE";
      recordAdmission(stage, reason);
      return { kind: "denied", stage, reason };
    } catch {
      recordAdmission(stage, "LIMITER_UNAVAILABLE");
      return { kind: "denied", stage, reason: "LIMITER_UNAVAILABLE" };
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

function recordAdmission(
  stage: "raw" | "settled-turn",
  result: string,
): void {
  try {
    console.log("Inbound WhatsApp abuse admission", { stage, result });
  } catch {
    // Admission telemetry must not affect job handling.
  }
}
