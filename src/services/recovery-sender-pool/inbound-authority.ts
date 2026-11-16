import { Prisma, type PrismaClient } from '@prisma/client';
import type { WhatsAppInboundEvent, WhatsAppSenderIdentity } from '../../integration/whatsapp/types.js';
import { lockRecoverySenderRecipient } from './recipient-lock.js';
import { parseCheckoutRecoveryLifetimeDays, isCheckoutRecoveryWithinLifetime } from '../recovery-lifetime/checkout-recovery-lifetime.js';
import { readMultipartPartIdentity, sha256 } from '../recovery-multipart/frozen.js';
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
type Reader = Pick<Prisma.TransactionClient, '$queryRawUnsafe'>;
export type InboundOwnerEvidence = WhatsAppSenderIdentity & {
    canonicalRecipient: string;
    threadId: string;
    routeId: string | null;
    conversationId: string;
    checkoutRecoveryId: string;
    shopId: string;
    referenceProviderMessageId?: string | null;
};
export type SenderHandoff = WhatsAppSenderIdentity & {
    canonicalRecipient: string;
    threadId: string;
    routeId: string | null;
};
export type SenderResolution = {
    kind: 'owned';
    evidence: InboundOwnerEvidence;
    mode: 'active' | 'historical';
} | {
    kind: 'routing';
    scope: SenderHandoff;
} | {
    kind: 'invalid';
};
export const recipientDigits = (value: string) => /^\+?[1-9][0-9]{0,14}$/.test(value.trim()) ? value.trim().replace(/^\+/, '') : null;
export async function lockInboundProviderIdentity(tx: Reader, id: string) {
    await tx.$queryRawUnsafe(`WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended('whatsapp-inbound-provider:'||$1::text,0))) SELECT COUNT(*)::integer FROM locked`, id);
}
type OwnedRow = InboundOwnerEvidence & {
    releasedAt: Date | null;
    routeClosedAt: Date | null;
    threadClosedAt: Date | null;
    status: string;
    completedAt: Date | null;
    expiredAt: Date | null;
    lastExternalActivityAt: Date;
    contacted: boolean;
    initialAccepted: boolean;
    isLatest: boolean;
};
const ownerSql = `SELECT c.id AS "conversationId",r.id AS "checkoutRecoveryId",r."shopId",a."releasedAt",p.id AS "routeId",p."threadId",p."canonicalRecipient",p."providerPhoneNumberId",s."providerAccountId",p."closedAt" AS "routeClosedAt",t."closedAt" AS "threadClosedAt",r.status::text,r."completedAt",r."expiredAt",r."lastExternalActivityAt",
 NOT EXISTS(SELECT 1 FROM commerce."CheckoutRecovery" newer
 WHERE newer."shopId"=r."shopId"
 AND newer."checkoutToken"=r."checkoutToken"
 AND newer.generation>r.generation
 AND shop.platform='WOOCOMMERCE') AS "isLatest",
 EXISTS(SELECT 1 FROM commerce."RecoveryOutreachAttempt" i
 JOIN whatsapp."ConversationMessage" m ON m.id=i."outboundMessageId"
 WHERE i."checkoutRecoveryId"=r.id
 AND i.sequence=1
 AND i.recipient=p."canonicalRecipient"
 AND i."sentAt" IS NOT NULL
 AND m."conversationId"=c.id
 AND m.direction='OUTBOUND'
 AND m.status IN('DELIVERED','READ')
 AND (m."deliveredAt" IS NOT NULL OR m."readAt" IS NOT NULL)
 AND m."failedAt" IS NULL
 AND m."providerMessageId" IS NOT NULL
 AND m."sentAt" IS NOT NULL
 AND m."dispatchProviderAccountId"=s."providerAccountId"
 AND m."dispatchProviderPhoneNumberId"=p."providerPhoneNumberId") AS contacted,
 EXISTS(SELECT 1 FROM commerce."RecoveryOutreachAttempt" i
 JOIN whatsapp."ConversationMessage" m ON m.id=i."outboundMessageId"
 WHERE i."checkoutRecoveryId"=r.id
 AND i.sequence=1
 AND i.recipient=p."canonicalRecipient"
 AND i."sentAt" IS NOT NULL
 AND m."conversationId"=c.id
 AND m.direction='OUTBOUND'
 AND m.status IN('SENT','DELIVERED','READ')
 AND m."failedAt" IS NULL
 AND m."providerMessageId" IS NOT NULL
 AND m."sentAt" IS NOT NULL
 AND m."dispatchProviderAccountId"=s."providerAccountId"
 AND m."dispatchProviderPhoneNumberId"=p."providerPhoneNumberId") AS "initialAccepted"
 FROM whatsapp."RecoverySenderAssignment" a
 JOIN whatsapp."RecoverySenderRoute" p ON p.id=a."routeId"
 JOIN whatsapp."RecoverySenderThread" t ON t.id=p."threadId"
 JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=p."providerPhoneNumberId"
 JOIN whatsapp."Conversation" c ON c.id=a."conversationId"
 JOIN commerce."CheckoutRecovery" r ON r.id=c."checkoutRecoveryId"
 JOIN commerce."Shop" shop ON shop.id=r."shopId"

 WHERE c.type='RECOVERY'
 AND (c."shopId" IS NULL OR c."shopId"=r."shopId")
 AND r."shopId"=p."shopId"
 AND p."canonicalRecipient"=t."canonicalRecipient"
 AND p."providerPhoneNumberId"=t."providerPhoneNumberId"`;
