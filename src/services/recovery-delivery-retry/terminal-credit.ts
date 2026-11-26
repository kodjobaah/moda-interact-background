import type { PrismaClient } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { lockRecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { findExactRecoveryReservationSource } from "../recovery-delivery-compensation/lineage.js";
import { releaseReservedSource } from "../recovery-delivery-compensation/reserved.js";
import { requireLineage } from "../recovery-delivery-compensation/types.js";
import { readRetryFundingLineage } from "./funding-lineage.js";
import { expectedInitialRetryDispatchKey } from "./provider-dispatch-key.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";

const log = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
/** A definitive pre-permit or synchronous rejection may release only its own
 * RESERVED credit. Accepted/asynchronously failed sends belong to the normal
 * delivery compensation owner. Unknown outcomes are never released here. */
export async function releaseTerminalRetryCredit(db: Pick<PrismaClient, "$transaction">,
  scope: { shopId: string; recoveryId: string; outreachAttemptId: string }, conversationId: string, messageId: string) {
  const fields = { ...scope, checkoutRecoveryId: scope.recoveryId, conversationId, outboundMessageId: messageId };
  try {
    const result = await db.$transaction(async tx => {
      const owner = await lockRecoveryContext(tx, conversationId);
      requireLineage(owner?.shopId === scope.shopId && owner.recoveryId === scope.recoveryId, "retry release owner mismatch");
      await readRetryFundingLineage(tx, { recoveryId: scope.recoveryId, conversationId, attemptId: scope.outreachAttemptId });
      const attempt = await tx.recoveryOutreachAttempt.findUnique({ where: { id: scope.outreachAttemptId }, include: {
        checkoutRecovery: { select: { shop: { select: { platform: true } } } }, outboundMessage: true,
      } });
      const message = attempt?.outboundMessage;
      requireLineage(attempt?.status === "FAILED" && attempt.outboundMessageId === messageId && !attempt.sentAt &&
        message?.id === messageId && message.conversationId === conversationId && message.direction === "OUTBOUND" &&
        message.senderType === "AUTOMATION" && message.status === "FAILED" && !message.providerMessageId && !message.sentAt &&
        !message.deliveredAt && !message.readAt, "retry release requires definitive unsent message");
      const noPermit = !message.providerDispatchKey && !message.providerDispatchAdmittedAt && message.providerDispatchControlRevision === null &&
        !message.failedAt && !message.providerFailureCode && attempt.failureCode === "PRE_PROVIDER_REFUSED";
      const rejected = message.providerDispatchKey === expectedInitialRetryDispatchKey(attempt.checkoutRecovery.shop.platform, scope.shopId, attempt.id) &&
        !!message.providerDispatchAdmittedAt && message.providerDispatchControlRevision !== null && !!message.failedAt &&
        attempt.failureCode === "PROVIDER_REJECTED";
      // 131026's existing compensation path can already have released its
      // source. Do not assume every FAILED status proves no provider call.
      const source = await findExactRecoveryReservationSource(tx, scope.shopId, attempt.id);
      if (source?.reservation.status === "RELEASED") return { kind: "already-released", reservationId: source.reservation.id } as const;
      requireLineage(noPermit || rejected, "retry release outcome uncertain");
      requireLineage(!await tx.usageEvent.findUnique({ where: { idempotencyKey: `recovery-outreach:${attempt.id}` }, select: { id: true } }), "retry terminal usage still present");
      if (!source) return { kind: "absent" } as const;
      requireLineage(source.reservation.status === "RESERVED", "retry release source not reserved");
      await releaseReservedSource(tx, source);
      return { kind: "released", reservationId: source.reservation.id } as const;
    });
    if (result.kind === "released") log.info("recovery.delivery_retry.credit_released", { ...fields, fundingReservationId: result.reservationId });
    return result;
  } catch (error) {
    log.error("recovery.delivery_retry.credit_release_failed", { ...fields, sourceError: initialOutreachDiagnostic(error) });
    throw error;
  }
}
