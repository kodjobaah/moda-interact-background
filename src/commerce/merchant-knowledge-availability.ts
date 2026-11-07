import type { PrismaClient } from '@prisma/client';

/** Remove optional knowledge from model discovery when the merchant has not opted in.
 * MCP retains all execution-time entitlement, tenant and grant checks. */
export async function filterMerchantKnowledgeAvailability(
  prisma: Pick<PrismaClient, 'shopFeaturePreference'>, shopId: string, names: Set<string>,
): Promise<Set<string>> {
  if (!names.has('merchant_knowledge_lookup')) return names;
  const preference = await prisma.shopFeaturePreference.findFirst({
    where: { shopId, enabled: true, feature: { key: 'merchant_knowledge', active: true } }, select: { id: true },
  });
  if (!preference) names.delete('merchant_knowledge_lookup');
  return names;
}
