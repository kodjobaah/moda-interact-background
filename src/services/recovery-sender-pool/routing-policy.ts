import type { Prisma, PrismaClient } from '@prisma/client';
import { createLogger, type StructuredLogger } from '@modainteract/moda-interact-shared/logging';
import { sourceFailureFields } from '../../commerce/production-model.js';
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import {
  CommerceEnvironmentSchema, ResolvedCommerceModelSchema,
  type CommerceEnvironment, type ResolvedCommerceModel,
} from '@modainteract/moda-interact-shared/commerce/model';
import { sha256 } from '../recovery-multipart/frozen.js';
import { resolveProductionCommerceModel } from '../../commerce/model-resolution.js';
import type { RoutingPersistencePolicy } from './routing-handoff.js';

/** Application-owned decoder of the exact Admin-authored policy. No business defaults. */
export type RoutingAgentPolicy = Readonly<{
  schemaVersion: 1; enabled: boolean;
  modelBinding: { kind: 'FIXED_CATALOGUE'; modelCatalogueEntryId: string } | { kind: 'VERIFIED_SHOP_INHERIT' };
  promptRevisionId: string; wrapperAudience: 'ROUTER'; confidenceThreshold: number;
  budget: { deadlineMs: number; outputTokens: number; toolCalls: number };
  retry: { maxAttempts: number; backoffMs: number };
  input: { maxHistoryMessages: number; maxInputCharacters: number; maxCandidates: number };
  decisionTTLms: number; retentionMs: number;
}>;
export type RoutingPolicySnapshot = RoutingPersistencePolicy & Readonly<{
  policy: RoutingAgentPolicy;
  prompt: { revisionId: string; contentHash: string; promptText: string };
  model: null | {
    resolved: ResolvedCommerceModel; catalogueEditVersion: number;
    availabilityId: string; availabilityEditVersion: number; selectionSource: string;
  };
  verifiedShopId: string | null;
  commerceEnvironment: CommerceEnvironment;
}>;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ROUTING_POLICY_INVALID');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new Error('ROUTING_POLICY_INVALID');
  return row;
}
function integer(value: unknown, minimum: number, maximum = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('ROUTING_POLICY_INVALID');
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,191}$/.test(value)) throw new Error('ROUTING_POLICY_INVALID');
  return value;
}
export function decodeRoutingAgentPolicy(value: unknown): RoutingAgentPolicy {
  const row = object(value, ['schemaVersion','enabled','modelBinding','promptRevisionId','wrapperAudience','confidenceThreshold','budget','retry','input','decisionTTLms','retentionMs']);
  if (row.schemaVersion !== 1 || typeof row.enabled !== 'boolean' || row.wrapperAudience !== 'ROUTER') throw new Error('ROUTING_POLICY_INVALID');
  const rawBinding = row.modelBinding as Record<string, unknown> | null;
  let modelBinding: RoutingAgentPolicy['modelBinding'];
  if (rawBinding?.kind === 'FIXED_CATALOGUE') {
    const binding = object(rawBinding, ['kind','modelCatalogueEntryId']);
    modelBinding = { kind: 'FIXED_CATALOGUE', modelCatalogueEntryId: id(binding.modelCatalogueEntryId) };
  } else {
    const binding = object(rawBinding, ['kind']);
    if (binding.kind !== 'VERIFIED_SHOP_INHERIT') throw new Error('ROUTING_POLICY_INVALID');
    modelBinding = { kind: 'VERIFIED_SHOP_INHERIT' };
  }
  const budget = object(row.budget, ['deadlineMs','outputTokens','toolCalls']);
  const retry = object(row.retry, ['maxAttempts','backoffMs']);
  const input = object(row.input, ['maxHistoryMessages','maxInputCharacters','maxCandidates']);
  const decisionTTLms = integer(row.decisionTTLms, 1);
  const retentionMs = integer(row.retentionMs, decisionTTLms);
  return {
    schemaVersion: 1, enabled: row.enabled, modelBinding, promptRevisionId: id(row.promptRevisionId), wrapperAudience: 'ROUTER',
    confidenceThreshold: integer(row.confidenceThreshold, 0, 100),
    budget: { deadlineMs: integer(budget.deadlineMs,1), outputTokens: integer(budget.outputTokens,1), toolCalls: integer(budget.toolCalls,0) },
    retry: { maxAttempts: integer(retry.maxAttempts,1), backoffMs: integer(retry.backoffMs,0) },
    input: { maxHistoryMessages: integer(input.maxHistoryMessages,0), maxInputCharacters: integer(input.maxInputCharacters,1), maxCandidates: integer(input.maxCandidates,1) },
    decisionTTLms, retentionMs,
  };
}

