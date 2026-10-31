import type { PrismaClient } from "@prisma/client";
import type { CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import type { CheckoutPriceReconciliationService } from "../recovery-pricing/checkout-price-reconciliation.service.js";
import { fingerprintRecoveryPricingBasket } from "../recovery-pricing/price-comparison.js";
import type { CheckoutPriceReconciliation } from "../recovery-pricing/checkout-price-reconciliation.types.js";
import { RecoveryPolicyService } from "../recovery-policy.service.js";
import type { InitialOutreachAgentContext } from "../../agents/initial-outreach-offer.types.js";

const MAX_LINES = 100;
const MONEY = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ACTIVE_ATTEMPT_STATUSES = new Set(["PENDING", "CAPACITY_BLOCKED"]);

export class InitialOutreachAgentContextError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "InitialOutreachAgentContextError";
  }
}

type ContextDatabase = Pick<PrismaClient,
  "checkoutRecovery" | "recoveryOutreachAttempt" | "shop" | "commerceAgentConfiguration">;

export type InitialOutreachAgentContextServiceDependencies = Readonly<{
  db: ContextDatabase;
  environment: CommerceEnvironment;
  policyService?: Pick<RecoveryPolicyService, "resolve">;
  priceReconciliationService: Pick<CheckoutPriceReconciliationService, "reconcile">;
  now?: () => Date;
}>;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

function exponent(currency: string): number | null {
  try {
    const options = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions();
    const digits = options.maximumFractionDigits;
    return typeof digits === "number" && Number.isInteger(digits) && digits >= 0 &&
      digits <= 4 && options.minimumFractionDigits === digits ? digits : null;
  } catch {
    return null;
  }
}

function decimalMinor(value: unknown, currency: string): number | null {
  if (typeof value !== "string" || !MONEY.test(value)) return null;
  const places = exponent(currency);
  if (places === null) return null;
  const [whole = "", fractional = ""] = value.split(".");
  if (fractional.length > places) return null;
  try {
    const minor = BigInt(`${whole}${fractional.padEnd(places, "0")}`);
    return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
  } catch {
    return null;
  }
}

function lineTotalMinor(line: Record<string, unknown>, currency: string): number | null {
  const unit = typeof line.price === "string" ? decimalMinor(line.price, currency) : null;
  const quantity = line.quantity;
  if (unit === null || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
  const total = BigInt(unit) * BigInt(quantity);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

function stringIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(safeId);
  if (values.some((entry) => entry === null) || new Set(values).size !== values.length) return null;
  return values as string[];
}

function projectLine(raw: unknown, index: number, currency: string) {
  const line = record(raw);
  if (!line) throw new InitialOutreachAgentContextError("BASKET_LINE_INVALID");
  const quantity = line.quantity;
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new InitialOutreachAgentContextError("BASKET_LINE_QUANTITY_INVALID");
  }
  const title = typeof line.title === "string" ? line.title.slice(0, 160) : "";
  const category = typeof line.category === "string" ? line.category.slice(0, 128) : null;
  return {
    lineKey: `line-${String(index + 1).padStart(4, "0")}`,
    productId: safeId(line.productId),
    variantId: line.variantId === null ? null : safeId(line.variantId),
    categoryIds: stringIds(line.categoryIds),
    collectionIds: stringIds(line.collectionIds),
    isSaleItem: typeof line.isSaleItem === "boolean" ? line.isSaleItem : null,
    title,
    category,
    quantity,
    lineTotalMinor: lineTotalMinor(line, currency),
  };
}

function validatePriceReport(
  report: CheckoutPriceReconciliation,
  input: { shopId: string; recoveryId: string; attemptId: string; generation: number; fingerprint: string },
  items: InitialOutreachAgentContext["basket"]["items"],
): void {
  if (report.shopId !== input.shopId || report.checkoutRecoveryId !== input.recoveryId ||
      report.outreachAttemptId !== input.attemptId || report.generation !== input.generation ||
      report.basketFingerprint !== input.fingerprint || report.lines.length !== items.length) {
    throw new InitialOutreachAgentContextError("PRICE_REPORT_IDENTITY_MISMATCH");
  }
  for (const [index, item] of items.entries()) {
    const line = report.lines[index];
    if (!line || line.lineKey !== item.lineKey || line.productId !== item.productId ||
        line.variantId !== item.variantId || line.quantity !== item.quantity) {
      throw new InitialOutreachAgentContextError("PRICE_REPORT_LINE_MISMATCH");
    }
  }
}

