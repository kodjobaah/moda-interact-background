import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  formatCheckoutItemsSummary,
} from "../recovery-template-preparation/recovery-template-items-summary.js";
import {
  CheckoutRecoveryLifetimePolicyUnavailableError,
  isCheckoutRecoveryWithinLifetime,
  PersistedCheckoutRecoveryLifetimeReader,
  type CheckoutRecoveryLifetimeReader,
} from "../recovery-lifetime/checkout-recovery-lifetime.js";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import { recoveryTemplatePreparer } from "../recovery-template-preparation/recovery-template-preparer.service.js";
import type { PreparedRecoveryTemplate } from "../recovery-template-preparation/recovery-template.types.js";
import { templateSendFields } from "./prepared-template-send.js";

export type InitialFallbackTrigger =
  | "MERCHANT_MODE_NONE"
  | "NO_VERIFIED_PROMOTION"
  | "AI_UNAVAILABLE"
  | "MCP_UNAVAILABLE"
  | "DISCOUNT_REVALIDATION_UNAVAILABLE"
  | "DISCOUNT_INVALID_OR_INCOMPATIBLE"
  | "PRICE_UNVERIFIABLE"
  | "ALTERNATIVE_PRODUCT_UNVERIFIABLE"
  | "IMAGE_UNAVAILABLE";

export type InitialFallbackResult =
  | Readonly<{
      kind: "PREPARED";
      trigger: InitialFallbackTrigger;
      prepared: PreparedRecoveryTemplate;
      send: ReturnType<typeof templateSendFields>;
    }>
  | Readonly<{
      kind: "BLOCKED";
      reason: "INELIGIBLE_RECOVERY" | "INVALID_ATTEMPT" |
        "CHECKOUT_ITEMS_UNAVAILABLE" | "TEMPLATE_UNAPPROVED" |
        "APPROVED_BINDING_UNAVAILABLE" | "MERCHANT_OR_SENDER_MISMATCH";
    }>
  | Readonly<{
      kind: "RETRY";
      reason: "REQUIRED_STATE_UNAVAILABLE" | "PROVIDER_OUTCOME_UNCERTAIN";
    }>;

export interface InitialNoOfferFallbackPort {
  prepare(input: Readonly<{
    shopId: string;
    recoveryId: string;
    outreachAttemptId: string;
    trigger: InitialFallbackTrigger;
  }>): Promise<InitialFallbackResult>;
}

type FallbackDatabase = Pick<PrismaClient,
  "checkoutRecovery" | "recoveryOutreachAttempt" | "conversationMessage" |
  "backgroundRuntimeConfig" | "checkoutRecoveryStatusHistory">;
type FallbackPreparer = Pick<typeof recoveryTemplatePreparer, "prepare">;
type FallbackSenderResolver = () => Promise<string | null>;

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

function approvedHosts(domain: string): string[] {
  const origin = domain.includes("://") ? domain : `https://${domain}`;
  if (!URL.canParse(origin)) return [];
  const parsed = new URL(origin);
  if (!parsed.hostname.includes(".") || parsed.username || parsed.password ||
      !["https:", "http:"].includes(parsed.protocol)) return [];
  return [parsed.hostname.toLowerCase()];
}

function unavailableTemplateReason(reason: string): InitialFallbackResult {
  if (["SENDER_UNAVAILABLE", "SENDER_MISMATCH", "IDENTITY_MISMATCH", "SHOP_UNAVAILABLE"]
    .includes(reason)) {
    return { kind: "BLOCKED", reason: "MERCHANT_OR_SENDER_MISMATCH" };
  }
  if (["NO_APPROVED_ASSIGNMENT", "LEGACY_ASSIGNMENT", "AMBIGUOUS_ASSIGNMENT",
    "REGISTRATION_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "PROVIDER_DRIFT",
    "DEFINITION_UNAVAILABLE", "LOCALE_UNAVAILABLE", "INVALID_LANGUAGE", "NO_LANGUAGE"]
    .includes(reason)) {
    return { kind: "BLOCKED", reason: "TEMPLATE_UNAPPROVED" };
  }
  return { kind: "BLOCKED", reason: "APPROVED_BINDING_UNAVAILABLE" };
}

export class InitialNoOfferFallbackService implements InitialNoOfferFallbackPort {
  private readonly lifetimeReader: CheckoutRecoveryLifetimeReader;

  constructor(
    private readonly database: FallbackDatabase = prisma,
    private readonly preparer: FallbackPreparer = recoveryTemplatePreparer,
    private readonly senderWaba: FallbackSenderResolver =
      () => outboundWhatsAppAdmissionService.getProviderAccountId(),
    private readonly clock: () => Date = () => new Date(),
    private readonly log: Pick<StructuredLogger, "warn" | "error"> = logger,
    lifetimeReader?: CheckoutRecoveryLifetimeReader,
  ) {
    this.lifetimeReader = lifetimeReader ?? new PersistedCheckoutRecoveryLifetimeReader(database);
  }

