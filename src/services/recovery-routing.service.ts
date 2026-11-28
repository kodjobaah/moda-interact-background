import {
  resolveSenderInbound,
  readAssignedOwner,
  isAssignedConversationActive,
  type InboundOwnerEvidence,
  type SenderHandoff,
} from "./recovery-sender-pool/inbound-authority.js";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { shopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";

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
type ExecutionEligibility = Pick<
  typeof shopExecutionEligibilityService,
  "isShopExecutionActive"
>;

const logger = createLogger({
  serviceName: "moda-messaging-worker",
  environment: resolveDeploymentEnvironmentName(),
});

function providerMessageDigest(providerMessageId: string): string {
  return createHash("sha256")
    .update(providerMessageId)
    .digest("hex")
    .slice(0, 16);
}

export class RecoveryRoutingService {
  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly executionEligibility: ExecutionEligibility = shopExecutionEligibilityService,
  ) {}

  async resolveInboundMessage(
    event: WhatsAppInboundEvent,
    log: StructuredLogger = logger,
  ): Promise<RecoveryRoute> {
    const messageDigest = providerMessageDigest(event.providerMessageId);
    try {
      const pooled = await resolveSenderInbound(this.database, event);
      if (pooled.kind === "invalid") {
        log.info("whatsapp.inbound.route_decision", {
          messageDigest,
          stage: "pool-identity",
          decision: "ignored",
        });
        return { kind: "ignored" };
      }
      if (pooled.kind === "routing") return pooled;
      const { evidence, mode } = pooled;
      if (
        !(await this.executionEligibility.isShopExecutionActive(
          evidence.shopId,
          mode === "active" ? "recovery" : "general",
        ))
      )
        return { kind: "ignored" };
      return {
        kind: "resolved",
        conversationId: evidence.conversationId,
        checkoutRecoveryId: evidence.checkoutRecoveryId,
        shopId: evidence.shopId,
        mode,
        senderEvidence: evidence,
      };
    } catch (error) {
      log.error("whatsapp.inbound.route_failed", {
        messageDigest,
        stage: "routing",
        error,
      });
      throw error;
    }
  }

  async isCurrentActiveRoute(
    route: Extract<RecoveryRoute, { kind: "resolved" }>,
  ): Promise<boolean> {
    if (route.mode !== "active" || !route.senderEvidence) return false;
    const e = route.senderEvidence;
    const current = await readAssignedOwner(this.database, e.conversationId);
    return (
      !!current &&
      current.threadId === e.threadId &&
      current.routeId === e.routeId &&
      current.providerAccountId === e.providerAccountId &&
      current.providerPhoneNumberId === e.providerPhoneNumberId &&
      current.canonicalRecipient === e.canonicalRecipient &&
      (await isAssignedConversationActive(
        this.database,
        e.conversationId,
        new Date(),
        e.referenceProviderMessageId,
      )) === true
    );
  }
}

export const recoveryRoutingService = new RecoveryRoutingService();
