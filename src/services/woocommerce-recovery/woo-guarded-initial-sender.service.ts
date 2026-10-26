import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import { OutboundMessageDeliveryService } from "../outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { canonicalWhatsAppSender } from "../whatsapp-contact-opt-out/phone.js";
import type { WooObservedOrderStateReader } from "./contracts.js";
import type { WooGuardedInitialSender } from "./woo-recovery-outreach.service.js";

type ExistingAdmission = Pick<typeof outboundWhatsAppAdmissionService,
  "reserve" | "findExistingAdmission">;
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

      const previous = await this.outbound.findExistingAdmission(input.idempotencyKey);
      if (previous) {
        if (previous.conversationId !== input.conversationId)
          throw new Error("WOO_INITIAL_PROVIDER_ADMISSION_OWNERSHIP_MISMATCH");
        if (previous.status === "PENDING") throw new Error("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
        return { kind: "suppressed", reason: "duplicate" };
      }

      // Existing reservation creates ONE unique UsageEvent + pending message.
      // It does not admit any provider dispatch. A prepared/denied message may
      // be cleaned up, but an admitted dispatch key may never be released.
      const admission = await this.outbound.reserve({
        shopId: recovery.shopId,
        conversationId: input.conversationId,
        senderType: "AUTOMATION",
        idempotencyKey: input.idempotencyKey,
        recoveryCreditSourceKey: input.recoveryCreditSourceKey,
      });
      if (admission.kind !== "admitted") {
        if (admission.reason === "duplicate") {
          const current = await this.outbound.findExistingAdmission(input.idempotencyKey);
          if (current?.conversationId !== input.conversationId)
            throw new Error("WOO_INITIAL_PROVIDER_ADMISSION_OWNERSHIP_MISMATCH");
          if (current?.status === "PENDING") throw new Error("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
        }
        return { kind: "suppressed", reason: admission.reason };
      }

      const result = await this.delivery.sendPreparedWooInitialTemplate(admission, {
        to: input.recipient, templateName: template.name, languageCode: template.languageCode,
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
      // The shared logger owns sanitisation and sink isolation. Never emit
      // the recipient, checkout token, template body or raw provider/SQL error
      // message, which can contain customer data.
      this.log.error("woocommerce.recovery.initial.permit.failed", {
        shopId: recovery.shopId, recoveryId: recovery.id, attemptId: input.attemptId,
        errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
          ? error.name : "UnknownError",
        ...(
          typeof error === "object" && error !== null && "code" in error &&
          typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
            ? { errorCode: error.code } : {}
        ),
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
