import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RecoveryTemplatePreparer } from "../../../../src/services/recovery-template-preparation/recovery-template-preparer.service.js";
import type {
  AssignedVariantRow, RecoveryTemplateRepository, RegistrationRow,
} from "../../../../src/services/recovery-template-preparation/recovery-template.types.js";
import { templateSendFields } from "../../../../src/services/recovery-template-integration/prepared-template-send.js";
import { prepareAutomatedTemplateInput } from "../../../../src/services/conversation-moderation/automated-template-input.js";

// Copy of the ADMIN-002 checked-in prepared projection. This fixture must remain
// identical across repositories: an independent runtime hash, not a new compiler.
const adminVector = JSON.parse(readFileSync(new URL("../../../fixtures/arch049-admin-media-header-projection.json", import.meta.url), "utf8")) as {
  componentsSnapshot: unknown[];
  parameterBindingsSnapshot: Record<string, unknown>;
  submittedContentHash: string;
};
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
const hash = (components: unknown, bindings: unknown): string => createHash("sha256")
  .update(stableJson({ schemaVersion: 1, family: "META_RECOVERY", category: "MARKETING",
    components, parameterBindings: bindings }), "utf8").digest("hex");
const now = new Date("2026-10-27T12:00:00Z");

function fixture(role: string = "LOGO", overrides: { bindings?: unknown; components?: unknown;
  digest?: string; stage?: "INITIAL" | "FOLLOW_UP" } = {}) {
  const components = overrides.components ?? adminVector.componentsSnapshot;
  const bindings = overrides.bindings ?? { ...adminVector.parameterBindingsSnapshot, headerMediaRole: role };
  const digest = overrides.digest ?? hash(components, bindings);
  const stage = overrides.stage ?? "INITIAL";
  const registration = {
    id: "reg-1", wabaId: "waba-1", providerTemplateName: "moda_arch049_media",
    providerLanguageCode: "en_US", providerTemplateId: "meta-1", category: "MARKETING",
    providerStatus: "APPROVED", submissionState: "SUBMITTED", failureCode: null,
    driftDetectedAt: null, lastObservedContentHash: digest, lastObservedCategory: "MARKETING",
    submittedContentHash: digest, componentsSnapshot: components, parameterBindingsSnapshot: bindings,
    locale: { id: "loc-1", languageTag: "en", providerLanguageCode: "en_US", status: "REVIEWED",
      contentHash: digest, definition: { id: "def-1", kind: "META_RECOVERY", purpose: stage,
        offerType: "NO_OFFER", status: "PUBLISHED", category: "MARKETING",
        providerTemplateName: "moda_arch049_media", publishedAt: now, retiredAt: null } },
  } as RegistrationRow;
  const variant = { id: "variant-1", shopId: "shop-1", providerAccountId: "waba-1",
    purpose: `${stage}_NO_OFFER`, languageTag: "en", providerLanguageCode: "en_US",
    providerTemplateName: "moda_arch049_media", providerTemplateId: "meta-1", status: "APPROVED",
    enabled: true, metaRegistrationId: "reg-1", metaRegistration: registration } as AssignedVariantRow;
  return { variant, registration };
}

function setup(role: string, options: Parameters<typeof fixture>[1] = {}) {
  const { variant } = fixture(role, options);
  const readShopBrand = vi.fn(async () => null);
  const repository = { readCatalogue: vi.fn(async () => ({
    shop: { id: "shop-1", status: "ACTIVE", defaultLanguageTag: "en" }, variants: [variant],
  })), readShopBrand } satisfies RecoveryTemplateRepository;
  const resolveMedia = vi.fn(async (shopId: string, mediaRole: string) => ({
    shopId, role: mediaRole as "LOGO", kind: "R2_DERIVATIVE" as const, status: "READY" as const,
    httpsUrl: `https://media.modainteract.com/shop-brands/${shopId}/${mediaRole.toLowerCase()}/image.jpg`,
  }));
  const logger = { warn: vi.fn(), error: vi.fn() };
  const preparer = new RecoveryTemplatePreparer(repository, async () => "waba-1",
    resolveMedia, ["media.modainteract.com"], () => now, logger);
  const input = { shopId: "shop-1", senderWabaId: "waba-1", stage: options?.stage ?? "INITIAL",
    offerPresentation: "NO_OFFER" as const, conversationLanguageTag: null, merchantLanguageTag: "en",
    customerFirstName: "Alex", shopName: { shopId: "shop-1", value: "Example Shop" } };
  return { preparer, input, resolveMedia, readShopBrand, logger };
}

