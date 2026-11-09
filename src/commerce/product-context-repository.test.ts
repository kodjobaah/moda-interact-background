import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProductContextRepository } from './product-context-repository.js';
import type { CommerceConversationProductContext } from '@modainteract/moda-interact-shared/commerce';
const now = Date.parse('2026-11-08T20:00:00Z');
const context = (conversationId = 'checkout'): CommerceConversationProductContext => ({ schemaVersion: 1, shopId: 'shop-a', conversationId, platform: 'SHOPIFY', references: [{ productId: 'gid://shopify/Product/123', variantId: null, title: 'Blue shirt', observedAt: new Date(now).toISOString() }], updatedAt: new Date(now).toISOString() });
it('degrades technical read/write failures without logging payloads', async () => {
  const warn = vi.fn();
  const db = { conversation: { findUnique: vi.fn().mockRejectedValue(new Error('secret credential')) }, $transaction: vi.fn().mockRejectedValue(new Error('secret credential')) } as unknown as PrismaClient;
  const repository = createProductContextRepository({ db, logger: { warn } });
  expect(await repository.read({ shopId: 'shop-a', conversationId: 'checkout', now })).toBeNull();
  expect(await repository.write({ shopId: 'shop-a', conversationId: 'checkout', now, expectedInboundVersion: 1, context: context() })).toBe('SKIPPED');
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|Blue shirt|gid:/);
});
const url = process.env.ARCH066_PRODUCT_CONTEXT_DATABASE_URL;
describe.skipIf(!url)('real PostgreSQL reference cache transaction contract', () => {
  const db = url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient();
  const second = url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient();
  const repository = createProductContextRepository({ db, logger: { warn: vi.fn() } });
  const other = createProductContextRepository({ db: second, logger: { warn: vi.fn() } });
  afterEach(() => vi.unstubAllEnvs());
  const input = (conversationId = 'checkout', version = 1) => ({ shopId: 'shop-a', conversationId, now, expectedInboundVersion: version, context: context(conversationId) });
  beforeAll(async () => {
    await db.$executeRawUnsafe(`INSERT INTO commerce."Shop" (id,platform) VALUES ('shop-a','SHOPIFY'),('shop-b','SHOPIFY')`);
    await db.$executeRawUnsafe(`INSERT INTO commerce."CheckoutRecovery" (id,"shopId") VALUES ('recovery-a','shop-a')`);
    await db.$executeRawUnsafe(`INSERT INTO whatsapp."Conversation" (id,"shopId","checkoutRecoveryId","inboundVersion") VALUES ('checkout','shop-a','recovery-a',1),('missing-recovery','shop-a',NULL,1),('recovery',NULL,'recovery-a',1),('conflicting','shop-b','recovery-a',1),('race','shop-a','recovery-a',1),('simultaneous','shop-a','recovery-a',1)`);
  });
  afterAll(async () => { await Promise.all([db.$disconnect(), second.$disconnect()]); });
  it('requires real recovery ownership and rejects missing recovery, wrong/conflicting/missing owners', async () => {
    expect(await repository.write(input())).toBe('WRITTEN');
    expect(await repository.read({ ...input() })).toEqual(context());
    expect(await repository.write(input('recovery'))).toBe('WRITTEN');
    expect(await repository.write(input('conflicting'))).toBe('STALE');
    expect(await repository.write({ ...input(), shopId: 'shop-b' })).toBe('STALE');
    expect(await repository.write(input('missing'))).toBe('STALE');
    expect(await repository.write(input('missing-recovery'))).toBe('STALE');
    expect(await repository.read({ shopId: 'shop-a', conversationId: 'missing-recovery', now })).toBeNull();
  });
  it('uses canonical JSON equality without extending expiry and fences versions/revisions', async () => {
    const before = await db.commerceConversationProductContext.findUniqueOrThrow({ where: { conversationId: 'checkout' } });
    const reordered = { ...context(), references: context().references.map(({ title, ...rest }) => ({ title, ...rest })) };
    expect(await repository.write({ ...input(), now: now + 1000, context: reordered })).toBe('UNCHANGED');
    expect((await db.commerceConversationProductContext.findUniqueOrThrow({ where: { conversationId: 'checkout' } })).expiresAt).toEqual(before.expiresAt);
    expect(await repository.write({ ...input(), context: { ...context(), references: [] } })).toBe('CONFLICT');
    await db.conversation.update({ where: { id: 'checkout' }, data: { inboundVersion: 2 }, select: { id: true } });
    expect(await repository.write(input())).toBe('STALE');
    expect(await repository.write(input('checkout', 2))).toBe('WRITTEN');
    expect((await db.commerceConversationProductContext.findUniqueOrThrow({ where: { conversationId: 'checkout' } })).revision).toBe(2);
    await db.commerceConversationProductContext.update({ where: { conversationId: 'checkout' }, data: { sourceInboundVersion: 3 } });
    expect(await repository.write(input('checkout', 2))).toBe('STALE');
  });
  it('ignores expired and malformed data and enforces both payload size bounds', async () => {
    expect(await repository.read({ shopId: 'shop-a', conversationId: 'recovery', now: now + 86400000 })).toBeNull();
    await db.commerceConversationProductContext.update({ where: { conversationId: 'recovery' }, data: { references: { secret: 'untrusted' } } });
    expect(await repository.read({ shopId: 'shop-a', conversationId: 'recovery', now })).toBeNull();
    expect(await repository.write({ ...input('race'), context: { ...context('race'), references: [{ ...context('race').references[0]!, title: 'x'.repeat(33000) }] } })).toBe('SKIPPED');
    await expect(db.$executeRawUnsafe(`UPDATE whatsapp."CommerceConversationProductContext" SET "references"=jsonb_build_object('a',repeat('x',40000)) WHERE "conversationId"='recovery'`)).rejects.toThrow();
  });
  it('waits on the canonical row lock and rejects an inbound version advanced while waiting', async () => {
    let unlock!: () => void;
    const barrier = new Promise<void>(resolve => { unlock = resolve; });
    let locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM whatsapp."Conversation" WHERE id='race' FOR UPDATE`;
      locked(); await barrier;
      await tx.conversation.update({ where: { id: 'race' }, data: { inboundVersion: 2 }, select: { id: true } });
    });
    await acquired;
    const waiting = other.write(input('race'));
    let sawLock = false;
    for (let i = 0; i < 50; i++) {
      const rows = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%Conversation%') AS waiting`;
      if (rows[0]?.waiting) { sawLock = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    unlock(); await holder;
    expect(sawLock).toBe(true);
    expect(await waiting).toBe('STALE');
    expect(await repository.write(input('race', 2))).toBe('WRITTEN');
  });
  it('serializes competing same-version inserts and never overwrites the winner', async () => {
    const results = await Promise.all([repository.write(input('simultaneous')), other.write({ ...input('simultaneous'), context: { ...context('simultaneous'), references: [] } })]);
    expect(results.sort()).toEqual(['CONFLICT', 'WRITTEN']);
    expect((await db.commerceConversationProductContext.findUniqueOrThrow({ where: { conversationId: 'simultaneous' } })).revision).toBe(1);
  });

});
