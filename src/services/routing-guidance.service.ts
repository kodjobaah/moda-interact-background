import { createHash } from "node:crypto";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import { Prisma, type PrismaClient } from "@prisma/client";
import { connectionRedis } from "../lib/redis.js";
import prisma from "../lib/db.js";
import { hasLocalNoContact } from "./whatsapp-contact-opt-out/local-no-contact.js";
import { canonicalWhatsAppSender } from "./whatsapp-contact-opt-out/phone.js";
import { lockWhatsAppStopRecipient } from "./whatsapp-contact-opt-out/recipient-stop-serialization.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import type { RoutingGuidanceReason } from "./recovery-routing.service.js";
import { whatsAppService } from "./whatsapp.service.js";

const identify =
  "Please use WhatsApp's Reply option on the basket message you'd like help with, so I can identify the right checkout.";
export const routingGuidanceText: Record<RoutingGuidanceReason, string> = {
  MULTIPLE_RECOVERIES: identify,
  NO_RECOVERY:
    identify +
    " If you cannot find that message, please contact the store directly.",
  INVALID_REFERENCE:
    identify +
    " If you cannot find that message, please contact the store directly.",
  SHOP_UNAVAILABLE:
    "Please contact the store directly for help with your basket.",
};
// Called only after canonical inbound parsing and raw abuse admission. This
// platform reply has no merchant conversation, reservation, grant or usage.
// An injectable boundary permits real concurrent PostgreSQL testing without
// sending WhatsApp or changing Redis in the test environment.
type GuidanceDependencies = {
  database?: Pick<PrismaClient, "$transaction">;
  cache?: Pick<typeof connectionRedis, "set">;
  provider?: Pick<typeof whatsAppService, "resolveSender" | "sendWhatsAppText">;
};
export async function sendRoutingGuidance(
  event: WhatsAppInboundEvent,
  reason: RoutingGuidanceReason,
  { database = prisma, cache = connectionRedis, provider = whatsAppService }: GuidanceDependencies = {},
): Promise<void> {
  if (event.content.type === "unsupported") return;
  const sender = await provider.resolveSender();
  if (
    event.providerAccountId !== sender.providerAccountId ||
    event.providerPhoneNumberId !== sender.providerPhoneNumberId
  )
    return;
  const canonical = canonicalWhatsAppSender(event.customerPhone);
  if (!canonical) return;
  const digest = createHash("sha256")
    .update(event.providerMessageId)
    .digest("hex");
  const key = `moda:${resolveDeploymentEnvironmentName()}:whatsapp:clarification:${digest}`;
  try {
    if ((await cache.set(key, "1", "EX", 86400, "NX")) !== "OK")
      return;
  } catch {
    return;
  }
  try {
    // There is no merchant conversation/Shop to use as a final fence. A short
    // PostgreSQL transaction acquires the *same canonical recipient lock* as
    // the STOP writer and reads the current all-merchant no-contact projection.
    // Its commit is the guidance admission point. Meta I/O is always after it:
    // a STOP committed first prevents admission; a previously admitted send
    // cannot be retracted if STOP commits just before the network request.
    const admitted = await database.$transaction(async (tx) => {
      await lockWhatsAppStopRecipient(tx, canonical);
      return !(await hasLocalNoContact(tx, { recipient: event.customerPhone }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (!admitted) return;
    await provider.sendWhatsAppText(
      { to: event.customerPhone, text: routingGuidanceText[reason] },
      AbortSignal.timeout(10_000),
    );
  } catch {
    // Keep the guard even on ambiguous provider failures: no automatic resend.
    console.warn("Platform routing guidance suppressed", {
      outcome: "send-failed",
    });
  }
}
