import { createHash } from "node:crypto";

import { connectionRedis } from "../../lib/redis.js";
import type { WooCheckoutRef } from "./contracts.js";

/** No contact, basket or unhashed checkout identifier is persisted here. */
export type WooActivityWatermark = Readonly<{
  /** Temporarily optional in the type bridge; all BG007 writes include it. */
  generation?: number;
  lastEventId: string;
  lastActivityAt: string;
  checkoutDigest: string;
  state: "nonempty" | "empty" | "unknown" | "conflicting";
}>;

export interface WooActivityWatermarkPort {
  read(ref: WooCheckoutRef): Promise<WooActivityWatermark | null>;
  write(ref: WooCheckoutRef, value: WooActivityWatermark, retentionMs: number): Promise<void>;
}

type WatermarkRedis = Pick<typeof connectionRedis, "get" | "set">;

export function wooActivityWatermarkKey(ref: WooCheckoutRef): string {
  const digest = createHash("sha256")
    .update(ref.shopId)
    .update("\0")
    .update(ref.checkoutToken)
    .digest("hex");
  return `pending-recovery:woo:activity:${digest}`;
}

/** Retain the watermark past maturity for delayed retries and replayed webhooks.
 * This is a bounded transient guard, NOT proof of an unreceived Woo event. */
export const WOO_REPLAY_BUFFER_MS = 24 * 60 * 60_000;
export const MAX_WOO_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function wooCandidateRetentionMs(dueAtMs: number, nowMs: number): number | null {
  if (!Number.isFinite(dueAtMs) || !Number.isFinite(nowMs)) return null;
  const ttl = Math.ceil(Math.max(0, dueAtMs - nowMs) + WOO_REPLAY_BUFFER_MS);
  return ttl > MAX_WOO_RETENTION_MS ? null : ttl;
}

function isWatermark(value: unknown): value is WooActivityWatermark {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.lastEventId === "string" &&
    candidate.lastEventId.length > 0 && candidate.lastEventId.length <= 128 &&
    typeof candidate.lastActivityAt === "string" &&
    Number.isFinite(Date.parse(candidate.lastActivityAt)) &&
    typeof candidate.checkoutDigest === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.checkoutDigest) &&
    ["nonempty", "empty", "unknown", "conflicting"].includes(String(candidate.state)) &&
    Number.isSafeInteger(candidate.generation) && Number(candidate.generation) > 0;
}

/** A corrupt Redis watermark is a retryable failure, not permission to send. */
export class WooActivityWatermarkStore implements WooActivityWatermarkPort {
  constructor(private readonly redis: WatermarkRedis = connectionRedis) {}

  async read(ref: WooCheckoutRef): Promise<WooActivityWatermark | null> {
    const raw = await this.redis.get(wooActivityWatermarkKey(ref));
    if (raw === null) return null;
    if (Buffer.byteLength(raw) > 1_024) throw new Error("Invalid Woo activity watermark");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid Woo activity watermark");
    }
    if (!isWatermark(parsed)) throw new Error("Invalid Woo activity watermark");
    return parsed;
  }

  async write(ref: WooCheckoutRef, value: WooActivityWatermark, retentionMs: number): Promise<void> {
    if (!isWatermark(value) || !Number.isSafeInteger(retentionMs) ||
      retentionMs < WOO_REPLAY_BUFFER_MS || retentionMs > MAX_WOO_RETENTION_MS) {
      throw new Error("Invalid Woo activity watermark retention");
    }
    await this.redis.set(wooActivityWatermarkKey(ref), JSON.stringify(value), "PX", retentionMs);
  }
}
