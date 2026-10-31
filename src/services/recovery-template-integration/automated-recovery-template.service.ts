import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { recoveryOfferResolver } from "../recovery-offers/recovery-offer-resolver.service.js";
import { initialOutreachOfferSelectionService } from "../recovery-offers/initial-outreach-offer-selection.service.js";
import { fingerprintRecoveryPricingBasket } from "../recovery-pricing/price-comparison.js";
import type { CheckoutPriceReconciliation } from "../recovery-pricing/checkout-price-reconciliation.types.js";
import type { InitialOutreachOfferSelectionService } from "../recovery-offers/initial-outreach-offer-selection.service.js";
import type { CurrentOutreachOfferAdmissionToken } from "../recovery-offers/current-outreach-offer-revalidation.service.js";
import type {
  PreviouslyPromisedOffer, RecoveryOfferDecision, ResolveRecoveryOfferInput,
} from "../recovery-offers/recovery-offer.types.js";
import { recoveryTemplatePreparer } from "../recovery-template-preparation/recovery-template-preparer.service.js";
import type {
  PreparedRecoveryTemplate, RecoveryTemplatePreparationInput, RecoveryPromotionTarget,
  SourceBoundPromotionalProduct, TrustedOffer,
} from "../recovery-template-preparation/recovery-template.types.js";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import type { RecoveryPolicySnapshot } from "../recovery-policy.service.js";
import {
  CheckoutRecoveryLifetimePolicyUnavailableError,
  isCheckoutRecoveryWithinLifetime,
  PersistedCheckoutRecoveryLifetimeReader,
  type CheckoutRecoveryLifetimeReader,
} from "../recovery-lifetime/checkout-recovery-lifetime.js";
import { templateSendFields, type RecoveryOfferPromise } from "./prepared-template-send.js";

export type AutomatedTemplateResult =
  | { kind: "prepared"; prepared: PreparedRecoveryTemplate; send: ReturnType<typeof templateSendFields>;
  admissionToken?: CurrentOutreachOfferAdmissionToken }
  | { kind: "unavailable"; reason: string };

export type AutomatedTemplateInput = Readonly<{
  shopId: string; recoveryId: string; stage: "INITIAL" | "FOLLOW_UP";
  policy: RecoveryPolicySnapshot;
  /** Sequence 1 uses shop default. Sequence 2 uses the conversation language. */
  conversationLanguageTag: string | null;
  customerFirstName?: string | null;
  outreachAttemptId?: string;
}>;

const logger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});

function boundedFailure(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name : "unknown";
}

/** The only supported historical promise is the template input actually stored
 * on a provider-confirmed sequence-one message. Mutable current catalogue or
 * policy must never be treated as proof of what was sent previously. */
export function previousPromise(content: string): PreviouslyPromisedOffer | null {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.contract !== "moda.whatsapp.automated-template-parameters.v1") return null;
    const promise = record.recoveryPromise;
    if (!promise || typeof promise !== "object" || Array.isArray(promise)) return null;
    const evidence = promise as Record<string, unknown>;
    if (evidence.kind === "NO_OFFER" && Object.keys(evidence).length === 1) return { kind: "NO_OFFER" };
    if ((evidence.kind === "CODE_OFFER" || evidence.kind === "AUTOMATIC_OFFER") &&
        typeof evidence.providerDiscountId === "string" && evidence.providerDiscountId.length > 0 &&
        evidence.providerDiscountId.length <= 191 &&
        (evidence.kind !== "CODE_OFFER" || (typeof evidence.code === "string" &&
          evidence.code.length > 0 && evidence.code.length <= 100))) {
      return { kind: evidence.kind, providerDiscountId: evidence.providerDiscountId,
        ...(evidence.kind === "CODE_OFFER" ? { code: evidence.code as string } : {}) };
    }
    if (evidence.kind === "CHECKOUT_DISCOUNT" && evidence.offerSet &&
        typeof evidence.offerSet === "object" && !Array.isArray(evidence.offerSet)) {
      const offerSet = evidence.offerSet as Record<string, unknown>;
      const offers = offerSet.offers;
      if (offerSet.schemaVersion === "moda.outreach.checkout-offers.v1" &&
          Array.isArray(offers) && offers.length === 1 &&
          offers[0] && typeof offers[0] === "object" && !Array.isArray(offers[0])) {
        const [offer] = offers as [Record<string, unknown>];
        if (typeof offer.providerDiscountId === "string" && offer.providerDiscountId.length > 0 &&
            offer.providerDiscountId.length <= 191 && offer.method === "CODE" &&
            typeof offer.code === "string" && offer.code.length > 0 && offer.code.length <= 100) {
          return { kind: "CODE_OFFER", providerDiscountId: offer.providerDiscountId, code: offer.code };
        }
        if (typeof offer.providerDiscountId === "string" && offer.providerDiscountId.length > 0 &&
            offer.providerDiscountId.length <= 191 && offer.method === "AUTOMATIC" && offer.code === null) {
          return { kind: "AUTOMATIC_OFFER", providerDiscountId: offer.providerDiscountId };
        }
      }
    }
    return null;
  } catch (error) {
    // Legacy or corrupt receipts fail closed; record the parse exception for diagnosis.
    logger.warn("recovery_template.previous_promise.invalid_receipt", {
      errorType: boundedFailure(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      error,
    });
    return null;
  }
}