  async prepare(input: Readonly<{
    shopId: string;
    recoveryId: string;
    outreachAttemptId: string;
    trigger: InitialFallbackTrigger;
  }>): Promise<InitialFallbackResult> {
    try {
      const [recovery, attempt] = await Promise.all([
        this.database.checkoutRecovery.findUnique({
          where: { id: input.recoveryId },
          select: {
            id: true, shopId: true, generation: true, status: true,
            checkoutUrl: true, lineItems: true, lastExternalActivityAt: true,
            expiredAt: true, customer: { select: { firstName: true } },
            shop: { select: {
              id: true, domain: true, platform: true, status: true, defaultLanguageTag: true,
            } },
          },
        }),
        this.database.recoveryOutreachAttempt.findFirst({
          where: { id: input.outreachAttemptId, checkoutRecoveryId: input.recoveryId },
          select: {
            id: true, checkoutRecoveryId: true, sequence: true, trigger: true,
            status: true, sentAt: true, outboundMessageId: true, followUpDueAt: true,
          },
        }),
      ]);
      if (!recovery || recovery.shopId !== input.shopId || recovery.shop.id !== input.shopId ||
          !["SHOPIFY", "WOOCOMMERCE"].includes(recovery.shop.platform) ||
          recovery.shop.status !== "ACTIVE" || recovery.status !== "DETECTED" || recovery.expiredAt) {
        return { kind: "BLOCKED", reason: "INELIGIBLE_RECOVERY" };
      }
      if (!attempt || attempt.checkoutRecoveryId !== recovery.id || attempt.sequence !== 1 ||
          attempt.trigger !== "INITIAL" || !["PENDING", "CAPACITY_BLOCKED"].includes(attempt.status) ||
          attempt.sentAt || attempt.outboundMessageId || attempt.followUpDueAt) {
        return { kind: "BLOCKED", reason: "INVALID_ATTEMPT" };
      }

      const [linkedMessage, dispatchedMessage] = await Promise.all([
        attempt.outboundMessageId
          ? this.database.conversationMessage.findUnique({
              where: { id: attempt.outboundMessageId },
              select: { id: true },
            })
          : Promise.resolve(null),
        this.database.conversationMessage.findFirst({
          where: { providerDispatchKey: `recovery-outreach:${attempt.id}` },
          select: { id: true },
        }),
      ]);
      if (linkedMessage || dispatchedMessage) {
        return { kind: "RETRY", reason: "PROVIDER_OUTCOME_UNCERTAIN" };
      }

      if (!recovery.checkoutUrl || typeof recovery.checkoutUrl !== "string") {
        return { kind: "BLOCKED", reason: "APPROVED_BINDING_UNAVAILABLE" };
      }
      const summary = formatCheckoutItemsSummary(recovery.lineItems, recovery.shop.defaultLanguageTag ?? "en");
      if (!summary) return { kind: "BLOCKED", reason: "CHECKOUT_ITEMS_UNAVAILABLE" };

      let lifetimeDays: number;
      try {
        lifetimeDays = await this.lifetimeReader.read();
      } catch (error) {
        if (!(error instanceof CheckoutRecoveryLifetimePolicyUnavailableError)) throw error;
        return { kind: "RETRY", reason: "REQUIRED_STATE_UNAVAILABLE" };
      }
      const now = this.clock();
      if (!isCheckoutRecoveryWithinLifetime({
        lastExternalActivityAt: recovery.lastExternalActivityAt,
        now,
        checkoutRecoveryLifetimeDays: lifetimeDays,
      })) return { kind: "BLOCKED", reason: "INELIGIBLE_RECOVERY" };

      const senderWabaId = await this.senderWaba();
      if (!senderWabaId) return { kind: "BLOCKED", reason: "MERCHANT_OR_SENDER_MISMATCH" };
      const prepared = await this.preparer.prepare({
        shopId: recovery.shopId,
        senderWabaId,
        stage: "INITIAL",
        promotionTarget: "CHECKOUT",
        offerPresentation: "NO_OFFER",
        conversationLanguageTag: null,
        merchantLanguageTag: recovery.shop.defaultLanguageTag,
        customerFirstName: recovery.customer?.firstName ?? null,
        shopName: { shopId: recovery.shop.id, value: recovery.shop.domain },
        checkout: {
          shopId: recovery.shopId,
          url: recovery.checkoutUrl,
          lastExternalActivityAt: recovery.lastExternalActivityAt,
          checkoutRecoveryLifetimeDays: lifetimeDays,
          expiresAt: recovery.expiredAt,
          approvedHosts: approvedHosts(recovery.shop.domain),
        },
        checkoutItems: { shopId: recovery.shopId, lineItems: recovery.lineItems },
      });
      if (prepared.outcome !== "prepared") {
        const blocked = unavailableTemplateReason(prepared.reason);
        if (blocked.kind === "BLOCKED" && blocked.reason === "TEMPLATE_UNAPPROVED") {
          await this.database.checkoutRecoveryStatusHistory.create({
            data: {
              checkoutRecoveryId: recovery.id,
              fromStatus: recovery.status,
              toStatus: recovery.status,
              reason: "CONFIGURATION_BLOCKED",
              source: "INITIAL_NO_OFFER_FALLBACK",
              metadata: {
                outreachAttemptId: attempt.id,
                fallbackReason: prepared.reason,
              },
            },
          });
        }
        return blocked;
      }
      if (prepared.shopId !== input.shopId || prepared.senderWabaId !== senderWabaId ||
          prepared.purpose !== "INITIAL_NO_OFFER") {
        return { kind: "BLOCKED", reason: "MERCHANT_OR_SENDER_MISMATCH" };
      }
      return {
        kind: "PREPARED",
        trigger: input.trigger,
        prepared,
        send: templateSendFields(prepared, { kind: "NO_OFFER" }),
      };
    } catch (error) {
      try {
        this.log.error("recovery_template.initial_fallback.failed", {
          shopId: input.shopId,
          recoveryId: input.recoveryId,
          outreachAttemptId: input.outreachAttemptId,
          trigger: input.trigger,
          reason: "REQUIRED_STATE_UNAVAILABLE",
          errorType: error instanceof Error ? error.name : "unknown",
          error,
        });
      } catch {
        // Logging failure must not replace the retry disposition.
      }
      return { kind: "RETRY", reason: "REQUIRED_STATE_UNAVAILABLE" };
    }
  }
}

export const initialNoOfferFallbackService = new InitialNoOfferFallbackService();