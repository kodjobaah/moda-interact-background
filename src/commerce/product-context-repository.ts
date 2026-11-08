import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalJson, CommerceConversationProductContextSchema, type CommerceConversationProductContext } from '@modainteract/moda-interact-shared/commerce';
import { createLogger } from '@modainteract/moda-interact-shared/logging';
import prisma from '../lib/db.js';
import { resolveDeploymentEnvironmentName } from '../runtime/deployment-environment.js';

export type ProductContextWriteResult = 'WRITTEN' | 'UNCHANGED' | 'STALE' | 'CONFLICT' | 'SKIPPED';
type Identity = { shopId: string; conversationId: string; now: number | Date };
type Logger = { warn: (event: string, fields: { shopId: string; conversationId: string; reason: string }) => void };
const TTL = 24 * 60 * 60 * 1000;
const MAX_BYTES = 32768;
const ownerSelect = { shopId: true, inboundVersion: true, checkoutRecoveryId: true,
  checkoutRecovery: { select: { shopId: true, shop: { select: { platform: true } } } },
} satisfies Prisma.ConversationSelect;
type Owner = Prisma.ConversationGetPayload<{ select: typeof ownerSelect }>;
function owner(row: Owner | null, shopId: string) {
  if (!row?.checkoutRecoveryId || !row.checkoutRecovery) return null;
  const recovery = row.checkoutRecovery;
  if (row.shopId && row.shopId !== recovery.shopId) return null;
  return recovery.shopId === shopId ? { platform: recovery.shop.platform, version: row.inboundVersion } : null;
}
function validated(value: unknown, identity: Identity, platform: string) {
  const result = CommerceConversationProductContextSchema.safeParse(value);
  if (!result.success) return null;
  const context = result.data;
  const now = Number(identity.now);
  const updated = Date.parse(context.updatedAt);
  if (context.shopId !== identity.shopId || context.conversationId !== identity.conversationId || context.platform !== platform
    || !Number.isFinite(now) || updated > now || updated <= now - TTL
    || context.references.some(reference => Date.parse(reference.observedAt) > now || Date.parse(reference.observedAt) <= now - TTL)
    || Buffer.byteLength(canonicalJson(context), 'utf8') > MAX_BYTES) return null;
  return context;
}
export function createProductContextRepository(deps: { db?: PrismaClient; logger?: Logger } = {}) {
  const db = deps.db ?? prisma;
  const logger = deps.logger ?? createLogger({ serviceName: 'moda-messaging-worker', environment: resolveDeploymentEnvironmentName() });
  function warn(identity: Identity, reason: string) {
    try { logger.warn('commerce.product_context.ignored', { shopId: identity.shopId, conversationId: identity.conversationId, reason }); } catch { /* cache logging cannot affect delivery */ }
  }
  return {
    async read(identity: Identity): Promise<CommerceConversationProductContext | null> {
      try {
        const canonicalOwner = owner(await db.conversation.findUnique({ where: { id: identity.conversationId }, select: ownerSelect }), identity.shopId);
        if (!canonicalOwner) { warn(identity, 'OWNER_INVALID'); return null; }
        const row = await db.commerceConversationProductContext.findFirst({ where: { conversationId: identity.conversationId, shopId: identity.shopId } });
        if (!row) return null;
        const size = await db.$queryRaw<{ bytes: number }[]>`SELECT pg_column_size("references") AS bytes FROM "whatsapp"."CommerceConversationProductContext" WHERE "conversationId"=${identity.conversationId} AND "shopId"=${identity.shopId}`;
        const context = validated(row.references, identity, canonicalOwner.platform);
        if (!context || row.schemaVersion !== context.schemaVersion || row.revision < 1 || row.sourceInboundVersion < 0
          || row.sourceInboundVersion > canonicalOwner.version || row.expiresAt.getTime() <= Number(identity.now)
          || size.length !== 1 || size[0]!.bytes > MAX_BYTES) { warn(identity, 'ROW_INVALID'); return null; }
        return context;
      } catch { warn(identity, 'DATABASE_UNAVAILABLE'); return null; }
    },
    async write(input: Identity & { expectedInboundVersion: number; context: CommerceConversationProductContext }): Promise<ProductContextWriteResult> {
      if (!Number.isSafeInteger(input.expectedInboundVersion) || input.expectedInboundVersion < 0 || !Number.isFinite(Number(input.now))) { warn(input, 'INPUT_INVALID'); return 'SKIPPED'; }
      try {
        return await db.$transaction(async tx => {
          const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "whatsapp"."Conversation" WHERE "id"=${input.conversationId} FOR UPDATE`;
          if (!locked.length) return 'STALE';
          const canonicalOwner = owner(await tx.conversation.findUnique({ where: { id: input.conversationId }, select: ownerSelect }), input.shopId);
          if (!canonicalOwner || canonicalOwner.version !== input.expectedInboundVersion) return 'STALE';
          const context = validated(input.context, input, canonicalOwner.platform);
          if (!context) { warn(input, 'PAYLOAD_INVALID'); return 'SKIPPED'; }
          const json = canonicalJson(context);
          const size = await tx.$queryRaw<{ bytes: number }[]>`SELECT pg_column_size(${json}::jsonb) AS bytes`;
          if (size.length !== 1 || size[0]!.bytes > MAX_BYTES) { warn(input, 'PAYLOAD_TOO_LARGE'); return 'SKIPPED'; }
          const existing = await tx.commerceConversationProductContext.findUnique({ where: { conversationId: input.conversationId } });
          if (existing) {
            if (existing.shopId !== input.shopId || existing.sourceInboundVersion > input.expectedInboundVersion) return 'STALE';
            if (existing.sourceInboundVersion === input.expectedInboundVersion) return existing.schemaVersion === context.schemaVersion && canonicalJson(existing.references) === json ? 'UNCHANGED' : 'CONFLICT';
          }
          const data = { shopId: input.shopId, schemaVersion: context.schemaVersion, sourceInboundVersion: input.expectedInboundVersion,
            references: context as Prisma.InputJsonValue, expiresAt: new Date(Number(input.now) + TTL) };
          if (!existing) {
            await tx.commerceConversationProductContext.create({ data: { ...data, conversationId: input.conversationId, revision: 1 } });
          } else {
            const changed = await tx.commerceConversationProductContext.updateMany({ where: { conversationId: input.conversationId, shopId: input.shopId, revision: existing.revision }, data: { ...data, revision: { increment: 1 } } });
            if (changed.count !== 1) return 'CONFLICT';
          }
          return 'WRITTEN';
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'CONFLICT';
        warn(input, 'DATABASE_UNAVAILABLE'); return 'SKIPPED';
      }
    },
  };
}
export const createCommerceProductContextRepository = createProductContextRepository;
