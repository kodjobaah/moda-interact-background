import { expect, it, vi } from "vitest";
import { MerchantFollowUpOfferService } from "../../../../src/services/recovery-offers/merchant-follow-up-offer.service.js";

const offerSet = { schemaVersion: "moda.outreach.checkout-offers.v1", offers: [
  { offerId: "coupon-row", providerDiscountId: "woo:coupon:7", method: "CODE", code: "PICK15" },
] };
const input = { shopId: "shop", checkoutRecoveryId: "recovery", outreachAttemptId: "follow-up", offerSet };
function fixture(changed = false, unavailable = false) {
  const member = { ...offerSet.offers[0], code: changed ? "OTHER" : "PICK15", description: "15 percent" };
  const verify = vi.fn(async (_input: unknown) => unavailable ? { kind: "NO_VERIFIED_OFFER" } : {
    kind: "VALIDATED", result: { kind: "CHECKOUT_DISCOUNT", members: [member],
      offerSet: { ...offerSet, offers: [{ ...offerSet.offers[0], code: member.code }] } },
    admissionToken: { shopId: "shop" },
  });
  const context = { build: vi.fn(async () => ({ basket: { generation: 1, fingerprint: "a".repeat(64) }, priceReconciliation: null })) };
  const service = new MerchantFollowUpOfferService(context as never, {
    revalidateCurrentOutreachOffer: verify, validateAdmission: vi.fn(),
  } as never);
  return { service, verify };
}
it("revalidates the exact persisted offer without model selection", async () => {
  const { service, verify } = fixture();
  await expect(service.verify(input)).resolves.toMatchObject({ member: { code: "PICK15" } });
  expect(verify.mock.calls[0]?.[0]).toMatchObject({ proposed: {
    offerSet, members: [{ eligibility: { verdict: "UNVERIFIABLE" } }],
  } });
});
it("refuses missing eligibility, changed coupon, and malformed historical identity", async () => {
  await expect(fixture(false, true).service.verify(input)).resolves.toBeNull();
  await expect(fixture(true).service.verify(input)).resolves.toBeNull();
  const test = fixture();
  await expect(test.service.verify({ ...input, offerSet: { ...offerSet, offers: [
    { ...offerSet.offers[0], providerDiscountId: null },
  ] } })).resolves.toBeNull();
  expect(test.verify).not.toHaveBeenCalled();
});
