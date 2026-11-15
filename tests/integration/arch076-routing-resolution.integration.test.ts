import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type RecoveryBasketRoutingTurn } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WhatsAppInboundEvent } from '../../src/integration/whatsapp/types.js';
import { RecoverySenderPoolService } from '../../src/services/recovery-sender-pool/sender-pool.service.js';
import { persistRoutingHandoff, type RoutingPersistencePolicy } from '../../src/services/recovery-sender-pool/routing-handoff.js';
import {
  admitRoutingDecision,
  deleteRoutingRetentionCohort,
  fingerprint,
  freezeRoutingDecision,
  readRoutingCandidates,
  routingMessageId,
  type FrozenRoutingDecision,
  type RoutingAllowedAssessment,
  type RoutingCandidate,
} from '../../src/services/recovery-sender-pool/routing-store.js';
import {
  latestRoutingObjective,
  projectRoutingHistory,
  readRoutingHistoryProjection,
} from '../../src/services/recovery-sender-pool/routing-projection.js';
import { sha256 } from '../../src/services/recovery-multipart/frozen.js';
import { moderationConfig } from '../../src/services/conversation-moderation/moderation-policy.js';
import { RoutingRuntime } from '../../src/services/recovery-sender-pool/routing-runtime.js';
import type { RoutingPolicySnapshot } from '../../src/services/recovery-sender-pool/routing-policy.js';
import { readRoutingPrompt } from '../../src/services/recovery-sender-pool/routing-prompt.js';
import { digest, stableJson } from '../../src/services/conversation-wrappers/projection.js';
import type { SenderHandoff } from '../../src/services/recovery-sender-pool/inbound-authority.js';

const suite = process.env.MODA_DISPOSABLE_INTEGRATION === '1' && process.env.TEST_DATABASE_URL
  ? describe : describe.skip;

