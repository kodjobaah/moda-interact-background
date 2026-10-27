import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RecoveryTemplatePreparer } from "../../../../src/services/recovery-template-preparation/recovery-template-preparer.service.js";
import type {
  AssignedVariantRow, RecoveryTemplatePreparationInput, RecoveryTemplateRepository,
  ReadyBrandMedia, RegistrationRow, ShopBrandRow,
} from "../../../../src/services/recovery-template-preparation/recovery-template.types.js";

const now = new Date("2026-10-25T13:30:00.000Z");
const sourceUrl = "https://shop.example/checkout/checkout-1";
const checkout = { shopId: "shop-1", url: sourceUrl,
  observedAt: new Date(now.getTime() - 15_000), expiresAt: new Date(now.getTime() + 60_000),
  approvedHosts: ["shop.example"] };
const input = (override: Partial<RecoveryTemplatePreparationInput> = {}): RecoveryTemplatePreparationInput => ({
  shopId: "shop-1", senderWabaId: "waba-1", stage: "INITIAL", offerPresentation: "NO_OFFER",
  conversationLanguageTag: "en-US", merchantLanguageTag: "en",
  customerFirstName: "Alex", shopName: { shopId: "shop-1", value: "Merchant" }, checkout,
  ...override,
});

// Admin compiler's fixed v1 canonical hash compatibility vector (source text is
// deliberately excluded; only the immutable submitted compiled projection is read).
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
function snapshotHash(components: unknown, parameterBindings: unknown): string {
  return createHash("sha256").update(stableJson({ schemaVersion: 1, family: "META_RECOVERY",
    category: "MARKETING", components, parameterBindings })).digest("hex");
}
const standardComponents = [
  { type: "BODY", text: "Hello {{1}} from {{2}}", example: { body_text: [["Alex", "Merchant"]] } },
];
const standardBindings = {
  header: [], body: [{ position: 1, variable: "customer.firstName" }, { position: 2, variable: "shop.name" }],
  buttons: [],
};

function fixture(overrides: {
  language?: string; languageCode?: string; stage?: string; offer?: string;
  components?: unknown; bindings?: unknown; variant?: Record<string, unknown>;
  registration?: Record<string, unknown>; definition?: Record<string, unknown>;
  locale?: Record<string, unknown>;
} = {}): AssignedVariantRow {
  const language = overrides.language ?? "en";
  const languageCode = overrides.languageCode ?? "en_US";
  const components = overrides.components ?? standardComponents;
  const bindings = overrides.bindings ?? standardBindings;
  const digest = snapshotHash(components, bindings);
  const definition = {
    id: "definition-1", kind: "META_RECOVERY", purpose: overrides.stage ?? "INITIAL",
    offerType: overrides.offer ?? "NO_OFFER", status: "PUBLISHED", category: "MARKETING",
    providerTemplateName: "moda_initial_no_offer", publishedAt: now, retiredAt: null,
    ...overrides.definition,
  };
  const registration: RegistrationRow = {
    id: "registration-1", wabaId: "waba-1", providerTemplateName: "moda_initial_no_offer",
    providerLanguageCode: languageCode, providerTemplateId: "provider-tpl-1", category: "MARKETING",
    providerStatus: "APPROVED", submissionState: "SUBMITTED", failureCode: null,
    driftDetectedAt: null, lastObservedContentHash: digest, lastObservedCategory: "MARKETING",
    submittedContentHash: digest, componentsSnapshot: components,
    parameterBindingsSnapshot: bindings,
    locale: { id: "locale-1", languageTag: language, providerLanguageCode: languageCode,
      status: "REVIEWED", contentHash: digest, definition, ...overrides.locale },
    ...overrides.registration,
  } as RegistrationRow;
  return {
    id: "variant-1", shopId: "shop-1", providerAccountId: "waba-1",
    purpose: `${overrides.stage ?? "INITIAL"}_${overrides.offer ?? "NO_OFFER"}`,
    languageTag: language, providerLanguageCode: languageCode,
    providerTemplateName: "moda_initial_no_offer", providerTemplateId: "provider-tpl-1",
    status: "APPROVED", enabled: true, metaRegistrationId: "registration-1",
    metaRegistration: registration, ...overrides.variant,
  } as AssignedVariantRow;
}

