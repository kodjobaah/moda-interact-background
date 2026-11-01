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
  lastExternalActivityAt: new Date(now.getTime() - 15_000), checkoutRecoveryLifetimeDays: 21,
  expiresAt: new Date(now.getTime() + 60_000),
  approvedHosts: ["shop.example"] };
const input = (override: Partial<RecoveryTemplatePreparationInput> = {}): RecoveryTemplatePreparationInput => ({
  shopId: "shop-1", senderWabaId: "waba-1", stage: "INITIAL", offerPresentation: "NO_OFFER",
  promotionTarget: "CHECKOUT",
  conversationLanguageTag: "en-US", merchantLanguageTag: "en",
  customerFirstName: "Alex", shopName: { shopId: "shop-1", value: "Merchant" }, checkout,
  checkoutItems: { shopId: "shop-1", lineItems: [{ title: "Saved item", quantity: 1 }] },
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
  promotionTarget: "CHECKOUT",
  header: [], body: [{ position: 1, variable: "customer.firstName" }, { position: 2, variable: "shop.name" }],
  buttons: [],
};

function fixture(overrides: {
  language?: string; languageCode?: string; stage?: string; offer?: string;
  components?: unknown; bindings?: unknown; variant?: Record<string, unknown>;
  registration?: Record<string, unknown>; definition?: Record<string, unknown>;
  locale?: Record<string, unknown>; preserveBindings?: boolean;
} = {}): AssignedVariantRow {
  const language = overrides.language ?? "en";
  const languageCode = overrides.languageCode ?? "en_US";
  const components = structuredClone(overrides.components ?? standardComponents);
  const rawBindings = structuredClone(overrides.bindings ?? standardBindings);
  const initial = (overrides.stage ?? "INITIAL") === "INITIAL";
  const hasItemsSummary = initial && rawBindings && typeof rawBindings === "object" &&
    !Array.isArray(rawBindings) && Array.isArray((rawBindings as Record<string, unknown>).body) &&
    ((rawBindings as Record<string, unknown>).body as unknown[]).some((binding) => binding &&
      typeof binding === "object" && (binding as Record<string, unknown>).variable === "checkout.itemsSummary");
  if (initial && !overrides.preserveBindings && !hasItemsSummary && rawBindings && typeof rawBindings === "object" &&
      !Array.isArray(rawBindings) && Array.isArray((rawBindings as Record<string, unknown>).body)) {
    const body = (rawBindings as Record<string, unknown>).body as unknown[];
    const position = body.length + 1;
    (rawBindings as Record<string, unknown>).body = [
      ...body, { position, variable: "checkout.itemsSummary" },
    ];
    const bodyComponent = components.find((component) => component && typeof component === "object" &&
      (component as Record<string, unknown>).type === "BODY") as Record<string, unknown> | undefined;
    if (bodyComponent && typeof bodyComponent.text === "string") {
      bodyComponent.text = `${bodyComponent.text} {{${position}}}`;
    }
  }
  const bindings = rawBindings && typeof rawBindings === "object" && !Array.isArray(rawBindings)
    ? { promotionTarget: "CHECKOUT", ...rawBindings } : rawBindings;
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
  categoryNames?: Record<string, string | null>;
  shopId?: string;
} = {}) {
  const shopId = options.shopId ?? "shop-1";
  const readCatalogue = vi.fn(async () => ({
    shop: { id: shopId, status: "ACTIVE", defaultLanguageTag: options.defaultLanguage ?? "en" },
    variants: rows,
  }));
  const readShopBrand = vi.fn(async () => options.brand ?? null);
  const readShopCategory = vi.fn(async (_shopId: string, languageTag: string) => options.categoryNames?.[languageTag] ?? null);
  const repo = { readCatalogue, readShopBrand, readShopCategory } satisfies RecoveryTemplateRepository;
  const warn = vi.fn(); const error = vi.fn();
  const resolveConfiguredSender = vi.fn(async () => "waba-1");
  const resolveMedia = vi.fn(async () => options.media ?? null);
  const service = new RecoveryTemplatePreparer(repo, resolveConfiguredSender,
    resolveMedia, options.mediaHosts ?? [], () => now, { warn, error });
  return { service, repo, readCatalogue, readShopBrand, readShopCategory, warn, error, resolveMedia, resolveConfiguredSender };
}