describe("ARCH-049 Admin frozen-image projection and BG006 pass-through", () => {
  it("matches the literal Admin SHA256 vector, including headerMediaRole", () => {
    expect(hash(adminVector.componentsSnapshot, adminVector.parameterBindingsSnapshot))
      .toBe(adminVector.submittedContentHash);
  });

  it.each(["LOGO", "SQUARE_LOGO", "COVER_IMAGE"])("prepares %s and leaves image unchanged at final-send input", async (role) => {
    const { preparer, input, resolveMedia, readShopBrand } = setup(role);
    const prepared = await preparer.prepare(input);
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") return;
    const link = `https://media.modainteract.com/shop-brands/shop-1/${role.toLowerCase()}/image.jpg`;
    expect(prepared.bindingFingerprint).toBe(prepared.submittedContentHash);
    expect(prepared.template.components).toEqual([
      { type: "header", parameters: [{ type: "image", image: { link } }] },
      { type: "body", parameters: [{ type: "text", text: "Alex" },
        { type: "text", text: "Example Shop" }] },
    ]);
    expect(resolveMedia).toHaveBeenCalledWith("shop-1", role);
    expect(readShopBrand).toHaveBeenCalledWith("shop-1");
    const sent = templateSendFields(prepared, { kind: "NO_OFFER" });
    const boundary = prepareAutomatedTemplateInput({ ...sent, to: "+447400123456" });
    expect(boundary.providerInput.imageHeader).toEqual({ link });
    expect(boundary.providerInput.bodyParameters).toEqual(["Alex", "Example Shop"]);
    expect(boundary.providerInput.templateRegistration).toBeUndefined();
    expect(boundary.effectiveText).not.toContain(link);
  });

  it("keeps Admin's original fixed LOGO fingerprint rather than recomputing a different projection", async () => {
    const { preparer, input } = setup("LOGO", { digest: adminVector.submittedContentHash });
    const prepared = await preparer.prepare(input);
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome === "prepared") {
      expect(prepared.bindingFingerprint).toBe(adminVector.submittedContentHash);
    }
  });

  it.each(["INITIAL", "FOLLOW_UP"] as const)("supports %s without changing BG006 send semantics", async (stage) => {
    const { preparer, input } = setup("COVER_IMAGE", { stage });
    const prepared = await preparer.prepare(input);
    expect(prepared).toMatchObject({ outcome: "prepared", purpose: `${stage}_NO_OFFER` });
    if (prepared.outcome === "prepared") {
      expect(templateSendFields(prepared, { kind: "NO_OFFER" }).imageHeader).toEqual({
        link: "https://media.modainteract.com/shop-brands/shop-1/cover_image/image.jpg",
      });
    }
  });

  it("fails closed for missing/unknown/mismatched/duplicate or tampered media role bindings", async () => {
    const { componentsSnapshot: components, parameterBindingsSnapshot: original } = adminVector;
    for (const bindings of [
      { header: [], body: original.body, buttons: [] },
      { ...original, headerMediaRole: "headerImage" },
      { ...original, headerMediaRole: "UNKNOWN" },
      { ...original, headerMediaRole: "LOGO", header: [{ position: 1, variable: "shop.name" }] },
      { ...original, headerMediaRole: "LOGO", schemaVersion: 2 },
      { ...original, headerMediaRole: "LOGO", extraMediaRole: "COVER_IMAGE" },
    ]) {
      const { preparer, input, resolveMedia } = setup("LOGO", { components, bindings });
      expect(await preparer.prepare(input)).toMatchObject({ outcome: "unavailable", reason: "BINDINGS_INVALID" });
      expect(resolveMedia).not.toHaveBeenCalled();
    }
    const mismatched = setup("LOGO", { digest: "f".repeat(64) });
    expect(await mismatched.preparer.prepare(mismatched.input)).toMatchObject({
      outcome: "unavailable", reason: "BINDING_FINGERPRINT_MISMATCH",
    });
    const text = setup("LOGO", { components: [{ type: "HEADER", format: "TEXT", text: "Hello" },
      { type: "BODY", text: "Hi {{1}} {{2}}" }] });
    expect(await text.preparer.prepare(text.input)).toMatchObject({
      outcome: "unavailable", reason: "BINDINGS_INVALID",
    });
  });

  it("preserves a correctly frozen TEXT header and does not resolve image media", async () => {
    const components = [
      { type: "HEADER", format: "TEXT", text: "Hello {{1}}" },
      { type: "BODY", text: "Welcome {{1}}" },
    ];
    const bindings = { schemaVersion: 1,
      header: [{ position: 1, variable: "shop.name" }],
      body: [{ position: 1, variable: "customer.firstName" }], buttons: [] };
    const { preparer, input, resolveMedia } = setup("LOGO", { components, bindings });
    expect(await preparer.prepare(input)).toMatchObject({ outcome: "prepared", template: {
      components: [
        { type: "header", parameters: [{ type: "text", text: "Example Shop" }] },
        { type: "body", parameters: [{ type: "text", text: "Alex" }] },
      ],
    } });
    expect(resolveMedia).not.toHaveBeenCalled();
  });
});
