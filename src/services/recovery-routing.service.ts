import { Prisma } from "@prisma/client";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";
import { shopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";
import { whatsAppService } from "./whatsapp.service.js";

export type RoutingGuidanceReason =
  | "MULTIPLE_RECOVERIES"
  | "NO_RECOVERY"
  | "INVALID_REFERENCE"
  | "SHOP_UNAVAILABLE";
export type RecoveryRoute =
  | {
      kind: "resolved";
      conversationId: string;
      checkoutRecoveryId: string;
      shopId: string;
    }
  | { kind: "guidance"; reason: RoutingGuidanceReason }
  | { kind: "ignored" };
export const canonicalPhone = (phone: string) =>
  phone.trim().replace(/^\+/, "");

export class RecoveryRoutingService {
  async resolveInboundMessage(
    event: WhatsAppInboundEvent,
  ): Promise<RecoveryRoute> {
    const sender = whatsAppService.resolveSender();
    if (
      event.providerAccountId !== sender.providerAccountId ||
      event.providerPhoneNumberId !== sender.providerPhoneNumberId
    )
      return { kind: "ignored" };
    const phone = canonicalPhone(event.customerPhone);
    const stored = await prisma.conversationMessage.findUnique({
      where: { providerMessageId: event.providerMessageId },
      select: { conversationId: true, direction: true },
    });
    if (stored && stored.direction !== "INBOUND")
      return { kind: "guidance", reason: "INVALID_REFERENCE" };
    let conversationId: string;
    if (event.contextMessageId) {
      const original = await prisma.conversationMessage.findUnique({
        where: { providerMessageId: event.contextMessageId },
        select: {
          direction: true,
          sentAt: true,
          conversationId: true,
          conversation: {
            select: {
              checkoutRecovery: {
                select: { customer: { select: { phone: true } } },
              },
            },
          },
        },
      });
      if (
        !original ||
        original.direction !== "OUTBOUND" ||
        !original.sentAt ||
        canonicalPhone(
          original.conversation.checkoutRecovery?.customer?.phone ?? "",
        ) !== phone
      ) {
        return { kind: "guidance", reason: "INVALID_REFERENCE" };
      }
      conversationId = original.conversationId;
    } else if (stored) {
      conversationId = stored.conversationId;
    } else {
      // Count distinct recoveries across all shops before eligibility. Terminal
      // status, message age and repeated outreach cannot remove ambiguity.
      const candidates = await prisma.$queryRaw<
        Array<{ conversationId: string }>
      >(Prisma.sql`
        SELECT DISTINCT c.id AS "conversationId"
        FROM whatsapp."Conversation" c
        JOIN commerce."CheckoutRecovery" r ON r.id = c."checkoutRecoveryId"
        JOIN commerce."Customer" customer ON customer.id = r."customerId"
        WHERE regexp_replace(regexp_replace(customer.phone, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '^\\+', '') = ${phone}
          AND EXISTS (SELECT 1 FROM whatsapp."ConversationMessage" m
            WHERE m."conversationId" = c.id AND m.direction = 'OUTBOUND'
              AND m."providerMessageId" IS NOT NULL AND m."sentAt" IS NOT NULL)
        LIMIT 2
      `);
      if (candidates.length !== 1)
        return {
          kind: "guidance",
          reason: candidates.length ? "MULTIPLE_RECOVERIES" : "NO_RECOVERY",
        };
      conversationId = candidates[0]!.conversationId;
    }
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        checkoutRecovery: {
          select: {
            id: true,
            shopId: true,
            customer: { select: { phone: true } },
          },
        },
      },
    });
    const recovery = conversation?.checkoutRecovery;
    if (!recovery || canonicalPhone(recovery.customer?.phone ?? "") !== phone)
      return { kind: "guidance", reason: "INVALID_REFERENCE" };
    if (
      stored &&
      (stored.direction !== "INBOUND" ||
        stored.conversationId !== conversationId)
    )
      return { kind: "guidance", reason: "INVALID_REFERENCE" };
    if (
      !(await shopExecutionEligibilityService.isShopExecutionActive(
        recovery.shopId,
      ))
    )
      return { kind: "guidance", reason: "SHOP_UNAVAILABLE" };
    return {
      kind: "resolved",
      conversationId,
      checkoutRecoveryId: recovery.id,
      shopId: recovery.shopId,
    };
  }
}
export const recoveryRoutingService = new RecoveryRoutingService();
