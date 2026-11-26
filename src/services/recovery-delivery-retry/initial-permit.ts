import type { Prisma } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { isInitialRetryId } from "../../domain/recovery-outreach-identity.js";
import { planInitialRetryClaim } from "../../domain/recovery-retry-claim.js";
import type { WhatsAppSenderIdentity } from "../../integration/whatsapp/types.js";
import { readRecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { isCheckoutRecoveryWithinLifetime } from "../recovery-lifetime/checkout-recovery-lifetime.js";
import { RecoveryCompensationLineageError } from "../recovery-delivery-compensation/types.js";
import { EffectiveBillingPolicyResolver, EffectiveBillingPolicyError } from "../effective-billing-policy.service.js";
import { PostContractRecoveryPolicyResolver, PostContractRecoveryPolicyError } from "../post-contract-recovery-policy.service.js";
import { retryFundingIdentitySelect } from "./funding-lineage.js";
import { requireInitialRetryPredecessorReady } from "./funding.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";

const log = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
type Scope = { shopId: string; recoveryId: string; conversationId: string; attemptId: string; recipient: string; now: Date };
export type InitialRetryPermitCheck = { kind: "ready"; sender: WhatsAppSenderIdentity } | { kind: "held"; reason: string };

/** SQL-only last-mile retry eligibility. Caller MUST hold Shop -> Conversation
 * locks. Both platform permits retain their existing consent, template, message,
 * sender and exact fresh-credit checks. This check is not a provider permit.
 * Unlike claim(), it tolerates a prepared outbound UsageEvent for this attempt.
 */
export async function checkInitialRetryPermit(tx: Prisma.TransactionClient, input: Scope, logger: StructuredLogger = log): Promise<InitialRetryPermitCheck> {
  const fields = { shopId: input.shopId, checkoutRecoveryId: input.recoveryId, conversationId: input.conversationId,
    outreachAttemptId: input.attemptId, retryIntentId: input.attemptId.slice("retry_".length) };
  const hold = (reason: string, error?: unknown): InitialRetryPermitCheck => {
    logger.debug("recovery.delivery_retry.permit_held", { ...fields, reason, ...(error === undefined ? {} : { sourceError: initialOutreachDiagnostic(error) }) });
    return { kind: "held", reason };
  };
  if (!isInitialRetryId(input.attemptId) || !Number.isFinite(input.now.getTime())) return hold("invalid-retry-scope");
  try {
    const locked = await tx.$queryRaw<Array<{id: string}>>`SELECT id FROM commerce."CheckoutRecovery" WHERE id=${input.recoveryId} FOR UPDATE`;
    if (locked.length !== 1) return hold("retry-recovery-missing");
    const owner = await readRecoveryContext(tx, input.conversationId);
    const recovery = await tx.checkoutRecovery.findUnique({ where: { id: input.recoveryId }, select: {
      shopId: true, checkoutToken: true, generation: true, status: true, completedAt: true,
      expiredAt: true, lastExternalActivityAt: true, admissionBlockReason: true, shop: {select: {status: true}},
    } });
    if (!owner || owner.shopId !== input.shopId || owner.recoveryId !== input.recoveryId || owner.mode !== "AI" ||
        owner.inboundVersion !== 0 || owner.lastInboundAt || !recovery || recovery.shopId !== input.shopId ||
        recovery.shop.status !== "ACTIVE" || !["DETECTED", "MESSAGE_SENT"].includes(recovery.status) || recovery.completedAt || recovery.expiredAt ||
        recovery.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED") return hold("retry-recovery-ineligible");
    // Freeze the runtime policy during the provider decision, including its
    // retry delays, budget and checkout lifetime. No network I/O in this tx.
    await tx.$queryRaw`SELECT id FROM public."BackgroundRuntimeConfig" WHERE id='default' FOR SHARE`;
    const config = await tx.backgroundRuntimeConfig.findUnique({ where: { id: "default" }, select: { checkoutRecoveryLifetimeDays: true } });
    if (!config || !isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: recovery.lastExternalActivityAt, now: input.now,
      checkoutRecoveryLifetimeDays: config.checkoutRecoveryLifetimeDays })) return hold("retry-lifetime-expired");
    if (await tx.checkoutRecovery.findFirst({ where: { shopId: input.shopId, checkoutToken: recovery.checkoutToken,
      generation: { gt: recovery.generation } }, select: { id: true } })) return hold("retry-newer-generation");
    if (await tx.conversationAllowanceBlock.count({ where: { conversationId: input.conversationId } })) return hold("retry-existing-allowance");
    const attempts = await tx.recoveryOutreachAttempt.findMany({ where: {checkoutRecoveryId: input.recoveryId}, select: retryFundingIdentitySelect });
    const plan = planInitialRetryClaim({ intentId: fields.retryIntentId, recoveryId: input.recoveryId, conversationId: input.conversationId, attempts });
    if (plan.kind !== "existing" || plan.attemptId !== input.attemptId || plan.recipient !== input.recipient) return hold("retry-current-claim-unavailable");
    const attempt = await tx.recoveryOutreachAttempt.findUniqueOrThrow({ where: {id: input.attemptId}, select: {
      closedAt: true, failureCode: true, followUpDueAt: true, initiationKey: true, claimedAt: true, initiatedBy: true,
    } });
    if (attempt.closedAt || attempt.failureCode || attempt.followUpDueAt || attempt.initiationKey || attempt.claimedAt || attempt.initiatedBy)
      return hold("retry-claim-not-clean");
    await requireInitialRetryPredecessorReady(tx, input, plan.links);
    // The original owner locks serialize provider status updates (Shop KEY
    // SHARE) with this decision. A late receipt committed first blocks retry.
    const assignment = await tx.recoverySenderAssignment.findUnique({ where: {conversationId: input.conversationId}, select: {
      releasedAt: true, route: {select: {shopId: true, closedAt: true, canonicalRecipient: true, providerPhoneNumberId: true,
        thread: {select: {closedAt: true, sender: {select: {providerAccountId: true, verifiedAt: true}}}}}},
    } });
    const route = assignment?.route;
    if (!assignment || assignment.releasedAt || !route || route.shopId !== input.shopId || route.closedAt || route.thread.closedAt ||
        route.canonicalRecipient !== input.recipient.replace(/^\+/, "") || route.thread.sender.verifiedAt > input.now) return hold("retry-sender-unavailable");
    const sender = { providerAccountId: route.thread.sender.providerAccountId, providerPhoneNumberId: route.providerPhoneNumberId };
    // Every physical retry in the chain must remain on the original sender.
    const previous = await tx.conversationMessage.findMany({ where: {id: {in: plan.links.map(link => link.intent.failedMessageId)}}, select: {
      dispatchProviderAccountId: true, dispatchProviderPhoneNumberId: true,
    } });
    if (previous.length !== plan.links.length || previous.some(m => m.dispatchProviderAccountId !== sender.providerAccountId ||
      m.dispatchProviderPhoneNumberId !== sender.providerPhoneNumberId)) return hold("retry-sender-identity-changed");
    let policy;
    try { policy = await new EffectiveBillingPolicyResolver(tx).resolve(input.shopId, input.now); }
    catch (error) {
      if (!(error instanceof EffectiveBillingPolicyError) || error.reason !== "NO_CONTRACT") throw error;
      policy = await new PostContractRecoveryPolicyResolver(tx).resolve(input.shopId, input.now);
    }
    if (policy.newRecoveriesPaused || policy.automatedWhatsappPaused || ("features" in policy && !policy.features.has("checkout_recovery")))
      return hold("retry-billing-policy-paused-or-disabled");
    return {kind: "ready", sender};
  } catch (error) {
    if (error instanceof RecoveryCompensationLineageError) return hold("retry-policy-or-funding-lineage", error);
    if (error instanceof EffectiveBillingPolicyError || error instanceof PostContractRecoveryPolicyError) return hold("retry-billing-policy-unavailable", error);
    logger.error("recovery.delivery_retry.permit_failed", {...fields, sourceError: initialOutreachDiagnostic(error)});
    throw error;
  }
}