function promptText(
  row: {
    activePromptRevisionId: string | null;
    activePromptRevision: {
      id: string;
      status: string;
      promptText: string;
      prompt: { scope: string; shopId: string | null };
    } | null;
  } | undefined,
  scope: "PLATFORM" | "SHOP",
  shopId: string,
): { text: string; revisionId: string } | null {
  if (scope === "SHOP" && (!row || row.activePromptRevisionId === null)) return null;
  const revision = row?.activePromptRevision;
  if (!row || !row.activePromptRevisionId || !revision || revision.id !== row.activePromptRevisionId ||
      revision.status !== "PUBLISHED" || revision.prompt.scope !== scope ||
      revision.prompt.shopId !== (scope === "SHOP" ? shopId : null) ||
      typeof revision.promptText !== "string" || !revision.promptText.trim() ||
      revision.promptText.length > 8_000) {
    throw new InitialOutreachAgentContextError(scope === "PLATFORM"
      ? "PLATFORM_INSTRUCTIONS_INVALID" : "SHOP_INSTRUCTIONS_INVALID");
  }
  return { text: revision.promptText, revisionId: revision.id };
}

export class InitialOutreachAgentContextService {
  private readonly now: () => Date;
  private readonly policyService: Pick<RecoveryPolicyService, "resolve">;

  constructor(private readonly dependencies: InitialOutreachAgentContextServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.policyService = dependencies.policyService ?? new RecoveryPolicyService(dependencies.db as never);
  }

