import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import { digest, stableJson } from '../../../../src/services/conversation-wrappers/projection.js';
import { readRoutingPrompt, sendRoutingPrompt } from '../../../../src/services/recovery-sender-pool/routing-prompt.js';

vi.mock('../../../../src/services/whatsapp.service.js', () => ({ whatsAppService: { sendWhatsAppText: vi.fn() } }));
const prepared = { schemaVersion: 1, family: 'MODA_CONVERSATION_WRAPPER', responseSlot: 'response.body',
  header: [{ kind: 'text', value: 'A question about your basket' }],
  body: [{ kind: 'responseSlot', name: 'response.body' }], footer: [], conditionals: [] };
const hash = digest(stableJson(prepared));
const sourceHash = 'a'.repeat(64);
function fixture() {
  return { audience: 'ROUTER', definitionId: 'definition', editVersion: 7, definition: {
    id: 'definition', kind: 'MODA_CONVERSATION_WRAPPER', audience: 'ROUTER', status: 'PUBLISHED',
    publishedAt: new Date('2026-01-01'), retiredAt: null, sourceLanguageTag: 'en', astSchemaVersion: 1,
    sourceHash, locales: [{ id: 'locale', languageTag: 'en', providerLanguageCode: null,
      status: 'SOURCE_SAVED', contentHash: hash, localeAst: { schemaVersion: 1, prepared } }],
  } };
}
async function prompt() {
  const db = { whatsAppConversationWrapperActiveSlot: { findUnique: vi.fn(async () => fixture()) } };
  const result = await readRoutingPrompt(db as never, { languageTag: 'en', responseBody: 'Which basket?' });
  if (!result) throw new Error('fixture invalid');
  return result;
}
describe('independent neutral ROUTER selector', () => {
  it('uses exact ROUTER pointer and the shared verified renderer without tenant reads', async () => {
    const findUnique = vi.fn(async () => fixture());
    const result = await readRoutingPrompt({ whatsAppConversationWrapperActiveSlot: { findUnique } } as never,
      { languageTag: 'en', responseBody: 'Which basket?' });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { audience: 'ROUTER' } }));
    expect(result?.body).toBe('A question about your basket\nWhich basket?');
    expect(result?.preparedHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['missing', 'draft', 'retired', 'foreign', 'unreviewed', 'hash', 'variable', 'media', 'conditional'])(
    'refuses %s rather than falling back to a shop wrapper', async kind => {
      const slot = fixture();
      if (kind === 'draft') slot.definition.status = 'SAVED';
      if (kind === 'retired') slot.definition.retiredAt = new Date() as never;
      if (kind === 'foreign') slot.definition.audience = 'SHARED';
      if (kind === 'unreviewed') slot.definition.locales[0]!.status = 'TRANSLATED';
      if (kind === 'hash') slot.definition.locales[0]!.contentHash = 'b'.repeat(64);
      if (['variable', 'media', 'conditional'].includes(kind)) {
        const unsafe = structuredClone(prepared) as Record<string, unknown>;
        if (kind === 'variable') unsafe.header = [{ kind: 'variable', name: 'shop.name' }];
        if (kind === 'media') unsafe.productImage = { variable: 'response.productImage', placement: 'BEFORE_BODY', optional: true };
        if (kind === 'conditional') unsafe.conditionals = [{ when: 'checkout.available', tokens: [{ kind: 'text', value: 'Checkout' }] }];
        slot.definition.locales[0]!.localeAst.prepared = unsafe as never;
        slot.definition.locales[0]!.contentHash = digest(stableJson(unsafe));
      }
      const findUnique = vi.fn(async () => kind === 'missing' ? null : slot);
      expect(await readRoutingPrompt({ whatsAppConversationWrapperActiveSlot: { findUnique } } as never,
        { languageTag: 'en', responseBody: 'Which basket?' })).toBeNull();
    });
  it('has no hidden locale fallback', async () => {
    const findUnique = vi.fn(async () => fixture());
    expect(await readRoutingPrompt({ whatsAppConversationWrapperActiveSlot: { findUnique } } as never,
      { languageTag: 'fr', responseBody: 'Quel panier?' })).toBeNull();
  });
});

