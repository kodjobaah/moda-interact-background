import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { CommerceConversationProductContext } from '@modainteract/moda-interact-shared/commerce';
import { createProductContextRepository } from './product-context-repository.js';
import { presentedProductContext } from './product-context-write.js';
import { OutboundMessageDeliveryService } from '../services/outbound-whatsapp-admission/outbound-message-delivery.service.js';
import { OutboundSendFenceService } from '../services/recovery-conversation/outbound-send-fence.service.js';

const url = process.env.ARCH066_PRODUCT_CONTEXT_DATABASE_URL;
const now = new Date('2026-11-09T12:00:00Z');
const body = 'Tree B\nVariant stock: 2';
const pair = (id: string) => ({ productId: `gid://shopify/Product/${id}`, variantId: null });
function context(conversationId: string, id: string): CommerceConversationProductContext {
  return presentedProductContext({ schemaVersion: 1, shopId: 'shop-r2', conversationId, platform: 'SHOPIFY', updatedAt: now.toISOString(),
    references: [{ ...pair(id), title: `Tree ${id}`, observedAt: now.toISOString(), selectedOptions: [{ name: 'Finish', value: 'Green' }] }] }, [pair(id)], now);
}

describe.skipIf(!url)('ARCH067 final admission context transaction (real PostgreSQL)', () => {
  const db = url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient();
  beforeAll(async () => {
    await db.$executeRawUnsafe(`INSERT INTO commerce."Shop" (id,platform) VALUES ('shop-r2','SHOPIFY')`);
    await db.$executeRawUnsafe(`INSERT INTO commerce."CheckoutRecovery" (id,"shopId") VALUES ('recovery-r2','shop-r2')`);
    await db.$executeRawUnsafe(`INSERT INTO commerce."RecoveryOutreachAttempt" (id,"checkoutRecoveryId",sequence,recipient,"sentAt") VALUES ('attempt-r2','recovery-r2',1,'+447700900001',$1)`, new Date(+now - 2000));
  });
  afterAll(async () => db.$disconnect());
  afterEach(() => vi.unstubAllEnvs());

  async function setup(name: string, moderate?: () => Promise<'allow' | 'block'>) {
    vi.stubEnv('COMMERCE_PRODUCT_REFERENCE_V2_WRITE_ENABLED', 'true');
    const conversationId = `conversation-r2-${name}`, messageId = `message-r2-${name}`;
    await db.$executeRawUnsafe(`INSERT INTO whatsapp."Conversation" (id,"shopId","checkoutRecoveryId","inboundVersion") VALUES ($1,'shop-r2','recovery-r2',1)`, conversationId);
    await db.$executeRawUnsafe(`INSERT INTO whatsapp."ConversationMessage" (id,"conversationId",direction,"senderType",status,content,"providerMessageId","createdAt") VALUES ($1,$2,'INBOUND','CUSTOMER','SENT','Fixture inbound',$1,$3)`, `inbound-${name}`, conversationId, new Date(+now - 1000));
    await db.$executeRawUnsafe(`INSERT INTO whatsapp."ConversationMessage" (id,"conversationId",direction,"senderType",status,content) VALUES ($1,$2,'OUTBOUND','AGENT','PENDING','[Pending automated WhatsApp message]')`, messageId, conversationId);
    const repository = createProductContextRepository({ db });
    expect(await repository.write({ shopId: 'shop-r2', conversationId, now, expectedInboundVersion: 1, context: context(conversationId, '301') })).toBe('WRITTEN');
    await db.$executeRawUnsafe(`UPDATE whatsapp."Conversation" SET "inboundVersion"=2 WHERE id=$1`, conversationId);
    const provider = { sendWhatsAppText: vi.fn().mockRejectedValue(new Error('fixture unknown provider outcome')) };
    // Only the external policy/moderation/provider seams are scripted. Final
    // eligibility locks, message permit and context writes execute real SQL.
    const database = {
      $transaction: db.$transaction.bind(db), $queryRawUnsafe: db.$queryRawUnsafe.bind(db),
      conversationMessage: {
        findUnique: db.conversationMessage.findUnique.bind(db.conversationMessage),
        update: async (input: { where: Prisma.ConversationMessageWhereInput; data: { content: string } }) => {
          const result = await db.conversationMessage.updateMany(input);
          if (result.count !== 1) throw Object.assign(new Error('fixture message missing'), { code: 'P2025' });
          return {};
        },
      },
    };
    const fence = new OutboundSendFenceService(db, async () => null, () => now);
    const service = new OutboundMessageDeliveryService(database as never, provider as never,
      { evaluate: vi.fn(async () => ({ allowed: true })) } as never,
      { readTurnOwnership: vi.fn(async () => ({ recoveryId: 'recovery-r2', revision: 0 })) } as never,
      fence,
      { assessText: vi.fn(async () => ({ kind: moderate ? await moderate() : 'allow' })), requireCurrentAllowance: vi.fn(async () => true) } as never,
      { failPrepared: vi.fn(), afterProviderError: vi.fn() } as never);
    const input = { kind: 'admitted' as const, shopId: 'shop-r2', conversationId, messageId, terminal: false, executionScope: 'recovery' as const,
      to: '+447700900001', text: body, expectedControlRevision: 0, expectedInboundVersion: 2, productContextUpdate: context(conversationId, '302') };
    const snapshot = () => db.commerceConversationProductContext.findUniqueOrThrow({ where: { conversationId } });
    const message = () => db.conversationMessage.findUniqueOrThrow({ where: { id: messageId }, select: { content: true, providerDispatchKey: true, providerDispatchAdmittedAt: true } });
    return { input, service, provider, snapshot, message, conversationId };
  }

  it.each(['moderation', 'takeover', 'inbound', 'context-conflict'] as const)('keeps list A and revision intact on %s rejection', async reason => {
    const test: Awaited<ReturnType<typeof setup>> = await setup(reason, async () => {
      if (reason === 'takeover') await db.$executeRawUnsafe(`UPDATE whatsapp."Conversation" SET "controlMode"='HUMAN',"controlRevision"=1 WHERE id=$1`, test.conversationId);
      if (reason === 'inbound') await db.$executeRawUnsafe(`UPDATE whatsapp."Conversation" SET "inboundVersion"=3 WHERE id=$1`, test.conversationId);
      return reason === 'moderation' ? 'block' : 'allow';
    });
    if (reason === 'context-conflict') await db.$executeRawUnsafe(`UPDATE whatsapp."CommerceConversationProductContext" SET "sourceInboundVersion"=2 WHERE "conversationId"=$1`, test.conversationId);
    const before = await test.snapshot();
    expect(await test.service.sendPreparedText(test.input)).toMatchObject({ kind: 'suppressed' });
    expect(await test.snapshot()).toEqual(before);
    expect((await test.message()).providerDispatchKey).toBeNull();
    expect(test.provider.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it('commits B/body/permit once and preserves it on replay after an unknown provider outcome', async () => {
    const test = await setup('admitted');
    await expect(test.service.sendPreparedText(test.input)).rejects.toThrow('fixture unknown provider outcome');
    const stored = await test.snapshot(), message = await test.message();
    expect(stored.revision).toBe(2);
    expect(stored.references).toEqual(test.input.productContextUpdate);
    expect(message.content).toBe(body);
    expect(message.providerDispatchKey).toBeTruthy();
    expect(test.provider.sendWhatsAppText).toHaveBeenCalledExactlyOnceWith({ to: test.input.to, text: body });
    expect(await test.service.sendPreparedText({ ...test.input, text: 'Recomputed stock: 7', productContextUpdate: context(test.conversationId, '303') })).toMatchObject({ kind: 'suppressed', reason: 'duplicate' });
    expect(await test.snapshot()).toEqual(stored);
    expect(await test.message()).toEqual(message);
    expect(test.provider.sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
});
