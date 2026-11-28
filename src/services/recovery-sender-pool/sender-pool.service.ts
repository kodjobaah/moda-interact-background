import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import {
  isCheckoutRecoveryWithinLifetime,
  parseCheckoutRecoveryLifetimeDays,
} from "../recovery-lifetime/checkout-recovery-lifetime.js";
import { platformConsumerConfiguration } from "../platform-configuration/consumers.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { lockRecoverySenderRecipient } from "./recipient-lock.js";

type Tx = Prisma.TransactionClient;
type Owner = {
  id: string;
  shopId: string | null;
  checkoutRecoveryId: string | null;
  type: string;
};
type Recovery = {
  id: string;
  shopId: string;
  status: string;
  completedAt: Date | null;
  expiredAt: Date | null;
  lastExternalActivityAt: Date;
};
export type RecoverySenderIdentity = Readonly<{
  conversationId: string;
  routeId: string;
  threadId: string;
  canonicalRecipient: string;
  providerPhoneNumberId: string;
  providerAccountId: string;
}>;
export type SenderAccountSnapshot = Readonly<{
  accountId: string;
  rowId: string;
  version: number;
  environment: string;
}>;
async function readSenderAccount(): Promise<SenderAccountSnapshot> {
  const row = await platformConsumerConfiguration.read("messaging.sender");
  if (!row.rowId || !/^[0-9]{1,64}$/.test(row.value.businessAccountId))
    throw new Error("SENDER_ACCOUNT_CONFIGURATION_INVALID");
  return {
    accountId: row.value.businessAccountId,
    rowId: row.rowId,
    version: row.version,
    environment: resolveDeploymentEnvironmentName(),
  };
}
export type SenderAllocation =
  | { kind: "assigned"; sender: RecoverySenderIdentity }
  | { kind: "held"; reason: "sender-inventory-unavailable" }
  | {
      kind: "unavailable";
      reason: "recovery-terminal" | "assignment-released";
    };
