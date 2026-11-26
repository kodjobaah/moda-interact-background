import { Prisma } from "@prisma/client";
import { setTimeout as delay } from "node:timers/promises";
import { isRecoveryReservationRetryableConflict } from "../recovery-reservation/reservation-lifecycle.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";

/** Only use for database-only, replayable owners. Never wrap provider calls,
 * an outbound dispatch permit, or an entire execution job with this policy. */
export function isReplayableRecoveryTransactionError(error: unknown): boolean {
  if (isRecoveryReservationRetryableConflict(error)) return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2010") return error.meta?.code === "40001" || error.meta?.code === "40P01";
  return error.code === "P2028" && closedTransactionKind(error) !== undefined;
}

function closedTransactionKind(error: Prisma.PrismaClientKnownRequestError) {
  const detail = typeof error.meta?.error === "string" ? error.meta.error : "";
  const message = `${error.message}\n${detail}`;
  if (/expired transaction|transaction (?:has )?expired/i.test(message)) return "expired";
  if (/transaction not found/i.test(message)) return "not-found";
  if (/transaction already closed/i.test(message)) return "closed";
  return undefined;
}

/** Prisma often prefixes the real error with a lengthy source excerpt. Retain
 * a separate bounded diagnostic for its actual transaction failure reason. */
export function transactionFailureDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2028") return {};
  const kind = closedTransactionKind(error);
  if (!kind) return {};
  const marker = error.message.lastIndexOf("Transaction API error:");
  const detail = marker >= 0 ? error.message.slice(marker) : typeof error.meta?.error === "string" ? error.meta.error : error.message;
  const durations = /timeout for this transaction was (\d+) ms, however (\d+) ms passed/i.exec(detail);
  return { transactionFailureKind: kind, transactionErrorMessage: initialOutreachDiagnostic(detail).message,
    ...(durations ? { prismaTimeoutMs: Number(durations[1]), prismaElapsedMs: Number(durations[2]) } : {}) };
}

/** Small bounded backoff outside the transaction, including after an uncertain
 * commit. The next transaction MUST reread the exact durable identity. */
export function recoveryTransactionBackoffMs(attempt: number): number {
  return Math.min(250, 50 * Math.max(1, attempt));
}
export async function waitForRecoveryTransactionReplay(attempt: number): Promise<void> {
  await delay(recoveryTransactionBackoffMs(attempt));
}

/** Monotonic wall timing: stages include database round trips/lock waits;
 * they are not server-side SQL execution time. Initial phase includes pool
 * acquisition. Commit phase includes commit acknowledgment. */
export class RecoveryTransactionTiming {
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stage = "transaction_acquire";
  private readonly durations: Record<string, number> = {};

  enter(stage: string): void {
    const now = performance.now();
    this.durations[this.stage] = (this.durations[this.stage] ?? 0) + now - this.stageStarted;
    this.stageStarted = now;
    this.stage = stage;
  }

  snapshot() {
    const now = performance.now();
    const values = { ...this.durations, [this.stage]: (this.durations[this.stage] ?? 0) + now - this.stageStarted };
    return { transactionElapsedMs: Math.round(now - this.started),
      stageDurationsMs: Object.fromEntries(Object.entries(values).map(([name, ms]) => [name, Math.round(ms)])) };
  }

  async measure<T>(operation: () => Promise<T>): Promise<T> {
    this.enter("identity");
    const result = await operation();
    this.enter("transaction_commit");
    return result;
  }
}

export const SLOW_RECOVERY_TRANSACTION_MS = 1_000;
