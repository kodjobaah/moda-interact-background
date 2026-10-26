/** ARCH-047-BG005: Background-only runtime seam. No Admin AST imports. */
export type WrapperSource = "AI" | "HUMAN";
export type WrapperAudience = "SHARED" | WrapperSource;
export type WrapperVariable =
  | "customer.firstName" | "shop.name" | "checkout.url"
  | "shopBrand.brandName" | "shopBrand.logoUrl" | "shopBrand.logoAltText"
  | "shopBrand.logoWidth" | "shopBrand.logoHeight" | "shopBrand.squareLogoUrl"
  | "shopBrand.squareLogoAltText" | "shopBrand.coverImageUrl";

export type PreparedToken =
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "variable"; name: WrapperVariable }>
  | Readonly<{ kind: "responseSlot"; name: "response.body" }>;

/** Admin emits this immutable projection in WhatsAppTemplateLocale.localeAst.prepared. */
export type PreparedWrapper = Readonly<{
  schemaVersion: 1;
  family: "MODA_CONVERSATION_WRAPPER";
  responseSlot: "response.body";
  header: readonly PreparedToken[];
  body: readonly PreparedToken[];
  footer: readonly PreparedToken[];
  conditionals: readonly Readonly<{ when: "checkout.available"; tokens: readonly PreparedToken[] }>[];
}>;

export type VerifiedWrapperContext = Readonly<{
  conversationId: string;
  shopId: string;
  conversationLanguageTag: string | null;
  merchantLanguageTag: string | null;
  variables: Partial<Record<WrapperVariable, string>>;
  checkoutAvailable: boolean;
}>;

export type WrapperDefinition = Readonly<{
  id: string;
  kind: string;
  audience: string | null;
  status: string;
  sourceLanguageTag: string;
  astSchemaVersion: number;
  sourceHash: string;
  publishedAt: Date | null;
  retiredAt: Date | null;
  createdByAdminId: string;
  locales: readonly Readonly<{
    id: string;
    languageTag: string;
    status: string;
    providerLanguageCode: string | null;
    localeAst: unknown;
    contentHash: string | null;
    reviewedAt: Date | null;
    reviewedByAdminId: string | null;
  }>[];
}>;

export type WrapperSlot = Readonly<{
  audience: string;
  definitionId: string;
  editVersion: number;
  definition: WrapperDefinition;
}>;

export type WrapperReadPort = Readonly<{
  loadContext(conversationId: string): Promise<VerifiedWrapperContext | "TENANT_MISMATCH" | null>;
  loadSlots(): Promise<readonly WrapperSlot[]>;
}>;

export type WrapperRefusal =
  | "INVALID_INPUT" | "INVALID_LANGUAGE" | "CONVERSATION_UNAVAILABLE" | "TENANT_MISMATCH"
  | "NOT_CONFIGURED" | "DEFINITION_UNAVAILABLE" | "LOCALE_UNAVAILABLE"
  | "PREPARED_MISSING" | "PREPARED_INVALID" | "VARIABLE_UNAVAILABLE"
  | "ALREADY_WRAPPED" | "OUTPUT_TOO_LONG" | "REPLAY_MISMATCH";

export type WrappedResult = Readonly<{
  kind: "rendered";
  body: string;
  wrapperDefinitionId: string;
  localeId: string;
  audience: WrapperAudience;
  slotEditVersion: number;
  languageTag: string;
  contentHash: string;
  messageIdentity: string;
  source: WrapperSource;
  /** Deterministic identity for caller-owned replay persistence; not a send admission. */
  applicationKey: string;
  responseDigest: string;
  replayed: boolean;
}>;

export type WrapperRenderResult = WrappedResult
  | Readonly<{ kind: "no-wrapper"; body: string; reason: "NOT_CONFIGURED" }>
  | Readonly<{ kind: "unavailable" | "rejected"; reason: WrapperRefusal }>;

export type RenderConversationResponseInput = Readonly<{
  conversationId: string;
  source: WrapperSource;
  messageIdentity: string;
  responseBody: string;
  languageTag?: string | null;
  /** Previously prepared outcome owned by the outbound caller for the same message. */
  previousApplication?: WrappedResult;
}>;
