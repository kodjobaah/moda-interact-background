import prisma from "../../lib/db.js";
import type { NormalizedAbandonedCheckout } from "../../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";
import {
  resolveRecoveryInternationalContext,
  serializeRecoveryLineItems,
  toRecoverySeed,
} from "./recovery-mappers.js";

export class RecoverySnapshotBuilderService {
  async build(
    candidate: PendingRecoveryCandidate,
    shopDomain: string,
    checkout: NormalizedAbandonedCheckout,
  ): Promise<RecoveryCheckoutSeed> {
    const shop = await prisma.shop.findUnique({
      where: { id: candidate.shopId },
      select: {
        settings: {
          select: {
            defaultLanguageTag: true,
            defaultCountryCode: true,
            defaultTimeZone: true,
          },
        },
      },
    });
    const internationalContext = resolveRecoveryInternationalContext(
      candidate,
      checkout,
      shop?.settings,
    );

    return toRecoverySeed(candidate, shopDomain, checkout, internationalContext);
  }

  serializeLineItems(
    lineItems: NormalizedAbandonedCheckout["lineItems"],
  ): RecoveryCheckoutSeed["lineItems"] {
    return serializeRecoveryLineItems(lineItems);
  }
}

export const recoverySnapshotBuilderService = new RecoverySnapshotBuilderService();