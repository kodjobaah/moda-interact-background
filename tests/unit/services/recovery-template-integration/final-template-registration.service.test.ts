import { describe, expect, it, vi } from "vitest";
import { checkFinalTemplateRegistration, type FinalTemplateIdentity } from
  "../../../../src/services/recovery-template-integration/final-template-registration.service.js";

const hash = "a".repeat(64);
const now = new Date("2026-10-26T09:00:00.000Z");
const identity: FinalTemplateIdentity = {
  shopId: "shop-1", senderWabaId: "waba-1", purpose: "INITIAL_NO_OFFER",
  variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
  providerTemplateId: "meta-1", providerTemplateName: "moda_initial", providerLanguageCode: "en_US",
  submittedContentHash: hash, bindingFingerprint: hash,
};
const approved = {
  variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
  shopId: "shop-1", purpose: "INITIAL_NO_OFFER", wabaId: "waba-1",
  providerTemplateId: "meta-1", providerTemplateName: "moda_initial", providerLanguageCode: "en_US",
  submittedContentHash: hash, variantStatus: "APPROVED", enabled: true,
  category: "MARKETING", providerStatus: "APPROVED", submissionState: "SUBMITTED",
  failureCode: null, lastReconciledAt: new Date("2026-10-26T08:40:00.000Z"),
  lastObservedContentHash: hash, lastObservedCategory: "MARKETING", driftDetectedAt: null,
  definitionStatus: "PUBLISHED", definitionKind: "META_RECOVERY", definitionPurpose: "INITIAL",
  definitionOfferType: "NO_OFFER", definitionName: "moda_initial", definitionCategory: "MARKETING",
  publishedAt: new Date("2026-10-25T00:00:00Z"), retiredAt: null,
  localeStatus: "REVIEWED", localeLanguageCode: "en_US", localeContentHash: hash,
  unresolvedObservation: false,
};
const harness = (row: unknown) => {
  const query = vi.fn(async (_statement: string, ..._params: unknown[]) => row === null ? [] : [row]);
  return { tx: { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn() } as never, query };
};

describe("ARCH-047 final SQL template registration permit", () => {
  it("permits the exact approved registration with a fresh verified Meta projection", async () => {
    const f = harness(approved);
    expect(await checkFinalTemplateRegistration(f.tx, identity, now)).toBeNull();
    expect(f.query).toHaveBeenCalledOnce();
    const [sql, variantId, shopId, registrationId] = f.query.mock.calls[0]!;
    expect(sql).toContain("FOR SHARE OF v,r,l,d");
    expect(sql).toContain('e."outcome"=\'RECONCILIATION_PENDING\'');
    expect([variantId, shopId, registrationId]).toEqual(["variant-1", "shop-1", "registration-1"]);
  });

  it.each([
    ["missing", null, "TEMPLATE_REGISTRATION_UNAVAILABLE"],
    ["other shop", { ...approved, shopId: "shop-2" }, "TEMPLATE_REGISTRATION_UNAVAILABLE"],
    ["disabled assignment", { ...approved, enabled: false }, "TEMPLATE_REGISTRATION_UNAVAILABLE"],
    ["replaced registration", { ...approved, registrationId: "registration-2" }, "TEMPLATE_REGISTRATION_UNAVAILABLE"],
    ["retired definition", { ...approved, retiredAt: now }, "TEMPLATE_REGISTRATION_UNAVAILABLE"],
    ["unknown Meta status", { ...approved, providerStatus: "UNKNOWN" }, "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"],
    ["paused Meta status", { ...approved, providerStatus: "PAUSED" }, "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"],
    ["disabled Meta status", { ...approved, providerStatus: "DISABLED" }, "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"],
    ["pending webhook", { ...approved, unresolvedObservation: true }, "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"],
    ["provider drift", { ...approved, driftDetectedAt: now }, "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"],
    ["hash drift", { ...approved, lastObservedContentHash: "b".repeat(64) }, "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"],
    ["pending recheck", { ...approved, failureCode: "STATUS_RECONCILIATION_PENDING" }, "TEMPLATE_PROVIDER_STATUS_UNRESOLVED"],
    ["no Meta reconciliation", { ...approved, lastReconciledAt: null }, "TEMPLATE_PROVIDER_STATUS_STALE"],
    ["over 60 minutes", { ...approved, lastReconciledAt: new Date("2026-10-26T07:59:59Z") }, "TEMPLATE_PROVIDER_STATUS_STALE"],
    ["future reconciliation", { ...approved, lastReconciledAt: new Date("2026-10-26T09:01:00Z") }, "TEMPLATE_PROVIDER_STATUS_STALE"],
  ] as const)("denies %s without external provider calls", async (_name, row, reason) => {
    const f = harness(row);
    expect(await checkFinalTemplateRegistration(f.tx, identity, now)).toBe(reason);
    expect(f.query).toHaveBeenCalledOnce();
  });

  it("propagates database errors instead of swallowing provider eligibility failures", async () => {
    const tx = { $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("SQL unavailable")) } as never;
    await expect(checkFinalTemplateRegistration(tx, identity, now)).rejects.toThrow("SQL unavailable");
  });
});
