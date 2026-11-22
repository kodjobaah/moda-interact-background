import type { Prisma } from "@prisma/client";

export type ShopifyUsageEventMapping = {
  mappedProviderHandles: string[];
  unmappedProviderHandles: string[];
};

type UsageEventCatalogueReader = Pick<Prisma.TransactionClient, "merchantPricingPlan">;

/**
 * Compares only the usage-event handles Shopify actually attached to the observed
 * subscription with the exact event handles authored on the matching merchant plan.
 * The caller owns persistence and must write `unmappedProviderHandles` in its
 * existing subscription-projection transaction.
 */
export async function resolveShopifyUsageEventMapping(
  transaction: UsageEventCatalogueReader,
  planHandle: string,
  providerUsageEventHandles: readonly string[],
): Promise<ShopifyUsageEventMapping> {
  const providerHandles = [...new Set(providerUsageEventHandles)].sort(compareExactHandles);
  if (providerHandles.length === 0) {
    return { mappedProviderHandles: [], unmappedProviderHandles: [] };
  }

  const catalogue = await transaction.merchantPricingPlan.findUnique({
    where: { shopifyPlanHandle: planHandle },
    select: { usageEvents: { select: { eventHandle: true } } },
  });
  const catalogueHandles = new Set(catalogue?.usageEvents.map((event) => event.eventHandle) ?? []);
  const mappedProviderHandles: string[] = [];
  const unmappedProviderHandles: string[] = [];

  for (const handle of providerHandles) {
    (catalogueHandles.has(handle) ? mappedProviderHandles : unmappedProviderHandles).push(handle);
  }

  return { mappedProviderHandles, unmappedProviderHandles };
}

function compareExactHandles(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
