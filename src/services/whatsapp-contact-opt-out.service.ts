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
    private readonly log: Pick<StructuredLogger, "info" | "warn"> = logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async handleInbound(event: WhatsAppInboundEvent): Promise<boolean> {
    if (!isExplicitWhatsAppStop(event.content)) return false;
    const sender = await this.resolveSender();
    if (sender.providerAccountId !== event.providerAccountId ||
        sender.providerPhoneNumberId !== event.providerPhoneNumberId) {
      this.log.warn("whatsapp.stop.ignored", { reasonCode: "UNRECOGNISED_PROVIDER_SENDER" });
      return true;
    }
    const canonical = canonicalWhatsAppSender(event.customerPhone);
    if (!canonical) {
      this.log.warn("whatsapp.stop.unmatched", { reasonCode: "INVALID_CANONICAL_PHONE" });
      return true;
    }
    const quotedShop = event.contextMessageId
      ? await resolveQuotedStopShop(this.database, event.contextMessageId, canonical)
      : null;
    const scope = quotedShop ? "QUOTED_SHOP" as const : "ALL_REGISTERED_SHOPS" as const;
    const result = await writeLocalStop(this.database, {
      canonical, shopId: quotedShop, eventId: event.providerMessageId, at: this.now(),
    });
    if (result.notices.length === 0) {
      this.log.warn("whatsapp.stop.unmatched", { scope, reasonCode: "NO_ACTIVE_CUSTOMER_PHONE" });
      return true;
    }
    // If notice publication fails, throw so the existing inbound BullMQ job
    // retries; the already committed STOP cannot be lost or re-dated.
    await publishStopNotices(this.database, result.notices, scope);
    this.log.info("whatsapp.stop.recorded", {
      scope, shopCount: result.notices.length, updatedCount: result.changed,
    });
    return true;
  }
}

export const whatsAppContactOptOutService = new WhatsAppContactOptOutService();
