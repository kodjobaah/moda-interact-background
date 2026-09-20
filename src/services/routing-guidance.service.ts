import { createHash } from "node:crypto";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import { connectionRedis } from "../lib/redis.js";
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
export async function sendRoutingGuidance(
  event: WhatsAppInboundEvent,
  reason: RoutingGuidanceReason,
): Promise<void> {
  if (event.content.type === "unsupported") return;
  const sender = whatsAppService.resolveSender();
  if (
    event.providerAccountId !== sender.providerAccountId ||
    event.providerPhoneNumberId !== sender.providerPhoneNumberId
  )
    return;
  const digest = createHash("sha256")
    .update(event.providerMessageId)
    .digest("hex");
  const key = `moda:${resolveDeploymentEnvironmentName()}:whatsapp:clarification:${digest}`;
  try {
    if ((await connectionRedis.set(key, "1", "EX", 86400, "NX")) !== "OK")
      return;
  } catch {
    return;
  }
  try {
    await whatsAppService.sendWhatsAppText(
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
