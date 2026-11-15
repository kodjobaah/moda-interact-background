import type { RoutingAudioTranscript } from './routing-audio.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type RecoveryBasketRoutingTurn } from '@prisma/client';
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import { sha256 } from '../recovery-multipart/frozen.js';
import { lockInboundProviderIdentity, readAssignedOwner, isAssignedConversationActive, verifyInboundOwner, type SenderHandoff } from './inbound-authority.js';
import { lockRecoverySenderRecipient } from './recipient-lock.js';
import { recordProcessableInbound } from '../conversation-ai-delay/pending-turn-repository.js';
import { lockWhatsAppStopRecipient } from '../whatsapp-contact-opt-out/recipient-stop-serialization.js';
import { canonicalWhatsAppSender } from '../whatsapp-contact-opt-out/phone.js';
import { moderationConfig, MODERATION_TIMEOUT_MS } from '../conversation-moderation/moderation-policy.js';
import { hasLocalNoContact } from '../whatsapp-contact-opt-out/local-no-contact.js';
import type { WhatsAppInboundEvent } from '../../integration/whatsapp/types.js';
export const fingerprint = (value: unknown) => sha256(canonicalJson(value));
export type RoutingCandidate = {
    optionKey: string;
    conversationId: string;
    routeId: string;
    shopId: string;
    facts: Prisma.JsonValue;
    controlRevision: number;
};
export type FrozenRoutingDecision = Prisma.InputJsonObject & {
    schemaVersion: 1;
    role: 'SELECT_ONLY' | 'NEW_QUESTION' | 'SELECT_AND_QUESTION' | 'CLARIFY';
    currentInboundProviderMessageId: string;
    originalTurnId: string | null;
    originalInboundProviderMessageId: string | null;
    promptTurnId: string | null;
    confirmedPromptProviderMessageId: string | null;
    selectedAssignmentConversationId: string | null;
    offeredOptionKey: string | null;
    candidateFingerprint: string;
    originalTextSha256: string;
    associatedMessages: {
        originalMessageId: string | null;
        currentMessageId: string | null;
    };
    clause: {
        start: number;
        end: number;
        sha256: string;
    } | null;
    controlRevision: number | null;
};
export async function readRoutingAudioSourceHash(db: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>, id: string): Promise<string | null> {
    const rows = await db.$queryRawUnsafe<Array<{
        hash: string | null;
    }>>('SELECT whatsapp.arch076_r15_audio_source_sha256("inputJson") AS hash FROM whatsapp."RecoveryBasketRoutingTurn" WHERE "inboundProviderMessageId" = $1', id);
    return rows[0]?.hash ?? null;
}
export function routingAudioOf(turn: RecoveryBasketRoutingTurn): RoutingAudioTranscript | null {
    const event = turn.inputJson as unknown as WhatsAppInboundEvent | null;
    const snapshot = turn.moderationJson as unknown as {
        audioTranscript?: RoutingAudioTranscript;
    } | null;
    const audio = snapshot?.audioTranscript;
    if (event?.content?.type !== 'audio' || !audio || typeof audio.text !== 'string' || !audio.text.trim() || audio.provenance?.verified !== true || audio.provenance.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(audio.provenance.sourceSha256) || audio.provenance.providerMessageId !== event.providerMessageId || audio.provenance.mediaIdSha256 !== sha256(event.content.mediaId) || audio.provenance.transcriptSha256 !== sha256(audio.text))
        return null;
    return audio;
}
export const textOf = (turn: RecoveryBasketRoutingTurn): string | null => {
    const event = turn.inputJson as unknown as WhatsAppInboundEvent | null;
    return event?.content?.type === 'text' ? event.content.text : routingAudioOf(turn)?.text ?? null;
};
/** Only saved commerce item facts are routing context; arbitrary item properties
 * (including custom notes/customer data) are never forwarded. All rows remain. */
