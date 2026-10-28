import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { recoveryOfferResolver } from "../recovery-offers/recovery-offer-resolver.service.js";
import type {
  PreviouslyPromisedOffer, RecoveryOfferDecision, ResolveRecoveryOfferInput,
} from "../recovery-offers/recovery-offer.types.js";
import { recoveryTemplatePreparer } from "../recovery-template-preparation/recovery-template-preparer.service.js";
import type {
  PreparedRecoveryTemplate, RecoveryTemplatePreparationInput,
} from "../recovery-template-preparation/recovery-template.types.js";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import type { RecoveryPolicySnapshot } from "../recovery-policy.service.js";
import { templateSendFields, type RecoveryOfferPromise } from "./prepared-template-send.js";

export type AutomatedTemplateResult =
  | { kind: "prepared"; prepared: PreparedRecoveryTemplate; send: ReturnType<typeof templateSendFields> }
  | { kind: "unavailable"; reason: string };

export type AutomatedTemplateInput = Readonly<{
  shopId: string; recoveryId: string; stage: "INITIAL" | "FOLLOW_UP";
  policy: RecoveryPolicySnapshot;
  /** Sequence 1 uses shop default. Sequence 2 uses the conversation language. */
  conversationLanguageTag: string | null;
  customerFirstName?: string | null;
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
  constructor(
    private readonly offers: Pick<typeof recoveryOfferResolver, "resolve"> = recoveryOfferResolver,
    private readonly preparer: Pick<typeof recoveryTemplatePreparer, "prepare"> = recoveryTemplatePreparer,
    private readonly database: Pick<typeof prisma, "checkoutRecovery" | "conversationMessage"> = prisma,
    private readonly senderWaba: () => Promise<string> = () => outboundWhatsAppAdmissionService.getProviderAccountId(),
    private readonly clock: () => Date = () => new Date(),
    private readonly log: Pick<StructuredLogger, "warn" | "error"> = logger,
  ) {}

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
          id: true, shopId: true, status: true, checkoutUrl: true, updatedAt: true,
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
      const now = this.clock();
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
      if (offer.kind !== "NO_OFFER" && input.stage === "FOLLOW_UP" &&
          (!prior || prior.kind !== offer.kind || prior.providerDiscountId !== offer.providerDiscountId ||
           (offer.kind === "CODE_OFFER" && prior.code !== offer.parameters.code))) {
        return unavailable("FOLLOW_UP_OFFER_CHANGED");
      }
      const offerPresentation = offer.kind;
      const prep: RecoveryTemplatePreparationInput = {
        shopId: input.shopId,
        senderWabaId: await this.senderWaba(),
        stage: input.stage,
        offerPresentation,
        conversationLanguageTag: input.stage === "INITIAL" ? null : input.conversationLanguageTag,
        merchantLanguageTag: recovery.shop.defaultLanguageTag,
        customerFirstName: input.customerFirstName ?? recovery.customer?.firstName ?? null,
        shopName: { shopId: input.shopId, value: recovery.shop.domain },
        checkout: recovery.checkoutUrl ? {
          shopId: input.shopId, url: recovery.checkoutUrl,
          observedAt: recovery.updatedAt, expiresAt: null,
          approvedHosts: authorisedHosts(recovery.shop.domain),
        } : null,
        ...(offer.kind !== "NO_OFFER" ? { verifiedOffer: {
          shopId: input.shopId, kind: offer.kind, verified: true,
          verifiedAt: offer.evidence.evaluatedAt, expiresAt: offer.evidence.expiresAt,
          ...(offer.kind === "CODE_OFFER" ? { code: offer.parameters.code } : {}),
          description: offer.description,
        } as const } : {}),
      };
      const prepared = await this.preparer.prepare(prep);
      if (prepared.outcome !== "prepared") return unavailable(prepared.reason);
      return { kind: "prepared", prepared,
        send: templateSendFields(prepared, promiseFor(offer)) };
    } catch (error) {
      this.log.error("recovery_template.integration.failed", {
        shopId: input.shopId, recoveryId: input.recoveryId,
        stage: input.stage, errorType: boundedFailure(error),
        errorMessage: error instanceof Error ? error.message : String(error),
        error,
      });
      throw error;
    }
  }
}

export const automatedRecoveryTemplateService = new AutomatedRecoveryTemplateService();