function promiseFor(offer: RecoveryOfferDecision): RecoveryOfferPromise {
  return offer.kind === "NO_OFFER" ? { kind: "NO_OFFER" } : {
    kind: offer.kind, providerDiscountId: offer.providerDiscountId,
    ...(offer.kind === "CODE_OFFER" ? { code: offer.parameters.code! } : {}),
  };
}

function currentBasketFingerprint(recovery: {
  id: string; shopId: string; generation: number; currency: string | null; lineItems: unknown;
}): string | null {
  try {
    return fingerprintRecoveryPricingBasket({
      shopId: recovery.shopId, checkoutRecoveryId: recovery.id,
      generation: recovery.generation, currency: recovery.currency, lineItems: recovery.lineItems,
    });
  } catch {
    return null;
  }
}

function samePriceEvidence(
  left: CheckoutPriceReconciliation | null,
  right: CheckoutPriceReconciliation | null,
): boolean {
  if (left === null || right === null) return left === right;
  const { evaluatedAt: _leftEvaluatedAt, ...leftFacts } = left;
  const { evaluatedAt: _rightEvaluatedAt, ...rightFacts } = right;
  return JSON.stringify(leftFacts) === JSON.stringify(rightFacts);
}

function sameCurrentOfferContext(
  original: Awaited<ReturnType<InitialOutreachOfferSelectionService["resolve"]>>["context"],
  current: Awaited<ReturnType<InitialOutreachOfferSelectionService["resolve"]>>["currentContext"],
): boolean {
  return original.shopId === current.shopId &&
    original.checkoutRecoveryId === current.checkoutRecoveryId &&
    original.outreachAttemptId === current.outreachAttemptId &&
    original.mode === current.mode &&
    JSON.stringify(original.authorisedDiscountIds) === JSON.stringify(current.authorisedDiscountIds) &&
    original.platformInstructionRevisionId === current.platformInstructionRevisionId &&
    original.merchantInstructionRevisionId === current.merchantInstructionRevisionId &&
    original.basket.generation === current.basket.generation &&
    original.basket.fingerprint === current.basket.fingerprint &&
    samePriceEvidence(original.priceReconciliation, current.priceReconciliation);
}

function authorisedHosts(domain: string): string[] {
  // Only the authenticated Shop's canonical host can authorise a checkout URL.
  // Never add a host inferred from a merchant-controlled checkout URL itself.
  const origin = domain.includes("://") ? domain : `https://${domain}`;
  if (!URL.canParse(origin)) return [];
  const normalized = new URL(origin);
  if (!normalized.hostname.includes(".") || normalized.username || normalized.password ||
      !["https:", "http:"].includes(normalized.protocol)) return [];
  return [normalized.hostname.toLowerCase()];
}

/** A narrow coordinator: no sends, no reservation and no mutable discount state. */
export class AutomatedRecoveryTemplateService {
  private readonly lifetimeReader: CheckoutRecoveryLifetimeReader;

  constructor(
    private readonly offers: Pick<typeof recoveryOfferResolver, "resolve"> = recoveryOfferResolver,
    private readonly preparer: Pick<typeof recoveryTemplatePreparer, "prepare"> = recoveryTemplatePreparer,
    private readonly database: Pick<typeof prisma, "checkoutRecovery" | "conversationMessage" | "backgroundRuntimeConfig"> = prisma,
    private readonly senderWaba: () => Promise<string> = () => outboundWhatsAppAdmissionService.getProviderAccountId(),
    private readonly clock: () => Date = () => new Date(),
    private readonly log: Pick<StructuredLogger, "warn" | "error"> = logger,
    lifetimeReader?: CheckoutRecoveryLifetimeReader,
    private readonly initialOffers: Pick<InitialOutreachOfferSelectionService, "resolve"> =
      initialOutreachOfferSelectionService,
    private readonly admissionValidator: Pick<InitialOutreachOfferSelectionService, "validateAdmission"> =
      initialOutreachOfferSelectionService,
  ) {
    this.lifetimeReader = lifetimeReader ?? new PersistedCheckoutRecoveryLifetimeReader(database);
  }

