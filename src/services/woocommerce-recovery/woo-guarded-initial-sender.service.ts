import { initialOutreachDiagnostic } from "../outbound-whatsapp-admission/outbound-provider-failure.service.js";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import { OutboundMessageDeliveryService } from "../outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { canonicalWhatsAppSender } from "../whatsapp-contact-opt-out/phone.js";
import type { WooObservedOrderStateReader } from "./contracts.js";
import type { WooGuardedInitialSender } from "./woo-recovery-outreach.service.js";

type ExistingAdmission = Pick<typeof outboundWhatsAppAdmissionService,
  "reserve" | "findExistingAdmission" | "inspectInitialOutreachAdmission">;
type InitialDelivery = Pick<OutboundMessageDeliveryService, "sendPreparedWooInitialTemplate">;

/**
 * ARCH-046-BACKGROUND-004. The only Woo initial-template sender for BG005 to
 * inject into the accepted outreach workflow. Earlier checkout/consent/order
 * preflight is repeated at this boundary but is NEVER used instead of the
 * final Shop-locked SQL provider permit in OutboundMessageDeliveryService.
 *
 * Caller owns the checkout lease, credit lifecycle and sequence-one attempt;
 * no worker, Redis scheduler, follow-up or extra charging logic lives here.
 */
export class WooGuardedInitialSenderService implements WooGuardedInitialSender {
  private readonly log: StructuredLogger;

  constructor(
    private readonly orders: WooObservedOrderStateReader,
    logger: StructuredLogger,
    private readonly outbound: ExistingAdmission = outboundWhatsAppAdmissionService,
    private readonly delivery: InitialDelivery = new OutboundMessageDeliveryService(),
  ) {
    this.log = logger.child({ component: "woo-guarded-initial-sender" });
  }

  findExistingAdmission(idempotencyKey: string) {
    return this.outbound.findExistingAdmission(idempotencyKey);
  }

  inspectInitialOutreachAdmission(scope: Parameters<ExistingAdmission["inspectInitialOutreachAdmission"]>[0]) {
    return this.outbound.inspectInitialOutreachAdmission(scope);
  }

  async sendInitial(input: Parameters<WooGuardedInitialSender["sendInitial"]>[0]):
    ReturnType<WooGuardedInitialSender["sendInitial"]> {
    const { recovery, consent, template } = input;
    try {
      if (recovery.shop.platform !== "WOOCOMMERCE" || recovery.shopId !== consent.shopId ||
        recovery.customerId !== consent.customerId || recovery.shop.status !== "ACTIVE" ||
        recovery.status !== "DETECTED" || recovery.completedAt ||
        input.idempotencyKey !== `recovery-outreach:${input.attemptId}` ||
        input.recoveryCreditSourceKey !== createRecoveryIdempotencyKey(recovery.shopId, input.idempotencyKey) ||
        template.verifiedCategory !== "MARKETING" || !template.name || !template.languageCode ||
        !template.sendFields?.templateRegistration ||
        template.sendFields.templateRegistration.shopId !== recovery.shopId ||
        template.sendFields.templateRegistration.providerTemplateName !== template.name ||
        template.sendFields.templateRegistration.providerLanguageCode !== template.languageCode ||
        canonicalWhatsAppSender(input.recipient) !== consent.canonicalRecipient) {
        return this.suppress(recovery.shopId, recovery.id, input.attemptId, "invalid-woo-initial-scope");
      }

      // BG004 holds BG002's checkout lease. An observed order in Redis is
      // excluded before the SQL transaction; a missing Woo event cannot be
      // detected here. Durable terminal rows are checked in the SQL permit.
      const observed = await this.orders.read({ shopId: recovery.shopId, checkoutToken: recovery.checkoutToken });
      if (observed.kind === "ambiguous") throw new Error("WOO_ORDER_EVIDENCE_AMBIGUOUS");
      if (observed.kind !== "none-observed")
        return this.suppress(recovery.shopId, recovery.id, input.attemptId, "woo-observed-order-terminal");

      const scope = { shopId: recovery.shopId, recoveryId: recovery.id, outreachAttemptId: input.attemptId };
      const previous = await this.inspectInitialOutreachAdmission(scope);
      if (previous.kind === "held")
        throw new Error(previous.reason === "lineage-conflict"
          ? "WOO_INITIAL_PROVIDER_ADMISSION_OWNERSHIP_MISMATCH"
          : "WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
      if (previous.kind !== "absent" && previous.message.conversationId !== input.conversationId)
        throw new Error("WOO_INITIAL_PROVIDER_ADMISSION_OWNERSHIP_MISMATCH");
      if (previous.kind === "confirmed" || previous.kind === "failed")
        return { kind: "suppressed", reason: "duplicate" };
      const admission = previous.kind === "prepared" ? {
        kind: "admitted" as const, shopId: recovery.shopId,
        conversationId: input.conversationId, messageId: previous.message.id, terminal: false,
        executionScope: "recovery" as const,
      } : await this.outbound.reserve({
        shopId: recovery.shopId,
        conversationId: input.conversationId,
        senderType: "AUTOMATION",
        idempotencyKey: input.idempotencyKey,
        recoveryCreditSourceKey: input.recoveryCreditSourceKey,
        initialOutreach: scope,
      });
      if (admission.kind !== "admitted") return { kind: "suppressed", reason: admission.reason };

      const result = await this.delivery.sendPreparedWooInitialTemplate(admission, {
        ...template.sendFields!, to: input.recipient,
      }, {
        recoveryId: recovery.id,
        checkoutToken: recovery.checkoutToken,
        customerId: consent.customerId,
        attemptId: input.attemptId,
        consent,
        idempotencyKey: input.idempotencyKey,
        recoveryCreditSourceKey: input.recoveryCreditSourceKey,
      });
      if (result.kind === "suppressed")
        return this.suppress(recovery.shopId, recovery.id, input.attemptId, result.reason);
      return { kind: "admitted" };
    } catch (error) {
      this.log.error("woocommerce.recovery.initial.permit.failed", {
        shopId: recovery.shopId, recoveryId: recovery.id, attemptId: input.attemptId,
        stage: "guarded_sender", sourceError: initialOutreachDiagnostic(error),
      });
      throw error;
    }
  }

  private suppress(shopId: string, recoveryId: string, attemptId: string, reason: string) {
    this.log.warn("woocommerce.recovery.initial.permit.suppressed", {
      shopId, recoveryId, attemptId, reason,
    });
    return { kind: "suppressed" as const, reason };
  }
}

/** BG005 supplies the same observed-order reader/coordinator used by BG004. */
export function createWooGuardedInitialSender(input: {
  orders: WooObservedOrderStateReader;
  logger: StructuredLogger;
}): WooGuardedInitialSender {
  return new WooGuardedInitialSenderService(input.orders, input.logger);
}
