import type { RecoveryShopHeaderReceipt } from "./recovery-shop-header.js";
export type { RecoveryShopHeaderReceipt };
/** ARCH-047-BG005: Background-only runtime seam. No Admin AST imports. */
import type { ConversationDeliveryPlan, ConversationVerifiedProducts } from "@modainteract/moda-interact-shared/commerce/presentation";
import type { CommerceFinalResponse } from "@modainteract/moda-interact-shared/commerce";
import type { CommerceVerifiedPresentation, WrapperSource, WrapperAudience, WrapperVariable, PreparedToken, PreparedWrapper, VerifiedWrapperContext as SharedVerifiedWrapperContext, WrapperDefinition, WrapperSlot, WrapperRefusal } from "@modainteract/moda-interact-shared/commerce/presentation";
export type { WrapperSource, WrapperAudience, WrapperVariable, PreparedToken, PreparedWrapper, WrapperDefinition, WrapperSlot, WrapperRefusal };
export type VerifiedWrapperContext = SharedVerifiedWrapperContext & Readonly<{recoveryShopHeader?: RecoveryShopHeaderReceipt}>;
export type CommercePresentationInput = Readonly<{ envelope: CommerceFinalResponse; verified: CommerceVerifiedPresentation; verifiedProducts?: ConversationVerifiedProducts; deadlineAt?: number; signal?: AbortSignal; productPairs?: readonly { productId: string; variantId: string | null }[] }>;

export type WrapperReadPort = Readonly<{
  loadContext(conversationId: string): Promise<VerifiedWrapperContext | "TENANT_MISMATCH" | null>;
  loadSlots(): Promise<readonly WrapperSlot[]>;
}>;

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
  /** Trusted runtime augmentation, bound into application provenance. */
  recoveryCheckoutUrl?: string;
  recoveryShopHeader?: RecoveryShopHeaderReceipt;
  deliveryPlan?: ConversationDeliveryPlan;
  presentedPairs?: readonly { productId: string; variantId: string | null }[];
}>;

export type WrapperRenderResult = WrappedResult
  | Readonly<{ kind: "no-wrapper"; body: string; reason: "NOT_CONFIGURED"; recoveryCheckoutUrl?: string; recoveryShopHeader?: RecoveryShopHeaderReceipt; deliveryPlan?: ConversationDeliveryPlan; presentedPairs?: readonly { productId: string; variantId: string | null }[] }>
  | Readonly<{ kind: "unavailable" | "rejected"; reason: WrapperRefusal }>;

export type RenderConversationResponseInput = Readonly<{
  conversationId: string;
  source: WrapperSource;
  messageIdentity: string;
  responseBody: string;
  hostComposedReplyCandidates?: readonly string[];
  commercePresentation?: CommercePresentationInput;
  languageTag?: string | null;
  /** Previously prepared outcome owned by the outbound caller for the same message. */
  previousApplication?: WrappedResult;
}>;