const unavailable = async (service: RecoveryTemplatePreparer, reason: string,
  params: RecoveryTemplatePreparationInput = input()) => {
  const outcome = await service.prepare(params);
  expect(outcome).toMatchObject({ outcome: "unavailable", reason });
};

describe("ARCH-047 BACKGROUND-001: reusable, read-only recovery template preparation", () => {
  it("binds a source-bound alternative product only to its approved CTA while retaining checkout CTA", async () => {
    const components = [
      { type: "BODY", text: "{{1}} {{2}} {{3}} from {{4}}" },
      { type: "BUTTONS", buttons: [
        { type: "URL", text: "Resume checkout", url: "https://shop.example/resume?url={{1}}" },
        { type: "URL", text: "View product", url: "https://shop.example/product?url={{1}}" },
      ] },
    ];
    const bindings = { promotionTarget: "ALTERNATIVE_PRODUCT", header: [], body: [
      { position: 1, variable: "promotion.productName" },
      { position: 2, variable: "promotion.offerDescription" },
      { position: 3, variable: "promotion.productUrl" },
      { position: 4, variable: "shop.name" },
    ], buttons: [
      { index: 0, subType: "url", variable: "checkout.url" },
      { index: 1, subType: "url", variable: "promotion.productUrl" },
    ] };
    const row = fixture({ offer: "AUTOMATIC_OFFER", components, bindings });
    const { service } = setup([row]);
    const productUrl = "https://shop.example/products/blue-jacket";
    const request = input({ offerPresentation: "AUTOMATIC_OFFER", promotionTarget: "ALTERNATIVE_PRODUCT",
      verifiedOffer: { kind: "AUTOMATIC_OFFER", shopId: "shop-1", verified: true,
        verifiedAt: now, expiresAt: null, description: "a current sale price" },
      promotionalProduct: { sourceTool: "commerce_get_product", authenticatedShopId: "shop-1",
        product: { productId: "product-2", variantId: "variant-2", title: "Blue jacket", url: productUrl } },
    });
    const prepared = await service.prepare(request);
    expect(prepared).toMatchObject({ outcome: "prepared", template: { components: [
      { type: "body", parameters: [
        { text: "Blue jacket" }, { text: "a current sale price" }, { text: productUrl }, { text: "Merchant" },
        { text: "1 × Saved item" },
      ] },
      { type: "button", index: "0", parameters: [{ text: encodeURIComponent(sourceUrl) }] },
      { type: "button", index: "1", parameters: [{ text: encodeURIComponent(productUrl) }] },
    ] } });

    await unavailable(service, "PROMOTION_PRODUCT_URL_UNAVAILABLE", {
      ...request,
      promotionalProduct: { ...request.promotionalProduct!, product: {
        ...request.promotionalProduct!.product, url: "http://shop.example/products/blue-jacket",
      } },
    });
  });

  it("selects the approved singular or plural CODE revision for the final source-backed offer count", async () => {
    const single = fixture({ offer: "CODE_OFFER", variant: { id: "variant-single" },
      components: [{ type: "BODY", text: "Use {{1}} from {{2}}" }],
      bindings: { promotionTarget: "CHECKOUT", header: [], body: [
        { position: 1, variable: "offer.code" }, { position: 2, variable: "shop.name" },
      ], buttons: [] },
    });
    const plural = fixture({ offer: "CODE_OFFER", variant: { id: "variant-plural" },
      components: [{ type: "BODY", text: "Possible codes {{1}} from {{2}}" }],
      bindings: { promotionTarget: "CHECKOUT", header: [], body: [
        { position: 1, variable: "offer.codes" }, { position: 2, variable: "shop.name" },
      ], buttons: [] },
    });
    const { service } = setup([single, plural]);
    const one = await service.prepare(input({ offerPresentation: "CODE_OFFER", verifiedOffer: {
      kind: "CODE_OFFER", shopId: "shop-1", verified: true, verifiedAt: now,
      expiresAt: null, code: "SAVE10", codes: ["SAVE10"], description: "10% off",
    } }));
    const several = await service.prepare(input({ offerPresentation: "CODE_OFFER", verifiedOffer: {
      kind: "CODE_OFFER", shopId: "shop-1", verified: true, verifiedAt: now,
      expiresAt: null, code: "SAVE10", codes: ["SAVE10", "SHIPFREE"], description: "10% off",
    } }));
    expect(one).toMatchObject({ outcome: "prepared", variantId: "variant-single",
      template: { components: [{ parameters: [{ text: "SAVE10" }, { text: "Merchant" },
        { text: "1 × Saved item" }] }] } });
    expect(several).toMatchObject({ outcome: "prepared", variantId: "variant-plural",
      template: { components: [{ parameters: [{ text: "SAVE10, SHIPFREE" }, { text: "Merchant" },
        { text: "1 × Saved item" }] }] } });
  });

  it.each(["INITIAL", "FOLLOW_UP"] as const)("maps all three %s verified-offer purposes without sending", async (stage: "INITIAL" | "FOLLOW_UP") => {
    for (const offer of ["NO_OFFER", "CODE_OFFER", "AUTOMATIC_OFFER"] as const) {
      const row = offer === "CODE_OFFER" && stage === "INITIAL" ? fixture({ stage, offer,
        components: [{ type: "BODY", text: "{{1}} {{2}} {{3}}" }],
        bindings: { promotionTarget: "CHECKOUT", header: [], body: [
          { position: 1, variable: "offer.code" }, { position: 2, variable: "customer.firstName" },
          { position: 3, variable: "shop.name" },
        ], buttons: [] },
      }) : fixture({ stage, offer });
      const { service, readCatalogue, readShopBrand } = setup([row]);
      const result = await service.prepare(input({ stage, offerPresentation: offer,
        verifiedOffer: offer === "NO_OFFER" ? null : { kind: offer, shopId: "shop-1", verified: true,
          verifiedAt: now, expiresAt: null, code: "SAVE10", description: "10% off" },
      }));
      const expectedBody = offer === "CODE_OFFER" && stage === "INITIAL"
        ? [{ type: "text", text: "SAVE10" }, { type: "text", text: "Alex" },
          { type: "text", text: "Merchant" }, { type: "text", text: "1 × Saved item" }]
        : [{ type: "text", text: "Alex" }, { type: "text", text: "Merchant" },
          ...(stage === "INITIAL" ? [{ type: "text", text: "1 × Saved item" }] : [])];
      expect(result).toMatchObject({ outcome: "prepared", purpose: `${stage}_${offer}`,
        variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
        providerTemplateName: "moda_initial_no_offer", providerLanguageCode: "en_US",
        canonicalLanguageTag: "en", selectionSource: "base",
        template: { components: [{ type: "body", parameters: [
          ...expectedBody ] }] },
      });
      expect(readCatalogue).toHaveBeenCalledWith({ shopId: "shop-1",
        senderWabaId: "waba-1", purpose: `${stage}_${offer}` });
      expect(readShopBrand).toHaveBeenCalledWith("shop-1");
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
      parameters: [{ text: "Alex" }, { text: "Merchant" }, { text: "1 × Saved item" }],
    }] } });
    expect(french).toMatchObject({ outcome: "prepared", canonicalLanguageTag: "fr",
      selectionSource: "base", template: { components: [{
        parameters: [{ text: "Merchant" }, { text: "Alex" }, { text: "1 × Saved item" }],
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
    const unsupported = fixture({ components: [{ type: "BODY", text: "Hi {{1}}" },
      { type: "CAROUSEL", cards: [] }], bindings: {
      header: [], body: [{ position: 1, variable: "shop.name" }], buttons: [],
    } });
    await unavailable(setup([unsupported]).service, "BINDINGS_INVALID");
  });

  it("binds the persisted checkout URL unchanged and applies only provider parameter encoding", async () => {
    const body = { type: "BODY", text: "Checkout {{1}} from {{2}}" };
    const button = { type: "BUTTONS", buttons: [{ type: "URL", text: "Finish checkout",
      url: "https://shop.example/finish?target={{1}}", example: ["https://shop.example/example"] }] };
    const row = fixture({ components: [body, button], bindings: {
      header: [], body: [{ position: 1, variable: "checkout.url" }, { position: 2, variable: "shop.name" }],
      buttons: [{ index: 0, subType: "url", variable: "checkout.url" }],
    } });
    const { service } = setup([row]);
    expect(await service.prepare(input())).toMatchObject({ outcome: "prepared",
      template: { components: [{ type: "body", parameters: [{ text: sourceUrl }, { text: "Merchant" },
        { text: "1 × Saved item" }] },
        { type: "button", index: "0", parameters: [{ text: encodeURIComponent(sourceUrl) }] }] },
    });
    expect(await service.prepare(input({ checkout: { ...checkout,
      lastExternalActivityAt: new Date(now.getTime() - 8 * 86_400_000) } })))
      .toMatchObject({ outcome: "prepared" });
    expect(await service.prepare(input({ checkout: { ...checkout,
      lastExternalActivityAt: new Date(now.getTime() - 21 * 86_400_000) } })))
      .toMatchObject({ outcome: "unavailable", reason: "CHECKOUT_UNAVAILABLE" });
    expect(await service.prepare(input({ checkout: { ...checkout,
      lastExternalActivityAt: new Date(now.getTime() - 21 * 86_400_000 + 1) } })))
      .toMatchObject({ outcome: "prepared" });
    expect(await service.prepare(input({ checkout: { ...checkout,
      lastExternalActivityAt: new Date(now.getTime() + 1) } })))
      .toMatchObject({ outcome: "unavailable", reason: "CHECKOUT_UNAVAILABLE" });
    expect(await service.prepare(input({ checkout: { ...checkout,
      checkoutRecoveryLifetimeDays: 0, lastExternalActivityAt: now } })))
      .toMatchObject({ outcome: "unavailable", reason: "CHECKOUT_UNAVAILABLE" });
    await unavailable(service, "CHECKOUT_UNAVAILABLE", input({ checkout: null }));
    await unavailable(service, "CHECKOUT_UNAVAILABLE", input({ checkout: {
      ...checkout, shopId: "other-shop" } }));
    const differentStoredValue = "not validated by this sender";
    const changedValueWithRedirect = fixture({ components: [{ ...body, text: "Checkout {{1}} from {{2}} {{3}}" },
      { ...button, buttons: [{
      ...button.buttons[0], url: "https://redirect.attacker.test/?next={{1}}",
    }] }], bindings: row.metaRegistration!.parameterBindingsSnapshot });
    const preparedChangedValue = await setup([changedValueWithRedirect]).service.prepare(input({
      checkout: { ...checkout, url: differentStoredValue },
    }));
    expect(preparedChangedValue).toMatchObject({ outcome: "prepared", template: { components: [
      { type: "body", parameters: [{ text: differentStoredValue }, { text: "Merchant" },
        { text: "1 × Saved item" }] },
      { type: "button", parameters: [{ text: encodeURIComponent(differentStoredValue) }] },
    ] } });
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
      { position: 9, variable: "shop.name" },
    ], buttons: [] };
    const components = [{ type: "BODY", text: Array.from({ length: 9 }, (_, i) => `{{${i + 1}}}`).join(" ") }];
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
        { text: "Moda Brand" },
        { text: "1 × Saved item" },
      ] }],
    } });
    expect(success.readShopBrand).toHaveBeenCalledTimes(1);
    expect(success.readShopBrand).toHaveBeenCalledWith("shop-1");
    await unavailable(setup([row]).service, "BINDING_VALUE_UNAVAILABLE");
  });

  it("rejects legacy unbound IMAGE headers and binds only a frozen canonical READY role", async () => {
    const components = [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello" }];
    const followUpInput = input({ stage: "FOLLOW_UP" });
    const legacy = fixture({ stage: "FOLLOW_UP", components, bindings: { header: [], body: [], buttons: [] } });
    await unavailable(setup([legacy]).service, "BINDINGS_INVALID", followUpInput);
    const bound = fixture({ stage: "FOLLOW_UP", components, bindings: {
      schemaVersion: 1, headerMediaRole: "LOGO", header: [], body: [], buttons: [],
    } });
    await unavailable(setup([bound]).service, "MEDIA_NOT_READY", followUpInput);
    const media: ReadyBrandMedia = { shopId: "shop-1", role: "LOGO", kind: "R2_DERIVATIVE",
      status: "READY", httpsUrl: "https://assets.moda-cdn.test/ready.jpeg" };
    const injected = setup([bound], { media, mediaHosts: ["assets.moda-cdn.test"] });
    expect(await injected.service.prepare(followUpInput))
      .toMatchObject({ outcome: "prepared", template: { components: [{
        type: "header", parameters: [{ type: "image", image: { link: media.httpsUrl } }],
      }] } });
    expect(injected.resolveMedia).toHaveBeenCalledWith("shop-1", "LOGO");
  });

  it("binds only the verified attempt-specific product derivative to an approved IMAGE variant", async () => {
    const imageRow = fixture({ variant: { id: "variant-image" },
      components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello {{1}}" }],
      bindings: { schemaVersion: 1, headerMediaRole: "CHECKOUT_PRODUCT", header: [], body: [
        { position: 1, variable: "shop.name" },
      ], buttons: [] },
    });
    const textRow = fixture({ variant: { id: "variant-text" } });
    const configured = setup([imageRow, textRow]);
    const request = { shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      generation: 1, productId: "product-1", variantId: null };
    const validateBeforeBinding = vi.fn(async () => true);
    const prepareForBinding = vi.fn(async () => ({ result: {
      kind: "READY", shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      productId: "product-1", variantId: null, objectKey: "outreach-products/shopify/shop/2026/10/25/attempt-1/p-x/v-none/sha256-y.jpg",
      publicImageUrl: "https://media.modainteract.com/outreach-products/shopify/shop/2026/10/25/attempt-1/p-x/v-none/sha256-y.jpg",
      contentSha256: "a".repeat(64), width: 1125, height: 600, contentType: "image/jpeg", preparedAt: now,
    }, validateBeforeBinding }));
    const service = new RecoveryTemplatePreparer(configured.repo, configured.resolveConfiguredSender,
      configured.resolveMedia, [], () => now, { warn: vi.fn(), error: vi.fn() },
      () => ({ prepareForBinding }) as never);

    const result = await service.prepare(input({ productImage: request }));
    expect(result).toMatchObject({ outcome: "prepared", variantId: "variant-image", template: {
      components: [
        { type: "header", parameters: [{ type: "image", image: { link: expect.stringContaining("/outreach-products/") } }] },
        { type: "body", parameters: [{ type: "text", text: "Merchant" },
          { type: "text", text: "1 × Saved item" }] },
      ],
    } });
    expect(prepareForBinding).toHaveBeenCalledWith(request);
    expect(validateBeforeBinding).toHaveBeenCalledOnce();
  });

  it.each(["unavailable", "stale"] as const)("uses the approved TEXT variant when product media is %s", async (mode) => {
    const imageRow = fixture({ variant: { id: "variant-image" },
      components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello {{1}}" }],
      bindings: { schemaVersion: 1, headerMediaRole: "CHECKOUT_PRODUCT", header: [], body: [
        { position: 1, variable: "shop.name" },
      ], buttons: [] },
    });
    const textRow = fixture({ variant: { id: "variant-text" } });
    const configured = setup([imageRow, textRow]);
    const prepareForBinding = vi.fn(async () => ({ result: mode === "unavailable"
      ? { kind: "UNAVAILABLE", reason: "PRODUCT_IMAGE_UNAVAILABLE" }
      : { kind: "READY", shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
          productId: "product-1", variantId: null, objectKey: "outreach-products/shopify/shop/2026/10/25/attempt-1/p-x/v-none/sha256-y.jpg",
          publicImageUrl: "https://media.modainteract.com/outreach-products/image.jpg", contentSha256: "a".repeat(64),
          width: 1125, height: 600, contentType: "image/jpeg", preparedAt: now },
      validateBeforeBinding: async () => false }));
    const service = new RecoveryTemplatePreparer(configured.repo, configured.resolveConfiguredSender,
      configured.resolveMedia, [], () => now, { warn: vi.fn(), error: vi.fn() },
      () => ({ prepareForBinding }) as never);

    const result = await service.prepare(input({ productImage: { shopId: "shop-1", checkoutRecoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", generation: 1, productId: "product-1", variantId: null } }));
    expect(result).toMatchObject({ outcome: "prepared", variantId: "variant-text", template: {
      components: [{ type: "body", parameters: [
        { type: "text", text: "Alex" }, { type: "text", text: "Merchant" },
        { type: "text", text: "1 × Saved item" },
      ] },
      ],
    } });
    expect(JSON.stringify(result)).not.toContain("media.modainteract.com");
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
      const row = fixture({ components: [{ type: "BODY", text: "Brand {{1}} from {{2}}" }],
        bindings: { header: [], body: [{ position: 1, variable: key },
          { position: 2, variable: "shop.name" }], buttons: [] } });
      await unavailable(setup([row], { brand: { ...brand, ...wrong } }).service,
        "BINDING_VALUE_UNAVAILABLE");
    }
    // No ShopBrand is a normal WooCommerce state; never borrow Shopify data.
    await unavailable(setup([fixture({ components: [{ type: "BODY", text: "{{1}} {{2}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shopBrand.brandName" },
        { position: 2, variable: "shop.name" }], buttons: [] },
    })]).service, "BINDING_VALUE_UNAVAILABLE");
  });

  it("fails closed for a wrong-shop ready media derivative, and never logs customer content", async () => {
    const row = fixture({ components: [{ type: "BODY", text: "{{1}} {{2}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shopBrand.logoUrl" },
        { position: 2, variable: "shop.name" }], buttons: [] } });
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
      components: [{ type: "BODY", text: "Hello {{1}} from {{2}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shopBrand.brandName" },
        { position: 2, variable: "shop.name" }], buttons: [] },
    })]);
    await unavailable(service, "BINDING_VALUE_UNAVAILABLE", input({ checkoutItems: undefined }));
    expect(warn).toHaveBeenCalledWith("recovery_template.prepare.binding_unavailable",
      expect.objectContaining({ reason: "BINDING_VALUE_UNAVAILABLE", errorType: "BindingUnavailable" }));
    readCatalogue.mockRejectedValueOnce(new Error("SENSITIVE customer checkout url and token"));
    await expect(service.prepare(input())).rejects.toThrow("SENSITIVE customer checkout url and token");
    expect(error).toHaveBeenCalledWith("recovery_template.prepare.failed", expect.objectContaining({
      shopId: "shop-1", errorType: "Error",
    }));
    expect(JSON.stringify(error.mock.calls)).not.toContain("SENSITIVE");
    expect(error.mock.lastCall?.[1]).not.toHaveProperty("errorMessage");
  });

  it("binds each shared-WABA template to its own authenticated merchant name", async () => {
    const shopA = setup([fixture({ variant: { id: "variant-a", shopId: "shop-a" } })], {
      shopId: "shop-a", brand: { brandName: "Merchant A" } as ShopBrandRow,
    });
    const shopB = setup([fixture({ variant: { id: "variant-b", shopId: "shop-b" } })], {
      shopId: "shop-b", brand: { brandName: "Merchant B" } as ShopBrandRow,
    });

    const [preparedA, preparedB] = await Promise.all([
      shopA.service.prepare(input({ shopId: "shop-a", shopName: { shopId: "shop-a", value: "shop-a.test" },
        checkout: { ...checkout, shopId: "shop-a" }, checkoutItems: { shopId: "shop-a",
          lineItems: [{ title: "Item A", quantity: 1 }] } })),
      shopB.service.prepare(input({ shopId: "shop-b", shopName: { shopId: "shop-b", value: "shop-b.test" },
        checkout: { ...checkout, shopId: "shop-b" }, checkoutItems: { shopId: "shop-b",
          lineItems: [{ title: "Item B", quantity: 1 }] } })),
    ]);

    expect(preparedA).toMatchObject({ outcome: "prepared", shopId: "shop-a",
      template: { components: [{ parameters: [{ text: "Alex" }, { text: "Merchant A" },
        { text: "1 × Item A" }] }] } });
    expect(preparedB).toMatchObject({ outcome: "prepared", shopId: "shop-b",
      template: { components: [{ parameters: [{ text: "Alex" }, { text: "Merchant B" },
        { text: "1 × Item B" }] }] } });
    expect(shopA.readCatalogue).toHaveBeenCalledWith({ shopId: "shop-a", senderWabaId: "waba-1",
      purpose: "INITIAL_NO_OFFER" });
    expect(shopB.readCatalogue).toHaveBeenCalledWith({ shopId: "shop-b", senderWabaId: "waba-1",
      purpose: "INITIAL_NO_OFFER" });
  });
});


