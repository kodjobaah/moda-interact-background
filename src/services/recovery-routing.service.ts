import { resolveSenderInbound, quotedOwner, readAssignedOwner, isAssignedConversationActive, isLegacyConversationActive, type InboundOwnerEvidence, type SenderHandoff } from "./recovery-sender-pool/inbound-authority.js";
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
import {
  recoveryRecipientAttemptsSelect,
  recoveryRecipientCustomerSelect, resolveRecoveryRecipient,
} from "./recovery-recipient-ownership.js";

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
      senderEvidence?: InboundOwnerEvidence;
    }
  | { kind: "guidance"; reason: RoutingGuidanceReason }
  | { kind: "routing"; scope: SenderHandoff }
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
      const pooled=await resolveSenderInbound(this.database as PrismaClient,event);
      if(pooled.kind==='invalid')return {kind:'ignored'};
      if(pooled.kind==='routing')return pooled;
      if(pooled.kind==='owned'){
        if(!await this.executionEligibility.isShopExecutionActive(pooled.evidence.shopId,pooled.mode==='active'?'recovery':'general'))return {kind:'ignored'};
        return {kind:'resolved',conversationId:pooled.evidence.conversationId,checkoutRecoveryId:pooled.evidence.checkoutRecoveryId,shopId:pooled.evidence.shopId,mode:pooled.mode,senderEvidence:pooled.evidence};
      }
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
        select: { conversationId: true, direction: true, dispatchProviderAccountId:true, dispatchProviderPhoneNumberId:true },
      });
      if (stored && (stored.direction !== "INBOUND" || stored.dispatchProviderAccountId !== event.providerAccountId || stored.dispatchProviderPhoneNumberId !== event.providerPhoneNumberId)) {
        logGuidance(log, messageDigest, "stored-provider-message", "INVALID_REFERENCE");
        return { kind: "guidance", reason: "INVALID_REFERENCE" };
      }

      let conversationId: string;
      if (stored) {
        // Provider-message identity is durable ownership. Replays stay pinned
        // even if a later payload carries different context or newer outreach.
        conversationId = stored.conversationId;
      } else if (event.contextMessageId) {
        const originalConversationId=await quotedOwner(this.database as PrismaClient,event.contextMessageId,event);
        if(!originalConversationId){
          logGuidance(log,messageDigest,"explicit-context","INVALID_REFERENCE");
          return {kind:'guidance',reason:'INVALID_REFERENCE'};
        }
        conversationId=originalConversationId;
      } else {
        // An unenrolled singleton has no recipient-only routing authority.
        return {kind:'guidance',reason:'NO_RECOVERY'};
      }

      const conversation = await this.database.conversation.findUnique({
        where: { id: conversationId },
        select: {
          shopId: true, customerId: true,
          checkoutRecovery: {
            select: {
              id: true,
              shopId: true,
              checkoutToken: true,
              generation: true,
              status: true,
              shop: { select: { platform: true, defaultCountryCode: true } },
              customer: { select: recoveryRecipientCustomerSelect },
              outreachAttempts: recoveryRecipientAttemptsSelect,
            },
          },
        },
      });
      const recovery = conversation?.checkoutRecovery;
      const recipient = recovery ? resolveRecoveryRecipient(recovery, conversationId) : null;
      if (!recovery || canonicalPhone(recipient ?? "") !== phone ||
          (conversation.shopId && conversation.shopId !== recovery.shopId) ||
          (conversation.customerId && conversation.customerId !== recovery.customer?.id)) {
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
      const mode = isContinuingRecoveryStatus(recovery.status) && lineage?.isLatest && await isLegacyConversationActive(this.database as PrismaClient,conversationId,new Date(),Boolean(stored||event.contextMessageId))
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
      return { kind: "resolved", ...identifiers, mode, senderEvidence:{...identifiers,threadId:null,routeId:null,canonicalRecipient:phone,providerAccountId:event.providerAccountId,providerPhoneNumberId:event.providerPhoneNumberId,referenceProviderMessageId:event.contextMessageId} };
    } catch (error) {
      log.error("whatsapp.inbound.route_failed", {
        ...identifiers, messageDigest, stage: "routing", error,
      });
      throw error;
    }
  }

  async isCurrentActiveRoute(route: Extract<RecoveryRoute, { kind: "resolved" }>): Promise<boolean> {
    if (route.mode !== "active") return false;
    if(route.senderEvidence){
      const e=route.senderEvidence;
      if(e.threadId===null){
        const direct=!!e.referenceProviderMessageId&&await quotedOwner(this.database as PrismaClient,e.referenceProviderMessageId,{schemaVersion:1,provider:'whatsapp',providerAccountId:e.providerAccountId,providerPhoneNumberId:e.providerPhoneNumberId,providerMessageId:'route-current-proof',customerPhone:e.canonicalRecipient,contextMessageId:e.referenceProviderMessageId,occurredAt:new Date().toISOString(),content:{type:'text',text:''}})===e.conversationId;
        return isLegacyConversationActive(this.database as PrismaClient,e.conversationId,new Date(),direct);
      }
      const current=await readAssignedOwner(this.database as PrismaClient,e.conversationId);
      return !!current&&current.threadId===e.threadId&&current.routeId===e.routeId&&current.providerAccountId===e.providerAccountId&&current.providerPhoneNumberId===e.providerPhoneNumberId&&current.canonicalRecipient===e.canonicalRecipient&&await isAssignedConversationActive(this.database as PrismaClient,e.conversationId,new Date(),e.referenceProviderMessageId)===true;
    }
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
