import { createHash } from "node:crypto";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type { Redis } from "ioredis";
import { first, recoveryDatabase, type RecoveryDatabase } from "./recovery-conversation.sql.js";

export type HumanPolicyDecision = { kind: "allowed" }
  | { kind: "denied"; reason: "human_messaging_suspended" | "human_content_invalid" | "human_rate_limited" | "human_repeated_spam" }
  | { kind: "retryable"; reason: "human_screening_unavailable" };
export type HumanPolicyConfig = {
  maxTextCharacters: number; shopPerMinute: number;
  recipientPerHour: number; repeatedIdenticalPerTenMinutes: number;
};
export const DEFAULT_HUMAN_POLICY: HumanPolicyConfig = {
  maxTextCharacters: 4000,
  shopPerMinute: 30,
  recipientPerHour: 12,
  repeatedIdenticalPerTenMinutes: 3,
};
const logger = createLogger({
  serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName(),
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function normalizeHumanContent(text: string) {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** Atomic Redis screening, not inbound customer abuse counters. Rates and
 * deduplication are per command, not per lease/retry. Redis TIME is canonical.
 * All keys carry the same hash tag for a future Redis Cluster migration.
 */
const SCREEN_SCRIPT = `
local tick = redis.call('TIME')
local now = tick[1] * 1000 + math.floor(tick[2] / 1000)
local member = ARGV[1]
if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
local windows = {60000, 3600000, 600000}
for i=1,3 do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now-windows[i]) end
for i=1,3 do
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i+1]) then return i end
end
for i=1,3 do
  redis.call('ZADD', KEYS[i], 'NX', now, member)
  redis.call('PEXPIRE', KEYS[i], windows[i]+10000)
end
redis.call('SET', KEYS[4], '1', 'PX', 86400000, 'NX')
return 0
`;
export type RedisScreen = Pick<Redis, "eval">;

export class HumanSendPolicyService {
  constructor(
    private readonly database: RecoveryDatabase = recoveryDatabase,
    private readonly redis?: RedisScreen,
    private readonly limits: HumanPolicyConfig = DEFAULT_HUMAN_POLICY,
  ) {}

  async checkRestriction(shopId: string): Promise<HumanPolicyDecision> {
    const row = await first<{ status: string }>(this.database,
      `SELECT "status"::text FROM "commerce"."ShopHumanMessagingRestriction" WHERE "shopId"=$1`, shopId);
    return row?.status === "SUSPENDED"
      ? { kind: "denied", reason: "human_messaging_suspended" }
      : { kind: "allowed" };
  }

  validateContent(input: { kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE"; content: string; templateName?: string }): HumanPolicyDecision {
    if (input.kind === "HUMAN_TEXT") {
      const content = input.content.trim();
      const containsForbiddenControl = [...content].some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x08 || (codePoint >= 0x0e && codePoint <= 0x1f) || codePoint === 0x7f;
      });
      if (!content || [...content].length > this.limits.maxTextCharacters || containsForbiddenControl)
        return { kind: "denied", reason: "human_content_invalid" };
    } else if (!input.templateName || !/^[A-Za-z0-9_]{1,255}$/.test(input.templateName)) {
      return { kind: "denied", reason: "human_content_invalid" };
    }
    return { kind: "allowed" };
  }

  async screenHumanCommand(input: {
    commandId: string; shopId: string; recipient: string;
    kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE";
    content: string; templateName?: string;
  }): Promise<HumanPolicyDecision> {
    const valid = this.validateContent(input);
    if (valid.kind !== "allowed" || !input.recipient.trim())
      return valid.kind !== "allowed" ? valid : { kind: "denied", reason: "human_content_invalid" };
    const restriction = await this.checkRestriction(input.shopId);
    if (restriction.kind !== "allowed") return restriction;
    if (!this.redis) return { kind: "retryable", reason: "human_screening_unavailable" };
    const scope = digest(input.shopId).slice(0, 24);
    const recipient = digest(input.recipient).slice(0, 24);
    const normalized = digest(normalizeHumanContent(input.content));
    const hashTag = `{arch040-${scope}}`;
    try {
      const result = Number(await this.redis.eval(SCREEN_SCRIPT, 4,
        `human:${hashTag}:shop`,
        `human:${hashTag}:recipient:${recipient}`,
        `human:${hashTag}:repeat:${recipient}:${normalized}`,
        `human:${hashTag}:seen:${digest(input.commandId)}`,
        digest(input.commandId),
        this.limits.shopPerMinute, this.limits.recipientPerHour,
        this.limits.repeatedIdenticalPerTenMinutes));
      if (result === 0) return { kind: "allowed" };
      if (result === 3) return { kind: "denied", reason: "human_repeated_spam" };
      if (result === 1 || result === 2) return { kind: "denied", reason: "human_rate_limited" };
      return { kind: "retryable", reason: "human_screening_unavailable" };
    } catch (error) {
      // Fail closed without hiding infrastructure errors. Redis screening is
      // retryable and must not become a silent ALLOW or permanent refusal.
      logger.warn("arch040.human_screening.unavailable", {
        commandId: input.commandId, shopId: input.shopId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return { kind: "retryable", reason: "human_screening_unavailable" };
    }
  }
}