function setup(rows: AssignedVariantRow[] = [fixture()], options: {
  brand?: ShopBrandRow | null;
  media?: ReadyBrandMedia | null;
  mediaHosts?: string[];
  defaultLanguage?: string | null;
} = {}) {
  const readCatalogue = vi.fn(async () => ({
    shop: { id: "shop-1", status: "ACTIVE", defaultLanguageTag: options.defaultLanguage ?? "en" },
    variants: rows,
  }));
  const readShopBrand = vi.fn(async () => options.brand ?? null);
  const repo = { readCatalogue, readShopBrand } satisfies RecoveryTemplateRepository;
  const warn = vi.fn(); const error = vi.fn();
  const resolveConfiguredSender = vi.fn(async () => "waba-1");
  const resolveMedia = vi.fn(async () => options.media ?? null);
  const service = new RecoveryTemplatePreparer(repo, resolveConfiguredSender,
    resolveMedia, options.mediaHosts ?? [], () => now, { warn, error });
  return { service, repo, readCatalogue, readShopBrand, warn, error, resolveMedia, resolveConfiguredSender };
}

const unavailable = async (service: RecoveryTemplatePreparer, reason: string,
  params: RecoveryTemplatePreparationInput = input()) => {
  const outcome = await service.prepare(params);
  expect(outcome).toMatchObject({ outcome: "unavailable", reason });
};

