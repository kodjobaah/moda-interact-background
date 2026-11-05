import type { CommerceShippingInformation } from "@modainteract/moda-interact-shared/commerce";

export type ShippingPresentation = Readonly<{
  requiresShipping: boolean | null;
  policyUrl: string | null;
  limitation: boolean;
}>;

function safeAvailablePolicyUrl(source: CommerceShippingInformation): string | null {
  if (source.policy.status !== "AVAILABLE" || !source.policy.url) return null;
  try {
    const url = new URL(source.policy.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash
      ? source.policy.url : null;
  } catch { return null; }
}

export function selectShippingPresentation(input: {
  selection: Readonly<{ productId: string | null; variantId: string | null }>;
  observation: CommerceShippingInformation | null;
  refreshed: CommerceShippingInformation | null;
}): ShippingPresentation {
  const source = input.refreshed;
  if (!source || source.product.productId !== input.selection.productId ||
      source.product.variantId !== input.selection.variantId ||
      source.provider !== input.observation?.provider) {
    return Object.freeze({ requiresShipping: null, policyUrl: null, limitation: true });
  }
  const policyUrl = safeAvailablePolicyUrl(source);
  return Object.freeze({
    requiresShipping: source.product.status === "AVAILABLE" ? source.product.requiresShipping : null,
    policyUrl,
    limitation: source.product.status !== "AVAILABLE" || source.product.requiresShipping === null ||
      source.policy.status !== "AVAILABLE" || source.policy.trust === "UNTRUSTED_REFERENCE",
  });
}