/** Credentials stay in the existing protected resolver; this snapshot contains only public revision/parameter evidence. */
export async function readRoutingPolicy(db: PrismaClient, input: { environment: string; verifiedShopId?: string }, logger?: Pick<StructuredLogger, 'warn'>): Promise<RoutingPolicySnapshot | null> {
  try {
    const commerceEnvironment = CommerceEnvironmentSchema.parse(input.environment.toUpperCase());
    const row = await db.platformConfiguration.findUnique({ where: { environment_key: { environment: input.environment, key: 'recovery.routingAgent' } } });
    if (!row || row.environment !== input.environment || !Number.isSafeInteger(row.version) || row.version < 1) return null;
    const policy = decodeRoutingAgentPolicy(row.value);
    if (!policy.enabled) return null;
    const prompt = await db.commerceAgentPromptRevision.findUnique({ where: { id: policy.promptRevisionId }, include: { prompt: true } });
    const context = prompt?.sourceContext as Record<string, unknown> | null;
    if (!prompt || prompt.status !== 'PUBLISHED' || !prompt.publishedAt || prompt.prompt.scope !== 'PLATFORM' || prompt.prompt.shopId !== null || context?.purpose !== 'RECOVERY_ROUTING' || context.schemaVersion !== 1 || !prompt.promptText.trim() || prompt.contentHash !== sha256(prompt.promptText)) return null;
    if (await db.commerceAgentConfiguration.findFirst({ where: { activePromptRevisionId: prompt.id }, select: { id: true } })) return null;
    let model: RoutingPolicySnapshot['model'] = null;
    if (policy.modelBinding.kind === 'FIXED_CATALOGUE' || input.verifiedShopId) {
      const inherited = policy.modelBinding.kind === 'VERIFIED_SHOP_INHERIT'
        ? await resolveProductionCommerceModel({ db, environment: commerceEnvironment, shopId: input.verifiedShopId! }) : null;
      const modelId = policy.modelBinding.kind === 'FIXED_CATALOGUE' ? policy.modelBinding.modelCatalogueEntryId : inherited!.model.catalogueEntryId;
      const entry = await db.commerceModelCatalogueEntry.findUnique({ where: { id: modelId }, include: { availability: true } });
      if (!entry || !entry.enabled || !entry.availability.enabled || !Number.isSafeInteger(entry.editVersion) || entry.editVersion < 1 || !Number.isSafeInteger(entry.availability.editVersion) || entry.availability.editVersion < 1) return null;
      if (policy.modelBinding.kind === 'FIXED_CATALOGUE' && (entry.availability.scope !== 'PLATFORM' || entry.availability.shopId !== null)) return null;
      const resolved = ResolvedCommerceModelSchema.parse({
        environment: commerceEnvironment, sourceScope: entry.availability.scope, sourceShopId: entry.availability.shopId,
        catalogueEntryId: entry.id, provider: entry.provider, providerModelId: entry.providerModelId,
        configurationSchemaVersion: entry.configurationSchemaVersion, configuration: entry.configuration,
      });
      if (inherited && canonicalJson(inherited.model) !== canonicalJson(resolved)) return null;
      model = { resolved, catalogueEditVersion: entry.editVersion, availabilityId: entry.availabilityId, availabilityEditVersion: entry.availability.editVersion, selectionSource: inherited?.selectionSource ?? 'FIXED_CATALOGUE' };
    }
    const configurationSnapshot: Prisma.InputJsonObject = {
      schemaVersion: 1, rowId: row.id, environment: row.environment, version: row.version,
      policy: policy as unknown as Prisma.InputJsonObject,
      prompt: { revisionId: prompt.id, contentHash: prompt.contentHash! },
      model: model as unknown as Prisma.InputJsonValue,
      verifiedShopId: input.verifiedShopId ?? null,
    };
    return { rowId: row.id, version: row.version, environment: row.environment, decisionTTLms: policy.decisionTTLms, retentionMs: policy.retentionMs,
      policy, prompt: { revisionId: prompt.id, contentHash: prompt.contentHash!, promptText: prompt.promptText }, model,
      verifiedShopId: input.verifiedShopId ?? null, commerceEnvironment, configurationSnapshot };
  } catch (error) {
    try {
      (logger ?? createLogger({ serviceName: 'moda-messaging-worker', environment: input.environment })).warn(
        'recovery.routing.policy_read_failed', {
          environment: input.environment, stage: 'readRoutingPolicy',
          ...sourceFailureFields(error, 'routing-policy', 'ROUTING_POLICY_READ_FAILED', [], 'internal'),
          operation: 'routing.policy.read',
        });
    } catch { /* Diagnostic sink failure must not affect the fail-closed policy decision. */ }
    return null;
  }
}