describe("ARCH-047 BACKGROUND-001: reusable, read-only recovery template preparation", () => {
  it.each(["INITIAL", "FOLLOW_UP"] as const)("maps all three %s verified-offer purposes without sending", async (stage: "INITIAL" | "FOLLOW_UP") => {
    for (const offer of ["NO_OFFER", "CODE_OFFER", "AUTOMATIC_OFFER"] as const) {
      const row = fixture({ stage, offer });
      const { service, readCatalogue, readShopBrand } = setup([row]);
      const result = await service.prepare(input({ stage, offerPresentation: offer,
        verifiedOffer: offer === "NO_OFFER" ? null : { kind: offer, shopId: "shop-1", verified: true,
          verifiedAt: now, expiresAt: null, code: "SAVE10", description: "10% off" },
      }));
      expect(result).toMatchObject({ outcome: "prepared", purpose: `${stage}_${offer}`,
        variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
        providerTemplateName: "moda_initial_no_offer", providerLanguageCode: "en_US",
        canonicalLanguageTag: "en", selectionSource: "base",
        template: { components: [{ type: "body", parameters: [
          { type: "text", text: "Alex" }, { type: "text", text: "Merchant" } ] }] },
      });
      expect(readCatalogue).toHaveBeenCalledWith({ shopId: "shop-1",
        senderWabaId: "waba-1", purpose: `${stage}_${offer}` });
      expect(readShopBrand).not.toHaveBeenCalled();
    }
  });

  it("English and translated language use their independently frozen, reordered bindings", async () => {
    const translated = fixture({ language: "fr", languageCode: "fr_FR",
      components: [{ type: "BODY", text: "Bonjour {{1}} {{2}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shop.name" },
        { position: 2, variable: "customer.firstName" }], buttons: [] },
      variant: { id: "variant-fr", metaRegistrationId: "registration-1" },
    });
    const { service } = setup([fixture(), translated]);
    const english = await service.prepare(input());
    const french = await service.prepare(input({ conversationLanguageTag: "fr-CA" }));
    expect(english).toMatchObject({ outcome: "prepared", template: { components: [{
      parameters: [{ text: "Alex" }, { text: "Merchant" }],
    }] } });
    expect(french).toMatchObject({ outcome: "prepared", canonicalLanguageTag: "fr",
      selectionSource: "base", template: { components: [{
        parameters: [{ text: "Merchant" }, { text: "Alex" }],
      }] } });
  });

  it("uses merchant default, then only explicit platform fallback", async () => {
    const { service } = setup([fixture()]);
    expect(await service.prepare(input({ conversationLanguageTag: "ja" }))).toMatchObject({
      outcome: "prepared", selectionSource: "merchant-fallback" });
    const platform = setup([fixture({ language: "de", languageCode: "de_DE" })], { defaultLanguage: "fr" });
    await unavailable(platform.service, "NO_APPROVED_ASSIGNMENT", input({
      conversationLanguageTag: "ja", merchantLanguageTag: "fr" }));
    expect(await platform.service.prepare(input({ conversationLanguageTag: "ja",
      merchantLanguageTag: "fr", platformFallbackEnabled: true,
      platformFallbackLanguageTag: "de" }))).toMatchObject({
      outcome: "prepared", selectionSource: "platform-fallback", canonicalLanguageTag: "de" });
  });

  it("refuses legacy, ambiguous, mismatched, drifted, revoked and disabled slots", async () => {
    for (const [row, reason] of [
      [fixture({ variant: { metaRegistrationId: null, metaRegistration: null } }), "LEGACY_ASSIGNMENT"],
      [fixture({ registration: { providerStatus: "PAUSED" } }), "PROVIDER_UNAVAILABLE"],
      [fixture({ registration: { driftDetectedAt: now } }), "PROVIDER_DRIFT"],
      [fixture({ registration: { lastObservedCategory: "UTILITY" } }), "PROVIDER_DRIFT"],
      [fixture({ registration: { providerTemplateName: "external-template" } }), "IDENTITY_MISMATCH"],
      [fixture({ definition: { publishedAt: null } }), "DEFINITION_UNAVAILABLE"],
      [fixture({ locale: { status: "TRANSLATING" } }), "LOCALE_UNAVAILABLE"],
    ] as const) await unavailable(setup([row]).service, reason);
    await unavailable(setup([fixture(), fixture({ variant: { id: "other" } })]).service,
      "AMBIGUOUS_ASSIGNMENT");
    await unavailable(setup([]).service, "NO_APPROVED_ASSIGNMENT");
    const wrongSender = setup([fixture()]);
    await unavailable(wrongSender.service, "SENDER_MISMATCH", input({ senderWabaId: "other-waba" }));
    expect(wrongSender.readCatalogue).not.toHaveBeenCalled();
  });

  it("rejects corrupt/mismatched fingerprints, unsupported slot types and wrong positions", async () => {
    const cases = [
      // No observed provider hash: exercise the stored binding fingerprint check,
      // rather than the earlier, independent provider-drift guard.
      fixture({
        registration: { submittedContentHash: "a".repeat(64), lastObservedContentHash: null },
        locale: { contentHash: "a".repeat(64) },
      }),
      fixture({ locale: { contentHash: "b".repeat(64) } }),
    ];
    for (const row of cases) await unavailable(setup([row]).service, "BINDING_FINGERPRINT_MISMATCH");
    const wrong = fixture({ components: [{ type: "BODY", text: "Hello {{2}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shop.name" }], buttons: [] } });
    await unavailable(setup([wrong]).service, "BINDINGS_INVALID");
    const unsupported = fixture({ components: [{ type: "BODY", text: "Hi" },
      { type: "CAROUSEL", cards: [] }], bindings: { header: [], body: [], buttons: [] } });
    await unavailable(setup([unsupported]).service, "BINDINGS_INVALID");
  });

  it("enforces body text versus real URL button, HTTPS allowlist and single encoding", async () => {
    const body = { type: "BODY", text: "Checkout {{1}}" };
    const button = { type: "BUTTONS", buttons: [{ type: "URL", text: "Finish checkout",
      url: "https://shop.example/finish?target={{1}}", example: ["https://shop.example/example"] }] };
    const row = fixture({ components: [body, button], bindings: {
      header: [], body: [{ position: 1, variable: "checkout.url" }],
      buttons: [{ index: 0, subType: "url", variable: "checkout.url" }],
    } });
    const { service } = setup([row]);
    expect(await service.prepare(input())).toMatchObject({ outcome: "prepared",
      template: { components: [{ type: "body", parameters: [{ text: sourceUrl }] },
        { type: "button", index: "0", parameters: [{ text: encodeURIComponent(sourceUrl) }] }] },
    });
    await unavailable(service, "CHECKOUT_UNAVAILABLE", input({ checkout: null }));
    await unavailable(service, "CHECKOUT_UNTRUSTED", input({ checkout: {
      ...checkout, url: "https://shop.example.evil/checkout/1" } }));
    await unavailable(service, "CHECKOUT_UNAVAILABLE", input({ checkout: {
      ...checkout, shopId: "other-shop" } }));
    const malicious = fixture({ components: [body, { ...button, buttons: [{
      ...button.buttons[0], url: "https://redirect.attacker.test/?next={{1}}",
    }] }], bindings: row.metaRegistration!.parameterBindingsSnapshot });
    await unavailable(setup([malicious]).service, "CHECKOUT_UNTRUSTED");
  });

  it("reads only the sending shop's brand once and refuses raw original image URLs", async () => {
    const brand: ShopBrandRow = { brandName: "Moda Brand", logoUrl: "https://merchant.example/logo.png",
      logoAltText: "Original Logo", logoWidth: 300, logoHeight: 120,
      squareLogoUrl: "https://merchant.example/square.png", squareLogoAltText: "Square",
      coverImageUrl: "https://merchant.example/cover.png" };
    const bindings = { header: [], body: [
      { position: 1, variable: "shopBrand.brandName" },
      { position: 2, variable: "shopBrand.logoAltText" },
      { position: 3, variable: "shopBrand.logoWidth" },
      { position: 4, variable: "shopBrand.logoHeight" },
      { position: 5, variable: "shopBrand.squareLogoAltText" },
      { position: 6, variable: "shopBrand.logoUrl" },
      { position: 7, variable: "shopBrand.squareLogoUrl" },
      { position: 8, variable: "shopBrand.coverImageUrl" },
    ], buttons: [] };
    const components = [{ type: "BODY", text: Array.from({ length: 8 }, (_, i) => `{{${i + 1}}}`).join(" ") }];
    const row = fixture({ components, bindings });
    const media = async (shopId: string, role: string): Promise<ReadyBrandMedia> => ({
      shopId, role: role as ReadyBrandMedia["role"], status: "READY", kind: "R2_DERIVATIVE",
      httpsUrl: `https://assets.moda-cdn.test/${role}.png`,
    });
    const configured = setup([row], { brand });
    await unavailable(configured.service, "MEDIA_NOT_READY");
    const success = setup([row], { brand, mediaHosts: ["assets.moda-cdn.test"] });
    const service = new RecoveryTemplatePreparer(success.repo, async () => "waba-1", media,
      ["assets.moda-cdn.test"], () => now, { warn: vi.fn(), error: vi.fn() });
    expect(await service.prepare(input())).toMatchObject({ outcome: "prepared", template: {
      components: [{ parameters: [
        { text: "Moda Brand" }, { text: "Original Logo" }, { text: "300" }, { text: "120" },
        { text: "Square" }, { text: "https://assets.moda-cdn.test/LOGO.png" },
        { text: "https://assets.moda-cdn.test/SQUARE_LOGO.png" },
        { text: "https://assets.moda-cdn.test/COVER_IMAGE.png" },
      ] }],
    } });
    expect(success.readShopBrand).toHaveBeenCalledTimes(1);
    expect(success.readShopBrand).toHaveBeenCalledWith("shop-1");
    await unavailable(setup([row]).service, "BINDING_VALUE_UNAVAILABLE");
  });

  it("rejects legacy unbound IMAGE headers and binds only a frozen canonical READY role", async () => {
    const components = [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello" }];
    const legacy = fixture({ components, bindings: { header: [], body: [], buttons: [] } });
    await unavailable(setup([legacy]).service, "BINDINGS_INVALID");
    const bound = fixture({ components, bindings: {
      schemaVersion: 1, headerMediaRole: "LOGO", header: [], body: [], buttons: [],
    } });
    await unavailable(setup([bound]).service, "MEDIA_NOT_READY");
    const media: ReadyBrandMedia = { shopId: "shop-1", role: "LOGO", kind: "R2_DERIVATIVE",
      status: "READY", httpsUrl: "https://assets.moda-cdn.test/ready.jpeg" };
    const injected = setup([bound], { media, mediaHosts: ["assets.moda-cdn.test"] });
    expect(await injected.service.prepare(input()))
      .toMatchObject({ outcome: "prepared", template: { components: [{
        type: "header", parameters: [{ type: "image", image: { link: media.httpsUrl } }],
      }] } });
    expect(injected.resolveMedia).toHaveBeenCalledWith("shop-1", "LOGO");
  });

  it("fails closed on wrongly scoped, disabled or revoked variants, even with a misbehaving repository adapter", async () => {
    for (const changes of [
      { shopId: "other-shop" }, { providerAccountId: "other-waba" },
      { purpose: "FOLLOW_UP_NO_OFFER" }, { status: "DISABLED" }, { enabled: false },
    ]) {
      await unavailable(setup([fixture({ variant: changes })]).service, "IDENTITY_MISMATCH");
    }
    await unavailable(setup([fixture({ registration: { failureCode: "REVOKED" } })]).service,
      "PROVIDER_UNAVAILABLE");
  });

  it("requires the correct ShopBrand types and refuses null, empty, oversize and unsafe text", async () => {
    const brand: ShopBrandRow = {
      brandName: "Valid brand", logoUrl: "https://merchant.example/original.png",
      logoAltText: "Alt", logoWidth: 100, logoHeight: 200,
      squareLogoUrl: "https://merchant.example/square.png", squareLogoAltText: "Square alt",
      coverImageUrl: "https://merchant.example/cover.png",
    };
    const cases = [
      { key: "shopBrand.brandName", wrong: { brandName: null } },
      { key: "shopBrand.brandName", wrong: { brandName: "a".repeat(201) } },
      { key: "shopBrand.logoAltText", wrong: { logoAltText: "\u0001unsafe" } },
      { key: "shopBrand.logoAltText", wrong: { logoAltText: "\u007funsafe" } },
      { key: "shopBrand.squareLogoAltText", wrong: { squareLogoAltText: "unsafe\u2028line" } },
      { key: "shopBrand.squareLogoAltText", wrong: { squareLogoAltText: "unsafe\u2029line" } },
      { key: "shopBrand.squareLogoAltText", wrong: { squareLogoAltText: "" } },
      { key: "shopBrand.logoWidth", wrong: { logoWidth: 0 } },
      { key: "shopBrand.logoHeight", wrong: { logoHeight: -1 } },
    ];
    for (const { key, wrong } of cases) {
      const row = fixture({ components: [{ type: "BODY", text: "Brand {{1}}" }],
        bindings: { header: [], body: [{ position: 1, variable: key }], buttons: [] } });
      await unavailable(setup([row], { brand: { ...brand, ...wrong } }).service,
        "BINDING_VALUE_UNAVAILABLE");
    }
    // No ShopBrand is a normal WooCommerce state; never borrow Shopify data.
    await unavailable(setup([fixture({ components: [{ type: "BODY", text: "{{1}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shopBrand.brandName" }], buttons: [] },
    })]).service, "BINDING_VALUE_UNAVAILABLE");
  });

  it("fails closed for a wrong-shop ready media derivative, and never logs customer content", async () => {
    const row = fixture({ components: [{ type: "BODY", text: "{{1}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shopBrand.logoUrl" }], buttons: [] } });
    const brand: ShopBrandRow = { brandName: null, logoUrl: "https://merchant.example/logo.png",
      logoAltText: null, logoWidth: null, logoHeight: null, squareLogoUrl: null,
      squareLogoAltText: null, coverImageUrl: null };
    const { service, warn } = setup([row], { brand,
      mediaHosts: ["assets.moda-cdn.test"], media: {
        shopId: "other-shop", role: "LOGO", status: "READY", kind: "R2_DERIVATIVE",
        httpsUrl: "https://assets.moda-cdn.test/file.png",
      } });
    await unavailable(service, "MEDIA_NOT_READY", input({ customerFirstName: "PRIVATE-CUSTOMER-TEXT" }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE-CUSTOMER-TEXT");
  });

  it("logs every handled binding exception and rethrows unexpected provider/database errors", async () => {
    const { service, warn, error, readCatalogue } = setup([fixture({
      components: [{ type: "BODY", text: "Hello {{1}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shopBrand.brandName" }], buttons: [] },
    })]);
    await unavailable(service, "BINDING_VALUE_UNAVAILABLE");
    expect(warn).toHaveBeenCalledWith("recovery_template.prepare.binding_unavailable",
      expect.objectContaining({ reason: "BINDING_VALUE_UNAVAILABLE", errorType: "BindingUnavailable" }));
    readCatalogue.mockRejectedValueOnce(new Error("SENSITIVE customer checkout url and token"));
    await expect(service.prepare(input())).rejects.toThrow("SENSITIVE customer checkout url and token");
    expect(error).toHaveBeenCalledWith("recovery_template.prepare.failed", expect.objectContaining({
      shopId: "shop-1", errorType: "Error",
    }));
    expect(JSON.stringify(error.mock.calls)).not.toContain("SENSITIVE");
  });
});