  async prepare(input: AutomatedTemplateInput): Promise<AutomatedTemplateResult> {
    const unavailable = (reason: string): AutomatedTemplateResult => {
      this.log.warn("recovery_template.integration.unavailable", {
        shopId: input.shopId, recoveryId: input.recoveryId, stage: input.stage, reason,
      });
      return { kind: "unavailable", reason };
    };
    try {
      const recovery = await this.database.checkoutRecovery.findUnique({
        where: { id: input.recoveryId },
        select: {
          id: true, shopId: true, generation: true, currency: true,
          status: true, checkoutUrl: true, lineItems: true,
          lastExternalActivityAt: true, expiredAt: true,
          customer: { select: { firstName: true } },
          shop: { select: { id: true, domain: true, status: true, defaultLanguageTag: true } },
          outreachAttempts: { where: { sequence: 1 }, select: { sentAt: true, outboundMessageId: true } },
        },
      });
      if (!recovery || recovery.shopId !== input.shopId || recovery.shop.id !== input.shopId ||
          recovery.shop.status !== "ACTIVE" ||
          !["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(recovery.status)) {
        return unavailable("RECOVERY_UNAVAILABLE");
      }
      const now = this.clock();
      if (!(recovery.lastExternalActivityAt instanceof Date) ||
          !Number.isSafeInteger(recovery.lastExternalActivityAt.getTime()) ||
          (recovery.expiredAt !== null && (!(recovery.expiredAt instanceof Date) ||
            !Number.isSafeInteger(recovery.expiredAt.getTime()) || recovery.expiredAt <= now))) {
        return unavailable("RECOVERY_UNAVAILABLE");
      }
      let checkoutRecoveryLifetimeDays: number | null = null;
      if (recovery.checkoutUrl) {
        try {
          checkoutRecoveryLifetimeDays = await this.lifetimeReader.read();
        } catch (error) {
          if (error instanceof CheckoutRecoveryLifetimePolicyUnavailableError) {
            return unavailable("CHECKOUT_UNAVAILABLE");
          }
          throw error;
        }
        if (!isCheckoutRecoveryWithinLifetime({
          lastExternalActivityAt: recovery.lastExternalActivityAt,
          now,
          checkoutRecoveryLifetimeDays,
        })) return unavailable("CHECKOUT_UNAVAILABLE");
      }
      let prior: PreviouslyPromisedOffer | undefined;
      if (input.stage === "FOLLOW_UP") {
        const initial = recovery.outreachAttempts[0];
        if (!initial?.sentAt || !initial.outboundMessageId) return unavailable("INITIAL_PROMISE_UNAVAILABLE");
        const message = await this.database.conversationMessage.findUnique({
          where: { id: initial.outboundMessageId },
          select: { content: true, status: true, providerMessageId: true, direction: true, senderType: true },
        });
        if (!message || !["SENT", "DELIVERED", "READ"].includes(message.status) ||
            !message.providerMessageId || message.direction !== "OUTBOUND" ||
            message.senderType !== "AUTOMATION") return unavailable("INITIAL_PROMISE_UNAVAILABLE");
        const parsed = previousPromise(message.content);
        if (!parsed) return unavailable("INITIAL_PROMISE_UNAVAILABLE");
        prior = parsed;
      }
      let offerPresentation: RecoveryTemplatePreparationInput["offerPresentation"];
      let promotionTarget: RecoveryPromotionTarget = "CHECKOUT";
      let verifiedOffer: TrustedOffer | undefined;
      let promotionalProduct: SourceBoundPromotionalProduct | undefined;
      let recoveryPromise: RecoveryOfferPromise;
      let admissionToken: CurrentOutreachOfferAdmissionToken | undefined;
      if (input.stage === "INITIAL") {
        if (!input.outreachAttemptId) return unavailable("OUTREACH_ATTEMPT_UNAVAILABLE");
        const selected = await this.initialOffers.resolve({
          shopId: input.shopId, checkoutRecoveryId: input.recoveryId,
          outreachAttemptId: input.outreachAttemptId,
        });
        const { result, context, currentContext } = selected;
        if (result.kind === "FAILURE") return unavailable(result.reasonCode);
        admissionToken = selected.admissionToken;
        const fingerprint = currentBasketFingerprint(recovery);
        if (!fingerprint || !sameCurrentOfferContext(context, currentContext) ||
          context.shopId !== input.shopId ||
            context.checkoutRecoveryId !== input.recoveryId || context.outreachAttemptId !== input.outreachAttemptId ||
            context.basket.generation !== recovery.generation || context.basket.fingerprint !== fingerprint ||
            context.mode !== input.policy.recoveryOfferMode ||
            (context.mode === "FIXED" && context.authorisedDiscountIds[0] !== input.policy.fixedShopifyDiscountId)) {
          return unavailable("INITIAL_OFFER_CONTEXT_STALE");
        }
        if (result.kind === "NO_VERIFIED_OFFER") {
          if (result.discoveryIncomplete) return unavailable("INITIAL_OFFER_DISCOVERY_INCOMPLETE");
          offerPresentation = "NO_OFFER";
          recoveryPromise = { kind: "NO_OFFER" };
        } else if (result.kind === "CHECKOUT_DISCOUNT") {
          if (result.shopId !== input.shopId || result.checkoutRecoveryId !== input.recoveryId ||
              result.outreachAttemptId !== input.outreachAttemptId || result.generation !== recovery.generation ||
              result.fingerprint !== fingerprint || result.group.verdict !== "SUPPORTED" ||
              !samePriceEvidence(result.priceReconciliation, context.priceReconciliation) ||
              result.group.offerIds.length !== result.offerSet.offers.length ||
              result.members.length !== result.offerSet.offers.length) {
            return unavailable("INITIAL_OFFER_IDENTITY_MISMATCH");
          }
          const ordered = result.offerSet.offers.map((offer, index) => {
            const member = result.members[index];
            if (!member || result.group.offerIds[index] !== offer.offerId ||
                member.offerId !== offer.offerId || member.providerDiscountId !== offer.providerDiscountId ||
                member.method !== offer.method || member.code !== offer.code ||
                member.eligibility.verdict !== "SUPPORTED") return null;
            return { offer, member };
          });
          if (ordered.some((entry) => entry === null)) return unavailable("INITIAL_OFFER_EVIDENCE_INVALID");
          const validOrdered: Array<NonNullable<(typeof ordered)[number]>> = ordered.filter(
            (entry): entry is NonNullable<(typeof ordered)[number]> => entry !== null,
          );
          const groups = new Map<"CODE" | "AUTOMATIC", typeof validOrdered>();
          for (const entry of validOrdered) {
            const group = groups.get(entry.offer.method) ?? [];
            group.push(entry);
            groups.set(entry.offer.method, group);
          }
          const sendable = [...groups.values()].sort((left, right) => right.length - left.length)[0]!;
          const offerSet = {
            schemaVersion: result.offerSet.schemaVersion,
            offers: sendable.map(({ offer }) => offer),
          };
          const codes = sendable.map(({ offer }) => offer.code);
          const description = sendable.map(({ member }) => member.description).join(", ");
          if (sendable[0]!.offer.method === "CODE" && codes.some((code) => !code)) {
            return unavailable("INITIAL_OFFER_CODE_UNAVAILABLE");
          }
          offerPresentation = sendable[0]!.offer.method === "CODE" ? "CODE_OFFER" : "AUTOMATIC_OFFER";
          verifiedOffer = {
            shopId: input.shopId, kind: offerPresentation, verified: true,
            verifiedAt: now, expiresAt: null,
            ...(offerPresentation === "CODE_OFFER" ? { code: codes[0]!, codes: codes as string[] } : {}),
            description,
          };
          recoveryPromise = { kind: "CHECKOUT_DISCOUNT", offerSet };
        } else {
          if (result.shopId !== input.shopId || result.checkoutRecoveryId !== input.recoveryId ||
              result.outreachAttemptId !== input.outreachAttemptId || result.generation !== recovery.generation ||
              result.fingerprint !== fingerprint || result.discoveryIncomplete ||
              context.mode === "NONE" || result.product.sourceTool !== "commerce_get_product" ||
              result.product.authenticatedShopId !== input.shopId || result.product.shopId !== input.shopId ||
              result.product.product.productId !== result.productId ||
              result.product.product.variantId !== result.variantId) {
            return unavailable("PROMOTION_PRODUCT_URL_UNAVAILABLE");
          }
          promotionTarget = "ALTERNATIVE_PRODUCT";
          offerPresentation = result.method === "CODE" ? "CODE_OFFER" : "AUTOMATIC_OFFER";
          if (offerPresentation === "CODE_OFFER" && !result.code) {
            return unavailable("PROMOTION_OFFER_CODE_UNAVAILABLE");
          }
          verifiedOffer = {
            shopId: input.shopId, kind: offerPresentation, verified: true,
            verifiedAt: now, expiresAt: null,
            ...(result.code ? { code: result.code } : {}), description: result.description,
          };
          const product = result.product.product;
          promotionalProduct = {
            sourceTool: result.product.sourceTool,
            authenticatedShopId: result.product.authenticatedShopId,
            product: { productId: product.productId, variantId: product.variantId,
              title: product.title, url: product.url },
          };
          recoveryPromise = {
            kind: "ALTERNATIVE_PRODUCT_PROMOTION", offerId: result.offerId,
            providerDiscountId: result.providerDiscountId, method: result.method, code: result.code,
            productId: result.productId, variantId: result.variantId,
            productTitle: result.product.product.title,
          };
        }
      } else {
        const offerInput: ResolveRecoveryOfferInput = {
          shopId: input.shopId, checkoutRecoveryId: input.recoveryId,
          stage: input.stage, policy: input.policy, now,
          ...(prior ? { previouslyPromisedOffer: prior } : {}),
        };
        const offer = await this.offers.resolve(offerInput);
        if (offer.kind === "NO_OFFER") {
          if (["INVALID_CONTEXT", "RECOVERY_UNAVAILABLE", "STALE_CHECKOUT", "PREVIOUS_OFFER_UNKNOWN"].includes(offer.reason)) {
            return unavailable(offer.reason);
          }
          if (prior && prior.kind !== "NO_OFFER") return unavailable("PREVIOUS_OFFER_UNVERIFIED");
          if (offer.reason === "PROVIDER_VERIFICATION_UNAVAILABLE") {
            this.log.warn("recovery_offer.capability_gap", {
              shopId: input.shopId, recoveryId: input.recoveryId, stage: input.stage,
              reason: "CHECKOUT_RULE_READER_UNAVAILABLE",
            });
          }
        }
        if (offer.kind !== "NO_OFFER" &&
            (!prior || prior.kind !== offer.kind || prior.providerDiscountId !== offer.providerDiscountId ||
             (offer.kind === "CODE_OFFER" && prior.code !== offer.parameters.code))) {
          return unavailable("FOLLOW_UP_OFFER_CHANGED");
        }
        offerPresentation = offer.kind;
        recoveryPromise = promiseFor(offer);
        if (offer.kind !== "NO_OFFER") {
          verifiedOffer = {
            shopId: input.shopId, kind: offer.kind, verified: true,
            verifiedAt: offer.evidence.evaluatedAt, expiresAt: offer.evidence.expiresAt,
            ...(offer.kind === "CODE_OFFER" ? { code: offer.parameters.code } : {}),
            description: offer.description,
          };
        }
      }
      const prep: RecoveryTemplatePreparationInput = {
        shopId: input.shopId,
        senderWabaId: await this.senderWaba(),
        stage: input.stage,
        offerPresentation,
        promotionTarget,
        conversationLanguageTag: input.stage === "INITIAL" ? null : input.conversationLanguageTag,
        merchantLanguageTag: recovery.shop.defaultLanguageTag,
        customerFirstName: input.customerFirstName ?? recovery.customer?.firstName ?? null,
        shopName: { shopId: input.shopId, value: recovery.shop.domain },
        checkoutItems: { shopId: input.shopId, lineItems: recovery.lineItems },
        checkout: recovery.checkoutUrl ? {
          shopId: input.shopId, url: recovery.checkoutUrl,
          lastExternalActivityAt: recovery.lastExternalActivityAt,
          checkoutRecoveryLifetimeDays: checkoutRecoveryLifetimeDays!,
          expiresAt: recovery.expiredAt,
          approvedHosts: authorisedHosts(recovery.shop.domain),
        } : null,
        ...(verifiedOffer ? { verifiedOffer } : {}),
        ...(promotionalProduct ? { promotionalProduct } : {}),
      };
      const prepared = await this.preparer.prepare(prep);
      if (prepared.outcome !== "prepared") return unavailable(prepared.reason);
      return { kind: "prepared", prepared, send: templateSendFields(prepared, recoveryPromise),
        ...(admissionToken ? { admissionToken } : {}) };
    } catch (error) {
      this.log.error("recovery_template.integration.failed", {
        shopId: input.shopId, recoveryId: input.recoveryId,
        stage: input.stage, errorType: boundedFailure(error),
        // Shared logger serializes Error values with bounded, stack-free fields.
        error,
      });
      throw error;
    }
  }

  validateAdmission(token: CurrentOutreachOfferAdmissionToken, signal: AbortSignal): Promise<boolean> {
    return this.admissionValidator.validateAdmission(token, signal);
  }
}

export const automatedRecoveryTemplateService = new AutomatedRecoveryTemplateService();
