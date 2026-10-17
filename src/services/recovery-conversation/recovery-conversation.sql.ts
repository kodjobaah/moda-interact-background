/**
 * ARCH-040 SQL port. The accepted DATABASE-001 migration owns these names and
 * constraints. Fixed statements use bound positional values (never interpolated
 * merchant data). The Background database gitlink must contain DATABASE-001.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import prisma from "../../lib/db.js";

export type SqlTransaction = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export type RecoveryDatabase = Pick<PrismaClient, "$transaction" | "$queryRawUnsafe" | "$executeRawUnsafe">;
export const recoveryDatabase: RecoveryDatabase = prisma;

export async function rows<T>(db: SqlTransaction, statement: string, ...params: unknown[]): Promise<T[]> {
  return db.$queryRawUnsafe<T[]>(statement, ...params);
}
export async function first<T>(db: SqlTransaction, statement: string, ...params: unknown[]): Promise<T | null> {
  return (await rows<T>(db, statement, ...params))[0] ?? null;
}
export async function changed(db: SqlTransaction, statement: string, ...params: unknown[]): Promise<number> {
  return db.$executeRawUnsafe(statement, ...params);
}

export type RecoveryContext = {
  id: string;
  shopId: string;
  recoveryId: string;
  checkoutToken: string;
  recoveryStatus: string;
  mode: "AI" | "HUMAN";
  revision: number;
  lastInboundAt: Date | null;
};

export const terminalRecovery = (status: string): boolean =>
  ["COMPLETED", "EXPIRED", "CANCELLED"].includes(status);

export async function readRecoveryContext(
  db: SqlTransaction, conversationId: string,
): Promise<RecoveryContext | null> {
  return first<RecoveryContext>(db, `
    SELECT c."id", r."shopId", r."id" AS "recoveryId", r."checkoutToken",
      r."status"::text AS "recoveryStatus", c."controlMode"::text AS "mode",
      c."controlRevision" AS "revision", c."lastInboundAt"
    FROM "whatsapp"."Conversation" c
    JOIN "commerce"."CheckoutRecovery" r ON r."id"=c."checkoutRecoveryId"
    WHERE c."id"=$1 AND c."type"='RECOVERY'
      AND (c."shopId" IS NULL OR c."shopId"=r."shopId")`, conversationId);
}

/** Lock order mandated by DATABASE-001: Shop -> Conversation -> command/attempt/message.
 * The Shop row (not an optional restriction row) serializes first suspension.
 * Never call Meta, Redis, or an HTTP policy adapter inside this transaction.
 */
export async function lockRecoveryContext(
  tx: SqlTransaction, conversationId: string,
): Promise<RecoveryContext | null> {
  const initial = await readRecoveryContext(tx, conversationId);
  if (!initial) return null;
  const shop = await first<{ id: string }>(tx,
    `SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, initial.shopId);
  if (!shop) return null;
  const locked = await first<{ id: string }>(tx,
    `SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=$1 FOR UPDATE`, conversationId);
  if (!locked) return null;
  const current = await readRecoveryContext(tx, conversationId);
  return current?.shopId === initial.shopId && current.recoveryId === initial.recoveryId ? current : null;
}

export type Decision = { kind: "allowed" } | { kind: "denied"; reason: string };
export const allowed = (): Decision => ({ kind: "allowed" });
export const denied = (reason: string): Decision => ({ kind: "denied", reason });
