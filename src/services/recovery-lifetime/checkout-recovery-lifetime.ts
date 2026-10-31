import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";

const MILLISECONDS_PER_DAY = 86_400_000n;

export interface CheckoutRecoveryLifetimeReader {
  read(): Promise<number>;
}

export class CheckoutRecoveryLifetimePolicyUnavailableError extends Error {
  constructor(readonly reason: "missing" | "invalid") {
    super(`Checkout recovery lifetime policy is ${reason}.`);
    this.name = "CheckoutRecoveryLifetimePolicyUnavailableError";
  }
}

export function parseCheckoutRecoveryLifetimeDays(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new RangeError("Invalid checkout recovery lifetime days.");
  }
  return value;
}

export function isCheckoutRecoveryWithinLifetime(input: Readonly<{
  lastExternalActivityAt: Date;
  now: Date;
  checkoutRecoveryLifetimeDays: number;
}>): boolean {
  const { lastExternalActivityAt, now, checkoutRecoveryLifetimeDays } = input;
  if (!(lastExternalActivityAt instanceof Date) || !(now instanceof Date) ||
      !Number.isSafeInteger(lastExternalActivityAt.getTime()) || !Number.isSafeInteger(now.getTime()) ||
      !Number.isSafeInteger(checkoutRecoveryLifetimeDays) || checkoutRecoveryLifetimeDays < 0) {
    return false;
  }

  const activityAtMs = BigInt(lastExternalActivityAt.getTime());
  const nowMs = BigInt(now.getTime());
  if (activityAtMs > nowMs) return false;
  return nowMs - activityAtMs < BigInt(checkoutRecoveryLifetimeDays) * MILLISECONDS_PER_DAY;
}

type LifetimePolicyDatabase = Pick<PrismaClient, "backgroundRuntimeConfig">;

export class PersistedCheckoutRecoveryLifetimeReader implements CheckoutRecoveryLifetimeReader {
  constructor(private readonly database: LifetimePolicyDatabase = prisma) {}

  async read(): Promise<number> {
    const row = await this.database.backgroundRuntimeConfig.findUnique({
      where: { id: "default" },
      select: { checkoutRecoveryLifetimeDays: true },
    });
    if (!row) throw new CheckoutRecoveryLifetimePolicyUnavailableError("missing");
    try {
      return parseCheckoutRecoveryLifetimeDays(row.checkoutRecoveryLifetimeDays);
    } catch {
      throw new CheckoutRecoveryLifetimePolicyUnavailableError("invalid");
    }
  }
}