import { productContextForPersistence } from "./product-context-write.js";
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
          const context = validated(productContextForPersistence(input.context), input, canonicalOwner.platform);
          if (!context) { warn(input, 'PAYLOAD_INVALID'); return 'SKIPPED'; }
          const json = canonicalJson(context);
          const size = await tx.$queryRaw<{ bytes: number }[]>`SELECT pg_column_size(${json}::jsonb) AS bytes`;
          if (size.length !== 1 || size[0]!.bytes > MAX_BYTES) { warn(input, 'PAYLOAD_TOO_LARGE'); return 'SKIPPED'; }
          const existing = await tx.commerceConversationProductContext.findUnique({ where: { conversationId: input.conversationId } });
          if (existing) {
            if (existing.shopId !== input.shopId || existing.sourceInboundVersion > input.expectedInboundVersion) return 'STALE';
            if (existing.sourceInboundVersion === input.expectedInboundVersion) {
              if (existing.schemaVersion !== context.schemaVersion || canonicalJson(existing.references) !== json) return 'CONFLICT';
              return 'UNCHANGED';
            }
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

/** A context failure aborts the enclosing final-permit transaction as well. */
export class ProductContextAdmissionError extends Error {
  constructor() { super('PRODUCT_CONTEXT_ADMISSION_REJECTED'); this.name = 'ProductContextAdmissionError'; }
}

/** Database-only participant in the Shop -> Conversation -> message permit transaction.
 * The caller has passed moderation and locked/updated the exact AGENT message.
 * Do not call through a separate transaction or before final eligibility checks.
 */
export async function commitAdmittedProductContext(
  tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>,
  input: Identity & { expectedInboundVersion: number; context: CommerceConversationProductContext; messageId: string; body: string; dispatchKey: string },
): Promise<void> {
  const reject = (): never => { throw new ProductContextAdmissionError(); };
  if (!Number.isSafeInteger(input.expectedInboundVersion) || input.expectedInboundVersion < 0 ||
      !input.body.trim() || input.body.length > 4096 || !input.dispatchKey) reject();
  const owners = await tx.$queryRawUnsafe<{ platform: string }[]>(`
    SELECT s."platform"::text FROM "whatsapp"."Conversation" c
    JOIN "commerce"."CheckoutRecovery" r ON r."id"=c."checkoutRecoveryId"
    JOIN "commerce"."Shop" s ON s."id"=r."shopId"
    WHERE c."id"=$1 AND r."shopId"=$2 AND (c."shopId" IS NULL OR c."shopId"=r."shopId")
      AND c."inboundVersion"=$3`, input.conversationId, input.shopId, input.expectedInboundVersion);
  if (owners.length !== 1) reject();
  let context: CommerceConversationProductContext | null = null;
  try { context = validated(productContextForPersistence(input.context), input, owners[0]!.platform); } catch { reject(); }
  if (!context) return reject();
  const json = canonicalJson(context);
  const sizes = await tx.$queryRawUnsafe<{ bytes: number }[]>('SELECT pg_column_size($1::jsonb) AS bytes', json);
  if (sizes.length !== 1 || sizes[0]!.bytes > MAX_BYTES) reject();
  // The exact moderated body and durable permit identify this context commit.
  const messages = await tx.$queryRawUnsafe<{ id: string }[]>(`
    SELECT "id" FROM "whatsapp"."ConversationMessage"
    WHERE "id"=$1 AND "conversationId"=$2 AND "direction"='OUTBOUND' AND "senderType"='AGENT'
      AND "status"='PENDING' AND "content"=$3 AND "providerDispatchKey"=$4
      AND "providerDispatchAdmittedAt" IS NOT NULL FOR UPDATE`, input.messageId, input.conversationId, input.body, input.dispatchKey);
  if (messages.length !== 1) reject();
  const previous = await tx.$queryRawUnsafe<{ shopId: string; sourceInboundVersion: number; revision: number; references: unknown; schemaVersion: number }[]>(`
    SELECT "shopId","sourceInboundVersion","revision","references","schemaVersion"
    FROM "whatsapp"."CommerceConversationProductContext" WHERE "conversationId"=$1 FOR UPDATE`, input.conversationId);
  const row = previous[0];
  if (row) {
    if (row.shopId !== input.shopId || row.sourceInboundVersion > input.expectedInboundVersion) reject();
    if (row.sourceInboundVersion === input.expectedInboundVersion) {
      if (row.schemaVersion !== context.schemaVersion || canonicalJson(row.references) !== json) reject();
      return;
    }
  }
  const expiresAt = new Date(Number(input.now) + TTL);
  const changed = row
    ? await tx.$queryRawUnsafe<{ revision: number }[]>(`
      UPDATE "whatsapp"."CommerceConversationProductContext"
      SET "references"=$1::jsonb,"schemaVersion"=$2,"sourceInboundVersion"=$3,"expiresAt"=$4,
        "revision"="revision"+1,"updatedAt"=statement_timestamp()
      WHERE "conversationId"=$5 AND "shopId"=$6 AND "revision"=$7 RETURNING "revision"`,
      json, context.schemaVersion, input.expectedInboundVersion, expiresAt, input.conversationId, input.shopId, row.revision)
    : await tx.$queryRawUnsafe<{ revision: number }[]>(`
      INSERT INTO "whatsapp"."CommerceConversationProductContext"
        ("conversationId","shopId","schemaVersion","sourceInboundVersion","references","expiresAt","revision","updatedAt")
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,1,statement_timestamp()) RETURNING "revision"`,
      input.conversationId, input.shopId, context.schemaVersion, input.expectedInboundVersion, json, expiresAt);
  if (changed.length !== 1) reject();
}
