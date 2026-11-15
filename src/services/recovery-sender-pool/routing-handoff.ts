import { Prisma, type PrismaClient } from '@prisma/client';
import type { WhatsAppInboundEvent } from '../../integration/whatsapp/types.js';
import { lockInboundProviderIdentity, recipientDigits, type SenderHandoff } from './inbound-authority.js';
import { lockRecoverySenderRecipient } from './recipient-lock.js';
/** BG004 supplies the validated, current application policy snapshot. No
 * implicit business TTL, model or retry default exists in the persistence seam. */
export type RoutingPersistencePolicy = Readonly<{
    rowId: string;
    version: number;
    environment: string;
    decisionTTLms: number;
    retentionMs: number;
    /** Complete immutable revision/parameter evidence from BG004; no customer content. */
    configurationSnapshot: Prisma.InputJsonObject;
}>;
export async function persistRoutingHandoff(db: PrismaClient, event: WhatsAppInboundEvent, scope: SenderHandoff, policy: RoutingPersistencePolicy | null, now = new Date()) {
    if (!policy)
        return { kind: 'held' as const, reason: 'routing-policy-unavailable' };
    if (!Number.isSafeInteger(policy.decisionTTLms) || policy.decisionTTLms <= 0 || !Number.isSafeInteger(policy.retentionMs) || policy.retentionMs < policy.decisionTTLms)
        throw new Error('INVALID_VALIDATED_ROUTING_POLICY');
    return db.$transaction(async (tx) => {
        await lockInboundProviderIdentity(tx, event.providerMessageId);
        await lockRecoverySenderRecipient(tx, scope.canonicalRecipient);
        const [owner] = await tx.$queryRawUnsafe<Array<{
            id: string;
            closedAt: Date | null;
        }>>(`SELECT t.id,t."closedAt" FROM whatsapp."RecoverySenderThread" t JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=t."providerPhoneNumberId" WHERE t.id=$1 AND t."canonicalRecipient"=$2 AND t."providerPhoneNumberId"=$3 AND s."providerAccountId"=$4 AND s."verifiedAt"<=$5 FOR SHARE OF t,s`, scope.threadId, scope.canonicalRecipient, scope.providerPhoneNumberId, scope.providerAccountId, now);
        if (!owner || recipientDigits(event.customerPhone) !== scope.canonicalRecipient || event.providerAccountId !== scope.providerAccountId || event.providerPhoneNumberId !== scope.providerPhoneNumberId)
            throw new Error('ROUTING_THREAD_CHANGED');
        const existing = await tx.recoveryBasketRoutingTurn.findUnique({ where: { inboundProviderMessageId: event.providerMessageId } });
        if (existing) {
            if (existing.threadId !== scope.threadId || existing.routeId !== scope.routeId)
                throw new Error('ROUTING_PROVIDER_ID_OWNER_MISMATCH');
            return { kind: 'persisted' as const, turn: existing };
        }
        if (owner.closedAt !== null)
            throw new Error('ROUTING_THREAD_CHANGED');
        if (await tx.conversationMessage.findUnique({ where: { providerMessageId: event.providerMessageId } }))
            throw new Error('MERCHANT_TRANSCRIPT_OWNS_PROVIDER_ID');
        if (scope.routeId && !await tx.recoverySenderRoute.findFirst({ where: { id: scope.routeId, threadId: scope.threadId, closedAt: null } }))
            throw new Error('ROUTING_SHOP_SCOPE_CHANGED');
        const [current] = await tx.$queryRawUnsafe<Array<{
            id: string;
        }>>(`SELECT id FROM public."PlatformConfiguration" WHERE id=$1 AND key='recovery.routingAgent' AND environment=$2 AND version=$3 FOR SHARE`, policy.rowId, policy.environment, policy.version);
        if (!current)
            throw new Error('ROUTING_POLICY_CHANGED');
        const turn = await tx.recoveryBasketRoutingTurn.create({ data: { inboundProviderMessageId: event.providerMessageId, threadId: scope.threadId, routeId: scope.routeId, occurredAt: new Date(event.occurredAt), inputJson: event as unknown as Prisma.InputJsonValue, configurationSnapshot: policy.configurationSnapshot, expiresAt: new Date(now.getTime() + policy.decisionTTLms) } });
        return { kind: 'persisted' as const, turn };
    });
}