describe("taxonomy-backed recovery template binding", () => {
  const categoryTemplate = (language: string, code: string) => fixture({
    language, languageCode: code,
    components: [{ type: "BODY", text: "We sell {{1}} at {{2}}" }],
    bindings: { header: [], body: [
      { position: 1, variable: "shop.categoryName" },
      { position: 2, variable: "shop.name" },
    ], buttons: [] },
  });

  it("uses the sending shop's active category for the selected Meta language", async () => {
    const { service, readShopCategory } = setup([categoryTemplate("en", "en_US"), categoryTemplate("fr", "fr_FR")], {
      categoryNames: { en: "Outdoor equipment", fr: "Équipement de plein air" },
    });
    const result = await service.prepare(input());
    expect(result).toMatchObject({ outcome: "prepared", template: { components: [
      { type: "body", parameters: [{ text: "Outdoor equipment" }, { text: "Merchant" },
        { text: "1 × Saved item" }] },
    ] } });
    expect(readShopCategory).toHaveBeenCalledWith("shop-1", "en");
    const translated = await service.prepare(input({ conversationLanguageTag: "fr-CA" }));
    expect(translated).toMatchObject({ outcome: "prepared", canonicalLanguageTag: "fr",
      template: { components: [{ parameters: [{ text: "Équipement de plein air" }, { text: "Merchant" },
        { text: "1 × Saved item" }] }] } });
    expect(readShopCategory).toHaveBeenCalledWith("shop-1", "fr");
  });

  it("refuses category-dependent templates for shops without an active/translated category", async () => {
    const { service } = setup([categoryTemplate("en", "en_US")]);
    await unavailable(service, "BINDING_VALUE_UNAVAILABLE");
    const untranslated = setup([categoryTemplate("fr", "fr_FR")], { categoryNames: { en: "Fashion" } });
    await unavailable(untranslated.service, "BINDING_VALUE_UNAVAILABLE", input({ conversationLanguageTag: "fr" }));
    const untrusted = setup([categoryTemplate("en", "en_US")], { categoryNames: { en: "Bad {{1}}" } });
    await unavailable(untrusted.service, "BINDING_VALUE_UNAVAILABLE");
  });
});

