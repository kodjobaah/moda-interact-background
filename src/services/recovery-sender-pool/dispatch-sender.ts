import { platformConsumerConfiguration } from "../platform-configuration/consumers.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import prisma from "../../lib/db.js";
import type { WhatsAppSenderIdentity } from "../../integration/whatsapp/types.js";
import { first, type SqlTransaction } from "../recovery-conversation/recovery-conversation.sql.js";

export type DispatchSenderSnapshot = Readonly<WhatsAppSenderIdentity & { rowId: string; version: number; environment: string }>;
/** Credentials are validated/unsealed before entering any provider-permit transaction. */
export async function readDispatchSenderSnapshot(): Promise<DispatchSenderSnapshot> {
  const row = await platformConsumerConfiguration.read("messaging.sender");
  if (!row.rowId || !row.value.accessToken?.trim() || !/^[0-9]{1,64}$/.test(row.value.businessAccountId) || !/^[0-9]{1,64}$/.test(row.value.phoneNumberId)) throw new Error("DISPATCH_SENDER_CONFIGURATION_INVALID");
  return { rowId: row.rowId, version: row.version, environment: resolveDeploymentEnvironmentName(), providerAccountId: row.value.businessAccountId, providerPhoneNumberId: row.value.phoneNumberId };
}
export async function readRecoveryDispatchSender(conversationId: string, _recipient?: string): Promise<WhatsAppSenderIdentity> {
  const rows = await prisma.$queryRawUnsafe<WhatsAppSenderIdentity[]>(`SELECT s."providerAccountId",r."providerPhoneNumberId"
    FROM whatsapp."RecoverySenderAssignment" a JOIN whatsapp."RecoverySenderRoute" r ON r.id=a."routeId"
    JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=r."providerPhoneNumberId"
    WHERE a."conversationId"=$1 AND a."releasedAt" IS NULL AND r."closedAt" IS NULL`, conversationId);
  if (rows.length !== 1) throw new Error("RECOVERY_DISPATCH_ASSIGNMENT_UNAVAILABLE");
  return rows[0]!;
}
/** SQL-only final authority; caller already holds the actual owner locks. */
export async function checkDispatchSender(tx: SqlTransaction, input: {
  snapshot: DispatchSenderSnapshot; conversationId: string; recipient: string; recovery: boolean; expectedSender?: WhatsAppSenderIdentity | undefined;
}): Promise<WhatsAppSenderIdentity | null> {
  const hasAssignment = input.recovery && !!await first(tx, `SELECT "conversationId" FROM whatsapp."RecoverySenderAssignment" WHERE "conversationId"=$1`, input.conversationId);
  const standalone = !hasAssignment;
  if (input.recovery && standalone) return null;
  if (standalone) {
    // Admin locks membership before configuration/inventory. Keep that order.
    await tx.$queryRawUnsafe(`WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended('whatsapp-pool-membership:' || $1::text,0))) SELECT COUNT(*)::integer FROM locked`, input.snapshot.providerPhoneNumberId);
    if (await first(tx, `SELECT "providerPhoneNumberId" FROM whatsapp."WhatsAppPoolSender" WHERE "providerPhoneNumberId"=$1`, input.snapshot.providerPhoneNumberId)) return null;
  }
  const config = await first(tx, `SELECT id FROM public."PlatformConfiguration"
    WHERE id=$1 AND environment=$2 AND key='messaging.sender' AND version=$3 FOR SHARE`, input.snapshot.rowId,input.snapshot.environment,input.snapshot.version);
  if (!config) return null;
  let sender: WhatsAppSenderIdentity = input.snapshot;
  if (hasAssignment) {
    const assignment = await first<WhatsAppSenderIdentity & { canonicalRecipient: string }>(tx, `SELECT s."providerAccountId",r."providerPhoneNumberId",r."canonicalRecipient"
      FROM whatsapp."RecoverySenderAssignment" a JOIN whatsapp."RecoverySenderRoute" r ON r.id=a."routeId"
      JOIN whatsapp."RecoverySenderThread" t ON t.id=r."threadId"
      JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=r."providerPhoneNumberId"
      WHERE a."conversationId"=$1 AND a."releasedAt" IS NULL AND r."closedAt" IS NULL AND t."closedAt" IS NULL
        AND s."verifiedAt"<=statement_timestamp() FOR SHARE OF a,r,t,s`, input.conversationId);
    if (!assignment || assignment.canonicalRecipient !== canonicalDispatchRecipient(input.recipient) || assignment.providerAccountId !== input.snapshot.providerAccountId) return null;
    sender = assignment;
  }
  if (input.expectedSender && (input.expectedSender.providerAccountId !== sender.providerAccountId || input.expectedSender.providerPhoneNumberId !== sender.providerPhoneNumberId)) return null;
  return {providerAccountId: sender.providerAccountId, providerPhoneNumberId: sender.providerPhoneNumberId};
}

function canonicalDispatchRecipient(value: string): string | null {
  const digits = value.startsWith("+") ? value.slice(1) : value;
  return /^[1-9][0-9]{0,14}$/.test(digits) ? digits : null;
}
