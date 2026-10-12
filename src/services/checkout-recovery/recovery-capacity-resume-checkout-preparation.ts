import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import type { abandonedCheckoutLookupService } from "../abandoned-checkout-lookup.service.js";
import type { recoverySnapshotBuilderService } from "./recovery-snapshot-builder.service.js";
import type { RecoveryRecipientResolverService } from "./recovery-recipient-resolver.service.js";

type AbandonedCheckoutLookupPort = Pick<typeof abandonedCheckoutLookupService, "lookup">;
type RecoverySnapshotBuilderPort = Pick<typeof recoverySnapshotBuilderService, "build">;
type RecoveryRecipientResolverPort = Pick<RecoveryRecipientResolverService, "resolve" | "resolveForCustomerInShop">;

export async function prepareRecoveryCapacityResumeCheckout(input: {
  recovery: {
    id: string;
    shopId: string;
    checkoutToken: string;
    cartToken: string | null;
    checkoutUrl: string | null;
    detectedAt: Date;
    customerId: string | null;
  };
  shopDomain: string;
  lookup: AbandonedCheckoutLookupPort;
  snapshotBuilder: RecoverySnapshotBuilderPort;
  recipientResolver: RecoveryRecipientResolverPort;
}) {
  const { recovery, shopDomain, lookup, snapshotBuilder, recipientResolver } = input;
  const outcome = await lookup.lookup({
    shopId: recovery.shopId,
    shopDomain,
    checkoutToken: recovery.checkoutToken,
    cartToken: recovery.cartToken,
    abandonedCheckoutUrl: recovery.checkoutUrl,
    checkoutCreatedAt: recovery.detectedAt.toISOString(),
  });
  if (outcome.kind === "provider-error") {
    throw new Error(
      `Abandoned checkout provider error while resuming recovery ${recovery.id}: ${outcome.message}`,
    );
  }
  if (outcome.kind === "ambiguous" || outcome.kind === "bounded-limit-exceeded") {
    throw new Error(
      `Abandoned checkout lookup ${outcome.kind} while resuming recovery ${recovery.id}`,
    );
  }

  const terminal = outcome.kind === "not-found" || outcome.checkout.completedAt !== null;
  let seed: RecoveryCheckoutSeed | null = null;
  let recipient: string | null = null;
  if (!terminal && outcome.kind === "found") {
    const candidate: PendingRecoveryCandidate = {
      shopId: recovery.shopId,
      shopDomain,
      checkoutToken: recovery.checkoutToken,
      cartToken: recovery.cartToken,
      abandonedCheckoutUrl: recovery.checkoutUrl,
      checkoutCreatedAt: recovery.detectedAt.toISOString(),
    };
    seed = await snapshotBuilder.build(candidate, shopDomain, outcome.checkout);
    recipient = await recipientResolver.resolve(seed) ??
      (recovery.customerId
        ? await recipientResolver.resolveForCustomerInShop(recovery.customerId, recovery.shopId)
        : null);
  }

  return { outcome, terminal, seed, recipient };
}