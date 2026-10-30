import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
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
      mode: "active" | "historical";
    }
  | { kind: "guidance"; reason: RoutingGuidanceReason }
  | { kind: "ignored" };
export const canonicalPhone = (phone: string) =>
  phone.trim().replace(/^\+/, "");

type RoutingDatabase = Pick<PrismaClient, "conversationMessage" | "conversation" | "$queryRaw">;
type ExecutionEligibility = Pick<typeof shopExecutionEligibilityService, "isShopExecutionActive">;
type WhatsAppSender = Pick<typeof whatsAppService, "resolveSender">;

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

function providerMessageDigest(providerMessageId: string): string {
  return createHash("sha256").update(providerMessageId).digest("hex").slice(0, 16);
}

function logGuidance(
  log: StructuredLogger,
  messageDigest: string,
  stage: string,
  reason: RoutingGuidanceReason,
  identifiers?: { conversationId?: string; checkoutRecoveryId?: string; shopId?: string },
): void {
  log.info("whatsapp.inbound.route_decision", {
    ...identifiers, messageDigest, stage, decision: "guidance", reason,
  });
}

export class RecoveryRoutingService {
  constructor(
    private readonly database: RoutingDatabase = prisma,
    private readonly executionEligibility: ExecutionEligibility = shopExecutionEligibilityService,
    private readonly senderService: WhatsAppSender = whatsAppService,
  ) {}

