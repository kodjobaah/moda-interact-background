/** ARCH-043: read-only, operation-scoped platform settings. No cached snapshots. */
import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { defaultWooCouponSyncConfig, validateWooCouponSyncConfig, type WooCouponSyncConfig } from "./woo-coupon-sync-config.js";

export type PlatformConfigDb = Pick<PrismaClient, "platformConfiguration">;
export type TranscriptionPolicy = Readonly<{ provider: "groq" | "openai"; groqModelId: string; openaiModelId: string }>;
const DEFAULT_TRANSCRIPTION: TranscriptionPolicy = Object.freeze({
  provider: "groq", groqModelId: "whisper-large-v3-turbo", openaiModelId: "gpt-4o-mini-transcribe",
});
export class OperationalPolicyError extends Error {
  constructor(readonly code: "database_unavailable" | "invalid_policy" | "disabled_policy") {
    super(`platform-policy-${code}`);
    this.name = "OperationalPolicyError";
  }
}
function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new OperationalPolicyError("invalid_policy");
  }
  return value as Record<string, unknown>;
}
function disabled(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as Record<string, unknown>).kind !== "disabled") return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.schemaVersion !== 1) {
    throw new OperationalPolicyError("invalid_policy");
  }
  return true;
}
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function validateTranscriptionPolicy(value: unknown): TranscriptionPolicy {
  const row = closedObject(value, ["provider", "groqModelId", "openaiModelId"]);
  if ((row.provider !== "groq" && row.provider !== "openai") ||
      typeof row.groqModelId !== "string" || !modelPattern.test(row.groqModelId) ||
      typeof row.openaiModelId !== "string" || !modelPattern.test(row.openaiModelId)) {
    throw new OperationalPolicyError("invalid_policy");
  }
  return Object.freeze(row as unknown as TranscriptionPolicy);
}
export class PlatformOperationalPolicyReader {
  constructor(
    private readonly db: PlatformConfigDb = prisma,
    private readonly environment: string = resolveDeploymentEnvironmentName(),
  ) {
    if (!/^(local|test|development|staging|production)$/.test(environment)) {
      throw new OperationalPolicyError("invalid_policy");
    }
  }
  private async get(key: "woo.couponSync" | "speech.transcription"): Promise<unknown | null> {
    try {
      const row = await this.db.platformConfiguration.findUnique({
        where: { environment_key: { environment: this.environment, key } },
        select: { environment: true, key: true, value: true, version: true },
      });
      if (!row) return null;
      if (row.environment !== this.environment || row.key !== key ||
          !Number.isSafeInteger(row.version) || row.version < 1) throw new OperationalPolicyError("invalid_policy");
      if (disabled(row.value)) throw new OperationalPolicyError("disabled_policy");
      return row.value;
    } catch (error) {
      if (error instanceof OperationalPolicyError) throw error;
      throw new OperationalPolicyError("database_unavailable");
    }
  }
  async wooCouponSync(): Promise<Readonly<WooCouponSyncConfig & { workerConcurrency: number }>> {
    const value = await this.get("woo.couponSync");
    return value === null ? Object.freeze({ ...defaultWooCouponSyncConfig(), workerConcurrency: 4 })
      : validateWooCouponSyncConfig(value);
  }
  async transcription(): Promise<TranscriptionPolicy> {
    const value = await this.get("speech.transcription");
    return value === null ? DEFAULT_TRANSCRIPTION : validateTranscriptionPolicy(value);
  }
}
export const platformOperationalPolicyReader = new PlatformOperationalPolicyReader();