async function sendFixture() {
  const value = await prompt();
  const now = new Date('2026-01-02T12:00:00Z');
  const { body, ...template } = value;
  const moderationJson = { id: 'moderation', allowed: true };
  const turn = { inboundProviderMessageId: 'inbound', threadId: 'thread', routeId: null,
    state: 'RECEIVED', promptAdmittedAt: null, promptProviderMessageId: null, workToken: null,
    workLeaseUntil: null, expiresAt: new Date(now.getTime() + 60_000), occurredAt: new Date(now.getTime() - 1_000),
    inputJson: { providerMessageId: 'inbound', customerPhone: '+14155550101', providerAccountId: '123', providerPhoneNumberId: '456' },
    moderationJson, candidatesJson: [], configurationSnapshot: { version: 1 }, routingDecision: { schemaVersion: 1, role: 'CLARIFY', template } };
  let transaction = false;
  const update = vi.fn(async ({ data }) => { Object.assign(turn, data); return turn; });
  const updateMany = vi.fn(async ({ data }) => { Object.assign(turn, data); return { count: 1 }; });
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('RecoveryBasketRoutingTurn')) return [turn];
    if (sql.includes('RecoverySenderThread')) return [{ canonicalRecipient: '14155550101', providerPhoneNumberId: '456', providerAccountId: '123' }];
    if (sql.includes('PlatformConfiguration') || sql.includes('WhatsAppTemplateDefinition')) return [{ id: 'valid' }];
    return [];
  });
  const tx = { $queryRawUnsafe: query, recoveryBasketRoutingTurn: { findUnique: vi.fn(async () => turn), update } };
  const db = { $transaction: vi.fn(async fn => { transaction = true; try { return await fn(tx); } finally { transaction = false; } }),
    recoveryBasketRoutingTurn: { updateMany } } as unknown as PrismaClient;
  const provider = { sendWhatsAppText: vi.fn(async () => { expect(transaction).toBe(false); expect(turn.state).toBe('PROMPT_ADMITTED'); return { providerMessageId: 'meta-prompt' }; }) };
  const input = { turnId: 'inbound', prompt: { ...value, body }, now, deadlineMs: 1000,
    senderSnapshot: { rowId: 'sender-config', version: 3, environment: 'test', providerAccountId: '123', providerPhoneNumberId: '999' },
    moderationHash: digest(canonicalJson(moderationJson)), configurationCurrent: vi.fn(async () => true) };
  const noContact = vi.fn(async () => false);
  return { db, input, provider, noContact, turn, query, update, updateMany };
}
describe('durable router prompt provider permit', () => {
  it('admits before network, pins actual thread phone, then records exact receipt', async () => {
    const f = await sendFixture();
    expect(await sendRoutingPrompt(f.db, f.input, f)).toEqual({ kind: 'sent', providerMessageId: 'meta-prompt' });
    expect(f.provider.sendWhatsAppText).toHaveBeenCalledWith(expect.objectContaining({
      to: '14155550101', expectedSender: { providerAccountId: '123', providerPhoneNumberId: '456' },
      replyToProviderMessageId: 'inbound' }), expect.any(AbortSignal));
    expect(f.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ promptProviderMessageId: 'meta-prompt' }) }));
    expect((await sendRoutingPrompt(f.db, f.input, f)).kind).toBe('replay');
    expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
  it('takes canonical recipient ownership before the routing row lock', async () => {
    const f = await sendFixture();
    expect((await sendRoutingPrompt(f.db, f.input, f)).kind).toBe('sent');
    const sql = f.query.mock.calls.map(call => call[0]);
    const recipientLock = sql.findIndex(value => value.includes('pg_advisory_xact_lock($1::bigint)'));
    const turnLock = sql.findIndex(value => value.includes('RecoveryBasketRoutingTurn') && value.includes('FOR UPDATE'));
    const threadLock = sql.findIndex(value => value.includes('RecoverySenderThread') && value.includes('FOR SHARE'));
    expect(recipientLock).toBeGreaterThan(-1);
    expect(turnLock).toBeGreaterThan(recipientLock);
    expect(threadLock).toBeGreaterThan(turnLock);
  });
  it('does not claim a confirmed receipt when its durable settlement loses the CAS', async () => {
    const f = await sendFixture();
    f.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await sendRoutingPrompt(f.db, f.input, f)).toEqual({ kind: 'unknown' });
    expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
  it('retains uncertainty and never automatically retries an ambiguous send', async () => {
    const f = await sendFixture();
    f.provider.sendWhatsAppText.mockRejectedValueOnce(new Error('timeout'));
    expect(await sendRoutingPrompt(f.db, f.input, f)).toEqual({ kind: 'unknown' });
    expect(f.turn.state).toBe('PROMPT_UNKNOWN');
    expect((await sendRoutingPrompt(f.db, f.input, f)).kind).toBe('replay');
    expect(f.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
  it.each(['sender', 'recipient', 'configuration', 'template', 'moderation', 'decision', 'stop', 'expiry', 'lease', 'terminal'])(
    'refuses changed %s before any provider call', async kind => {
      const f = await sendFixture();
      if (kind === 'sender') f.turn.inputJson.providerAccountId = 'foreign';
      if (kind === 'recipient') f.turn.inputJson.customerPhone = '+14155550102';
      if (kind === 'configuration') f.input.configurationCurrent.mockResolvedValue(false);
      if (kind === 'template') f.query.mockImplementation(async sql => sql.includes('RecoveryBasketRoutingTurn') ? [f.turn] : sql.includes('WhatsAppTemplateDefinition') ? [] : sql.includes('RecoverySenderThread') ? [{ canonicalRecipient: '14155550101', providerPhoneNumberId: '456', providerAccountId: '123' }] : [{ id: 'valid' }] as never);
      if (kind === 'moderation') f.input.moderationHash = 'f'.repeat(64);
      if (kind === 'decision') f.turn.routingDecision.template.localeId = 'foreign';
      if (kind === 'stop') f.noContact.mockResolvedValue(true);
      if (kind === 'expiry') f.turn.expiresAt = f.input.now;
      if (kind === 'lease') f.turn.workToken = 'foreign' as never;
      if (kind === 'terminal') f.turn.state = 'EXPIRED';
      const result = await sendRoutingPrompt(f.db, f.input, f);
      expect(['held', 'replay']).toContain(result.kind);
      expect(f.provider.sendWhatsAppText).not.toHaveBeenCalled();
    });
});