  async resolveInboundMessage(
    event: WhatsAppInboundEvent,
    log: StructuredLogger = logger,
  ): Promise<RecoveryRoute> {
    const messageDigest = providerMessageDigest(event.providerMessageId);
    let identifiers: { conversationId: string; checkoutRecoveryId: string; shopId: string } | undefined;
    try {
      const sender = await this.senderService.resolveSender();
      if (
        event.providerAccountId !== sender.providerAccountId ||
        event.providerPhoneNumberId !== sender.providerPhoneNumberId
      ) {
        log.info("whatsapp.inbound.route_decision", {
          messageDigest, stage: "provider-identity", decision: "ignored",
        });
        return { kind: "ignored" };
      }
      const phone = canonicalPhone(event.customerPhone);
      const stored = await this.database.conversationMessage.findUnique({
        where: { providerMessageId: event.providerMessageId },
        select: { conversationId: true, direction: true },
      });
      if (stored && stored.direction !== "INBOUND") {
        logGuidance(log, messageDigest, "stored-provider-message", "INVALID_REFERENCE");
        return { kind: "guidance", reason: "INVALID_REFERENCE" };
      }

      let conversationId: string;
      if (stored) {
        // Provider-message identity is durable ownership. Replays stay pinned
        // even if a later payload carries different context or newer outreach.
        conversationId = stored.conversationId;
      } else if (event.contextMessageId) {
        const original = await this.database.conversationMessage.findUnique({
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
          logGuidance(log, messageDigest, "explicit-context", "INVALID_REFERENCE");
          return { kind: "guidance", reason: "INVALID_REFERENCE" };
        }
        conversationId = original.conversationId;
      } else {
        // The newest generation owns a Woo checkout lineage even before it
        // sends. A closed predecessor therefore cannot remain an inbound target.
        const candidates = await this.database.$queryRaw<Array<{ conversationId: string }>>(Prisma.sql`
          SELECT DISTINCT c.id AS "conversationId"
          FROM commerce."CheckoutRecovery" r
          JOIN whatsapp."Conversation" c ON c."checkoutRecoveryId" = r.id
          JOIN commerce."Customer" customer ON customer.id = r."customerId"
          JOIN commerce."Shop" shop ON shop.id = r."shopId"
          WHERE regexp_replace(regexp_replace(customer.phone, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '^\\+', '') = ${phone}
            AND (
              shop.platform <> 'WOOCOMMERCE'
              OR (
                r.status IN ('MESSAGE_SENT', 'ENGAGED')
                AND NOT EXISTS (
                  SELECT 1 FROM commerce."CheckoutRecovery" newer
                  WHERE newer."shopId" = r."shopId"
                    AND newer."checkoutToken" = r."checkoutToken"
                    AND newer.generation > r.generation
                )
              )
            )
            AND EXISTS (
              SELECT 1 FROM whatsapp."ConversationMessage" m
              WHERE m."conversationId" = c.id
                AND m.direction = 'OUTBOUND'
                AND m."providerMessageId" IS NOT NULL
                AND m."sentAt" IS NOT NULL
            )
          LIMIT 2
        `);
        if (candidates.length !== 1) {
          const reason = candidates.length ? "MULTIPLE_RECOVERIES" : "NO_RECOVERY";
          log.info("whatsapp.inbound.route_decision", {
            messageDigest, stage: "candidate-selection", decision: "guidance", reason,
          });
          return { kind: "guidance", reason };
        }
        conversationId = candidates[0]!.conversationId;
      }

      const conversation = await this.database.conversation.findUnique({
        where: { id: conversationId },
        select: {
          checkoutRecovery: {
            select: {
              id: true,
              shopId: true,
              checkoutToken: true,
              generation: true,
              status: true,
              shop: { select: { platform: true } },
              customer: { select: { phone: true } },
            },
          },
        },
      });
      const recovery = conversation?.checkoutRecovery;
      if (!recovery || canonicalPhone(recovery.customer?.phone ?? "") !== phone) {
        logGuidance(log, messageDigest, "conversation-owner", "INVALID_REFERENCE", { conversationId });
        return { kind: "guidance", reason: "INVALID_REFERENCE" };
      }
      if (stored && stored.conversationId !== conversationId) {
        logGuidance(log, messageDigest, "stored-inbound-owner", "INVALID_REFERENCE", { conversationId });
        return { kind: "guidance", reason: "INVALID_REFERENCE" };
      }

      identifiers = { conversationId, checkoutRecoveryId: recovery.id, shopId: recovery.shopId };
      const [lineage] = recovery.shop.platform === "WOOCOMMERCE"
        ? await this.database.$queryRaw<Array<{ isLatest: boolean }>>(Prisma.sql`
        SELECT NOT EXISTS (
          SELECT 1 FROM commerce."CheckoutRecovery" newer
          WHERE newer."shopId" = ${recovery.shopId}
            AND newer."checkoutToken" = ${recovery.checkoutToken}
            AND newer.generation > ${recovery.generation}
        ) AS "isLatest"
      `)
        : [{ isLatest: true }];
      const mode = isContinuingRecoveryStatus(recovery.status) && lineage?.isLatest
        ? "active"
        : "historical";
      const executionScope = mode === "active" ? "recovery" : "general";
      if (!(await this.executionEligibility.isShopExecutionActive(recovery.shopId, executionScope))) {
        logGuidance(log, messageDigest, "shop-execution", "SHOP_UNAVAILABLE", identifiers);
        return { kind: "guidance", reason: "SHOP_UNAVAILABLE" };
      }
      log.info("whatsapp.inbound.route_decision", {
        ...identifiers, mode, stage: "routing", decision: "resolved", messageDigest,
      });
      return { kind: "resolved", ...identifiers, mode };
    } catch (error) {
      log.error("whatsapp.inbound.route_failed", {
        ...identifiers, messageDigest, stage: "routing", error,
      });
      throw error;
    }
  }

  async isCurrentActiveRoute(route: Extract<RecoveryRoute, { kind: "resolved" }>): Promise<boolean> {
    if (route.mode !== "active") return false;
    const [current] = await this.database.$queryRaw<Array<{ current: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM commerce."CheckoutRecovery" r
        JOIN whatsapp."Conversation" c ON c."checkoutRecoveryId" = r.id
        JOIN commerce."Shop" shop ON shop.id = r."shopId"
        WHERE r.id = ${route.checkoutRecoveryId}
          AND c.id = ${route.conversationId}
          AND r.status IN ('MESSAGE_SENT', 'ENGAGED')
          AND (
            shop.platform <> 'WOOCOMMERCE'
            OR NOT EXISTS (
              SELECT 1 FROM commerce."CheckoutRecovery" newer
              WHERE newer."shopId" = r."shopId"
                AND newer."checkoutToken" = r."checkoutToken"
                AND newer.generation > r.generation
            )
          )
      ) AS current
    `);
    return current?.current === true;
  }
}
function isContinuingRecoveryStatus(status: string): boolean {
  return status === "MESSAGE_SENT" || status === "ENGAGED";
}

export const recoveryRoutingService = new RecoveryRoutingService();
