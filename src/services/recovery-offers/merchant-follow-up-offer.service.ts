import { InitialOutreachCheckoutOfferSetSchema, canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import prisma from "../../lib/db.js";
import { resolveCommerceEnvironment } from "../../commerce/model-environment.js";
import { productionContextBuilder } from "./initial-outreach-offer-selection.service.js";
import { RecoveryOutreachMcpSelectorService } from "./recovery-outreach-mcp-selector.service.js";
import { CurrentOutreachOfferRevalidationService, type CurrentOutreachOfferAdmissionToken } from "./current-outreach-offer-revalidation.service.js";

/** Revalidate the exact coupon promised in the provider-confirmed first message.
 * No model selection runs here and no replacement coupon is permitted. */
export class MerchantFollowUpOfferService {
  constructor(
    private readonly context = productionContextBuilder(prisma, resolveCommerceEnvironment(),
      input => new RecoveryOutreachMcpSelectorService(input), "FOLLOW_UP"),
    private readonly verifier: Pick<CurrentOutreachOfferRevalidationService,
      "revalidateCurrentOutreachOffer" | "validateAdmission"> =
      new CurrentOutreachOfferRevalidationService({ contextBuilder: context }),
  ) {}

  async verify(input: { shopId: string; checkoutRecoveryId: string; outreachAttemptId: string; offerSet: unknown }) {
    const parsed = InitialOutreachCheckoutOfferSetSchema.safeParse(input.offerSet);
    if (!parsed.success || parsed.data.offers.length !== 1 ||
        parsed.data.offers.some(offer => !offer.providerDiscountId)) return null;
    const signal = AbortSignal.timeout(30_000);
    const context = await this.context.build({ ...input, signal });
    const offerSet = parsed.data;
    const result = await this.verifier.revalidateCurrentOutreachOffer({ ...input, signal,
      proposed: { kind: "CHECKOUT_DISCOUNT", shopId: input.shopId,
        checkoutRecoveryId: input.checkoutRecoveryId, outreachAttemptId: input.outreachAttemptId,
        generation: context.basket.generation, fingerprint: context.basket.fingerprint,
        offerSet, priceReconciliation: context.priceReconciliation, discoveryIncomplete: false,
        // These are proposals only. The verifier replaces all eligibility and group evidence.
        members: offerSet.offers.map(offer => ({ ...offer, providerDiscountId: offer.providerDiscountId!, description: "Previously promised coupon",
          eligibility: { offerId: offer.offerId, verdict: "UNVERIFIABLE", eligibleLineKeys: [], reasonCodes: [] } })),
        group: { verdict: "UNVERIFIABLE", offerIds: offerSet.offers.map(offer => offer.offerId), reasonCodes: [] },
      } });
    if (result.kind !== "VALIDATED" || result.result.kind !== "CHECKOUT_DISCOUNT" ||
        canonicalJson(result.result.offerSet) !== canonicalJson(offerSet)) return null;
    return { member: result.result.members[0]!, admissionToken: result.admissionToken };
  }

  validateAdmission(token: CurrentOutreachOfferAdmissionToken, signal: AbortSignal) {
    return this.verifier.validateAdmission(token, signal);
  }
}
export const merchantFollowUpOfferService = new MerchantFollowUpOfferService();