/** SQL-only use inside the final short transaction. Compare the complete saved revision evidence under row share locks. */
export async function assertCurrentRoutingPolicy(tx: Prisma.TransactionClient, snapshot: RoutingPolicySnapshot): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{id:string}>>(`SELECT id FROM public."PlatformConfiguration" WHERE id=$1 AND environment=$2 AND key='recovery.routingAgent' AND version=$3 FOR SHARE`, snapshot.rowId, snapshot.environment, snapshot.version);
  if (rows.length !== 1) throw new Error('ROUTING_POLICY_CHANGED');
  await tx.$queryRawUnsafe(`SELECT id FROM commerce."CommerceAgentPromptRevision" WHERE id=$1 FOR SHARE`, snapshot.prompt.revisionId);
  if (snapshot.model) {
    await tx.$queryRawUnsafe(`SELECT id FROM commerce."CommerceModelCatalogueEntry" WHERE id=$1 FOR SHARE`, snapshot.model.resolved.catalogueEntryId);
    await tx.$queryRawUnsafe(`SELECT id FROM commerce."CommerceModelAvailability" WHERE id=$1 FOR SHARE`, snapshot.model.availabilityId);
  }
  if (snapshot.policy.modelBinding.kind === 'VERIFIED_SHOP_INHERIT' && snapshot.verifiedShopId) {
    await tx.$queryRawUnsafe(`SELECT id FROM commerce."CommerceAgentConfiguration" WHERE environment::text=$1 AND (scope='PLATFORM' OR "shopId"=$2) ORDER BY id FOR SHARE`, snapshot.commerceEnvironment, snapshot.verifiedShopId);
    await tx.$queryRawUnsafe(`SELECT id FROM billing."Subscription" WHERE "shopId"=$1 FOR SHARE`, snapshot.verifiedShopId);
    await tx.$queryRawUnsafe(`SELECT b.id FROM billing."BillingPlan" b JOIN billing."Subscription" s ON s."planId"=b.id WHERE s."shopId"=$1 FOR SHARE OF b`, snapshot.verifiedShopId);
    await tx.$queryRawUnsafe(`SELECT p.id FROM billing."MerchantPricingPlan" p JOIN billing."BillingPlan" b ON b."shopifyPlanHandle"=p."shopifyPlanHandle" JOIN billing."Subscription" s ON s."planId"=b.id WHERE s."shopId"=$1 FOR SHARE OF p`, snapshot.verifiedShopId);
  }
  // Reuse the existing inherited model resolver without opening a nested transaction.
  const transactionDatabase = Object.assign(Object.create(tx), { $transaction: async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(tx) }) as PrismaClient;
  const current = await readRoutingPolicy(transactionDatabase, { environment: snapshot.environment, ...(snapshot.verifiedShopId ? { verifiedShopId: snapshot.verifiedShopId } : {}) });
  if (!current || canonicalJson(current.configurationSnapshot) !== canonicalJson(snapshot.configurationSnapshot)) throw new Error('ROUTING_POLICY_CHANGED');
}