describe("ARCH-052 saved basket and merchant bindings", () => {
  const basketTemplate = fixture({
    components: [{ type: "BODY", text: "{{1}} from {{2}}" }],
    bindings: { header: [], body: [{ position: 1, variable: "checkout.itemsSummary" },
      { position: 2, variable: "shop.name" }], buttons: [] },
  });

  it("excludes INITIAL registrations without one well-formed summary binding", async () => {
    const noSummary = fixture({ preserveBindings: true });
    const duplicate = fixture({ preserveBindings: true,
      components: [{ type: "BODY", text: "{{1}} {{2}}" }],
      bindings: { header: [], body: [
        { position: 1, variable: "checkout.itemsSummary" },
        { position: 2, variable: "checkout.itemsSummary" },
      ], buttons: [] },
    });
    const malformedPosition = fixture({ preserveBindings: true,
      components: [{ type: "BODY", text: "{{1}}" }],
      bindings: { header: [], body: [{ position: 2, variable: "checkout.itemsSummary" }], buttons: [] },
    });
    await unavailable(setup([noSummary]).service, "DEFINITION_UNAVAILABLE");
    await unavailable(setup([duplicate]).service, "DEFINITION_UNAVAILABLE");
    await unavailable(setup([malformedPosition]).service, "BINDINGS_INVALID");
  });

  it("binds a deterministic Shopify basket summary and prefers the configured shop display name", async () => {
    const brand: ShopBrandRow = { brandName: "Verified Outfitters", logoUrl: null,
      logoAltText: null, logoWidth: null, logoHeight: null, squareLogoUrl: null,
      squareLogoAltText: null, coverImageUrl: null };
    const { service } = setup([basketTemplate], { brand });
    const result = await service.prepare(input({ checkoutItems: { shopId: "shop-1", lineItems: [
      { title: "Shoes", variantTitle: "Blue", quantity: 2 },
      { title: "Water bottle", quantity: 1 },
    ] } }));
    expect(result).toMatchObject({ outcome: "prepared", template: { components: [{
      parameters: [{ text: "2 × Shoes (Blue) and 1 × Water bottle" }, { text: "Verified Outfitters" }],
    }] } });

    const nameTemplate = fixture({ components: [{ type: "BODY", text: "{{1}}" }],
      bindings: { header: [], body: [{ position: 1, variable: "shop.name" }], buttons: [] } });
    const branded = setup([nameTemplate], { brand });
    expect(await branded.service.prepare(input())).toMatchObject({ template: { components: [{
      parameters: [{ text: "Verified Outfitters" }, { text: "1 × Saved item" }],
    }] } });
    const invalidBrand = setup([nameTemplate], { brand: { ...brand, brandName: "{{unsafe}}" } });
    expect(await invalidBrand.service.prepare(input())).toMatchObject({ template: { components: [{
      parameters: [{ text: "Merchant" }, { text: "1 × Saved item" }],
    }] } });
  });

  it("fails closed for missing basket data, malformed rows and cross-tenant facts", async () => {
    const { service } = setup([basketTemplate]);
    await unavailable(service, "BINDING_VALUE_UNAVAILABLE", input({ checkoutItems: undefined }));
    await unavailable(service, "BINDING_VALUE_UNAVAILABLE", input({ checkoutItems: {
      shopId: "other-shop", lineItems: [{ title: "PRIVATE OTHER TENANT", quantity: 1 }],
    } }));
    await unavailable(service, "BINDING_VALUE_UNAVAILABLE", input({ checkoutItems: {
      shopId: "shop-1", lineItems: [{ title: "{{1}}", quantity: 1 }],
    } }));
    await unavailable(service, "BINDING_VALUE_UNAVAILABLE", input({ checkoutItems: {
      shopId: "shop-1", lineItems: [
        { title: "Valid", quantity: 1 }, { title: "", quantity: 0 },
      ],
    } }));
  });
});
