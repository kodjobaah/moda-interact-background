import { processRoutedInboundMessage } from "../../src/services/whatsapp-inbound-processing.service.js";
import { ConversationTurnProcessor } from "../../src/services/conversation-turn-processor.service.js";
import { conversationService } from "../../src/services/conversation.service.js";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import { sha256 } from "../../src/services/recovery-multipart/frozen.js";
import { WhatsAppProviderStatusService } from "../../src/services/whatsapp-provider-status.service.js";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { RecoveryRoutingService } from '../../src/services/recovery-routing.service.js';
import { WhatsAppContactOptOutService } from '../../src/services/whatsapp-contact-opt-out.service.js';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { RecoverySenderPoolService } from '../../src/services/recovery-sender-pool/sender-pool.service.js';
import { resolveSenderInbound, quotedOwner, canProcessConversation, type InboundOwnerEvidence } from '../../src/services/recovery-sender-pool/inbound-authority.js';
import { persistVerifiedInbound } from '../../src/services/recovery-sender-pool/inbound-writer.js';
import { persistRoutingHandoff, type RoutingPersistencePolicy } from '../../src/services/recovery-sender-pool/routing-handoff.js';
import type { WhatsAppInboundEvent } from '../../src/integration/whatsapp/types.js';
const suite = process.env.MODA_DISPOSABLE_INTEGRATION === '1' && process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite('ARCH076 exact incoming sender generations', () => {
    const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    let rowId: string, policy: RoutingPersistencePolicy;
    const account = '91001', phone = '81001', past = new Date(Date.now() - 1000);
    const event = (recipient: string, quote: string | null = null, id = randomUUID()): WhatsAppInboundEvent => ({ schemaVersion: 1, provider: 'whatsapp', providerAccountId: account, providerPhoneNumberId: phone, providerMessageId: id, customerPhone: recipient, contextMessageId: quote, occurredAt: new Date().toISOString(), content: { type: 'text', text: 'Can it arrive Friday?' } });
    beforeAll(async () => {
        rowId = (await db.platformConfiguration.upsert({ where: { environment_key: { environment: 'test', key: 'messaging.sender' } }, create: { environment: 'test', key: 'messaging.sender', value: { fixture: true } }, update: {} })).id;
        const p = await db.platformConfiguration.upsert({ where: { environment_key: { environment: 'test', key: 'recovery.routingAgent' } }, create: { environment: 'test', key: 'recovery.routingAgent', value: { fixture: true } }, update: {} });
        policy = { rowId: p.id, version: p.version, environment: 'test', decisionTTLms: 60000, retentionMs: 120000, configurationSnapshot: { schemaVersion: 1, policyRowId: p.id, policyVersion: p.version } };
        await db.backgroundRuntimeConfig.upsert({ where: { id: 'default' }, create: { id: 'default', checkoutRecoveryLifetimeDays: 30 }, update: { checkoutRecoveryLifetimeDays: 30 } });
        await db.whatsAppPoolSender.create({ data: { providerAccountId: account, providerPhoneNumberId: phone, verifiedAt: past, allocationEnabled: true } });
    });
    afterAll(() => db.$disconnect());
    async function fixture(recipient: string, shopId?: string) {
        const shop = shopId ? await db.shop.findUniqueOrThrow({ where: { id: shopId } }) : await db.shop.create({ data: { domain: `${randomUUID()}.test` } });
        const r = await db.checkoutRecovery.create({ data: { shopId: shop.id, checkoutToken: randomUUID(), status: 'MESSAGE_SENT', lastExternalActivityAt: past } });
        const c = await db.conversation.create({ data: { shopId: shop.id, checkoutRecoveryId: r.id, type: 'RECOVERY' } });
        const pool = new RecoverySenderPoolService(db, () => new Date(), async () => ({ rowId, version: 1, environment: 'test', accountId: account }));
        const allocated = await pool.allocate({ conversationId: c.id, canonicalRecipient: recipient });
        if (allocated.kind !== 'assigned')
            throw Error('allocation');
        const m = await db.conversationMessage.create({ data: { conversationId: c.id, direction: 'OUTBOUND', senderType: 'AUTOMATION', status: 'DELIVERED', deliveredAt: past, content: 'reminder', providerMessageId: randomUUID(), sentAt: past, providerDispatchKey: randomUUID(), providerDispatchAdmittedAt: past, providerDispatchControlRevision: 0, dispatchProviderAccountId: account, dispatchProviderPhoneNumberId: phone } });
        const a = await db.recoveryOutreachAttempt.create({ data: { checkoutRecoveryId: r.id, sequence: 1, recipient, trigger: 'INITIAL', configuredOfferMode: 'NONE', status: 'WAITING_FOR_RESPONSE', sentAt: past, outboundMessageId: m.id } });
        return { shop, r, c, m, a, sender: allocated.sender, pool };
    }
    async function owner(e: WhatsAppInboundEvent) {
        const r = await resolveSenderInbound(db, e);
        expect(r.kind).toBe('owned');
        if (r.kind !== 'owned')
            throw Error('owner');
        return r;
    }
    it('drained sender remains exact owner, unrelated WABA/recipient/phone refuse', async () => {
        const f = await fixture('447700900001');
        await db.whatsAppPoolSender.update({ where: { providerPhoneNumberId: phone }, data: { allocationEnabled: false } });
        expect((await owner(event(f.sender.canonicalRecipient))).evidence.conversationId).toBe(f.c.id);
        expect((await resolveSenderInbound(db, { ...event(f.sender.canonicalRecipient), providerAccountId: '999' })).kind).toBe('invalid');
        expect((await resolveSenderInbound(db, event('447700900999', f.m.providerMessageId))).kind).toBe('invalid');
        await db.whatsAppPoolSender.update({ where: { providerPhoneNumberId: phone }, data: { allocationEnabled: true } });
    });
    it('two shops or multiple same-shop baskets hand off before any transcript effect', async () => {
        const f = await fixture('447700900002');
        await fixture(f.sender.canonicalRecipient);
        const handoff = await resolveSenderInbound(db, event(f.sender.canonicalRecipient));
        expect(handoff).toMatchObject({ kind: 'routing', scope: { threadId: f.sender.threadId, routeId: null } });
        const g = await fixture('447700900003');
        await fixture(g.sender.canonicalRecipient, g.shop.id);
        expect(await resolveSenderInbound(db, event(g.sender.canonicalRecipient))).toMatchObject({ kind: 'routing', scope: { routeId: g.sender.routeId } });
    });
    it('exact quote selects its original basket despite multiple candidates', async () => {
        const f = await fixture('447700900004');
        await fixture(f.sender.canonicalRecipient, f.shop.id);
        expect((await owner(event(f.sender.canonicalRecipient, f.m.providerMessageId))).evidence.conversationId).toBe(f.c.id);
    });
    it('definitive failed initial is not contacted ownership', async () => {
        const f = await fixture('447700900005');
        await db.conversationMessage.update({ where: { id: f.m.id }, data: { status: 'FAILED', failedAt: new Date(), providerFailureCode: '131049' } });
        expect(await resolveSenderInbound(db, event(f.sender.canonicalRecipient))).toMatchObject({ kind: 'routing' });
        expect((await resolveSenderInbound(db, event(f.sender.canonicalRecipient, f.m.providerMessageId))).kind).toBe('invalid');
        expect(await canProcessConversation(db, f.c.id)).toBe(false);
    });
    it('text persistence is atomic, stamps exact pair and replay has one version', async () => {
        const f = await fixture('447700900006'), e = event(f.sender.canonicalRecipient), r = await owner(e);
        const saved = await persistVerifiedInbound(db, e, r.evidence, 'active');
        const duplicate = await persistVerifiedInbound(db, { ...e, contextMessageId: randomUUID() }, r.evidence, 'active');
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.version).toBe(saved.version);
        expect(saved.message).toMatchObject({ dispatchProviderAccountId: account, dispatchProviderPhoneNumberId: phone });
        expect((await owner({ ...e, contextMessageId: randomUUID() })).evidence.conversationId).toBe(f.c.id);
    });
    it('released/expired generations stay historical and cannot acquire a newer route', async () => {
        const f = await fixture('447700900007');
        await db.checkoutRecovery.update({ where: { id: f.r.id }, data: { status: 'EXPIRED', expiredAt: new Date() } });
        await f.pool.release(f.c.id);
        const g = await fixture(f.sender.canonicalRecipient, f.shop.id);
        expect(g.sender.routeId).not.toBe(f.sender.routeId);
        const old = await owner(event(f.sender.canonicalRecipient, f.m.providerMessageId));
        expect(old.mode).toBe('historical');
        expect(old.evidence.routeId).toBe(f.sender.routeId);
        await expect(persistVerifiedInbound(db, event(f.sender.canonicalRecipient), old.evidence, 'active')).rejects.toThrow('INBOUND_SENDER_OWNER_CHANGED');
    });
    it('unknown originals persist outside transcript, replay pins generation and payload', async () => {
        const f = await fixture('447700900008');
        await fixture(f.sender.canonicalRecipient);
        const e = event(f.sender.canonicalRecipient), r = await resolveSenderInbound(db, e);
        if (r.kind !== 'routing')
            throw Error('handoff');
        const saved = await persistRoutingHandoff(db, e, r.scope, policy);
        expect(saved.kind).toBe('persisted');
        expect(await db.conversationMessage.count({ where: { providerMessageId: e.providerMessageId } })).toBe(0);
        await persistRoutingHandoff(db, { ...e, content: { type: 'text', text: 'changed' } }, r.scope, policy);
        expect((await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: e.providerMessageId } })).inputJson).toEqual(e);
    });
    it('shared provider-ID lock serializes routing versus merchant text writers', async () => {
        const f = await fixture('447700900009'), e = event(f.sender.canonicalRecipient), r = await owner(e);
        const scope = { ...r.evidence, threadId: r.evidence.threadId! };
        const results = await Promise.allSettled([persistRoutingHandoff(db, e, scope, policy), persistVerifiedInbound(db, e, r.evidence, 'active')]);
        expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find(x => x.status === 'rejected');
        expect(rejected?.status).toBe('rejected');
        if (rejected?.status === 'rejected')
            expect(String(rejected.reason)).toMatch(/INBOUND_ROUTING_TURN_OWNS_PROVIDER_ID|MERCHANT_TRANSCRIPT_OWNS_PROVIDER_ID/);
        expect(await db.recoveryBasketRoutingTurn.count({ where: { inboundProviderMessageId: e.providerMessageId } }) + await db.conversationMessage.count({ where: { providerMessageId: e.providerMessageId } })).toBe(1);
    });
    it('final persistence rechecks expiry and does not revive lifetime/activity', async () => {
        const f = await fixture('447700900010'), e = event(f.sender.canonicalRecipient), r = await owner(e);
        const expired = new Date(Date.now() - 31 * 86400000);
        await db.checkoutRecovery.update({ where: { id: f.r.id }, data: { lastExternalActivityAt: expired } });
        await expect(persistVerifiedInbound(db, e, r.evidence, 'active')).rejects.toThrow();
        expect((await db.checkoutRecovery.findUniqueOrThrow({ where: { id: f.r.id } })).lastExternalActivityAt).toEqual(expired);
        expect(await db.conversationMessage.count({ where: { providerMessageId: e.providerMessageId } })).toBe(0);
    });
    it('audio reservation uses the same ownership/id boundary without creating a turn', async () => {
        const f = await fixture('447700900011'), e = event(f.sender.canonicalRecipient), r = await owner(e);
        const audio = { ...e, content: { type: 'audio' as const, mediaId: 'fixture-media', mimeType: 'audio/ogg', sha256: null } };
        const saved = await persistVerifiedInbound(db, audio, r.evidence, 'active');
        expect(saved.message.contentType).toBe('AUDIO');
        expect(saved.message.transcriptionStatus).toBe('PENDING');
        expect(saved.version).toBe(0);
        await expect(persistRoutingHandoff(db, audio, { ...r.evidence, threadId: r.evidence.threadId! }, policy)).rejects.toThrow('MERCHANT_TRANSCRIPT_OWNS_PROVIDER_ID');
    });
    it('absent/stale policy holds instead of guessing router business defaults', async () => {
        const f = await fixture('447700900012'), e = event(f.sender.canonicalRecipient), r = await owner(e), scope = { ...r.evidence, threadId: r.evidence.threadId! };
        expect((await persistRoutingHandoff(db, e, scope, null)).kind).toBe('held');
        await expect(persistRoutingHandoff(db, e, scope, { ...policy, version: 999 })).rejects.toThrow('ROUTING_POLICY_CHANGED');
    });
    it('recipient/account forged replay cannot claim another transcript or pending turn', async () => {
        const f = await fixture('447700900013'), e = event(f.sender.canonicalRecipient), r = await owner(e);
        await persistVerifiedInbound(db, e, r.evidence, 'active');
        expect((await resolveSenderInbound(db, { ...e, customerPhone: '447700900999' })).kind).toBe('invalid');
        expect(await quotedOwner(db, f.m.providerMessageId, { ...e, providerAccountId: '999' })).toBeNull();
        const foreign: InboundOwnerEvidence = { ...r.evidence, canonicalRecipient: '447700900999' };
        await expect(persistVerifiedInbound(db, e, foreign, 'active')).rejects.toThrow();
    });
    it('HTTP acceptance alone is not contacted and exact router ignores foreign sender', async () => {
        const f = await fixture('447700900014');
        await db.conversationMessage.update({ where: { id: f.m.id }, data: { status: 'SENT', deliveredAt: null } });
        const service = new RecoveryRoutingService(db, { isShopExecutionActive: async () => true }, { resolveSender: async () => {
                throw Error('singleton forbidden');
            } });
        expect((await service.resolveInboundMessage(event(f.sender.canonicalRecipient))).kind).toBe('routing');
        expect((await service.resolveInboundMessage({ ...event(f.sender.canonicalRecipient), providerAccountId: '999' })).kind).toBe('ignored');
        expect(await quotedOwner(db, f.m.providerMessageId!, event(f.sender.canonicalRecipient))).toBe(f.c.id);
        const quoted = await service.resolveInboundMessage(event(f.sender.canonicalRecipient, f.m.providerMessageId));
        expect(quoted).toMatchObject({ kind: 'resolved', mode: 'active', conversationId: f.c.id });
        if (quoted.kind !== 'resolved' || !quoted.senderEvidence)
            throw Error('quote');
        await persistVerifiedInbound(db, event(f.sender.canonicalRecipient, f.m.providerMessageId), quoted.senderEvidence, 'active');
        expect((await db.conversation.findUniqueOrThrow({ where: { id: f.c.id } })).inboundVersion).toBe(1);
    });
    it('actual router sends confirmed prompt references and single remaining candidate selections to handoff', async () => {
        const f = await fixture('447700900015'), q = event(f.sender.canonicalRecipient), at = new Date();
        const saved = await persistRoutingHandoff(db, q, { ...f.sender, routeId: null }, policy);
        if (saved.kind !== 'persisted')
            throw Error('prompt original');
        const promptId = randomUUID();
        await db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: q.providerMessageId }, data: { state: 'PROMPT_ADMITTED', promptText: 'Which basket?', promptAdmittedAt: at, promptSentAt: at, promptProviderMessageId: promptId } });
        const service = new RecoveryRoutingService(db, { isShopExecutionActive: async () => true }, { resolveSender: async () => {
                throw Error('singleton forbidden');
            } });
        expect(await service.resolveInboundMessage({ ...event(f.sender.canonicalRecipient, promptId), content: { type: 'text', text: '2' } })).toMatchObject({ kind: 'routing', scope: { threadId: f.sender.threadId, routeId: null } });
        expect(await service.resolveInboundMessage({ ...event(f.sender.canonicalRecipient), content: { type: 'text', text: '2' } })).toMatchObject({ kind: 'routing' });
        expect((await service.resolveInboundMessage(event('447700900999', promptId))).kind).toBe('ignored');
    });
    it('actual pooled STOP scopes exact confirmed quote and rejects foreign receiving account', async () => {
        const f = await fixture('14155550101'), g = await fixture(f.sender.canonicalRecipient);
        const customer = await db.customer.create({ data: { shopId: f.shop.id, phone: '+' + f.sender.canonicalRecipient } }), other = await db.customer.create({ data: { shopId: g.shop.id, phone: '+' + f.sender.canonicalRecipient } });
        const first = await db.customerPhone.create({ data: { customerId: customer.id, phone: '+' + f.sender.canonicalRecipient, whatsappCanonicalPhone: f.sender.canonicalRecipient } }), second = await db.customerPhone.create({ data: { customerId: other.id, phone: '+' + f.sender.canonicalRecipient, whatsappCanonicalPhone: f.sender.canonicalRecipient } });
        const service = new WhatsAppContactOptOutService(db, async () => {
            throw Error('singleton forbidden');
        });
        const stop = { ...event(f.sender.canonicalRecipient, f.m.providerMessageId), content: { type: 'text' as const, text: 'STOP' } };
        expect(await service.handleInbound({ ...stop, providerAccountId: '999' })).toBe(true);
        expect((await db.customerPhone.findUniqueOrThrow({ where: { id: first.id } })).whatsappNoContact).toBe(false);
        expect(await service.handleInbound(stop)).toBe(true);
        expect((await db.customerPhone.findUniqueOrThrow({ where: { id: first.id } })).whatsappNoContact).toBe(true);
        expect((await db.customerPhone.findUniqueOrThrow({ where: { id: second.id } })).whatsappNoContact).toBe(false);
    });
    it('actual status application rejects foreign or NULL sender before post-commit effects', async () => {
        const f = await fixture('447700900017');
        let effects = 0;
        const service = new WhatsAppProviderStatusService(db, createLogger({ serviceName: 'fixture', environment: 'test', sink: () => {
            } }), 3, { reconcile: async () => {
                effects++;
            } }, { afterCorrection: async () => {
                effects++;
            } }, { fromProviderDelivery: async () => {
                effects++;
            } }, { notify: async () => {
                effects++;
            } });
        const callback = { schemaVersion: 3, providerAccountId: '999', providerPhoneNumberId: phone, providerMessageId: f.m.providerMessageId!, status: 'FAILED', occurredAt: new Date().toISOString(), failure: { providerCode: '131049' } };
        expect(await service.process(callback)).toBe('ignored');
        expect(effects).toBe(0);
        expect((await db.conversationMessage.findUniqueOrThrow({ where: { id: f.m.id } })).status).toBe('DELIVERED');
        const nullRoot = await db.conversationMessage.create({ data: { conversationId: f.c.id, direction: 'OUTBOUND', senderType: 'AGENT', status: 'SENT', content: 'old null proof', providerMessageId: randomUUID(), sentAt: past } });
        expect(await service.process({ ...callback, providerAccountId: account, providerMessageId: nullRoot.providerMessageId! })).toBe('ignored');
        expect(effects).toBe(0);
    });
    it('actual legacy router and atomic writer preserve only exact confirmed quote/replay without backfill', async () => {
        const to = '14155550102', legacyPhone = '81002', shop = await db.shop.create({ data: { domain: `${randomUUID()}.test` } }), customer = await db.customer.create({ data: { shopId: shop.id, phone: '+' + to } });
        const recovery = await db.checkoutRecovery.create({ data: { shopId: shop.id, customerId: customer.id, checkoutToken: randomUUID(), status: 'MESSAGE_SENT', lastExternalActivityAt: past } }), conversation = await db.conversation.create({ data: { shopId: shop.id, customerId: customer.id, checkoutRecoveryId: recovery.id, type: 'RECOVERY' } });
        const root = await db.conversationMessage.create({ data: { conversationId: conversation.id, direction: 'OUTBOUND', senderType: 'AUTOMATION', status: 'SENT', content: 'confirmed legacy reminder', providerMessageId: randomUUID(), sentAt: past, providerDispatchKey: randomUUID(), providerDispatchAdmittedAt: past, providerDispatchControlRevision: 0, dispatchProviderAccountId: account, dispatchProviderPhoneNumberId: legacyPhone } });
        await db.recoveryOutreachAttempt.create({ data: { checkoutRecoveryId: recovery.id, recipient: to, sequence: 1, trigger: 'INITIAL', configuredOfferMode: 'NONE', status: 'WAITING_FOR_RESPONSE', sentAt: past, outboundMessageId: root.id } });
        const service = new RecoveryRoutingService(db, { isShopExecutionActive: async () => true }, { resolveSender: async () => ({ providerAccountId: account, providerPhoneNumberId: legacyPhone }) });
        const incoming = { ...event(to, root.providerMessageId), providerPhoneNumberId: legacyPhone };
        const resolved = await service.resolveInboundMessage(incoming);
        expect(resolved).toMatchObject({ kind: 'resolved', mode: 'active', conversationId: conversation.id });
        if (resolved.kind !== 'resolved' || !resolved.senderEvidence)
            throw Error('legacy proof');
        const saved = await persistVerifiedInbound(db, incoming, resolved.senderEvidence, 'active');
        expect(saved.duplicate).toBe(false);
        expect((await service.resolveInboundMessage({ ...incoming, contextMessageId: randomUUID() })).kind).toBe('resolved');
        expect(await db.recoverySenderAssignment.count({ where: { conversationId: conversation.id } })).toBe(0);
        expect(await service.resolveInboundMessage({ ...incoming, providerMessageId: randomUUID(), contextMessageId: null })).toEqual({ kind: 'guidance', reason: 'NO_RECOVERY' });
        await db.whatsAppPoolSender.create({ data: { providerAccountId: account, providerPhoneNumberId: legacyPhone, verifiedAt: past, allocationEnabled: false } });
        await expect(persistVerifiedInbound(db, { ...incoming, providerMessageId: randomUUID() }, resolved.senderEvidence, 'active')).rejects.toThrow('LEGACY_SENDER_ENROLLED');
    });
    it('confirmed child quote follows frozen actual root/shop/sender instead of current presentation geometry', async () => {
        const f = await fixture('447700900018');
        const root = await db.conversationMessage.create({ data: { conversationId: f.c.id, direction: 'OUTBOUND', senderType: 'AGENT', status: 'PENDING', content: 'product reply' } });
        const source = { schemaVersion: 1, kind: 'RECOVERY_MULTIPART_PREPARATION', messageId: root.id, body: root.content, recipient: f.sender.canonicalRecipient, sender: { providerAccountId: account, providerPhoneNumberId: phone }, receipt: { shopId: f.shop.id, conversationId: f.c.id }, retiredGeometry: 'not re-rendered' };
        await db.conversationMessage.update({ where: { id: root.id }, data: { outboundPresentation: source } });
        const payload = { kind: 'TEXT', body: 'product reply' }, part = await db.conversationDeliveryPart.create({ data: { messageId: root.id, ordinal: 0, role: 'ANSWER', payload, payloadDigest: sha256(canonicalJson(payload)), sourceIdentity: { schemaVersion: 1, sourceDigest: sha256(canonicalJson(source)), shopId: f.shop.id, conversationId: f.c.id }, deadlineAt: new Date(Date.now() + 60000), providerAccountId: account, providerPhoneNumberId: phone, state: 'DELIVERED', providerDispatchKey: randomUUID(), providerDispatchAdmittedAt: past, providerMessageId: randomUUID(), acknowledgedAt: past, deliveredAt: past } });
        expect(await quotedOwner(db, part.providerMessageId!, event(f.sender.canonicalRecipient))).toBe(f.c.id);
        expect(await quotedOwner(db, part.providerMessageId!, event('447700900999'))).toBeNull();
        expect((await owner(event(f.sender.canonicalRecipient, part.providerMessageId))).evidence.conversationId).toBe(f.c.id);
    });
    it('exhausted conversation message count never removes the original basket candidate', async () => {
        const f = await fixture('447700900019');
        await db.conversationMessage.createMany({ data: Array.from({ length: 20 }, () => ({ conversationId: f.c.id, direction: 'OUTBOUND' as const, senderType: 'AGENT' as const, status: 'SENT' as const, content: 'prior allowance consumption', providerMessageId: randomUUID(), sentAt: past })) });
        expect((await owner(event(f.sender.canonicalRecipient))).evidence.conversationId).toBe(f.c.id);
        expect(await canProcessConversation(db, f.c.id)).toBe(true);
    });
    it('actual quote-before-callback pipeline records exact question and one deterministic logical AI job', async () => {
        const f = await fixture('447700900020');
        await db.conversationMessage.update({ where: { id: f.m.id }, data: { status: 'SENT', deliveredAt: null } });
        const router = new RecoveryRoutingService(db, { isShopExecutionActive: async () => true }, { resolveSender: async () => {
                throw Error('singleton forbidden');
            } }), jobs = new Map<string, unknown>();
        const add = vi.fn(async (_name: string, payload: unknown, options: {
            jobId: string;
        }) => {
            jobs.set(options.jobId, payload);
        });
        const runAgent = vi.fn(async () => {
            throw Error('model must not execute in enqueue fixture');
        });
        const processor = new ConversationTurnProcessor({ queue: { add } as never, conversation: conversationService, admission: {} as never, loadTurn: async () => {
                throw Error('context must not load during enqueue');
            }, runAgent, getResult: x => x as never, runtimeConfig: { current: () => ({ conversationQuietWindowMs: 100, conversationMaxSettleWindowMs: 200 }) } as never, now: () => new Date(Date.now() + 1000) });
        const incoming = { ...event(f.sender.canonicalRecipient, f.m.providerMessageId), content: { type: 'text' as const, text: 'Can this exact basket arrive Friday?' } };
        const ports = { router, conversation: conversationService, stop: { handleInbound: async () => false }, abuse: { admitRaw: async () => ({ kind: 'allowed' as const }) }, reachability: { fromRoutedInbound: async () => {
                } } };
        const log = createLogger({ serviceName: 'fixture', environment: 'test', sink: () => {
            } }), enqueue = (id: string, version: number) => processor.enqueue(id, version);
        await processRoutedInboundMessage(incoming, {}, log, enqueue, ports);
        await processRoutedInboundMessage({ ...incoming, contextMessageId: randomUUID() }, {}, log, enqueue, ports);
        expect(await db.conversationMessage.count({ where: { providerMessageId: incoming.providerMessageId } })).toBe(1);
        const saved = await db.conversationMessage.findUniqueOrThrow({ where: { providerMessageId: incoming.providerMessageId } });
        expect(saved.content).toBe(incoming.content.text);
        expect(saved.conversationId).toBe(f.c.id);
        expect((await db.conversation.findUniqueOrThrow({ where: { id: f.c.id } })).inboundVersion).toBe(1);
        expect([...jobs.values()]).toEqual([{ conversationId: f.c.id, observedVersion: 1 }]);
        expect(runAgent).not.toHaveBeenCalled();
        expect((await db.conversationMessage.findUniqueOrThrow({ where: { id: f.m.id } })).deliveredAt).toBeNull();
    });
 it('Woo completed successor generation excludes stale old basket while exact old quote stays historical',async()=>{
  // The active-generation constraint remains enabled: model a stale predecessor
  // after a later generation completed, rather than fabricate two active rows.
  const f=await fixture('447700900021');await db.shop.update({where:{id:f.shop.id},data:{platform:'WOOCOMMERCE'}});await db.checkoutRecovery.create({data:{shopId:f.shop.id,checkoutToken:f.r.checkoutToken,generation:f.r.generation+1,status:'COMPLETED',completedAt:new Date(),lastExternalActivityAt:new Date()}});
  expect((await resolveSenderInbound(db,event(f.sender.canonicalRecipient))).kind).toBe('routing');expect((await owner(event(f.sender.canonicalRecipient,f.m.providerMessageId))).mode).toBe('historical');expect(await canProcessConversation(db,f.c.id)).toBe(false);
 });
 it('actual router respects inactive shop before transcript effects',async()=>{
  const f=await fixture('447700900022'),service=new RecoveryRoutingService(db,{isShopExecutionActive:async()=>false},{resolveSender:async()=>{throw Error('singleton forbidden');}}),incoming=event(f.sender.canonicalRecipient,f.m.providerMessageId);
  expect(await service.resolveInboundMessage(incoming)).toEqual({kind:'ignored'});expect(await db.conversationMessage.count({where:{providerMessageId:incoming.providerMessageId}})).toBe(0);
 });
 it('actual historical quote pipeline cannot schedule commerce or refresh expired activity',async()=>{
  const f=await fixture('447700900023');await db.checkoutRecovery.update({where:{id:f.r.id},data:{status:'EXPIRED',expiredAt:new Date()}});await f.pool.release(f.c.id);
  const router=new RecoveryRoutingService(db,{isShopExecutionActive:async()=>true},{resolveSender:async()=>{throw Error('singleton forbidden');}}),enqueue=vi.fn(),incoming=event(f.sender.canonicalRecipient,f.m.providerMessageId);
  await processRoutedInboundMessage(incoming,{},createLogger({serviceName:'fixture',environment:'test',sink:()=>{}}),enqueue,{router,conversation:conversationService,stop:{handleInbound:async()=>false},abuse:{admitRaw:async()=>({kind:'allowed' as const})},reachability:{fromRoutedInbound:async()=>{}}});
  expect(enqueue).not.toHaveBeenCalled();expect((await db.conversation.findUniqueOrThrow({where:{id:f.c.id}})).inboundVersion).toBe(0);expect((await db.checkoutRecovery.findUniqueOrThrow({where:{id:f.r.id}})).lastExternalActivityAt).toEqual(past);expect(await db.conversationMessage.count({where:{providerMessageId:incoming.providerMessageId}})).toBe(1);
 });
 it('a failed earlier quoted witness does not mask a valid later authenticated contact',async()=>{
  const f=await fixture('447700900024');await db.conversationMessage.update({where:{id:f.m.id},data:{status:'SENT',deliveredAt:null}});
  const quoted=async()=>db.conversationMessage.create({data:{conversationId:f.c.id,direction:'OUTBOUND',senderType:'AGENT',status:'SENT',content:'basket answer',providerMessageId:randomUUID(),sentAt:past,providerDispatchKey:randomUUID(),providerDispatchAdmittedAt:past,providerDispatchControlRevision:0,dispatchProviderAccountId:account,dispatchProviderPhoneNumberId:phone}});
  const first=await quoted(),firstEvent=event(f.sender.canonicalRecipient,first.providerMessageId),firstOwner=await owner(firstEvent);await persistVerifiedInbound(db,firstEvent,firstOwner.evidence,'active');await db.conversationMessage.update({where:{id:first.id},data:{status:'FAILED',failedAt:new Date()}});
  const second=await quoted(),secondEvent=event(f.sender.canonicalRecipient,second.providerMessageId),secondOwner=await owner(secondEvent);await persistVerifiedInbound(db,secondEvent,secondOwner.evidence,'active');expect(await canProcessConversation(db,f.c.id)).toBe(true);expect((await owner(event(f.sender.canonicalRecipient))).evidence.conversationId).toBe(f.c.id);
 });

});
