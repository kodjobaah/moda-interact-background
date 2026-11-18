import { receivingSenderKnown } from "./recovery-sender-pool/inbound-authority.js";
import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { whatsAppService } from "./whatsapp.service.js";
import { canonicalWhatsAppSender, isExplicitWhatsAppStop } from "./whatsapp-contact-opt-out/phone.js";
import { resolveQuotedStopShop } from "./whatsapp-contact-opt-out/quoted-outbound.js";
import { publishStopNotices, writeLocalStop } from "./whatsapp-contact-opt-out/stop-writer.js";

type Sender = { providerAccountId: string; providerPhoneNumberId: string };

const logger = createLogger({
  serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName(),
});

/** Explicit STOP takes precedence over abuse limits, moderation and routing.
 * Authentication remains at WhatsApp ingress; also validate the configured sender
 * so a queued event from a different provider account cannot suppress customers.
 */
export class WhatsAppContactOptOutService {
  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly resolveSender: () => Promise<Sender> = () => whatsAppService.resolveSender(),
    private readonly log: Pick<StructuredLogger, "info" | "warn" | "error"> = logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async handleInbound(event: WhatsAppInboundEvent): Promise<boolean> {
    if (!isExplicitWhatsAppStop(event.content)) return false;
    let pooled: boolean | null;
    let sender: Sender;
    try {
      pooled = await receivingSenderKnown(this.database,event);
      sender = pooled===null?await this.resolveSender():event;
    } catch (error) {
      this.log.error("whatsapp.stop.failed", {
        operation: "resolve_inbound_sender",
        stage: "sender_validation",
        providerMessageId: event.providerMessageId,
        outcome: "retryable_failure",
        error,
      });
      throw error;
    }
    if (pooled===false || sender.providerAccountId !== event.providerAccountId ||
        sender.providerPhoneNumberId !== event.providerPhoneNumberId) {
      this.log.warn("whatsapp.stop.ignored", { reasonCode: "UNRECOGNISED_PROVIDER_SENDER" });
      return true;
    }
    const canonical = canonicalWhatsAppSender(event.customerPhone);
    if (!canonical) {
      this.log.warn("whatsapp.stop.unmatched", { reasonCode: "INVALID_CANONICAL_PHONE" });
      return true;
    }
    let quotedShop: string | null;
    try {
      quotedShop = event.contextMessageId
        ? await resolveQuotedStopShop(this.database, event.contextMessageId, canonical, event)
        : null;
    } catch (error) {
      this.log.error("whatsapp.stop.failed", {
        operation: "resolve_quoted_outbound",
        stage: "quote_resolution",
        providerMessageId: event.providerMessageId,
        contextMessageId: event.contextMessageId,
        outcome: "retryable_failure",
        error,
      });
      throw error;
    }
    const scope = quotedShop ? "QUOTED_SHOP" as const : "ALL_REGISTERED_SHOPS" as const;
    if (event.contextMessageId) {
      this.log.info("whatsapp.stop.quote_resolution", {
        providerMessageId: event.providerMessageId,
        contextMessageId: event.contextMessageId,
        ...(quotedShop ? { shopId: quotedShop } : {}),
        outcome: quotedShop ? "verified_quote" : "global_fallback",
        reasonCode: quotedShop
          ? "VERIFIED_QUOTED_OUTBOUND"
          : "QUOTE_NOT_VERIFIED_GLOBAL_STOP_FALLBACK",
        message: quotedShop
          ? "Quoted outbound was verified; STOP is scoped to its shop."
          : "Quoted outbound could not be verified; STOP retains standalone global suppression.",
      });
    }
    let result: Awaited<ReturnType<typeof writeLocalStop>>;
    try {
      result = await writeLocalStop(this.database, {
        canonical, shopId: quotedShop, eventId: event.providerMessageId, at: this.now(),
      });
    } catch (error) {
      this.log.error("whatsapp.stop.failed", {
        operation: "persist_stop",
        stage: "postgresql_write",
        providerMessageId: event.providerMessageId,
        ...(quotedShop ? { shopId: quotedShop } : {}),
        outcome: "retryable_failure",
        error,
      });
      throw error;
    }
    if (result.notices.length === 0) {
      this.log.warn("whatsapp.stop.unmatched", { scope, reasonCode: "NO_ACTIVE_CUSTOMER_PHONE" });
      return true;
    }
    // If notice publication fails, throw so the existing inbound BullMQ job
    // retries; the already committed STOP cannot be lost or re-dated.
    try {
      await publishStopNotices(this.database, result.notices, scope);
    } catch (error) {
      this.log.error("whatsapp.stop.failed", {
        operation: "publish_stop_notices",
        stage: "postgresql_publication",
        providerMessageId: event.providerMessageId,
        ...(quotedShop ? { shopId: quotedShop } : {}),
        outcome: "retryable_failure",
        error,
      });
      throw error;
    }
    this.log.info("whatsapp.stop.recorded", {
      scope, shopCount: result.notices.length, updatedCount: result.changed,
    });
    return true;
  }
}

export const whatsAppContactOptOutService = new WhatsAppContactOptOutService();