export async function readAssignedOwner(db: Reader, conversationId: string): Promise<OwnedRow | null> {
    return (await db.$queryRawUnsafe<OwnedRow[]>(ownerSql + `
 AND c.id=$1`, conversationId))[0] ?? null;
}
async function active(db: Reader, row: OwnedRow, now: Date, quoteId?: string | null) {
    let directContact = false;
    if (row.initialAccepted && !row.contacted) {
        const witnesses = quoteId ? [{ referenceId: quoteId }] : await db.$queryRawUnsafe<Array<{referenceId:string}>>(`
            SELECT DISTINCT "inReplyToProviderId" AS "referenceId"
            FROM whatsapp."ConversationMessage"
            WHERE "conversationId"=$1 AND direction='INBOUND'
              AND "dispatchProviderAccountId"=$2 AND "dispatchProviderPhoneNumberId"=$3
              AND "inReplyToProviderId" IS NOT NULL`,row.conversationId,row.providerAccountId,row.providerPhoneNumberId);
        // Contact evidence is a set, not the first/newest customer question.
        // A later failed quoted send cannot hide another valid exact witness.
        for (const witness of witnesses) {
            const owner = await quotedOwner(db,witness.referenceId,{schemaVersion:1,provider:'whatsapp',providerAccountId:row.providerAccountId,providerPhoneNumberId:row.providerPhoneNumberId,providerMessageId:'contact-proof-read',customerPhone:row.canonicalRecipient,contextMessageId:witness.referenceId,occurredAt:now.toISOString(),content:{type:'text',text:''}});
            if (owner===row.conversationId) {directContact=true;break;}
        }
    }
    const [policy] = await db.$queryRawUnsafe<Array<{
        checkoutRecoveryLifetimeDays: number;
    }>>(`SELECT "checkoutRecoveryLifetimeDays" FROM public."BackgroundRuntimeConfig"
 WHERE id='default' FOR SHARE`);
    if (!policy)
        return false;
    return !row.releasedAt &&
        !row.routeClosedAt &&
        !row.threadClosedAt &&
        row.initialAccepted &&
        (row.contacted || directContact) &&
        row.isLatest &&
        ['MESSAGE_SENT', 'ENGAGED'].includes(row.status) &&
        !row.completedAt &&
        (!row.expiredAt || row.expiredAt > now) &&
        isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: row.lastExternalActivityAt, now, checkoutRecoveryLifetimeDays: parseCheckoutRecoveryLifetimeDays(policy.checkoutRecoveryLifetimeDays) });
}
function matches(e: InboundOwnerEvidence, event: WhatsAppInboundEvent) {
    return e.providerAccountId === event.providerAccountId &&
        e.providerPhoneNumberId === event.providerPhoneNumberId &&
        e.canonicalRecipient === recipientDigits(event.customerPhone);
}
function evidence(row: OwnedRow): InboundOwnerEvidence {
    return { conversationId: row.conversationId, checkoutRecoveryId: row.checkoutRecoveryId, shopId: row.shopId, threadId: row.threadId, routeId: row.routeId, canonicalRecipient: row.canonicalRecipient, providerAccountId: row.providerAccountId, providerPhoneNumberId: row.providerPhoneNumberId };
}
/** Exact confirmed historical source. Presentation geometry is not ownership. */
export async function quotedOwner(db: Reader, id: string, event: WhatsAppInboundEvent): Promise<string | null> {
    const [root] = await db.$queryRawUnsafe<Array<{
        id: string;
        conversationId: string;
        recipient: string | null;
        account: string | null;
        phone: string | null;
    }>>(`SELECT m.id,m."conversationId",COALESCE(i.recipient,h."recipientSnapshot",(SELECT original.recipient FROM commerce."RecoveryOutreachAttempt" original
 JOIN whatsapp."Conversation" owned ON owned."checkoutRecoveryId"=original."checkoutRecoveryId"
 JOIN whatsapp."ConversationMessage" sent ON sent.id=original."outboundMessageId"
 WHERE owned.id=m."conversationId"
 AND original.sequence=1
 AND original."sentAt" IS NOT NULL
 AND sent."sentAt" IS NOT NULL
 AND sent."providerMessageId" IS NOT NULL
 AND sent."dispatchProviderAccountId"=m."dispatchProviderAccountId"
 AND sent."dispatchProviderPhoneNumberId"=m."dispatchProviderPhoneNumberId")) AS recipient,m."dispatchProviderAccountId" AS account,m."dispatchProviderPhoneNumberId" AS phone,"inReplyToProviderId" AS "referenceId" FROM whatsapp."ConversationMessage" m LEFT
 JOIN commerce."RecoveryOutreachAttempt" i ON i."outboundMessageId"=m.id LEFT
 JOIN whatsapp."MerchantConversationSendCommand" h ON h."outboundMessageId"=m.id
 JOIN whatsapp."Conversation" c ON c.id=m."conversationId" LEFT
 JOIN commerce."CheckoutRecovery" r ON r.id=c."checkoutRecoveryId"
 WHERE (r.id IS NULL OR c."shopId" IS NULL OR c."shopId"=r."shopId")
 AND (i.id IS NULL OR i."checkoutRecoveryId"=r.id)
 AND (h.id IS NULL OR (h."conversationId"=c.id
 AND h."shopId"=COALESCE(r."shopId",c."shopId")))
 AND m."providerMessageId"=$1
 AND m.direction='OUTBOUND'
 AND m."sentAt" IS NOT NULL
 AND m."providerDispatchKey" IS NOT NULL
 AND m."providerDispatchAdmittedAt" IS NOT NULL
 AND m.status IN('SENT','DELIVERED','READ')
 AND m."failedAt" IS NULL FOR SHARE OF m`, id);
    if (root &&
        root.account === event.providerAccountId &&
        root.phone === event.providerPhoneNumberId &&
        recipientDigits(root.recipient ?? '') === recipientDigits(event.customerPhone))
        return root.conversationId;
    const [part] = await db.$queryRawUnsafe<Array<{
        id: string;
        conversationId: string;
        shopId: string;
        content: string;
        outboundPresentation: unknown;
        sourceIdentity: unknown;
        account: string;
        phone: string;
    }>>(`SELECT m.id,m."conversationId",r."shopId",m.content,m."outboundPresentation",p."sourceIdentity",p."providerAccountId" AS account,p."providerPhoneNumberId" AS phone FROM whatsapp."ConversationDeliveryPart" p
 JOIN whatsapp."ConversationMessage" m ON m.id=p."messageId"
 JOIN whatsapp."Conversation" c ON c.id=m."conversationId"
 JOIN commerce."CheckoutRecovery" r ON r.id=c."checkoutRecoveryId"
 WHERE c.type='RECOVERY'
 AND (c."shopId" IS NULL OR c."shopId"=r."shopId")
 AND p."providerMessageId"=$1
 AND p.state IN('ACKNOWLEDGED','DELIVERED','READ')
 AND p."providerDispatchKey" IS NOT NULL
 AND p."providerDispatchAdmittedAt" IS NOT NULL
 AND p."acknowledgedAt" IS NOT NULL
 AND p."failedAt" IS NULL FOR SHARE OF m,p`, id);
    if (!part || part.account !== event.providerAccountId || part.phone !== event.providerPhoneNumberId)
        return null;
    const source = part.outboundPresentation as {
        schemaVersion?: unknown;
        kind?: unknown;
        messageId?: unknown;
        recipient?: unknown;
        body?: unknown;
        sender?: WhatsAppSenderIdentity;
        receipt?: {
            conversationId?: unknown;
            shopId?: unknown;
        };
    } | null, identity = readMultipartPartIdentity(part.sourceIdentity);
    return source &&
        identity &&
        source.schemaVersion === 1 &&
        source.kind === 'RECOVERY_MULTIPART_PREPARATION' &&
        source.messageId === part.id &&
        source.body === part.content &&
        source.receipt?.conversationId === part.conversationId &&
        source.receipt?.shopId === part.shopId &&
        identity.shopId === part.shopId &&
        identity.conversationId === part.conversationId &&
        identity.sourceDigest === sha256(canonicalJson(source)) &&
        source.sender?.providerAccountId === part.account &&
        source.sender?.providerPhoneNumberId === part.phone &&
        source.recipient === recipientDigits(event.customerPhone) ? part.conversationId : null;
}
/** No provider/model call. Ownership never reads credits or allowance. */
export async function resolveSenderInbound(db: Reader, event: WhatsAppInboundEvent, now = new Date()): Promise<SenderResolution> {
    const canonicalRecipient = recipientDigits(event.customerPhone);
    if (!canonicalRecipient)
        return { kind: 'invalid' };
    const [sender] = await db.$queryRawUnsafe<Array<WhatsAppSenderIdentity & {
        verifiedAt: Date;
    }>>(`SELECT "providerAccountId","providerPhoneNumberId","verifiedAt" FROM whatsapp."WhatsAppPoolSender"
 WHERE "providerPhoneNumberId"=$1`, event.providerPhoneNumberId);
    if (!sender)
        return { kind: 'invalid' };
    if (sender.verifiedAt > now || sender.providerAccountId !== event.providerAccountId)
        return { kind: 'invalid' };
    const [pending] = await db.$queryRawUnsafe<Array<{
        threadId: string;
        routeId: string | null;
        canonicalRecipient: string;
        providerAccountId: string;
        providerPhoneNumberId: string;
    }>>(`SELECT q."threadId",q."routeId",t."canonicalRecipient",t."providerPhoneNumberId",s."providerAccountId" FROM whatsapp."RecoveryBasketRoutingTurn" q
 JOIN whatsapp."RecoverySenderThread" t ON t.id=q."threadId"
 JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=t."providerPhoneNumberId"
 WHERE q."inboundProviderMessageId"=$1`, event.providerMessageId);
    if (pending) {
        if (pending.canonicalRecipient !== canonicalRecipient || pending.providerAccountId !== event.providerAccountId || pending.providerPhoneNumberId !== event.providerPhoneNumberId)
            return { kind: 'invalid' };
        return { kind: 'routing', scope: pending };
    }
    const [stored] = await db.$queryRawUnsafe<Array<{
        conversationId: string;
        account: string | null;
        phone: string | null;
        referenceId: string | null;
    }>>(`SELECT "conversationId","dispatchProviderAccountId" AS account,"dispatchProviderPhoneNumberId" AS phone,"inReplyToProviderId" AS "referenceId" FROM whatsapp."ConversationMessage"
 WHERE "providerMessageId"=$1
 AND direction='INBOUND'`, event.providerMessageId);
    if (!stored &&
        event.contextMessageId) {
        const [prompt] = await db.$queryRawUnsafe<Array<{
            threadId: string;
            routeId: string | null;
            canonicalRecipient: string;
            providerPhoneNumberId: string;
            providerAccountId: string;
        }>>(`SELECT q."threadId",q."promptScopeRouteId" AS "routeId",t."canonicalRecipient",t."providerPhoneNumberId",s."providerAccountId" FROM whatsapp."RecoveryBasketRoutingTurn" q
 JOIN whatsapp."RecoverySenderThread" t ON t.id=q."threadId"
 JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=t."providerPhoneNumberId"
 WHERE q."promptProviderMessageId"=$1
 AND q."promptSentAt" IS NOT NULL`, event.contextMessageId);
        if (prompt) {
            if (prompt.canonicalRecipient !== canonicalRecipient || prompt.providerAccountId !== event.providerAccountId || prompt.providerPhoneNumberId !== event.providerPhoneNumberId)
                return { kind: 'invalid' };
            return { kind: 'routing', scope: prompt };
        }
    }
    let id = stored?.conversationId;
    if (stored &&
        (stored.account !== sender.providerAccountId || stored.phone !== sender.providerPhoneNumberId))
        return { kind: 'invalid' };
    if (!id &&
        event.contextMessageId) {
        id = await quotedOwner(db, event.contextMessageId, event) ?? undefined;
        if (!id)
            return { kind: 'invalid' };
    }
    if (id) {
        const row = await readAssignedOwner(db, id);
        if (!row || !matches(row, event))
            return { kind: 'invalid' };
        return { kind: 'owned', evidence: { ...evidence(row), referenceProviderMessageId: stored ? stored.referenceId : event.contextMessageId }, mode: await active(db, row, now, stored ? stored.referenceId : event.contextMessageId) ? 'active' : 'historical' };
    }
    const [thread] = await db.$queryRawUnsafe<Array<{
        id: string;
    }>>(`SELECT id FROM whatsapp."RecoverySenderThread"
 WHERE "canonicalRecipient"=$1
 AND "providerPhoneNumberId"=$2
 AND "closedAt" IS NULL`, canonicalRecipient, event.providerPhoneNumberId);
    if (!thread)
        return { kind: 'invalid' };
    const prompts = await db.$queryRawUnsafe<Array<{
        routeId: string | null;
    }>>(`SELECT "promptScopeRouteId" AS "routeId" FROM whatsapp."RecoveryBasketRoutingTurn"
 WHERE "threadId"=$1
 AND "resolvedAt" IS NULL
 AND state IN('RECEIVED','PROMPT_ADMITTED')
 AND "promptSentAt" IS NOT NULL
 AND "promptProviderMessageId" IS NOT NULL
 AND "expiresAt">$2`, thread.id, now);
    if (prompts.length) {
        const scopes = new Set(prompts.map(p => p.routeId));
        return { kind: 'routing', scope: { ...sender, canonicalRecipient, threadId: thread.id, routeId: scopes.size === 1 ? prompts[0]!.routeId : null } };
    }
    const rows = await db.$queryRawUnsafe<OwnedRow[]>(ownerSql + `
 AND p."threadId"=$1
 AND a."releasedAt" IS NULL
 AND p."closedAt" IS NULL
 AND t."closedAt" IS NULL`, thread.id);
    const candidates = [];
    for (const row of rows)
        if (await active(db, row, now))
            candidates.push(row);
    if (candidates.length === 1)
        return { kind: 'owned', evidence: evidence(candidates[0]!), mode: 'active' };
    const shops = new Set(candidates.map(r => r.routeId));
    return { kind: 'routing', scope: { ...sender, canonicalRecipient, threadId: thread.id, routeId: shops.size === 1 ? candidates[0]!.routeId : null } };
}
/** Final transaction fence shared by text/audio persistence. Lock provider first,
 * then recipient, then owner; allocator/releaser uses the same recipient lock. */