suite('ARCH076 R15 frozen routing association', () => {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
  const providerAccountId = '92001', providerPhoneNumberId = '82001';
  let senderConfigurationId: string, policy: RoutingPersistencePolicy;
  let serial = 100;

  beforeAll(async () => {
    const sender = await db.platformConfiguration.upsert({
      where: { environment_key: { environment: 'test', key: 'messaging.sender' } },
      create: { environment: 'test', key: 'messaging.sender', value: { fixture: true } },
      update: {},
    });
    senderConfigurationId = sender.id;
    const configured = await db.platformConfiguration.upsert({
      where: { environment_key: { environment: 'test', key: 'recovery.routingAgent' } },
      create: { environment: 'test', key: 'recovery.routingAgent', value: { fixture: true } },
      update: {},
    });
    policy = {
      rowId: configured.id, version: configured.version, environment: 'test',
      decisionTTLms: 600_000, retentionMs: 1_200_000,
      configurationSnapshot: { schemaVersion: 1, rowId: configured.id, version: configured.version, prompt: { revisionId: 'fixture-router-prompt', contentHash: sha256('neutral router') } },
    };
    await db.backgroundRuntimeConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', checkoutRecoveryLifetimeDays: 30 },
      update: { checkoutRecoveryLifetimeDays: 30 },
    });
    await db.whatsAppPoolSender.create({ data: {
      providerPhoneNumberId, providerAccountId,
      verifiedAt: new Date(Date.now() - 5000), allocationEnabled: true,
    } });
  });
  afterAll(() => db.$disconnect());

  async function createBasket(recipient: string, shopId?: string) {
    const shop = shopId ? await db.shop.findUniqueOrThrow({ where: { id: shopId } })
      : await db.shop.create({ data: { domain: `${randomUUID()}.routing.test` } });
    const past = new Date(Date.now() - 2000);
    const recovery = await db.checkoutRecovery.create({ data: {
      shopId: shop.id, checkoutToken: randomUUID(), status: 'MESSAGE_SENT',
      lastExternalActivityAt: past, currency: 'USD', totalPrice: 42,
      lineItems: [{ title: 'Running shoes', quantity: 1 }],
    } });
    const conversation = await db.conversation.create({ data: {
      shopId: shop.id, checkoutRecoveryId: recovery.id, type: 'RECOVERY',
    } });
    const pool = new RecoverySenderPoolService(db, () => new Date(), async () => ({
      rowId: senderConfigurationId, version: 1, environment: 'test', accountId: providerAccountId,
    }));
    const assignment = await pool.allocate({ conversationId: conversation.id, canonicalRecipient: recipient });
    if (assignment.kind !== 'assigned') throw new Error('fixture sender allocation unavailable');
    const delivered = await db.conversationMessage.create({ data: {
      conversationId: conversation.id, direction: 'OUTBOUND', senderType: 'AUTOMATION',
      status: 'DELIVERED', content: 'Confirmed recovery reminder', providerMessageId: randomUUID(),
      sentAt: past, deliveredAt: past, providerDispatchKey: randomUUID(),
      providerDispatchAdmittedAt: past, providerDispatchControlRevision: 0,
      dispatchProviderAccountId: providerAccountId, dispatchProviderPhoneNumberId: providerPhoneNumberId,
    } });
    await db.recoveryOutreachAttempt.create({ data: {
      checkoutRecoveryId: recovery.id, sequence: 1, recipient, trigger: 'INITIAL',
      configuredOfferMode: 'NONE', status: 'WAITING_FOR_RESPONSE', sentAt: past,
      outboundMessageId: delivered.id,
    } });
    return { shop, recovery, conversation, sender: assignment.sender, pool };
  }

  async function fixture() {
    expect(serial).toBeLessThanOrEqual(199);
    const recipient = `14155550${serial++}`;
    const first = await createBasket(recipient);
    const second = await createBasket(recipient, first.shop.id);
    const foreign = await createBasket(recipient);
    const scope: SenderHandoff = {
      providerAccountId, providerPhoneNumberId, canonicalRecipient: recipient,
      threadId: first.sender.threadId, routeId: null,
    };
    return { recipient, first, second, foreign, scope };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function inbound(f: Fixture, text: string, contextMessageId: string | null = null): WhatsAppInboundEvent {
    return {
      schemaVersion: 1, provider: 'whatsapp', providerAccountId, providerPhoneNumberId,
      providerMessageId: randomUUID(), customerPhone: f.recipient, contextMessageId,
      occurredAt: new Date().toISOString(), content: { type: 'text', text },
    };
  }
  const current = async (tx: Prisma.TransactionClient) => !!(await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM public."PlatformConfiguration" WHERE id=$1 AND version=$2 FOR SHARE`, policy.rowId, policy.version,
  ))[0];
  function assessment(text: string): RoutingAllowedAssessment {
    return {
      id: randomUUID(), hash: sha256(text), policyVersion: moderationConfig().policyVersion,
      requestedModel: 'fixture-moderation', returnedModel: 'fixture-moderation',
      operationRows: [{ id: policy.rowId, version: policy.version }],
      categories: {}, scores: {}, providerRequestId: `moderation-${randomUUID()}`,
    };
  }
  async function persist(f: Fixture, text: string, scope = f.scope, quote: string | null = null) {
    const event = inbound(f, text, quote);
    const result = await persistRoutingHandoff(db, event, scope, policy);
    if (result.kind !== 'persisted') throw new Error('fixture handoff not persisted');
    return { event, row: result.turn };
  }
  function decision(
    row: RecoveryBasketRoutingTurn,
    candidates: RoutingCandidate[],
    originalText: string,
    overrides: Partial<FrozenRoutingDecision> = {},
  ): FrozenRoutingDecision {
    const event = row.inputJson as unknown as WhatsAppInboundEvent;
    const currentText = event.content.type === 'text' ? event.content.text : '';
    return {
      schemaVersion: 1, role: 'CLARIFY', currentInboundProviderMessageId: row.inboundProviderMessageId,
      originalTurnId: null, originalInboundProviderMessageId: null,
      promptTurnId: null, confirmedPromptProviderMessageId: null,
      selectedAssignmentConversationId: null, offeredOptionKey: null,
      candidateFingerprint: fingerprint(candidates), originalTextSha256: sha256(originalText),
      currentTextSha256: sha256(currentText),
      associatedMessages: {
        originalMessageId: routingMessageId(row.inboundProviderMessageId),
        currentMessageId: routingMessageId(row.inboundProviderMessageId),
      },
      clause: null, controlRevision: null,
      configuration: policy.configurationSnapshot,
      template: { definitionId: 'fixture-router', localeId: 'fixture-en', preparedHash: sha256('neutral router') },
      ...overrides,
    };
  }
  async function freeze(
    row: RecoveryBasketRoutingTurn,
    candidates: RoutingCandidate[],
    value: FrozenRoutingDecision,
    originalAssessment: RoutingAllowedAssessment,
    routeId: string | null,
    parentId: string | null = null,
    clauseAssessment?: RoutingAllowedAssessment,
    currentAssessment?: RoutingAllowedAssessment,
  ) {
    const event = row.inputJson as unknown as WhatsAppInboundEvent;
    const fullText = event.content.type === 'text' ? event.content.text : '';
    const currentAllowed = currentAssessment ?? (originalAssessment.hash === sha256(fullText) ? originalAssessment : assessment(fullText));
    const assessments = { original: originalAssessment, current: currentAllowed,
      ...(clauseAssessment ? { clause: clauseAssessment } : {}) };
    value.assessments = assessments as unknown as Prisma.InputJsonObject;
    value.audioCurrent = null;
    value.audioOriginal = null;
    value.moderation ??= {
      original: { id: originalAssessment.id, hash: originalAssessment.hash },
      current: { id: currentAllowed.id, hash: currentAllowed.hash },
      clause: clauseAssessment ? { id: clauseAssessment.id, hash: clauseAssessment.hash } : null,
    };
    const moderation = { schemaVersion: 1, current: currentAllowed };
    // Capture only this authentic input before classification; decision metadata
    // later references these frozen assessments without rewriting the snapshot.
    await db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: row.inboundProviderMessageId },
      data: { moderationJson: moderation as unknown as Prisma.InputJsonObject } });
    return freezeRoutingDecision(db, row.inboundProviderMessageId, {
      decision: value, candidates,
      moderation: moderation as unknown as Prisma.InputJsonValue,
      parentId, routeId,
    }, current);
  }
  async function confirmPrompt(row: RecoveryBasketRoutingTurn, scopeRouteId: string | null) {
    const at = new Date(), providerId = `confirmed-prompt-${randomUUID()}`;
    await db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: row.inboundProviderMessageId }, data: {
      state: 'PROMPT_ADMITTED', promptText: 'Choose the original request and basket from these saved options.',
      promptScopeRouteId: scopeRouteId, promptAdmittedAt: at, promptSentAt: at,
      promptProviderMessageId: providerId,
    } });
    return providerId;
  }

  /** Three independent authentic inputs, with both children pointing directly at Q1. */
  async function star(text = 'running shoes', role: 'SELECT_ONLY' | 'SELECT_AND_QUESTION' = 'SELECT_ONLY', changeDecision?: (value: FrozenRoutingDecision, context: { q1: string; q2: string; foreignRoute: string }) => FrozenRoutingDecision, sharedFixture?: Fixture) {
    const f = sharedFixture ?? await fixture();
    const originalText = 'Can it arrive Friday?';
    const q1 = await persist(f, originalText);
    const all = await readRoutingCandidates(db, f.scope);
    const originalAssessment = assessment(originalText);
    const q1Decision = decision(q1.row, all, originalText);
    await freeze(q1.row, all, q1Decision, originalAssessment, null);
    const neutralReceipt = await confirmPrompt(q1.row, null);
    const knownScope = { ...f.scope, routeId: f.first.sender.routeId };
    const q2 = await persist(f, '1', knownScope, neutralReceipt);
    const baskets = await readRoutingCandidates(db, knownScope);
    const q2Decision = decision(q2.row, baskets, originalText, {
      originalTurnId: q1.row.inboundProviderMessageId,
      originalInboundProviderMessageId: q1.row.inboundProviderMessageId,
      promptTurnId: q1.row.inboundProviderMessageId,
      confirmedPromptProviderMessageId: neutralReceipt,
    });
    await freeze(q2.row, baskets, q2Decision, originalAssessment, knownScope.routeId, q1.row.inboundProviderMessageId);
    const basketReceipt = await confirmPrompt(q2.row, knownScope.routeId);
    const q3 = await persist(f, text, knownScope, basketReceipt);
    const selected = role === 'SELECT_AND_QUESTION' ? baskets[1]! : baskets.find(candidate => candidate.conversationId === f.first.conversation.id)!;
    const clause = role === 'SELECT_AND_QUESTION'
      ? { start: text.indexOf('Can I'), end: text.length, sha256: sha256(text.slice(text.indexOf('Can I'))) }
      : null;
    const clauseAssessment = clause ? assessment(text.slice(clause.start, clause.end)) : undefined;
    const currentAssessment = assessment(text);
    let q3Decision = decision(q3.row, baskets, originalText, {
      role, originalTurnId: q1.row.inboundProviderMessageId,
      originalInboundProviderMessageId: q1.row.inboundProviderMessageId,
      promptTurnId: q2.row.inboundProviderMessageId,
      confirmedPromptProviderMessageId: basketReceipt,
      selectedAssignmentConversationId: selected.conversationId, offeredOptionKey: selected.optionKey,
      controlRevision: selected.controlRevision,
      associatedMessages: {
        originalMessageId: routingMessageId(q1.row.inboundProviderMessageId),
        currentMessageId: routingMessageId(q3.row.inboundProviderMessageId),
      },
      clause,
      moderation: {
        original: { id: originalAssessment.id, hash: originalAssessment.hash },
        current: { id: currentAssessment.id, hash: currentAssessment.hash },
        clause: clauseAssessment ? { id: clauseAssessment.id, hash: clauseAssessment.hash } : null,
      },
    });
    if (changeDecision) q3Decision = changeDecision(q3Decision, { q1: q1.event.providerMessageId, q2: q2.event.providerMessageId, foreignRoute: f.foreign.sender.routeId });
    await freeze(q3.row, baskets, q3Decision, originalAssessment, knownScope.routeId, q1.row.inboundProviderMessageId, clauseAssessment, currentAssessment);
    const assessments = { original: originalAssessment, current: currentAssessment, ...(clauseAssessment ? { clause: clauseAssessment } : {}) };
    return { f, originalText, q1, q2, q3, q1Decision, q2Decision, q3Decision, baskets, selected, assessments, knownScope };
  }

  it.each(['TEXT', 'AUDIO', 'AUDIO_FOREIGN', 'AUDIO_SOURCE_TAMPER', 'AUDIO_NEW'] as const)('runs actual %s accept/process through shop and basket clarification exactly once', async mode => {
    const f = await fixture();
    const admin = await db.platformAdmin.create({ data: { email: `${randomUUID()}@example.test`, role: 'SUPER_ADMIN' } });
    const prepared = {
      schemaVersion: 1, family: 'MODA_CONVERSATION_WRAPPER', responseSlot: 'response.body',
      header: [{ kind: 'text', value: 'Choose the saved request and basket.' }],
      body: [{ kind: 'responseSlot', name: 'response.body' }], footer: [], conditionals: [],
    };
    const definition = await db.whatsAppTemplateDefinition.create({ data: {
      kind: 'MODA_CONVERSATION_WRAPPER', audience: 'ROUTER', sourceLanguageTag: 'en',
      astSchemaVersion: 1, sourceHash: sha256(randomUUID()), status: 'PUBLISHED',
      publishedAt: new Date(), createdByAdminId: admin.id,
    } });
    await db.whatsAppTemplateLocale.create({ data: {
      definitionId: definition.id, languageTag: 'en', status: 'SOURCE_SAVED',
      contentHash: digest(stableJson(prepared)), localeAst: { schemaVersion: 1, prepared },
    } });
    await db.whatsAppConversationWrapperActiveSlot.upsert({
      where: { audience: 'ROUTER' },
      create: { audience: 'ROUTER', definitionId: definition.id, editVersion: 1, updatedByAdminId: admin.id },
      update: { definitionId: definition.id, editVersion: { increment: 1 }, updatedByAdminId: admin.id },
    });
    const snapshot: RoutingPolicySnapshot = {
      ...policy, verifiedShopId: null, commerceEnvironment: 'TEST', model: null,
      prompt: { revisionId: 'fixture-router-prompt', contentHash: sha256('neutral router'), promptText: 'Choose exactly.' },
      policy: {
        schemaVersion: 1, enabled: true, modelBinding: { kind: 'VERIFIED_SHOP_INHERIT' },
        promptRevisionId: 'fixture-router-prompt', wrapperAudience: 'ROUTER', confidenceThreshold: 90,
        budget: { deadlineMs: 30000, outputTokens: 1000, toolCalls: 0 },
        retry: { maxAttempts: 3, backoffMs: 1000 },
        input: { maxHistoryMessages: 20, maxInputCharacters: 100000, maxCandidates: 20 },
        decisionTTLms: policy.decisionTTLms, retentionMs: policy.retentionMs,
      },
    };
    const isAudio = mode !== 'TEXT';
    const transcript = '🛒 2 cafe\u0301. Can I collect on Saturday?';
    const audio = vi.fn(async (event: WhatsAppInboundEvent, _scope: SenderHandoff, sourceSha256: string) => {
      if (event.content.type !== 'audio') throw new Error('fixture audio required');
      return { text: transcript, provenance: {
        schemaVersion: 1 as const, verified: true as const, sourceSha256: mode === 'AUDIO_SOURCE_TAMPER' ? '0'.repeat(64) : sourceSha256,
        providerMessageId: mode === 'AUDIO_FOREIGN' ? randomUUID() : event.providerMessageId,
        mediaIdSha256: sha256(event.content.mediaId), mediaSha256: sha256('fixture audio bytes'),
        transcriptSha256: sha256(transcript), provider: 'openai', model: 'fixture-transcription', durationMs: 1200,
        operationRows: [{ id: policy.rowId, version: policy.version }],
      } };
    });
    let q1Id = '', q2Id = '';
    const classify = vi.fn(async (input: import('../../src/services/recovery-sender-pool/routing-classifier.js').RoutingClassifierInput) => {
      const candidate = input.candidates.find(c => c.conversationId === f.first.conversation.id)!;
      const prompt = input.prompts.find(p => p.turnId === q2Id)!;
      return { kind: 'decision' as const, decision: {
        role: mode === 'AUDIO_NEW' ? 'NEW_QUESTION' as const : mode === 'AUDIO' ? 'SELECT_AND_QUESTION' as const : 'SELECT_ONLY' as const, confidence: 100,
        originalTurnId: mode === 'AUDIO_NEW' ? null : q1Id, promptTurnId: mode === 'AUDIO_NEW' ? null : q2Id,
        confirmedPromptProviderMessageId: mode === 'AUDIO_NEW' ? null : prompt.confirmedProviderMessageId,
        selectedConversationId: candidate.conversationId, selectedRouteId: candidate.routeId,
        offeredOptionKey: mode === 'AUDIO_NEW' ? null : candidate.optionKey, newQuestionClause: mode === 'AUDIO' ? { start: transcript.indexOf('Can I'), end: transcript.length } : null,
      } };
    });
    const sendPrompt = vi.fn(async (_database: PrismaClient, input: { turnId: string; prompt: { body: string } }) => {
      const row = await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: input.turnId } });
      const providerMessageId = await confirmPrompt(row, row.routeId);
      return { kind: 'sent' as const, providerMessageId };
    });
    const runtime = new RoutingRuntime(db, {
      readPolicy: async () => snapshot, currentPolicy: async tx => { if (!await current(tx)) throw new Error('missing policy'); },
      classify, audio, moderate: async text => assessment(text), readPrompt: readRoutingPrompt,
      sendPrompt, shopActive: async () => true,
      senderSnapshot: async () => ({ rowId: senderConfigurationId, version: 1, environment: 'test', providerAccountId, providerPhoneNumberId }),
    });
    const enqueue = vi.fn(async () => undefined);
    if (mode === 'AUDIO_NEW') {
      const direct = inbound(f, '');
      direct.content = { type: 'audio', mediaId: randomUUID(), mimeType: 'audio/ogg', sha256: null, voice: true };
      const scope = { ...f.scope, routeId: f.first.sender.routeId };
      expect(await runtime.accept(direct, scope, enqueue)).toMatchObject({ kind: 'admitted', conversationId: f.first.conversation.id });
      const turn = await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: direct.providerMessageId } });
      const frozen = turn.routingDecision as FrozenRoutingDecision;
      expect(turn.parentProviderMessageId).toBeNull();
      expect(frozen).toMatchObject({ role: 'NEW_QUESTION', originalInboundProviderMessageId: null, originalTurnId: null });
      expect(frozen.associatedMessages.originalMessageId).toBe(frozen.associatedMessages.currentMessageId);
      expect(frozen.audioOriginal).toEqual(frozen.audioCurrent);
      expect(frozen.audioOriginal).toMatchObject({ verified: true, providerMessageId: direct.providerMessageId });
      const message = await db.conversationMessage.findUniqueOrThrow({ where: { providerMessageId: direct.providerMessageId } });
      expect(message).toMatchObject({ conversationId: f.first.conversation.id, content: transcript,
        contentType: 'AUDIO', transcriptionStatus: 'COMPLETED' });
      const reviews = await db.conversationModerationAssessment.findMany({ where: { conversationMessageId: message.id } });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ inputKind: 'TRANSCRIPT', decision: 'ALLOW', contentSha256: sha256(transcript) });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(await runtime.accept(direct, scope, enqueue)).toMatchObject({ kind: 'terminal' });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(audio).toHaveBeenCalledTimes(1);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(sendPrompt).not.toHaveBeenCalled();
      return;
    }
    const q1 = inbound(f, 'Can it arrive Friday?'); q1Id = q1.providerMessageId;
    expect(await runtime.accept(q1, f.scope, enqueue)).toMatchObject({ kind: 'sent' });
    const original = await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: q1Id } });
    const options = original.candidatesJson as unknown as RoutingCandidate[];
    const shopOption = [...new Set(options.map(c => c.routeId))].indexOf(f.first.sender.routeId) + 1;
    const q2 = inbound(f, `${q1Id}:${shopOption}`, original.promptProviderMessageId); q2Id = q2.providerMessageId;
    expect(await runtime.accept(q2, f.scope, enqueue)).toMatchObject({ kind: 'sent' });
    expect(classify).not.toHaveBeenCalled();
    const shopChoice = await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: q2Id } });
    expect(shopChoice.routeId).toBe(f.first.sender.routeId);
    const q3 = inbound(f, 'the running shoes', shopChoice.promptProviderMessageId);
    if (isAudio) q3.content = { type: 'audio', mediaId: randomUUID(), mimeType: 'audio/ogg', sha256: null, voice: true }; 
    if (mode === 'AUDIO_FOREIGN' || mode === 'AUDIO_SOURCE_TAMPER') {
      const reason = mode === 'AUDIO_FOREIGN' ? 'routing-current-moderation-invalid' : 'routing-audio-source-changed';
      expect(await runtime.accept(q3, { ...f.scope, routeId: f.first.sender.routeId }, enqueue)).toEqual({ kind: 'held', reason });
      expect(await runtime.process(q3.providerMessageId, enqueue)).toEqual({ kind: 'held', reason });
      expect(audio).toHaveBeenCalledTimes(1);
      expect(classify).not.toHaveBeenCalled();
      expect(sendPrompt).toHaveBeenCalledTimes(2);
      expect(enqueue).not.toHaveBeenCalled();
      expect(await db.conversationMessage.count({ where: { providerMessageId: { in: [q1Id, q2Id, q3.providerMessageId] } } })).toBe(0);
      return;
    }
    expect(await runtime.accept(q3, { ...f.scope, routeId: f.first.sender.routeId }, enqueue)).toMatchObject({ kind: 'admitted', conversationId: f.first.conversation.id });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await runtime.accept(q3, { ...f.scope, routeId: f.first.sender.routeId }, enqueue)).toMatchObject({ kind: 'terminal' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await db.conversationMessage.count({ where: { providerMessageId: q2Id } })).toBe(0);
    const messages = await db.conversationMessage.findMany({ where: { conversationId: f.first.conversation.id, direction: 'INBOUND' } });
    const projected = projectRoutingHistory(messages, await readRoutingHistoryProjection(f.first.conversation.id, db));
    expect(latestRoutingObjective(projected).map(message => message.content)).toEqual(mode === 'AUDIO'
      ? ['Can it arrive Friday?', 'Can I collect on Saturday?'] : ['Can it arrive Friday?']);
    expect(audio).toHaveBeenCalledTimes(mode === 'AUDIO' ? 1 : 0);
    if (mode === 'AUDIO') {
      const voice = messages.find(message => message.providerMessageId === q3.providerMessageId)!;
      expect(voice).toMatchObject({ content: transcript, contentType: 'AUDIO', transcriptionStatus: 'COMPLETED',
        transcriptionProvider: 'openai', transcriptionModel: 'fixture-transcription', mediaDurationMs: 1200 });
      const reviews = await db.conversationModerationAssessment.findMany({ where: { conversationMessageId: voice.id } });
      expect(reviews).toHaveLength(2);
      expect(reviews.every(review => review.inputKind === 'TRANSCRIPT' && review.decision === 'ALLOW')).toBe(true);
      expect(reviews.map(review => review.contentSha256).sort()).toEqual([sha256(transcript), sha256('Can I collect on Saturday?')].sort());
    }
  });

  it('unknown-shop Q1 → shop Q2 → basket Q3 admits the exact original once and preserves star evidence', async () => {
    const s = await star();
    expect(await db.conversationMessage.count({ where: { providerMessageId: { in: [s.q1.event.providerMessageId, s.q2.event.providerMessageId, s.q3.event.providerMessageId] } } })).toBe(0);
    const result = await admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current);
    expect(result).toMatchObject({ kind: 'admitted', conversationId: s.selected.conversationId, version: 1 });
    const [original, shopChoice, selection] = await Promise.all([s.q1, s.q2, s.q3].map(q => db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: q.event.providerMessageId } })));
    expect(original).toMatchObject({ state: 'RESOLVED', selectedConversationId: s.selected.conversationId, resolutionInboundProviderMessageId: s.q3.event.providerMessageId });
    expect(original.routingDecision).toEqual(s.q1Decision);
    expect(shopChoice.routingDecision).toEqual(s.q2Decision);
    expect(shopChoice.parentProviderMessageId).toBe(s.q1.event.providerMessageId);
    expect(selection.parentProviderMessageId).toBe(s.q1.event.providerMessageId);
    expect(selection.routingDecision).toEqual(s.q3Decision);
    expect(selection).toMatchObject({ state: 'RESOLVED', selectedConversationId: s.selected.conversationId, resolutionInboundProviderMessageId: s.q3.event.providerMessageId });
    const messages = await db.conversationMessage.findMany({ where: { conversationId: s.selected.conversationId, direction: 'INBOUND' }, orderBy: { createdAt: 'asc' } });
    expect(messages.map(message => message.content)).toEqual([s.originalText, 'running shoes']);
    expect(messages.map(message => message.providerMessageId)).toEqual([s.q1.event.providerMessageId, s.q3.event.providerMessageId]);
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q2.event.providerMessageId } })).toBe(0);
    expect(await db.conversation.count({ where: { checkoutRecoveryId: s.f.first.recovery.id } })).toBe(1);
    expect(await db.conversationAllowanceBlock.count({ where: { conversationId: s.selected.conversationId } })).toBe(0);
    const projected = projectRoutingHistory(messages, await readRoutingHistoryProjection(s.selected.conversationId, db));
    expect(latestRoutingObjective(projected).map(message => message.content)).toEqual([s.originalText]);
  });

  it('SELECT_AND_QUESTION retains exact authenticated selection text, but projects only the independently moderated clause', async () => {
    const text = '2. Can I collect on Saturday?';
    const s = await star(text, 'SELECT_AND_QUESTION');
    await admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current);
    const messages = await db.conversationMessage.findMany({ where: { conversationId: s.selected.conversationId, direction: 'INBOUND' } });
    expect(messages.find(message => message.providerMessageId === s.q3.event.providerMessageId)?.content).toBe(text);
    const projected = projectRoutingHistory(messages, await readRoutingHistoryProjection(s.selected.conversationId, db));
    expect(latestRoutingObjective(projected).map(message => message.content)).toEqual([s.originalText, 'Can I collect on Saturday?']);
    const frozen = JSON.stringify((await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: s.q3.event.providerMessageId } })).routingDecision);
    expect(frozen).not.toContain(text);
    expect(frozen).not.toContain('Can I collect on Saturday?');
    const clauseMessage = messages.find(message => message.providerMessageId === s.q3.event.providerMessageId)!;
    expect(await db.conversationModerationAssessment.findFirst({ where: { conversationMessageId: clauseMessage.id } })).toMatchObject({ contentSha256: sha256('Can I collect on Saturday?'), decision: 'ALLOW' });
  });

  it('preserves UTF-16 clause offsets after emoji and combining characters', async () => {
    const text = '🛒 2 cafe\u0301. Can I collect on Saturday?';
    const s = await star(text, 'SELECT_AND_QUESTION');
    expect(s.q3Decision.clause?.start).toBe(text.indexOf('Can I'));
    expect(s.q3Decision.clause?.start).toBeGreaterThan(Array.from(text.slice(0, text.indexOf('Can I'))).length);
    await admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current);
    const messages = await db.conversationMessage.findMany({ where: { conversationId: s.selected.conversationId, direction: 'INBOUND' } });
    expect(messages.find(message => message.providerMessageId === s.q3.event.providerMessageId)?.content).toBe(text);
    const projected = projectRoutingHistory(messages, await readRoutingHistoryProjection(s.selected.conversationId, db));
    expect(latestRoutingObjective(projected).map(message => message.content)).toEqual([s.originalText, 'Can I collect on Saturday?']);
    const full = await db.conversationModerationAssessment.findUniqueOrThrow({ where: { id: s.assessments.current.id } });
    expect(full).toMatchObject({ decision: 'ALLOW', contentSha256: sha256(text) });
    const clause = await db.conversationModerationAssessment.findUniqueOrThrow({ where: { id: s.assessments.clause!.id } });
    expect(clause).toMatchObject({ decision: 'ALLOW', contentSha256: sha256('Can I collect on Saturday?') });
  });

  it('crash after decision freeze and duplicate replay cannot readmit or choose a different basket', async () => {
    const s = await star();
    const restored = await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: s.q3.event.providerMessageId } });
    expect(restored.routingDecision).toEqual(s.q3Decision);
    expect((await admitRoutingDecision(db, restored.inboundProviderMessageId, s.assessments, current)).kind).toBe('admitted');
    expect(await admitRoutingDecision(db, restored.inboundProviderMessageId, s.assessments, async () => false)).toMatchObject({ kind: 'replay', conversationId: s.selected.conversationId });
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q1.event.providerMessageId } })).toBe(1);
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q3.event.providerMessageId } })).toBe(1);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: s.selected.conversationId } })).inboundVersion).toBe(1);
  });

  it('concurrent identical resolution attempts have one admission and one durable replay', async () => {
    const s = await star();
    const results = await Promise.all([
      admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current),
      admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current),
    ]);
    expect(results.map(result => result.kind).sort()).toEqual(['admitted', 'replay']);
    expect(await db.conversationMessage.count({ where: { conversationId: s.selected.conversationId, direction: 'INBOUND' } })).toBe(2);
  });

  it('two simultaneous selection children cannot resolve the same original twice', async () => {
    const s = await star();
    const second = await persist(s.f, 'running shoes', s.knownScope, s.q3.event.contextMessageId);
    const secondDecision: FrozenRoutingDecision = {
      ...s.q3Decision,
      currentInboundProviderMessageId: second.event.providerMessageId,
      associatedMessages: {
        originalMessageId: routingMessageId(s.q1.event.providerMessageId),
        currentMessageId: routingMessageId(second.event.providerMessageId),
      },
    };
    await freeze(second.row, s.baskets, secondDecision, s.assessments.original,
      s.knownScope.routeId, s.q1.event.providerMessageId, undefined, s.assessments.current);
    const results = await Promise.allSettled([
      admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current),
      admitRoutingDecision(db, second.event.providerMessageId, s.assessments, current),
    ]);
    const admitted = results.filter(result => result.status === 'fulfilled' && result.value.kind === 'admitted');
    expect(admitted).toHaveLength(1);
    const refused = results.find(result => result.status === 'rejected');
    expect(refused?.status).toBe('rejected');
    if (refused?.status === 'rejected') expect(String(refused.reason)).toContain('ROUTING_ORIGINAL_STALE');
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q1.event.providerMessageId } })).toBe(1);
  });

  it('an independent NEW_QUESTION admits only itself and leaves an older original pending', async () => {
    const f = await fixture(), original = await persist(f, 'Can it arrive Friday?');
    const scoped = { ...f.scope, routeId: f.first.sender.routeId };
    const baskets = await readRoutingCandidates(db, scoped);
    await freeze(original.row, baskets, decision(original.row, baskets, 'Can it arrive Friday?'), assessment('Can it arrive Friday?'), null);
    const currentQuestion = await persist(f, 'Do the shoes come in black?', scoped);
    const selected = baskets[0]!, allowed = assessment('Do the shoes come in black?');
    const value = decision(currentQuestion.row, baskets, 'Do the shoes come in black?', {
      role: 'NEW_QUESTION', selectedAssignmentConversationId: selected.conversationId,
      controlRevision: selected.controlRevision,
      moderation: { original: { id: allowed.id, hash: allowed.hash }, current: { id: allowed.id, hash: allowed.hash }, clause: null },
    });
    await freeze(currentQuestion.row, baskets, value, allowed, scoped.routeId);
    expect((await admitRoutingDecision(db, currentQuestion.event.providerMessageId, { original: allowed, current: allowed }, current)).kind).toBe('admitted');
    expect((await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: original.event.providerMessageId } })).state).toBe('RECEIVED');
    expect(await db.conversationMessage.count({ where: { providerMessageId: original.event.providerMessageId } })).toBe(0);
    expect((await db.conversationMessage.findUniqueOrThrow({ where: { providerMessageId: currentQuestion.event.providerMessageId } })).content).toBe('Do the shoes come in black?');
  });

  it('retains immutable original/candidate/config/parent evidence and forbids terminal payload resurrection', async () => {
    const s = await star();
    await expect(db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: s.q1.event.providerMessageId }, data: { inputJson: { changed: true } } })).rejects.toThrow('ROUTING_INPUT_SNAPSHOT_IMMUTABLE');
    await expect(db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: s.q3.event.providerMessageId }, data: { candidatesJson: [] } })).rejects.toThrow('ROUTING_INPUT_SNAPSHOT_IMMUTABLE');
    await expect(db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: s.q3.event.providerMessageId }, data: { configurationSnapshot: { replaced: true } } })).rejects.toThrow('ROUTING_CONFIGURATION_IMMUTABLE');
    await expect(db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: s.q3.event.providerMessageId }, data: { parentProviderMessageId: s.q2.event.providerMessageId } })).rejects.toThrow('ROUTING_PARENT_IMMUTABLE');
    await admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current);
    for (const q of [s.q1, s.q3]) {
      const terminal = await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: q.event.providerMessageId } });
      expect(terminal).toMatchObject({ inputJson: null, candidatesJson: null, moderationJson: null, promptText: null, workToken: null, nextRepairAt: null });
      await expect(db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: q.event.providerMessageId }, data: { inputJson: q.event as unknown as Prisma.InputJsonValue } })).rejects.toThrow();
    }
    await expect(db.recoveryBasketRoutingTurn.update({ where: { inboundProviderMessageId: s.q1.event.providerMessageId }, data: { selectedConversationId: s.f.second.conversation.id } })).rejects.toThrow();
  });

  it.each(['configuration', 'template'] as const)('changed %s before admission holds the frozen original without transcript side effects', async () => {
    const s = await star();
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, async () => false)).rejects.toThrow('ROUTING_CONFIGURATION_CHANGED');
    expect(await db.conversationMessage.count({ where: { providerMessageId: { in: [s.q1.event.providerMessageId, s.q3.event.providerMessageId] } } })).toBe(0);
    expect((await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: s.q1.event.providerMessageId } })).routingDecision).toEqual(s.q1Decision);
  });

  it('a forged confirmed prompt from another original cannot resolve Q1', async () => {
    const foreign = await star();
    const s = await star('running shoes', 'SELECT_ONLY', value => ({
      ...value, promptTurnId: foreign.q2.event.providerMessageId,
      confirmedPromptProviderMessageId: foreign.q3.event.contextMessageId,
    }), foreign.f);
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current))
      .rejects.toThrow('ROUTING_PROMPT_CHANGED');
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q1.event.providerMessageId } })).toBe(0);
  });

  it('a missing confirmed prompt receipt cannot admit a selected basket', async () => {
    const s = await star('running shoes', 'SELECT_ONLY', value => ({
      ...value, confirmedPromptProviderMessageId: 'unconfirmed-provider-receipt',
    }));
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current))
      .rejects.toThrow('ROUTING_PROMPT_CHANGED');
  });

  it('an offered option from another basket cannot be paired with a selected Conversation', async () => {
    const s = await star('running shoes', 'SELECT_ONLY', value => ({
      ...value, offeredOptionKey: 'not-an-offered-option',
    }));
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current))
      .rejects.toThrow('ROUTING_PROMPT_OPTION_CHANGED');
  });

  it('a changed assignment cannot bind its original to a newer same-shop basket', async () => {
    const s = await star();
    await db.checkoutRecovery.update({ where: { id: s.f.first.recovery.id }, data: { status: 'EXPIRED', expiredAt: new Date() } });
    await s.f.first.pool.release(s.f.first.conversation.id);
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current)).rejects.toThrow();
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q1.event.providerMessageId } })).toBe(0);
    expect((await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: s.q1.event.providerMessageId } })).selectedConversationId).toBeNull();
  });

  it('serializes actual last-member release against admission without a deadlock or foreign association', async () => {
    const f = await fixture();
    // Leave one real active assignment before freezing the exact offered set.
    for (const basket of [f.second, f.foreign]) {
      await db.checkoutRecovery.update({ where: { id: basket.recovery.id }, data: { status: 'EXPIRED', expiredAt: new Date() } });
      expect(await basket.pool.release(basket.conversation.id)).toBe('released');
    }
    const s = await star('running shoes', 'SELECT_ONLY', undefined, f);
    const release = async () => {
      await db.checkoutRecovery.update({ where: { id: f.first.recovery.id }, data: { status: 'EXPIRED', expiredAt: new Date() } });
      return f.first.pool.release(f.first.conversation.id);
    };
    const [admission, released] = await Promise.allSettled([
      admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current),
      release(),
    ]);
    expect(released.status).toBe('fulfilled');
    if (released.status === 'fulfilled') expect(released.value).toBe('released');
    const messages = await db.conversationMessage.findMany({ where: { providerMessageId: {
      in: [s.q1.event.providerMessageId, s.q2.event.providerMessageId, s.q3.event.providerMessageId],
    } } });
    if (admission.status === 'fulfilled') {
      expect(admission.value).toMatchObject({ kind: 'admitted', conversationId: f.first.conversation.id });
      expect(messages).toHaveLength(2);
      expect(messages.every(message => message.conversationId === f.first.conversation.id)).toBe(true);
    } else {
      // The release either removed the assignment first, or its terminal lifecycle
      // commit removed the basket from the live offered facts before association.
      expect(String(admission.reason)).toMatch(/ROUTING_CANDIDATE_(OWNER_CHANGED|FACTS_CHANGED)/);
      expect(messages).toHaveLength(0);
    }
    const assignment = await db.recoverySenderAssignment.findUniqueOrThrow({ where: { conversationId: f.first.conversation.id } });
    expect(assignment.releasedAt).not.toBeNull();
    expect((await db.recoverySenderRoute.findUniqueOrThrow({ where: { id: f.first.sender.routeId } })).closedAt).not.toBeNull();
    expect((await db.recoverySenderThread.findUniqueOrThrow({ where: { id: f.first.sender.threadId } })).closedAt).not.toBeNull();
    expect(await db.conversationMessage.count({ where: { direction: 'OUTBOUND', conversationId: f.first.conversation.id } })).toBe(1);
  });

  it('a human-mode interval preserves the original but invalidates its old control revision', async () => {
    const s = await star();
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe(`SELECT id FROM commerce."Shop" WHERE id=$1 FOR UPDATE`, s.f.first.shop.id);
      await tx.$queryRawUnsafe(`SELECT id FROM whatsapp."Conversation" WHERE id=$1 FOR UPDATE`, s.selected.conversationId);
      await tx.$executeRawUnsafe(`UPDATE whatsapp."Conversation" SET "controlMode"='HUMAN',"controlRevision"=1,"controlChangedAt"=statement_timestamp() WHERE id=$1`, s.selected.conversationId);
      await tx.conversationControlEvent.create({ data: {
        conversationId: s.selected.conversationId, fromMode: 'AI', toMode: 'HUMAN', fromRevision: 0, toRevision: 1,
      } });
    });
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current))
      .rejects.toThrow('ROUTING_CONTROL_CHANGED');
    expect((await db.recoveryBasketRoutingTurn.findUniqueOrThrow({ where: { inboundProviderMessageId: s.q1.event.providerMessageId } })).routingDecision).toEqual(s.q1Decision);
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe(`SELECT id FROM commerce."Shop" WHERE id=$1 FOR UPDATE`, s.f.first.shop.id);
      await tx.$queryRawUnsafe(`SELECT id FROM whatsapp."Conversation" WHERE id=$1 FOR UPDATE`, s.selected.conversationId);
      await tx.$executeRawUnsafe(`UPDATE whatsapp."Conversation" SET "controlMode"='AI',"controlRevision"=2,"controlChangedAt"=statement_timestamp() WHERE id=$1`, s.selected.conversationId);
      await tx.conversationControlEvent.create({ data: {
        conversationId: s.selected.conversationId, fromMode: 'HUMAN', toMode: 'AI', fromRevision: 1, toRevision: 2,
      } });
    });
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current))
      .rejects.toThrow('ROUTING_CONTROL_CHANGED');
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q1.event.providerMessageId } })).toBe(0);
  });

  it('candidate facts changed after freezing cannot resolve the stale offered basket', async () => {
    const s = await star();
    await db.checkoutRecovery.update({ where: { id: s.f.first.recovery.id }, data: {
      lineItems: [{ title: 'A different item', quantity: 3 }],
    } });
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current))
      .rejects.toThrow('ROUTING_CANDIDATE_FACTS_CHANGED');
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q1.event.providerMessageId } })).toBe(0);
  });

  it('a suspended shop cannot admit a previously frozen selection', async () => {
    const s = await star();
    await db.shop.update({ where: { id: s.f.first.shop.id }, data: { status: 'SUSPENDED' } });
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current))
      .rejects.toThrow('ROUTING_SHOP_INACTIVE');
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q1.event.providerMessageId } })).toBe(0);
  });

  it('disabled routing policy does not prevent privacy expiry and payload scrubbing', async () => {
    const f = await fixture();
    const pending = await persist(f, 'A private question awaiting clarification');
    const policyRead = vi.fn(async () => null);
    const enqueue = vi.fn(async () => undefined);
    const runtime = new RoutingRuntime(db, { readPolicy: policyRead },
      () => new Date(pending.row.expiresAt.getTime() + 1));
    await runtime.repairPass(enqueue);
    const expired = await db.recoveryBasketRoutingTurn.findUniqueOrThrow({
      where: { inboundProviderMessageId: pending.event.providerMessageId },
    });
    expect(policyRead).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(expired).toMatchObject({ state: 'EXPIRED', inputJson: null, candidatesJson: null,
      moderationJson: null, promptText: null });
    expect(await db.conversationMessage.count({ where: { providerMessageId: pending.event.providerMessageId } })).toBe(0);
  });

  it('expired original evidence cannot admit or refresh its recovery lifetime', async () => {
    const s = await star();
    const originalRecovery = await db.checkoutRecovery.findUniqueOrThrow({ where: { id: s.f.first.recovery.id } });
    const afterExpiry = new Date(s.q1.row.expiresAt.getTime() + 1);
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current, afterExpiry))
      .rejects.toThrow('ROUTING_ORIGINAL_STALE');
    expect((await db.checkoutRecovery.findUniqueOrThrow({ where: { id: originalRecovery.id } })).lastExternalActivityAt).toEqual(originalRecovery.lastExternalActivityAt);
  });

  it('a moderation hash change cannot associate an unreviewed clause', async () => {
    const s = await star('2. Can I collect on Saturday?', 'SELECT_AND_QUESTION');
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, { ...s.assessments, clause: { ...s.assessments.clause!, hash: sha256('different text') } }, current)).rejects.toThrow('ROUTING_MODERATION_EVIDENCE_CHANGED');
    expect(await db.conversationMessage.count({ where: { providerMessageId: s.q1.event.providerMessageId } })).toBe(0);
  });

  it('terminal replay fails closed after deletion of an authentic associated message', async () => {
    const s = await star();
    await admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current);
    await db.conversationMessage.delete({ where: { providerMessageId: s.q1.event.providerMessageId } });
    await expect(admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current)).rejects.toThrow();
  });

  it('deferred parent/resolver references retain the whole cohort until it can be removed together', async () => {
    const s = await star();
    await admitRoutingDecision(db, s.q3.event.providerMessageId, s.assessments, current);
    await expect(db.recoveryBasketRoutingTurn.delete({ where: { inboundProviderMessageId: s.q1.event.providerMessageId } })).rejects.toThrow();
    const ids = [s.q1.event.providerMessageId, s.q2.event.providerMessageId, s.q3.event.providerMessageId];
    await expect(deleteRoutingRetentionCohort(db, ids, new Date(Date.now() + 1000))).rejects.toThrow('ROUTING_RETENTION_NOT_ELIGIBLE');
    // Structural deferred-FK check only: application retention above must retain live-owner role evidence.
    const deleted = await db.$transaction(tx => tx.recoveryBasketRoutingTurn.deleteMany({ where: { inboundProviderMessageId: { in: ids } } }));
    expect(deleted.count).toBe(3);
    expect(await db.conversationMessage.count({ where: { providerMessageId: { in: ids } } })).toBe(2);
  });
});