export function safeRoutingItems(value: Prisma.JsonValue | null): Prisma.JsonValue {
    if (!Array.isArray(value))
        return { unavailable: true };
    return value.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return { unavailable: true };
        const out: Prisma.JsonObject = {};
        for (const key of ['productId', 'variantId', 'title', 'variantTitle', 'sku', 'quantity', 'price']) {
            const v = item[key];
            if (typeof v === 'string' || typeof v === 'number' || v === null)
                out[key] = v;
        }
        return out;
    });
}
export async function readRoutingCandidates(db: PrismaClient, scope: SenderHandoff, now = new Date()): Promise<RoutingCandidate[]> {
    const rows = await db.recoverySenderAssignment.findMany({ where: { releasedAt: null, route: { threadId: scope.threadId, closedAt: null, ...(scope.routeId ? { id: scope.routeId } : {}) } }, orderBy: { conversationId: 'asc' }, select: { conversationId: true, routeId: true, route: { select: { shopId: true, shop: { select: { domain: true } } } }, conversation: { select: { controlRevision: true } } } });
    const eligible: RoutingCandidate[] = [];
    for (const row of rows) {
        if (!await isAssignedConversationActive(db, row.conversationId, now))
            continue;
        const recovery = scope.routeId ? await db.checkoutRecovery.findUnique({ where: { id: (await db.conversation.findUniqueOrThrow({ where: { id: row.conversationId }, select: { checkoutRecoveryId: true } })).checkoutRecoveryId! }, select: { lineItems: true, currency: true, totalPrice: true } }) : null;
        eligible.push({ optionKey: row.conversationId, conversationId: row.conversationId, routeId: row.routeId, shopId: row.route.shopId, controlRevision: row.conversation.controlRevision,
            facts: scope.routeId ? { lineItems: safeRoutingItems(recovery?.lineItems ?? null), currency: recovery?.currency ?? null, totalPrice: recovery?.totalPrice?.toString() ?? null } : { shopLabel: row.route.shop.domain } });
    }
    return eligible;
}
export async function lockRoutingTurn(tx: Prisma.TransactionClient, id: string) {
    await lockInboundProviderIdentity(tx, id);
    const pointer = await tx.recoveryBasketRoutingTurn.findUnique({ where: { inboundProviderMessageId: id }, select: { thread: { select: { canonicalRecipient: true } } } });
    if (pointer)
        await lockRecoverySenderRecipient(tx, pointer.thread.canonicalRecipient);
    const rows = await tx.$queryRawUnsafe<RecoveryBasketRoutingTurn[]>(`SELECT * FROM whatsapp."RecoveryBasketRoutingTurn" WHERE "inboundProviderMessageId"=$1 FOR UPDATE`, id);
    return rows[0] ?? null;
}
export const scrubRoutingPayload = { inputJson: Prisma.DbNull, candidatesJson: Prisma.DbNull, moderationJson: Prisma.DbNull, promptText: null, workToken: null, workLeaseUntil: null, nextRepairAt: null } as const;
/** Classification freezes once. A later selection resolves an original without changing its CLARIFY decision. */
export async function freezeRoutingDecision(db: PrismaClient, id: string, input: {
    decision: FrozenRoutingDecision;
    candidates: RoutingCandidate[];
    moderation: Prisma.InputJsonValue;
    parentId: string | null;
    routeId: string | null;
}, current: (tx: Prisma.TransactionClient) => Promise<boolean>) {
    return db.$transaction(async (tx) => {
        const row = await lockRoutingTurn(tx, id);
        if (!row)
            throw new Error('ROUTING_TURN_MISSING');
        if (row.routingDecision)
            return row;
        const d = input.decision;
        if (d.currentInboundProviderMessageId !== id || d.originalTurnId !== input.parentId || d.originalInboundProviderMessageId !== input.parentId || d.role === 'NEW_QUESTION' && input.parentId !== null || ['SELECT_ONLY', 'SELECT_AND_QUESTION'].includes(d.role) && !input.parentId)
            throw new Error('ROUTING_ROLE_SCOPE_INVALID');
        if (row.state !== 'RECEIVED' || row.expiresAt <= new Date() || !await current(tx))
            throw new Error('ROUTING_DECISION_STALE');
        if (input.parentId) {
            const parent = await tx.recoveryBasketRoutingTurn.findUnique({ where: { inboundProviderMessageId: input.parentId } });
            if (!parent || parent.threadId !== row.threadId || parent.resolvedAt || parent.expiresAt <= new Date())
                throw new Error('ROUTING_ORIGINAL_STALE');
        }
        return tx.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: id }, data: { routingDecision: input.decision, candidatesJson: input.candidates as unknown as Prisma.InputJsonValue, moderationJson: input.moderation, parentProviderMessageId: input.parentId, routeId: input.routeId } });
    });
}
export type RoutingAllowedAssessment = {
    id: string;
    hash: string;
    policyVersion: string;
    requestedModel: string;
    returnedModel: string;
    operationRows: {
        id: string;
        version: number;
    }[];
    categories: Prisma.InputJsonObject;
    scores: Prisma.InputJsonObject;
    providerRequestId: string | null;
};
export async function admitRoutingDecision(db: PrismaClient, id: string, assessments: {
    original: RoutingAllowedAssessment;
    current?: RoutingAllowedAssessment;
    clause?: RoutingAllowedAssessment;
}, current: (tx: Prisma.TransactionClient) => Promise<boolean>, now = new Date()) {
    return db.$transaction(async (tx) => {
        const currentRow = await lockRoutingTurn(tx, id);
        if (!currentRow)
            throw new Error('ROUTING_TURN_MISSING');
        if (currentRow.state === 'RESOLVED') {
            const d = currentRow.routingDecision as FrozenRoutingDecision | null;
            if (!currentRow.selectedConversationId || !d?.associatedMessages?.originalMessageId)
                throw new Error('ROUTING_REPLAY_EVIDENCE_MISSING');
            const message = await tx.conversationMessage.findUnique({ where: { id: d.associatedMessages.originalMessageId } });
            if (!message || message.conversationId !== currentRow.selectedConversationId || sha256(message.content) !== d.originalTextSha256)
                throw new Error('ROUTING_REPLAY_EVIDENCE_MISSING');
            const currentId = d.associatedMessages.currentMessageId;
            if (!currentId)
                throw new Error('ROUTING_REPLAY_EVIDENCE_MISSING');
            const currentMessage = await tx.conversationMessage.findUnique({ where: { id: currentId } });
            if (!currentMessage || currentMessage.conversationId !== currentRow.selectedConversationId || currentMessage.providerMessageId !== id || typeof d.currentTextSha256 !== 'string' || sha256(currentMessage.content) !== d.currentTextSha256)
                throw new Error('ROUTING_REPLAY_EVIDENCE_MISSING');
            return { kind: 'replay' as const, conversationId: currentRow.selectedConversationId };
        }
        const decision = currentRow.routingDecision as FrozenRoutingDecision | null;
        if (!decision || decision.currentInboundProviderMessageId !== id || decision.role === 'NEW_QUESTION' && (decision.originalTurnId !== null || currentRow.parentProviderMessageId !== null) || decision.role === 'CLARIFY' || !decision.selectedAssignmentConversationId)
            throw new Error('ROUTING_DECISION_UNRESOLVED');
        const originalId = decision.originalTurnId ?? id;
        // Provider IDs ordered before recipient/owner locks; no reverse-child lookup.
        if (originalId !== id)
            await lockInboundProviderIdentity(tx, originalId);
        const original = originalId === id ? currentRow : await tx.recoveryBasketRoutingTurn.findUnique({ where: { inboundProviderMessageId: originalId } });
        if (!original || original.threadId !== currentRow.threadId || original.resolvedAt || original.expiresAt <= now || currentRow.expiresAt <= now)
            throw new Error('ROUTING_ORIGINAL_STALE');
        for (const turn of originalId === id ? [currentRow] : [original, currentRow]) {
            const audio = routingAudioOf(turn);
            if (audio && audio.provenance.sourceSha256 !== await readRoutingAudioSourceHash(tx, turn.inboundProviderMessageId))
                throw new Error('ROUTING_AUDIO_SOURCE_CHANGED');
        }
        if (!await current(tx))
            throw new Error('ROUTING_CONFIGURATION_CHANGED');
        const owner = await readAssignedOwner(tx, decision.selectedAssignmentConversationId);
        if (!owner || owner.threadId !== currentRow.threadId || currentRow.routeId && currentRow.routeId !== owner.routeId || original.routeId && original.routeId !== owner.routeId)
            throw new Error('ROUTING_CANDIDATE_OWNER_CHANGED');
        await lockRecoverySenderRecipient(tx, owner.canonicalRecipient);
        const [shopState] = await tx.$queryRawUnsafe<Array<{
            status: string;
        }>>(`SELECT s.status::text FROM commerce."Shop" s JOIN commerce."CheckoutRecovery" r ON r."shopId"=s.id JOIN whatsapp."Conversation" c ON c."checkoutRecoveryId"=r.id WHERE c.id=$1 AND s.id=$2 FOR UPDATE OF s,r,c`, owner.conversationId, owner.shopId);
        if (shopState?.status !== 'ACTIVE')
            throw new Error('ROUTING_SHOP_INACTIVE');
        const [control] = await tx.$queryRawUnsafe<Array<{
            controlRevision: number;
            controlMode: string;
        }>>(`SELECT "controlRevision","controlMode"::text FROM whatsapp."Conversation" WHERE id=$1 FOR UPDATE`, owner.conversationId);
        if (!control || control.controlRevision !== decision.controlRevision || control.controlMode !== 'AI')
            throw new Error('ROUTING_CONTROL_CHANGED');
        const canonical = canonicalWhatsAppSender(owner.canonicalRecipient);
        if (!canonical)
            throw new Error('ROUTING_RECIPIENT_INVALID');
        await lockWhatsAppStopRecipient(tx, canonical);
        if (await hasLocalNoContact(tx, { shopId: owner.shopId, recipient: owner.canonicalRecipient }))
            throw new Error('ROUTING_STOPPED');
        if (now.getTime() - currentRow.occurredAt.getTime() >= 24 * 60 * 60 * 1000)
            throw new Error('ROUTING_SERVICE_WINDOW_CLOSED');
        const offered = currentRow.candidatesJson as unknown as RoutingCandidate[] | null;
        if (!offered || fingerprint(offered) !== decision.candidateFingerprint || !offered.some(c => c.conversationId === owner.conversationId && c.routeId === owner.routeId && c.controlRevision === control.controlRevision))
            throw new Error('ROUTING_OFFER_CHANGED');
        await tx.$queryRawUnsafe(`SELECT c.id FROM whatsapp."Conversation" c JOIN commerce."CheckoutRecovery" r ON r.id=c."checkoutRecoveryId" WHERE c.id=ANY($1::text[]) ORDER BY c.id FOR SHARE OF c,r`, offered.map(candidate => candidate.conversationId));
        const liveCandidates = await readRoutingCandidates(tx as unknown as PrismaClient, { threadId: owner.threadId!, routeId: owner.routeId, canonicalRecipient: owner.canonicalRecipient, providerPhoneNumberId: owner.providerPhoneNumberId, providerAccountId: owner.providerAccountId }, now);
        if (fingerprint(liveCandidates) !== decision.candidateFingerprint)
            throw new Error('ROUTING_CANDIDATE_FACTS_CHANGED');
        if (originalId !== id) {
            if (currentRow.parentProviderMessageId !== originalId || !decision.promptTurnId)
                throw new Error('ROUTING_PARENT_CHANGED');
            const [prompt] = await tx.$queryRawUnsafe<RecoveryBasketRoutingTurn[]>(`SELECT * FROM whatsapp."RecoveryBasketRoutingTurn" WHERE "inboundProviderMessageId"=$1 FOR SHARE`, decision.promptTurnId);
            if (!prompt || prompt.threadId !== original.threadId || (prompt.inboundProviderMessageId !== originalId && prompt.parentProviderMessageId !== originalId) || prompt.routeId && prompt.routeId !== owner.routeId || prompt.expiresAt <= now || !prompt.promptSentAt || prompt.promptProviderMessageId !== decision.confirmedPromptProviderMessageId || prompt.promptScopeRouteId && prompt.promptScopeRouteId !== owner.routeId)
                throw new Error('ROUTING_PROMPT_CHANGED');
            const promptCandidates = prompt.candidatesJson as unknown as RoutingCandidate[] | null;
            if (!promptCandidates?.some(c => c.conversationId === owner.conversationId && c.routeId === owner.routeId && c.optionKey === decision.offeredOptionKey && c.controlRevision === control.controlRevision))
                throw new Error('ROUTING_PROMPT_OPTION_CHANGED');
            const priorDecision = prompt.routingDecision as Prisma.JsonObject | null;
            const priorTemplate = priorDecision?.template as Prisma.JsonObject | null;
            const currentTemplate = decision.template as Prisma.JsonObject | null;
            if (priorTemplate && currentTemplate && ['definitionId', 'localeId', 'languageTag', 'sourceHash', 'contentHash', 'slotEditVersion'].some(key => priorTemplate[key] !== currentTemplate[key]))
                throw new Error('ROUTING_PROMPT_TEMPLATE_CHANGED');
            const priorConfig = prompt.configurationSnapshot as Prisma.JsonObject | null;
            const currentConfig = currentRow.configurationSnapshot as Prisma.JsonObject | null;
            if (!priorConfig || !currentConfig || priorConfig.rowId !== currentConfig.rowId || priorConfig.version !== currentConfig.version || fingerprint(priorConfig.prompt) !== fingerprint(currentConfig.prompt))
                throw new Error('ROUTING_PROMPT_POLICY_CHANGED');
        }
        const originalText = textOf(original), currentText = textOf(currentRow);
        const frozenModeration = currentRow.moderationJson as {
            current?: Prisma.JsonValue;
        } | null;
        if (fingerprint(decision.assessments ?? null) !== fingerprint(assessments) || fingerprint(frozenModeration?.current ?? null) !== fingerprint((originalId === id ? assessments.original : assessments.current) ?? null))
            throw new Error('ROUTING_MODERATION_EVIDENCE_CHANGED');
        if (originalText === null || currentText === null || typeof decision.currentTextSha256 !== 'string' || sha256(currentText) !== decision.currentTextSha256 || originalId !== id && assessments.current?.hash !== sha256(currentText) || sha256(originalText) !== decision.originalTextSha256 || assessments.original.hash !== sha256(originalText))
            throw new Error('ROUTING_CONTENT_CHANGED');
        const clause = decision.clause ? currentText.slice(decision.clause.start, decision.clause.end) : null;
        if (decision.role === 'SELECT_AND_QUESTION' && (!clause || sha256(clause) !== decision.clause?.sha256 || assessments.clause?.hash !== sha256(clause)))
            throw new Error('ROUTING_CLAUSE_CHANGED');
        for (const assessment of [assessments.original, ...(assessments.current ? [assessments.current] : []), ...(assessments.clause ? [assessments.clause] : [])]) {
            if (assessment.policyVersion !== moderationConfig().policyVersion)
                throw new Error('ROUTING_MODERATION_CHANGED');
            for (const config of assessment.operationRows) {
                if (!(await tx.$queryRawUnsafe<Array<{
                    id: string;
                }>>(`SELECT id FROM public."PlatformConfiguration" WHERE id=$1 AND version=$2 FOR SHARE`, config.id, config.version)).length)
                    throw new Error('ROUTING_MODERATION_CHANGED');
            }
        }
        // Initial owner/witness bind + authentic records + terminal scrub commit together.
        const terminal = { ...scrubRoutingPayload, state: 'RESOLVED', resolvedAt: now, selectedConversationId: owner.conversationId, routeId: owner.routeId, resolutionInboundProviderMessageId: id };
        await tx.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: id }, data: terminal });
        if (originalId !== id)
            await tx.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: originalId }, data: terminal });
        await verifyInboundOwner(tx, owner, id, now, true, currentRow.occurredAt);
        if (originalId !== id)
            await verifyInboundOwner(tx, owner, originalId, now, true, original.occurredAt);
        const attachAssessment = async (messageId: string, assessment: RoutingAllowedAssessment, inputKind: 'TEXT' | 'TRANSCRIPT') => {
            await tx.conversationModerationAssessment.create({ data: { id: assessment.id, shopId: owner.shopId, conversationId: owner.conversationId, subject: 'CUSTOMER_MESSAGE', conversationMessageId: messageId, contentSha256: assessment.hash, inputKind, requestedModel: assessment.requestedModel, policyVersion: assessment.policyVersion } });
            const lease = randomUUID();
            await tx.conversationModerationAssessment.update({ where: { id: assessment.id }, data: { decision: 'CHECKING', attemptCount: 1, leaseToken: lease, leaseExpiresAt: new Date(Date.now() + MODERATION_TIMEOUT_MS) } });
            await tx.$queryRawUnsafe(`SELECT set_config('moda.moderation_lease_token',$1,true)`, lease);
            await tx.conversationModerationAssessment.update({ where: { id: assessment.id }, data: { decision: 'ALLOW', returnedModel: assessment.returnedModel, flagged: false, categories: assessment.categories, categoryScores: assessment.scores, providerRequestId: assessment.providerRequestId, assessedAt: now, leaseToken: null, leaseExpiresAt: null } });
        };
        const create = async (turn: RecoveryBasketRoutingTurn, messageId: string, content: string, assessment?: RoutingAllowedAssessment) => {
            const event = turn.inputJson as unknown as WhatsAppInboundEvent;
            const existing = await tx.conversationMessage.findUnique({ where: { providerMessageId: turn.inboundProviderMessageId } });
            if (existing) {
                if (existing.id !== messageId || existing.conversationId !== owner.conversationId)
                    throw new Error('ROUTING_MESSAGE_OWNER_CHANGED');
                return;
            }
            const audio = routingAudioOf(turn);
            await tx.conversationMessage.create({ data: { id: messageId, conversationId: owner.conversationId, providerMessageId: turn.inboundProviderMessageId, inReplyToProviderId: event.contextMessageId, direction: 'INBOUND', senderType: 'CUSTOMER', status: 'DELIVERED', content, contentType: audio ? 'AUDIO' : 'TEXT', ...(audio && event.content.type === 'audio' ? { providerMediaId: event.content.mediaId, providerMediaMimeType: event.content.mimeType, providerMediaSha256: event.content.sha256, mediaDurationMs: audio.provenance.durationMs, transcriptionStatus: 'COMPLETED' as const, transcriptionProvider: audio.provenance.provider, transcriptionModel: audio.provenance.model, transcriptionCompletedAt: now } : {}), createdAt: turn.occurredAt, dispatchProviderAccountId: owner.providerAccountId, dispatchProviderPhoneNumberId: owner.providerPhoneNumberId } });
            if (assessment)
                await attachAssessment(messageId, assessment, audio ? 'TRANSCRIPT' : 'TEXT');
        };
        const originalMessageId = decision.associatedMessages.originalMessageId;
        if (!originalMessageId)
            throw new Error('ROUTING_ASSOCIATION_MISSING');
        await create(original, originalMessageId, originalText, assessments.original);
        if (originalId !== id) {
            if (!decision.associatedMessages.currentMessageId)
                throw new Error('ROUTING_ASSOCIATION_MISSING');
            await create(currentRow, decision.associatedMessages.currentMessageId, currentText, assessments.current);
            if (assessments.clause && assessments.clause.id !== assessments.current?.id)
                await attachAssessment(decision.associatedMessages.currentMessageId, assessments.clause, routingAudioOf(currentRow) ? 'TRANSCRIPT' : 'TEXT');
        }
        const pending = await recordProcessableInbound(tx, owner.conversationId, now, { conversationAlreadyLocked: true });
        await tx.conversation.update({ where: { id: owner.conversationId }, data: { lastInboundAt: now, lastMessageAt: now } });
        return { kind: 'admitted' as const, conversationId: owner.conversationId, version: pending.version };
    });
}
export const routingMessageId = (providerId: string) => `routing-message-${sha256(providerId)}`;
export const routingAssessmentId = () => randomUUID();
/** Explicit owner-deleted retention cohort. Never delete role evidence while its
 * authentic Conversation survives, or orphan a pending parent/witness. */