  async build(input: Readonly<{
    shopId: string;
    checkoutRecoveryId: string;
    outreachAttemptId: string;
    signal: AbortSignal;
  }>): Promise<InitialOutreachAgentContext> {
    if (!input.shopId || !input.checkoutRecoveryId || !input.outreachAttemptId || !input.signal) {
      throw new InitialOutreachAgentContextError("INPUT_INVALID");
    }
    input.signal.throwIfAborted();
    const [recovery, attempt, shop, configurations] = await Promise.all([
      this.dependencies.db.checkoutRecovery.findFirst({
        where: { id: input.checkoutRecoveryId, shopId: input.shopId },
        select: { id: true, shopId: true, generation: true, currency: true, totalPrice: true, lineItems: true, status: true },
      }),
      this.dependencies.db.recoveryOutreachAttempt.findFirst({
        where: { id: input.outreachAttemptId, checkoutRecoveryId: input.checkoutRecoveryId },
        select: { id: true, checkoutRecoveryId: true, sequence: true, trigger: true, status: true, initiatedBy: true },
      }),
      this.dependencies.db.shop.findUnique({ where: { id: input.shopId }, select: { id: true, platform: true } }),
      this.dependencies.db.commerceAgentConfiguration.findMany({
        where: { environment: this.dependencies.environment, OR: [
          { scope: "PLATFORM", shopId: null }, { scope: "SHOP", shopId: input.shopId },
        ] },
        select: { scope: true, shopId: true, activePromptRevisionId: true,
          activePromptRevision: { select: { id: true, status: true, promptText: true, prompt: { select: { scope: true, shopId: true } } } } },
      }),
    ]);
    if (!recovery || recovery.shopId !== input.shopId || recovery.id !== input.checkoutRecoveryId ||
        recovery.status !== "DETECTED" || !Number.isSafeInteger(recovery.generation) || recovery.generation < 1) {
      throw new InitialOutreachAgentContextError("RECOVERY_CONTEXT_INVALID");
    }
    if (!attempt || attempt.id !== input.outreachAttemptId || attempt.checkoutRecoveryId !== recovery.id ||
        attempt.sequence !== 1 || attempt.trigger !== "INITIAL" || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        attempt.initiatedBy === "HUMAN") {
      throw new InitialOutreachAgentContextError("OUTREACH_ATTEMPT_INVALID");
    }
    if (!shop || shop.id !== input.shopId || (shop.platform !== "SHOPIFY" && shop.platform !== "WOOCOMMERCE")) {
      throw new InitialOutreachAgentContextError("SHOP_CONTEXT_INVALID");
    }
    if (typeof recovery.currency !== "string" || !/^[A-Z]{3}$/.test(recovery.currency)) {
      throw new InitialOutreachAgentContextError("BASKET_CURRENCY_INVALID");
    }
    const currency = recovery.currency;
    if (!Array.isArray(recovery.lineItems) || recovery.lineItems.length === 0 || recovery.lineItems.length > MAX_LINES) {
      throw new InitialOutreachAgentContextError("BASKET_SIZE_INVALID");
    }
    let fingerprint: string;
    try {
      fingerprint = fingerprintRecoveryPricingBasket({
        shopId: recovery.shopId,
        checkoutRecoveryId: recovery.id,
        generation: recovery.generation,
        currency: recovery.currency,
        lineItems: recovery.lineItems,
      });
    } catch (error) {
      throw new InitialOutreachAgentContextError(error instanceof Error ? "BASKET_FINGERPRINT_INVALID" : "BASKET_FINGERPRINT_FAILED");
    }
    const items = recovery.lineItems.map((line, index) => projectLine(line, index, currency));
    const policy = await this.policyService.resolve(input.shopId, this.now());
    const mode = policy.recoveryOfferMode;
    const authorisedDiscountIds = mode === "FIXED" && policy.fixedShopifyDiscountId
      ? [policy.fixedShopifyDiscountId] : [];
    const priceReconciliation = mode === "NONE" ? null : await this.dependencies.priceReconciliationService.reconcile({
      shopId: input.shopId,
      checkoutRecoveryId: input.checkoutRecoveryId,
      outreachAttemptId: input.outreachAttemptId,
      expectedGeneration: recovery.generation,
      expectedBasketFingerprint: fingerprint,
      signal: input.signal,
    });
    if (priceReconciliation) {
      validatePriceReport(priceReconciliation, {
        shopId: input.shopId,
        recoveryId: input.checkoutRecoveryId,
        attemptId: input.outreachAttemptId,
        generation: recovery.generation,
        fingerprint,
      }, items);
    }
    const platformRows = configurations.filter((row) => row.scope === "PLATFORM" && row.shopId === null);
    const shopRows = configurations.filter((row) => row.scope === "SHOP" && row.shopId === input.shopId);
    if (platformRows.length !== 1 || shopRows.length > 1) {
      throw new InitialOutreachAgentContextError("PROMPT_CONFIGURATION_DUPLICATE_OR_MISSING");
    }
    const platformPrompt = promptText(platformRows[0], "PLATFORM", input.shopId);
    const merchantPrompt = promptText(shopRows[0], "SHOP", input.shopId);
    if (!platformPrompt) throw new InitialOutreachAgentContextError("PLATFORM_INSTRUCTIONS_MISSING");
    const currentSubtotal = priceReconciliation?.completeness === "COMPLETE"
      ? priceReconciliation.currentMerchandiseSubtotal : null;
    const subtotalMinor = currentSubtotal && currentSubtotal.currency === recovery.currency
      ? decimalMinor(currentSubtotal.amountDecimal, recovery.currency) : null;
    const totalMinor = recovery.totalPrice === null ? null : decimalMinor(recovery.totalPrice.toString(), currency);
    return {
      shopId: input.shopId,
      checkoutRecoveryId: recovery.id,
      outreachAttemptId: attempt.id,
      environment: this.dependencies.environment,
      platform: shop.platform,
      mode,
      authorisedDiscountIds,
      basket: {
        currency,
        subtotalMinor,
        totalMinor,
        fingerprint,
        generation: recovery.generation,
        items,
      },
      priceReconciliation,
      platformInstructions: platformPrompt.text,
      merchantInstructions: merchantPrompt?.text ?? null,
      platformInstructionRevisionId: platformPrompt.revisionId,
      merchantInstructionRevisionId: merchantPrompt?.revisionId ?? null,
    };
  }
}