export async function verifyInboundOwner(tx: Prisma.TransactionClient, e: InboundOwnerEvidence, id: string, now = new Date(), requireActive = true, activityAt = now) {
    await lockInboundProviderIdentity(tx, id);
    await lockRecoverySenderRecipient(tx, e.canonicalRecipient);
    const turn = await tx.recoveryBasketRoutingTurn.findUnique({ where: { inboundProviderMessageId: id } });
    if (turn &&
        turn.selectedConversationId !== e.conversationId)
        throw new Error('INBOUND_ROUTING_TURN_OWNS_PROVIDER_ID');
    const [owner] = await tx.$queryRawUnsafe<Array<{
        id: string;
    }>>(`SELECT c.id FROM commerce."Shop" s
 JOIN commerce."CheckoutRecovery" r ON r."shopId"=s.id
 JOIN whatsapp."Conversation" c ON c."checkoutRecoveryId"=r.id
 WHERE c.id=$1
 AND r.id=$2
 AND r."shopId"=$3 FOR UPDATE OF s,c,r`, e.conversationId, e.checkoutRecoveryId, e.shopId);
    if (!owner)
        throw new Error('INBOUND_OWNER_CHANGED');
    const row = await readAssignedOwner(tx, e.conversationId);
    if (!row || row.routeId !== e.routeId || row.threadId !== e.threadId || row.canonicalRecipient !== e.canonicalRecipient || row.providerAccountId !== e.providerAccountId || row.providerPhoneNumberId !== e.providerPhoneNumberId || requireActive &&
        !await active(tx, row, now, e.referenceProviderMessageId))
        throw new Error('INBOUND_SENDER_OWNER_CHANGED');
    const message = await tx.conversationMessage.findUnique({ where: { providerMessageId: id } });
    if (message &&
        (message.conversationId !== e.conversationId || message.direction !== 'INBOUND' || message.dispatchProviderAccountId !== e.providerAccountId || message.dispatchProviderPhoneNumberId !== e.providerPhoneNumberId))
        throw new Error('INBOUND_REPLAY_OWNER_CHANGED');
    if (requireActive)
        await tx.$executeRawUnsafe(`UPDATE commerce."CheckoutRecovery" SET "lastExternalActivityAt"=GREATEST("lastExternalActivityAt",$2)
 WHERE id=$1`, e.checkoutRecoveryId, activityAt > now ? now : activityAt);
}
export async function isAssignedConversationActive(db: Reader, id: string, now = new Date(), quoteId?: string | null) {
    const row = await readAssignedOwner(db, id);
    return row ? active(db, row, now, quoteId) : null;
}
export type SenderInboundDatabase = Pick<PrismaClient, '$queryRawUnsafe'>;
/** Unassigned recoveries cannot be admitted into a pooled conversation. */
export async function canProcessConversation(db: Reader, id: string, now = new Date()) {
    const assigned = await isAssignedConversationActive(db, id, now);
    if (assigned !== null) return assigned;
    const [conversation] = await db.$queryRawUnsafe<Array<{ type: string }>>(`SELECT type::text FROM whatsapp."Conversation" WHERE id=$1`, id);
    return !!conversation && conversation.type !== 'RECOVERY';
}
export async function receivingSenderKnown(db: Reader, sender: WhatsAppSenderIdentity): Promise<boolean | null> {
    const [pool] = await db.$queryRawUnsafe<Array<{
        providerAccountId: string;
    }>>(`SELECT "providerAccountId" FROM whatsapp."WhatsAppPoolSender"
 WHERE "providerPhoneNumberId"=$1`, sender.providerPhoneNumberId);
    return pool ? pool.providerAccountId === sender.providerAccountId : null;
}
export async function assertNoRoutingTurn(tx: Reader, id: string) {
    if ((await tx.$queryRawUnsafe<Array<{
        id: string;
    }>>(`SELECT "inboundProviderMessageId" AS id FROM whatsapp."RecoveryBasketRoutingTurn"
 WHERE "inboundProviderMessageId"=$1`, id)).length)
        throw new Error('ROUTING_TURN_OWNS_PROVIDER_ID');
}
