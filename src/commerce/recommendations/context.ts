import { isIP } from "node:net";
import type { PrismaClient } from "@prisma/client";
import type { CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import type { CommerceTurnIdentity } from "@modainteract/moda-interact-shared/commerce";
import { CommerceHostError } from "../mcp-client.js";
import { RecoveryPolicyService } from "../../services/recovery-policy.service.js";
import { fingerprintRecoveryPricingBasket } from "../../services/recovery-pricing/price-comparison.js";

export type RecommendationPolicy = Readonly<{
  mode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE";
  authorisedDiscountIds: readonly string[];
  source: string;
}>;

export type RecommendationLine = Readonly<{
  lineKey: string;
  productId: string | null;
  variantId: string | null;
  title: string;
  quantity: number | null;
  categoryIds: readonly string[] | null;
  collectionIds: readonly string[] | null;
}>;

export type RecommendationContext = Readonly<{
  shopId: string;
  provider: "SHOPIFY" | "WOOCOMMERCE";
  turn: CommerceTurnIdentity;
  grantId: string;
  releaseId: string;
  policy: RecommendationPolicy;
  platformText: string;
  platformRevisionId: string;
  shopText: string | null;
  shopRevisionId: string | null;
  basket: null | Readonly<{
    generation: number;
    fingerprint: string;
    currency: string | null;
    lines: readonly RecommendationLine[];
  }>;
  basketUnavailableReason: string | null;
  storeUrl: string;
}>;

type OwnedRecovery = Readonly<{
  id: string;
  shopId: string;
  generation: number;
  currency: string | null;
  lineItems: unknown;
  shop: Readonly<{ platform: string; domain: string }>;
}>;

class RecommendationBasketValidationError extends Error {
  constructor() { super("RECOMMENDATION_BASKET_VALIDATION_FAILED"); }
}

function promptText(
  row: {
    activePromptRevisionId: string | null;
    activePromptRevision: { id: string; status: string; promptText: string;
      prompt: { scope: string; shopId: string | null } } | null;
  } | undefined,
  scope: "PLATFORM" | "SHOP",
  shopId: string,
): { text: string; revisionId: string } | null {
  if (scope === "SHOP" && (!row || row.activePromptRevisionId === null)) return null;
  const revision = row?.activePromptRevision;
  if (!row || !row.activePromptRevisionId || !revision || revision.id !== row.activePromptRevisionId ||
      revision.status !== "PUBLISHED" || revision.prompt.scope !== scope ||
      revision.prompt.shopId !== (scope === "SHOP" ? shopId : null) ||
      typeof revision.promptText !== "string" || !revision.promptText.trim() || revision.promptText.length > 8_000) {
    throw new CommerceHostError("INCOMPATIBLE_VERSION", false, undefined,
      new Error(scope === "PLATFORM" ? "PLATFORM_INSTRUCTIONS_INVALID" : "SHOP_INSTRUCTIONS_INVALID"));
  }
  return { text: revision.promptText, revisionId: revision.id };
}

function projectBasket(recovery: OwnedRecovery): RecommendationContext["basket"] {
  if (!Array.isArray(recovery.lineItems) || recovery.lineItems.length > 100 ||
      !Number.isSafeInteger(recovery.generation) || recovery.generation < 1) return null;
  try {
    const fingerprint = fingerprintRecoveryPricingBasket({
      shopId: recovery.shopId, checkoutRecoveryId: recovery.id,
      generation: recovery.generation, currency: recovery.currency, lineItems: recovery.lineItems,
    });
    const lines = recovery.lineItems.map((value, index): RecommendationLine => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new RecommendationBasketValidationError();
      const line = value as Record<string, unknown>;
      const id = (key: string) => typeof line[key] === "string" && (line[key] as string).length > 0 &&
        (line[key] as string).length <= 191 ? line[key] as string : null;
      const ids = (key: string): readonly string[] | null => {
        if (!Array.isArray(line[key]) || line[key].length > 128 ||
            !(line[key] as unknown[]).every((item) => typeof item === "string" && item.length > 0 && item.length <= 191)) return null;
        return Object.freeze([...(line[key] as string[])]);
      };
      const quantity = Number.isSafeInteger(line.quantity) && (line.quantity as number) > 0
        ? line.quantity as number : null;
      const title = typeof line.title === "string" && line.title.length <= 160 ? line.title : "";
      return Object.freeze({ lineKey: `line-${String(index + 1).padStart(4, "0")}`,
        productId: id("productId"), variantId: id("variantId"), title, quantity,
        categoryIds: ids("categoryIds"), collectionIds: ids("collectionIds") });
    });
    return Object.freeze({ generation: recovery.generation, fingerprint, currency: recovery.currency,
      lines: Object.freeze(lines) });
  } catch (error) {
    if (error instanceof RecommendationBasketValidationError || error instanceof TypeError &&
        (error.message === "Invalid recovery pricing basket identity" ||
          error.message === "Invalid basket fingerprint line item" ||
          error.message.startsWith("Invalid basket fingerprint field: "))) return null;
    throw error;
  }
}