const terminal = (r: Recovery, now: Date, days: number) =>
  !["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(r.status) ||
  r.completedAt !== null ||
  (r.expiredAt !== null && r.expiredAt <= now) ||
  (r.lastExternalActivityAt <= now &&
    !isCheckoutRecoveryWithinLifetime({
      lastExternalActivityAt: r.lastExternalActivityAt,
      now,
      checkoutRecoveryLifetimeDays: days,
    }));

/** Sender ownership never reads billing, allowance counters, model or plan state.
 * All provider/model/Redis calls stay outside these transactions. */
export class RecoverySenderPoolService {
  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly clock: () => Date = () => new Date(),
    private readonly readAccount: () => Promise<SenderAccountSnapshot> = readSenderAccount,
  ) {}

  async allocate(input: {
    conversationId: string;
    canonicalRecipient: string;
    initialAttemptId?: string;
  }): Promise<SenderAllocation> {
    // Capture configuration outside locks. An outage cannot change or prevent
    // reuse of existing immutable ownership; only a new route needs this grant.
    let account: SenderAccountSnapshot | undefined;
    let accountError: unknown;
    try {
      account = await this.readAccount();
    } catch (error) {
      accountError = error;
    }
    return this.database.$transaction(
      async (tx) => {
        await lockRecoverySenderRecipient(tx, input.canonicalRecipient);
        const now = this.clock();
        const days = await this.lifetime(tx);
        await this.releaseInactive(
          tx,
          input.canonicalRecipient,
          now,
          days,
          input.conversationId,
        );
        const owner = await this.owner(tx, input.conversationId);
        const recovery = await this.recovery(tx, owner);
        if (terminal(recovery, now, days))
          return { kind: "unavailable", reason: "recovery-terminal" };
        const existing = await this.assignment(tx, input.conversationId);
        if (existing) {
          if (existing.canonicalRecipient !== input.canonicalRecipient)
            throw new Error("SENDER_ASSIGNMENT_RECIPIENT_MISMATCH");
          if (existing.releasedAt !== null)
            return { kind: "unavailable", reason: "assignment-released" };
          if (input.initialAttemptId)
            await this.clearInventoryHold(tx, input.initialAttemptId, recovery);
          return { kind: "assigned", sender: this.identity(existing) };
        }
        const routes = await tx.$queryRawUnsafe<
          Array<{
            id: string;
            threadId: string;
            providerPhoneNumberId: string;
            providerAccountId: string;
          }>
        >(
          `
        SELECT r.id,r."threadId",r."providerPhoneNumberId",s."providerAccountId"
        FROM whatsapp."RecoverySenderRoute" r JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=r."providerPhoneNumberId"
        WHERE r."canonicalRecipient"=$1 AND r."shopId"=$2 AND r."closedAt" IS NULL
        ORDER BY r.id COLLATE "C" FOR UPDATE OF r`,
          input.canonicalRecipient,
          recovery.shopId,
        );
        let route = routes[0];
        if (!route) {
          if (!account)
            throw (
              accountError ??
              new Error("SENDER_ACCOUNT_CONFIGURATION_UNAVAILABLE")
            );
          const currentAccount = await tx.$queryRawUnsafe<
            Array<{ id: string }>
          >(
            `SELECT id FROM public."PlatformConfiguration" WHERE id=$1 AND environment=$2 AND key='messaging.sender' AND version=$3 FOR SHARE`,
            account.rowId,
            account.environment,
            account.version,
          );
          if (!currentAccount[0])
            throw new Error("SENDER_ACCOUNT_CONFIGURATION_CHANGED");
          const senders = await tx.$queryRawUnsafe<
            Array<{ providerPhoneNumberId: string; providerAccountId: string }>
          >(
            `
          SELECT s."providerPhoneNumberId",s."providerAccountId" FROM whatsapp."WhatsAppPoolSender" s
          WHERE s."allocationEnabled" AND s."verifiedAt"<=$2 AND s."providerAccountId"=$3
          ORDER BY (SELECT COUNT(DISTINCT r."shopId") FROM whatsapp."RecoverySenderRoute" r
            WHERE r."canonicalRecipient"=$1 AND r."providerPhoneNumberId"=s."providerPhoneNumberId" AND r."closedAt" IS NULL),
            s.priority,s."providerPhoneNumberId" COLLATE "C" LIMIT 1 FOR SHARE OF s`,
            input.canonicalRecipient,
            now,
            account.accountId,
          );
          const sender = senders[0];
          if (!sender) {
            if (input.initialAttemptId)
              await this.holdInitial(
                tx,
                input.initialAttemptId,
                recovery,
                input.canonicalRecipient,
                now,
              );
            return { kind: "held", reason: "sender-inventory-unavailable" };
          }
          const thread = await tx.recoverySenderThread.findFirst({
            where: {
              canonicalRecipient: input.canonicalRecipient,
              providerPhoneNumberId: sender.providerPhoneNumberId,
              closedAt: null,
            },
          });
          const threadId =
            thread?.id ??
            (
              await tx.recoverySenderThread.create({
                data: {
                  id: randomUUID(),
                  canonicalRecipient: input.canonicalRecipient,
                  providerPhoneNumberId: sender.providerPhoneNumberId,
                  openedAt: now,
                },
              })
            ).id;
          const created = await tx.recoverySenderRoute.create({
            data: {
              id: randomUUID(),
              shopId: recovery.shopId,
              threadId,
              canonicalRecipient: input.canonicalRecipient,
              providerPhoneNumberId: sender.providerPhoneNumberId,
              openedAt: now,
            },
          });
          route = { ...created, providerAccountId: sender.providerAccountId };
        }
        await tx.recoverySenderAssignment.create({
          data: {
            conversationId: input.conversationId,
            routeId: route.id,
            assignedAt: now,
          },
        });
        if (input.initialAttemptId)
          await this.clearInventoryHold(tx, input.initialAttemptId, recovery);
        return {
          kind: "assigned",
          sender: {
            conversationId: input.conversationId,
            routeId: route.id,
            threadId: route.threadId,
            canonicalRecipient: input.canonicalRecipient,
            providerPhoneNumberId: route.providerPhoneNumberId,
            providerAccountId: route.providerAccountId,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  /** Called by lifecycle/expiry paths; an active basket is never released for a cap. */
  async release(
    conversationId: string,
  ): Promise<"released" | "retained" | "absent"> {
    const stamp = await this.database.recoverySenderAssignment.findUnique({
      where: { conversationId },
      select: { route: { select: { canonicalRecipient: true } } },
    });
    if (!stamp) return "absent";
    return this.database.$transaction(
      async (tx) => {
        await lockRecoverySenderRecipient(tx, stamp.route.canonicalRecipient);
        const before = await this.assignment(tx, conversationId);
        if (!before) return "absent";
        await this.releaseInactive(
          tx,
          stamp.route.canonicalRecipient,
          this.clock(),
          await this.lifetime(tx),
          conversationId,
        );
        const after = await this.assignment(tx, conversationId);
        return after?.releasedAt ? "released" : "retained";
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  /** Existing recovery tick also reconciles completed/cancelled assignments,
   * including a crash between terminal lifecycle commit and cleanup. */
  async releaseTerminalAssignments(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("INVALID_SENDER_RELEASE_LIMIT");
    const due = await this.database.$queryRawUnsafe<
      Array<{ conversationId: string }>
    >(
      `SELECT a."conversationId" FROM whatsapp."RecoverySenderAssignment" a
      JOIN whatsapp."Conversation" c ON c.id=a."conversationId" JOIN commerce."CheckoutRecovery" r ON r.id=c."checkoutRecoveryId"
      WHERE a."releasedAt" IS NULL AND (r.status::text NOT IN ('DETECTED','MESSAGE_SENT','ENGAGED') OR r."completedAt" IS NOT NULL OR r."expiredAt"<=$1)
      ORDER BY a."conversationId" COLLATE "C" LIMIT $2`,
      this.clock(),
      limit,
    );
    let released = 0;
    for (const row of due)
      if ((await this.release(row.conversationId)) === "released") released++;
    return released;
  }

  private async lifetime(tx: Tx) {
    const rows = await tx.$queryRawUnsafe<
      Array<{ checkoutRecoveryLifetimeDays: number }>
    >(
      `SELECT "checkoutRecoveryLifetimeDays" FROM public."BackgroundRuntimeConfig" WHERE id='default' FOR SHARE`,
    );
    return parseCheckoutRecoveryLifetimeDays(
      rows[0]?.checkoutRecoveryLifetimeDays,
    );
  }
  private async owner(tx: Tx, id: string): Promise<Owner> {
    const rows = await tx.$queryRawUnsafe<Owner[]>(
      `SELECT id,"shopId","checkoutRecoveryId",type::text FROM whatsapp."Conversation" WHERE id=$1 FOR UPDATE`,
      id,
    );
    const row = rows[0];
    if (!row || row.type !== "RECOVERY" || !row.checkoutRecoveryId)
      throw new Error("SENDER_RECOVERY_OWNER_UNAVAILABLE");
    return row;
  }
  private async recovery(tx: Tx, owner: Owner): Promise<Recovery> {
    const rows = await tx.$queryRawUnsafe<Recovery[]>(
      `SELECT id,"shopId",status::text,"completedAt","expiredAt","lastExternalActivityAt" FROM commerce."CheckoutRecovery" WHERE id=$1 FOR SHARE`,
      owner.checkoutRecoveryId,
    );
    const row = rows[0];
    if (!row || (owner.shopId !== null && owner.shopId !== row.shopId))
      throw new Error("SENDER_RECOVERY_OWNER_MISMATCH");
    return row;
  }
  private async assignment(tx: Tx, conversationId: string) {
    const rows = await tx.$queryRawUnsafe<
      Array<RecoverySenderIdentity & { releasedAt: Date | null }>
    >(
      `SELECT a."conversationId",a."routeId",a."releasedAt",r."threadId",r."canonicalRecipient",r."providerPhoneNumberId",s."providerAccountId"
      FROM whatsapp."RecoverySenderAssignment" a JOIN whatsapp."RecoverySenderRoute" r ON r.id=a."routeId" JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=r."providerPhoneNumberId" WHERE a."conversationId"=$1`,
      conversationId,
    );
    return rows[0];
  }
  private identity(row: RecoverySenderIdentity): RecoverySenderIdentity {
    return {
      conversationId: row.conversationId,
      routeId: row.routeId,
      threadId: row.threadId,
      canonicalRecipient: row.canonicalRecipient,
      providerPhoneNumberId: row.providerPhoneNumberId,
      providerAccountId: row.providerAccountId,
    };
  }
  private async clearInventoryHold(
    tx: Tx,
    attemptId: string,
    recovery: Recovery,
  ) {
    const changed = await tx.recoveryOutreachAttempt.updateMany({
      where: {
        id: attemptId,
        checkoutRecoveryId: recovery.id,
        sequence: 1,
        failureCode: "SENDER_INVENTORY_UNAVAILABLE",
        sentAt: null,
        outboundMessageId: null,
      },
      data: { failureCode: null },
    });
    if (changed.count === 1)
      await tx.checkoutRecovery.updateMany({
        where: {
          id: recovery.id,
          status: "DETECTED",
          admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
        },
        data: { admissionBlockReason: null, admissionBlockedAt: null },
      });
  }
  private async holdInitial(
    tx: Tx,
    attemptId: string,
    recovery: Recovery,
    recipient: string,
    now: Date,
  ) {
    const attempts = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM commerce."RecoveryOutreachAttempt" WHERE id=$1 AND "checkoutRecoveryId"=$2 AND sequence=1 AND recipient=$3 AND status::text IN ('PENDING','CAPACITY_BLOCKED') AND "sentAt" IS NULL AND "outboundMessageId" IS NULL FOR UPDATE`,
      attemptId,
      recovery.id,
      recipient,
    );
    if (!attempts[0] || recovery.status !== "DETECTED")
      throw new Error("SENDER_INITIAL_HOLD_SCOPE_MISMATCH");
    await tx.recoveryOutreachAttempt.update({
      where: { id: attemptId },
      data: {
        status: "CAPACITY_BLOCKED",
        failureCode: "SENDER_INVENTORY_UNAVAILABLE",
      },
    });
    await tx.checkoutRecovery.update({
      where: { id: recovery.id },
      data: {
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
        admissionBlockedAt: now,
      },
    });
  }
  private async releaseInactive(
    tx: Tx,
    recipient: string,
    now: Date,
    days: number,
    requestedId: string,
  ) {
    // Lock Conversation owners in stable order before recovery rows, including a
    // not-yet-assigned requested owner. This matches the schema owner guards.
    const owners = await tx.$queryRawUnsafe<Owner[]>(
      `SELECT c.id,c."shopId",c."checkoutRecoveryId",c.type::text FROM whatsapp."Conversation" c
      WHERE c.id IN (SELECT $2::text UNION SELECT a."conversationId" FROM whatsapp."RecoverySenderAssignment" a JOIN whatsapp."RecoverySenderRoute" r ON r.id=a."routeId" WHERE a."releasedAt" IS NULL AND r."closedAt" IS NULL AND r."canonicalRecipient"=$1)
      ORDER BY c.id COLLATE "C" FOR UPDATE OF c`,
      recipient,
      requestedId,
    );
    for (const owner of owners) {
      const recovery = await this.recovery(tx, owner);
      if (terminal(recovery, now, days))
        await tx.recoverySenderAssignment.updateMany({
          where: {
            conversationId: owner.id,
            releasedAt: null,
            route: { canonicalRecipient: recipient },
          },
          data: { releasedAt: now },
        });
    }
    await tx.$executeRawUnsafe(
      `UPDATE whatsapp."RecoverySenderRoute" r SET "closedAt"=$2 WHERE r."canonicalRecipient"=$1 AND r."closedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM whatsapp."RecoverySenderAssignment" a WHERE a."routeId"=r.id AND a."releasedAt" IS NULL)`,
      recipient,
      now,
    );
    await tx.$executeRawUnsafe(
      `UPDATE whatsapp."RecoverySenderThread" t SET "closedAt"=$2 WHERE t."canonicalRecipient"=$1 AND t."closedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM whatsapp."RecoverySenderRoute" r WHERE r."threadId"=t.id AND r."closedAt" IS NULL)`,
      recipient,
      now,
    );
  }
}
export const recoverySenderPoolService = new RecoverySenderPoolService();
