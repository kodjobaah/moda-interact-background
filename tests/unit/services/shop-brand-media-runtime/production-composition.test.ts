import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  readSettings: vi.fn(),
}));
vi.mock("../../../../src/lib/db.js", () => ({
  default: { shopBrand: { findUnique: mocks.findUnique } },
}));
vi.mock("../../../../src/services/platform-configuration/consumers.js", () => ({
  readShopBrandPublicMediaConfiguration: mocks.readSettings,
}));
vi.mock("../../../../src/services/whatsapp.service.js", () => ({
  whatsAppService: { getProviderAccountId: async () => "waba-1" },
}));

import { RecoveryTemplatePreparer } from
  "../../../../src/services/recovery-template-preparation/recovery-template-preparer.service.js";
import type { AssignedVariantRow, RecoveryTemplateRepository } from
  "../../../../src/services/recovery-template-preparation/recovery-template.types.js";

const vector = JSON.parse(readFileSync(new URL("../../../fixtures/arch049-admin-media-header-projection.json", import.meta.url), "utf8")) as {
  componentsSnapshot: unknown[]; parameterBindingsSnapshot: unknown; submittedContentHash: string;
};
const now = new Date("2026-10-27T12:00:00Z");
const digest = "a".repeat(64), sourceFingerprint = `sha256:${"b".repeat(64)}`;
function shopMedia() {
  return { schemaVersion: 1, roles: { LOGO: {
    source: { url: "https://merchant.example/original.jpg", fingerprint: sourceFingerprint, generation: 1 },
    work: { status: "READY" },
    ready: { sourceGeneration: 1, sourceFingerprint,
      objectKey: `shop-brands/shop.example/logo/sha256-${digest}.jpg`,
      contentType: "image/jpeg", width: 1125, height: 600, sizeBytes: 12000,
      contentSha256: digest, verifiedAt: now.toISOString() },
  } } };
}
function instance(components: unknown = vector.componentsSnapshot,
  bindings: unknown = vector.parameterBindingsSnapshot,
  contentHash: string = vector.submittedContentHash) {
  const registration = {
    id: "reg-1", wabaId: "waba-1", providerTemplateName: "moda_media_header",
    providerLanguageCode: "en_US", providerTemplateId: "meta-1", category: "MARKETING",
    providerStatus: "APPROVED", submissionState: "SUBMITTED", failureCode: null,
    driftDetectedAt: null, lastObservedContentHash: contentHash, lastObservedCategory: "MARKETING",
    submittedContentHash: contentHash, componentsSnapshot: components, parameterBindingsSnapshot: bindings,
    locale: { id: "loc-1", languageTag: "en", providerLanguageCode: "en_US", status: "REVIEWED",
      contentHash, definition: { id: "def-1", kind: "META_RECOVERY", purpose: "FOLLOW_UP",
        offerType: "NO_OFFER", status: "PUBLISHED", category: "MARKETING",
        providerTemplateName: "moda_media_header", publishedAt: now, retiredAt: null } },
  };
  const variant = { id: "variant-1", shopId: "shop-1", providerAccountId: "waba-1",
    purpose: "FOLLOW_UP_NO_OFFER", languageTag: "en", providerLanguageCode: "en_US",
    providerTemplateName: "moda_media_header", providerTemplateId: "meta-1", status: "APPROVED",
    enabled: true, metaRegistrationId: "reg-1", metaRegistration: registration } as AssignedVariantRow;
  const readShopBrand = vi.fn(async () => null);
  const repo = { readCatalogue: vi.fn(async () => ({
    shop: { id: "shop-1", status: "ACTIVE", defaultLanguageTag: "en" }, variants: [variant],
  })), readShopBrand } satisfies RecoveryTemplateRepository;
  const logs = { warn: vi.fn(), error: vi.fn() };
  // No third/fourth arguments: requires the real production media adapter.
  const preparer = new RecoveryTemplatePreparer(repo, async () => "waba-1", undefined, undefined,
    () => now, logs);
  const input = { shopId: "shop-1", senderWabaId: "waba-1", stage: "FOLLOW_UP" as const,
    offerPresentation: "NO_OFFER" as const, conversationLanguageTag: null, merchantLanguageTag: "en",
    customerFirstName: "Alex", shopName: { shopId: "shop-1", value: "Example Shop" } };
  return { preparer, input, readShopBrand, logs };
}

beforeEach(() => {
  // Reset queued one-shot implementations as well as call history: a TEXT-only
  // preparation must not leave an unused media-config mock for the next test.
  vi.resetAllMocks();
  mocks.readSettings.mockResolvedValue({ publicOrigin: "https://shop-brands.modainteract.com/", bucketName: "brand-bucket" });
  mocks.findUnique.mockResolvedValue({ shopId: "shop-1", shop: { domain: "shop.example" },
    whatsAppMedia: shopMedia() });
});

describe("ARCH-049-BACKGROUND-004 production RecoveryTemplatePreparer wiring", () => {
  it("injects the current verified R2 media resolver and real public-origin reader", async () => {
    const { preparer, input, readShopBrand } = instance();
    const outcome = await preparer.prepare(input);
    expect(outcome).toMatchObject({ outcome: "prepared", template: { components: [
      { type: "header", parameters: [{ type: "image", image: { link:
        `https://shop-brands.modainteract.com/shop-brands/shop.example/logo/sha256-${digest}.jpg` } }] },
      { type: "body", parameters: [
        { type: "text", text: "Alex" },
        { type: "text", text: "Example Shop" },
      ] },
    ] } });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { shopId: "shop-1" },
      select: { shopId: true, whatsAppMedia: true, shop: { select: { domain: true } } } });
    expect(mocks.readSettings).toHaveBeenCalled();
    expect(readShopBrand).toHaveBeenCalledWith("shop-1");
  });

  it("does not access media config or media database for TEXT-only templates", async () => {
    const components = [{ type: "BODY", text: "Hello {{1}}" }];
    const bindings = { header: [], body: [{ position: 1, variable: "customer.firstName" }], buttons: [] };
    // Admin's exact v1 frozen hash for this independent TEXT projection.
    const { createHash } = await import("node:crypto");
    function stable(value: unknown): string {
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
      return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
    }
    const hash = createHash("sha256").update(stable({ schemaVersion: 1, family: "META_RECOVERY",
      category: "MARKETING", components, parameterBindings: bindings })).digest("hex");
    const { preparer, input } = instance(components, bindings, hash);
    expect(await preparer.prepare(input)).toMatchObject({ outcome: "prepared", template: {
      components: [{ type: "body", parameters: [{ type: "text", text: "Alex" }] }],
    } });
    expect(mocks.readSettings).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns MEDIA_NOT_READY for missing current role and logs unexpected config failures without leaking details", async () => {
    const { preparer, input, logs } = instance();
    mocks.findUnique.mockResolvedValueOnce({ shopId: "shop-1", shop: { domain: "shop.example" },
      whatsAppMedia: {} });
    expect(await preparer.prepare(input)).toMatchObject({ outcome: "unavailable", reason: "MEDIA_NOT_READY" });
    const sensitiveError = new Error("secret with checkout URL and token");
    mocks.readSettings.mockRejectedValueOnce(sensitiveError);
    await expect(preparer.prepare(input)).rejects.toBe(sensitiveError);
    expect(logs.error).toHaveBeenCalledWith("recovery_template.prepare.failed", expect.objectContaining({
      shopId: "shop-1", errorType: "Error",
    }));
    expect(JSON.stringify(logs.error.mock.calls)).not.toContain("secret with checkout URL");
  });
});
