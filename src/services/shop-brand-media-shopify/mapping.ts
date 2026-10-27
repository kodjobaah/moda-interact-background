import type { SourceObservation } from "../shop-brand-media-orchestration/contracts.js";
import type { ShopifyBrandSnapshot } from "./contracts.js";

/** Square fallback reuses the default logo as INPUT, never pretends Shopify provided squareLogo. */
export function shopifyBrandObservations(shopId: string, snapshot: ShopifyBrandSnapshot): SourceObservation[] {
  const square = snapshot.squareLogo ?? snapshot.logo;
  return [
    { shopId, role: "LOGO", sourceUrl: snapshot.logo?.url ?? null,
      sourceReference: snapshot.logo?.reference ?? null, sourceFingerprint: null,
      observedAt: snapshot.observedAt },
    { shopId, role: "SQUARE_LOGO", sourceUrl: square?.url ?? null,
      sourceReference: square ? `${snapshot.squareLogo ? "square" : "fallback"}:${square.reference}` : null,
      sourceFingerprint: null, observedAt: snapshot.observedAt },
    { shopId, role: "COVER_IMAGE", sourceUrl: snapshot.coverImage?.url ?? null,
      sourceReference: snapshot.coverImage?.reference ?? null, sourceFingerprint: null,
      observedAt: snapshot.observedAt },
  ];
}