export async function deleteRoutingRetentionCohort(db: PrismaClient, ids: readonly string[], retentionBefore: Date) {
    if (!ids.length || new Set(ids).size !== ids.length)
        throw new Error('ROUTING_RETENTION_COHORT_INVALID');
    return db.$transaction(async (tx) => {
        const rows = await tx.recoveryBasketRoutingTurn.findMany({ where: { inboundProviderMessageId: { in: [...ids] } } });
        if (rows.length !== ids.length || rows.some(r => !['RESOLVED', 'EXPIRED', 'IGNORED'].includes(r.state) || r.selectedConversationId !== null || r.createdAt > retentionBefore || r.inputJson !== null || r.candidatesJson !== null || r.moderationJson !== null || r.promptText !== null))
            throw new Error('ROUTING_RETENTION_NOT_ELIGIBLE');
        const dependents = await tx.recoveryBasketRoutingTurn.findMany({ where: { OR: [{ parentProviderMessageId: { in: [...ids] } }, { resolutionInboundProviderMessageId: { in: [...ids] } }] }, select: { inboundProviderMessageId: true } });
        if (dependents.some(r => !ids.includes(r.inboundProviderMessageId)))
            throw new Error('ROUTING_RETENTION_COHORT_INCOMPLETE');
        return tx.recoveryBasketRoutingTurn.deleteMany({ where: { inboundProviderMessageId: { in: [...ids] } } });
    });
}