function safeStoreUrl(domain: string): string {
  // Shop domains are trusted database fields but still reject control characters before URL parsing.
  // eslint-disable-next-line no-control-regex
  if (!domain || domain.length > 2_048 || /[\u0000-\u001f\u007f]/.test(domain)) throw new CommerceHostError("INVALID_INPUT");
  const input = /^https:\/\//i.test(domain) ? domain : `https://${domain}`;
  let url: URL;
  try { url = new URL(input); } catch (error) { throw new CommerceHostError("INVALID_INPUT", false, undefined, error); }
  const authority = input.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? "";
  if (url.protocol !== "https:" || url.username || url.password || authority.includes("@") || authority.includes(":") ||
      /[?#]/.test(input) || url.port || url.search || url.hash || !url.hostname ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new CommerceHostError("INVALID_INPUT");
  }
  const safeUrl = url.toString().replace(/\/$/, "");
  if (safeUrl.length > 2_048) throw new CommerceHostError("INVALID_INPUT");
  return safeUrl;
}

function policyProjection(policy: Awaited<ReturnType<RecoveryPolicyService["resolve"]>>): RecommendationPolicy {
  const mode = policy.recoveryOfferMode;
  return Object.freeze({ mode,
    authorisedDiscountIds: Object.freeze(mode === "FIXED" && policy.fixedShopifyDiscountId ? [policy.fixedShopifyDiscountId] : []),
    source: policy.source });
}

export async function loadRecommendationContext(input: {
  recovery: OwnedRecovery;
  turn: CommerceTurnIdentity;
  grant: { id: string; releaseId: string };
  db: PrismaClient;
  environment: CommerceEnvironment;
  signal: AbortSignal;
  assertCurrent(): Promise<unknown>;
  now?: () => Date;
}): Promise<RecommendationContext> {
  const provider = input.recovery.shop.platform;
  if (provider !== "SHOPIFY" && provider !== "WOOCOMMERCE") throw new CommerceHostError("INCOMPATIBLE_VERSION");
  await input.assertCurrent();
  input.signal.throwIfAborted();
  const [rows, policy] = await Promise.all([
    input.db.commerceAgentConfiguration.findMany({
      where: { environment: input.environment, OR: [
        { scope: "PLATFORM", shopId: null }, { scope: "SHOP", shopId: input.recovery.shopId },
      ] },
      select: { scope: true, shopId: true, activePromptRevisionId: true,
        activePromptRevision: { select: { id: true, status: true, promptText: true,
          prompt: { select: { scope: true, shopId: true } } } } },
    }),
    new RecoveryPolicyService(input.db).resolve(input.recovery.shopId, (input.now ?? (() => new Date()))()),
  ]);
  await input.assertCurrent();
  const platformRows = rows.filter((row) => row.scope === "PLATFORM" && row.shopId === null);
  const shopRows = rows.filter((row) => row.scope === "SHOP" && row.shopId === input.recovery.shopId);
  if (platformRows.length !== 1 || shopRows.length > 1) throw new CommerceHostError("INCOMPATIBLE_VERSION");
  const platform = promptText(platformRows[0], "PLATFORM", input.recovery.shopId);
  const shop = promptText(shopRows[0], "SHOP", input.recovery.shopId);
  if (!platform) throw new CommerceHostError("INCOMPATIBLE_VERSION");
  const basket = projectBasket(input.recovery);
  return Object.freeze({
    shopId: input.recovery.shopId, provider, turn: input.turn, grantId: input.grant.id,
    releaseId: input.grant.releaseId, policy: policyProjection(policy),
    platformText: platform.text, platformRevisionId: platform.revisionId,
    shopText: shop?.text ?? null, shopRevisionId: shop?.revisionId ?? null,
    basket, basketUnavailableReason: basket ? null : "BASKET_UNAVAILABLE",
    storeUrl: safeStoreUrl(input.recovery.shop.domain),
  });
}

export async function refreshRecommendationPolicy(input: {
  context: RecommendationContext; db: PrismaClient; signal: AbortSignal;
  assertCurrent(): Promise<unknown>; now?: () => Date;
}): Promise<RecommendationPolicy> {
  await input.assertCurrent();
  input.signal.throwIfAborted();
  const current = policyProjection(await new RecoveryPolicyService(input.db).resolve(
    input.context.shopId, (input.now ?? (() => new Date()))(),
  ));
  await input.assertCurrent();
  if (current.mode !== input.context.policy.mode ||
      JSON.stringify([...current.authorisedDiscountIds].sort()) !== JSON.stringify([...input.context.policy.authorisedDiscountIds].sort())) {
    throw new CommerceHostError("DENIED");
  }
  return current;
}

export async function refreshRecommendationContext(input: {
  context: RecommendationContext; recoveryId: string; db: PrismaClient; signal: AbortSignal;
  assertCurrent(): Promise<unknown>;
}): Promise<Readonly<{ basket: RecommendationContext["basket"]; basketChanged: boolean; policy: RecommendationPolicy }>> {
  await input.assertCurrent();
  input.signal.throwIfAborted();
  const row = await input.db.checkoutRecovery.findFirst({
    where: { id: input.recoveryId, shopId: input.context.shopId },
    select: { id: true, shopId: true, generation: true, currency: true, lineItems: true },
  });
  await input.assertCurrent();
  const next = row ? projectBasket({ ...row, shop: { platform: input.context.provider, domain: "" } }) : null;
  const basketChanged = !next || !input.context.basket || next.generation !== input.context.basket.generation ||
    next.fingerprint !== input.context.basket.fingerprint;
  const policy = await refreshRecommendationPolicy(input);
  return Object.freeze({ basket: next, basketChanged, policy });
}
