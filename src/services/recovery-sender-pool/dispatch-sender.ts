import { readMultipartPartIdentity, sha256 } from "../recovery-multipart/frozen.js";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
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
export async function readRecoveryDispatchSender(conversationId: string, recipient?: string): Promise<WhatsAppSenderIdentity> {
  const rows = await prisma.$queryRawUnsafe<WhatsAppSenderIdentity[]>(`SELECT s."providerAccountId",r."providerPhoneNumberId"
    FROM whatsapp."RecoverySenderAssignment" a JOIN whatsapp."RecoverySenderRoute" r ON r.id=a."routeId"
    JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=r."providerPhoneNumberId"
    WHERE a."conversationId"=$1 AND a."releasedAt" IS NULL AND r."closedAt" IS NULL`, conversationId);
  if (!rows.length && recipient) {
    const existing = await prisma.recoverySenderAssignment.findUnique({where:{conversationId}});
    if (!existing) {
      const snapshot = await readDispatchSenderSnapshot();
      const proof = await hasLegacyProof(prisma, conversationId, recipient, snapshot);
      if (proof) return {providerAccountId:snapshot.providerAccountId,providerPhoneNumberId:snapshot.providerPhoneNumberId};
    }
  }
  if (rows.length !== 1) throw new Error("RECOVERY_DISPATCH_ASSIGNMENT_UNAVAILABLE");
  return rows[0]!;
}
/** SQL-only final authority; caller already holds the actual owner locks. */
export async function checkDispatchSender(tx: SqlTransaction, input: {
  snapshot: DispatchSenderSnapshot; conversationId: string; recipient: string; recovery: boolean; expectedSender?: WhatsAppSenderIdentity | undefined; allowLegacyContinuation?: boolean;
}): Promise<WhatsAppSenderIdentity | null> {
  const hasAssignment = input.recovery && !!await first(tx, `SELECT "conversationId" FROM whatsapp."RecoverySenderAssignment" WHERE "conversationId"=$1`, input.conversationId);
  const standalone = !hasAssignment;
  if (input.recovery && standalone && !input.allowLegacyContinuation) return null;
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
  } else if (input.recovery && !await hasLegacyProof(tx, input.conversationId, input.recipient, input.snapshot)) return null;
  if (input.expectedSender && (input.expectedSender.providerAccountId !== sender.providerAccountId || input.expectedSender.providerPhoneNumberId !== sender.providerPhoneNumberId)) return null;
  return {providerAccountId: sender.providerAccountId, providerPhoneNumberId: sender.providerPhoneNumberId};
}

/** Exact prior contact evidence, never the mutable Conversation phone/current config alone. */
async function hasLegacyProof(db: SqlTransaction, conversationId: string, recipient: string, sender: WhatsAppSenderIdentity): Promise<boolean> {
  const root = await first(db, `SELECT m.id FROM whatsapp."ConversationMessage" m
    JOIN commerce."RecoveryOutreachAttempt" a ON a."outboundMessageId"=m.id AND a.sequence=1
    JOIN whatsapp."Conversation" c ON c."checkoutRecoveryId"=a."checkoutRecoveryId" AND c.id=m."conversationId"
    WHERE m."conversationId"=$1 AND m.direction='OUTBOUND' AND m."sentAt" IS NOT NULL
      AND m.status IN ('SENT','DELIVERED','READ') AND m."failedAt" IS NULL AND m."providerMessageId" IS NOT NULL
      AND m."dispatchProviderAccountId"=$3 AND m."dispatchProviderPhoneNumberId"=$4
      AND m."providerDispatchKey" IS NOT NULL AND m."providerDispatchAdmittedAt" IS NOT NULL
      AND a.recipient=$2 AND a."sentAt" IS NOT NULL LIMIT 1`, conversationId, recipient, sender.providerAccountId, sender.providerPhoneNumberId);
  if (root) return true;
  const part = await first<{id:string;content:string;outboundPresentation:unknown;sourceIdentity:unknown;actualShopId:string}>(db, `SELECT m.id,m.content,m."outboundPresentation",p."sourceIdentity",r."shopId" AS "actualShopId"
    FROM whatsapp."ConversationMessage" m JOIN whatsapp."ConversationDeliveryPart" p ON p."messageId"=m.id
    JOIN whatsapp."Conversation" c ON c.id=m."conversationId"
    JOIN commerce."CheckoutRecovery" r ON r.id=c."checkoutRecoveryId"
    WHERE c.type='RECOVERY' AND (c."shopId" IS NULL OR c."shopId"=r."shopId") AND m."conversationId"=$1 AND m.direction='OUTBOUND' AND m.status IN ('PENDING','SENT','DELIVERED','READ') AND m."failedAt" IS NULL
      AND p."providerAccountId"=$2 AND p."providerPhoneNumberId"=$3
      AND p.state IN ('ACKNOWLEDGED','DELIVERED','READ') AND p."providerMessageId" IS NOT NULL AND p."providerDispatchKey" IS NOT NULL
      AND p."providerDispatchAdmittedAt" IS NOT NULL AND p."acknowledgedAt" IS NOT NULL
    ORDER BY p."acknowledgedAt" DESC,p.id LIMIT 1`, conversationId,sender.providerAccountId,sender.providerPhoneNumberId);
  // Sender provenance is checked independently of obsolete presentation geometry.
  // The immutable admitted part must attest the exact frozen root bytes.
  // The current identity has no messageId field (extra fields are rejected);
  // source.messageId below must still equal the actual root, not another row.
  const source=part?.outboundPresentation as {schemaVersion?:unknown;kind?:unknown;messageId?:unknown;body?:unknown;recipient?:unknown;sender?:WhatsAppSenderIdentity;receipt?:{conversationId?:unknown;shopId?:unknown}} | undefined;
  const identity=readMultipartPartIdentity(part?.sourceIdentity);
  return !!part && !!source && !!identity && source.schemaVersion===1 && source.kind==='RECOVERY_MULTIPART_PREPARATION' && identity.sourceDigest===sha256(canonicalJson(source)) && identity.conversationId===conversationId && identity.shopId===part.actualShopId && source.receipt?.shopId===part.actualShopId && source.messageId===part.id && source.body===part.content && source.receipt?.conversationId===conversationId && source.recipient===recipient && source.sender?.providerAccountId===sender.providerAccountId && source.sender?.providerPhoneNumberId===sender.providerPhoneNumberId;
}

function canonicalDispatchRecipient(value: string): string | null {
  const digits = value.startsWith("+") ? value.slice(1) : value;
  return /^[1-9][0-9]{0,14}$/.test(digits) ? digits : null;
}
