import type { PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { connectionRedis } from "../../lib/redis.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { retryOutreachAttemptId } from "../../domain/recovery-outreach-identity.js";
import { followUpRetryBlockId } from "../../domain/recovery-follow-up-retry-allowance.js";
import {
  WooCheckoutLeaseGuard,
  CheckoutOrderGuardService,
} from "../pending-recovery-candidate/checkout-order-guard.service.js";
import { WooOrderTerminalEvidenceStore } from "../woocommerce-recovery/woo-order-reconciliation.service.js";
import {
  recoveryStoredConsentService,
  type StoredRecoveryConsentReader,
} from "../recovery-conversation/recovery-stored-consent.service.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import { recoveryRecipientSuppressionAdmissionService } from "../checkout-recovery/recovery-recipient-suppression-admission.service.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";
import { automatedRecoveryTemplateService } from "../recovery-template-integration/automated-recovery-template.service.js";
import { prepareAutomatedTemplateInput } from "../conversation-moderation/automated-template-input.js";
import {
  moderationAssessmentService,
  type ModerationAssessmentService,
} from "../conversation-moderation/moderation-assessment.service.js";
import { moderationConfig } from "../conversation-moderation/moderation-policy.js";
import { AiTurnOwnershipService } from "../recovery-conversation/ai-turn-ownership.service.js";
import { OutboundSendFenceService } from "../recovery-conversation/outbound-send-fence.service.js";
import { recoveryRuntimeEligibility } from "../recovery-conversation/recovery-runtime-eligibility.service.js";
import { whatsAppService } from "../whatsapp.service.js";
import { isDefinitiveWhatsAppError } from "../whatsapp-provider-rejection.js";
import { ScheduledFollowUpRetryFundingService } from "./follow-up-funding.js";
import { ScheduledFollowUpRetryOpeningService } from "./follow-up-opening.js";
import { ScheduledFollowUpRetryReconciliationService } from "./follow-up-reconciliation.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});
type Cursor = { notBeforeAt: Date; id: string };
type Db = Pick<
  PrismaClient,
  | "$transaction"
  | "checkoutRecovery"
  | "recoveryOutreachRetryIntent"
  | "conversationAllowanceBlock"
  | "conversationMessage"
  | "merchantSupportMessage"
  | "$queryRaw"
  | "platformBillingPolicy"
>;
type Result = Awaited<
  ReturnType<ScheduledFollowUpRetryReconciliationService["reconcile"]>
>;
const held = (reason: string): Result => ({ kind: "held", reason });

export function scheduledFollowUpRetryExecutionPorts() {
  return {
    lease: new WooCheckoutLeaseGuard(),
    shopifyOrders: new CheckoutOrderGuardService(),
    wooOrders: new WooOrderTerminalEvidenceStore(connectionRedis),
    consent: recoveryStoredConsentService as StoredRecoveryConsentReader,
    suppression: recoveryRecipientSuppressionAdmissionService,
    execution: shopExecutionEligibilityService,
    policy: recoveryPolicyService,
    template: automatedRecoveryTemplateService,
    ownership: new AiTurnOwnershipService(),
    moderation: moderationAssessmentService as ModerationAssessmentService,
    fence: new OutboundSendFenceService(prisma, recoveryRuntimeEligibility),
    provider: whatsAppService as Pick<
      typeof whatsAppService,
      "sendWhatsAppTemplate" | "getProviderAccountId"
    >,
  };
}
type Ports = ReturnType<typeof scheduledFollowUpRetryExecutionPorts>;

const readOwner = (db: Db, recoveryId: string) =>
  db.checkoutRecovery.findUnique({
    where: { id: recoveryId },
    select: {
      id: true,
      shopId: true,
      checkoutToken: true,
      customerId: true,
      status: true,
      completedAt: true,
      expiredAt: true,
      shop: { select: { platform: true, status: true } },
      conversation: { select: { id: true, languageTag: true } },
    },
  });
type Recovery = NonNullable<Awaited<ReturnType<typeof readOwner>>>;

/** Separate bounded scan, so old initial intents cannot starve follow-ups.
 * A previously funded attempt is deliberately eligible for rediscovery. */
export async function listDueScheduledFollowUpRetries(
  db: Pick<Db, "recoveryOutreachRetryIntent">,
  input: { now: Date; limit: number; after?: Cursor },
) {
  if (
    !Number.isFinite(input.now.getTime()) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 250 ||
    (input.after &&
      (!input.after.id || !Number.isFinite(input.after.notBeforeAt.getTime())))
  )
    throw new RangeError("Invalid follow-up retry discovery page");
  return db.recoveryOutreachRetryIntent.findMany({
    where: {
      policy: "AFTER_COOLDOWN",
      cancelledAt: null,
      notBeforeAt: { lte: input.now },
      failedAttempt: {
        trigger: "NO_RESPONSE_FOLLOW_UP",
        initiatedBy: "AUTOMATION",
        status: "FAILED",
      },
      ...(input.after
        ? {
            OR: [
              { notBeforeAt: { gt: input.after.notBeforeAt } },
              {
                notBeforeAt: input.after.notBeforeAt,
                id: { gt: input.after.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ notBeforeAt: "asc" }, { id: "asc" }],
    select: { id: true, notBeforeAt: true },
    take: input.limit,
  });
}

/** The checkout lease coordinates with existing order/recovery owners. The
 * durable final permit, not that lease, is the sole authority to call Meta.
 * A lost permit ACK or a network error is never automatically replayed. */
export class ScheduledFollowUpRetryExecutionService {
  private readonly opening: ScheduledFollowUpRetryOpeningService;
  private readonly funding: ScheduledFollowUpRetryFundingService;
  private readonly reconciliation: ScheduledFollowUpRetryReconciliationService;

  constructor(
    private readonly db: Db = prisma,
    private readonly ports: Ports = scheduledFollowUpRetryExecutionPorts(),
    private readonly log: StructuredLogger = logger,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.opening = new ScheduledFollowUpRetryOpeningService(db, clock, log);
    this.funding = new ScheduledFollowUpRetryFundingService(db, clock, log);
    this.reconciliation = new ScheduledFollowUpRetryReconciliationService(
      db,
      clock,
      log,
    );
  }

  async execute(intentId: string): Promise<Result> {
    const attemptId = retryOutreachAttemptId(intentId);
    const blockId = followUpRetryBlockId(attemptId);
    const fields: Record<string, unknown> = {
      retryIntentId: intentId,
      outreachAttemptId: attemptId,
      allowanceBlockId: blockId,
    };
    let stage = "load_owner";
    try {
      const intent = await this.db.recoveryOutreachRetryIntent.findUnique({
        where: { id: intentId },
        select: {
          failedAttempt: {
            select: {
              checkoutRecoveryId: true,
              trigger: true,
              initiatedBy: true,
              recipient: true,
            },
          },
        },
      });
      if (
        !intent ||
        intent.failedAttempt.trigger !== "NO_RESPONSE_FOLLOW_UP" ||
        intent.failedAttempt.initiatedBy !== "AUTOMATION"
      )
        return held("intent-not-scheduled-follow-up");
      const initial = await readOwner(
        this.db,
        intent.failedAttempt.checkoutRecoveryId,
      );
      if (!initial?.conversation) return held("owner-missing");
      const recipient = intent.failedAttempt.recipient;
      const scope = {
        shopId: initial.shopId,
        recoveryId: initial.id,
        conversationId: initial.conversation.id,
        intentId,
      };
      Object.assign(fields, {
        shopId: scope.shopId,
        checkoutRecoveryId: scope.recoveryId,
        conversationId: scope.conversationId,
        platform: initial.shop.platform,
      });
      stage = "checkout_lease";
      const result = await this.ports.lease.withCheckoutLock(
        initial.shopId,
        initial.checkoutToken,
        async (): Promise<Result> => {
          const recovery = await readOwner(this.db, initial.id);
          if (
            !recovery?.conversation ||
            recovery.shopId !== scope.shopId ||
            recovery.checkoutToken !== initial.checkoutToken ||
            recovery.shop.platform !== initial.shop.platform ||
            recovery.conversation.id !== scope.conversationId
          )
            return held("owner-changed");
          stage = "reconcile_existing";
          const existing = await this.db.conversationAllowanceBlock.findUnique({
            where: { id: blockId },
            select: { id: true },
          });
          let preparedAlready = false;
          if (existing) {
            const progress = await this.reconciliation.reconcile(blockId);
            if (progress.kind !== "ready") return progress;
            preparedAlready = progress.reason === "prepared";
          }
          stage = "preflight";
          const first = await this.preflight(recovery, recipient);
          if (first.kind === "held") return held(first.reason);
          const policy = await this.ports.policy.resolve(
            scope.shopId,
            this.clock(),
          );
          if (!policy.followUpEnabled) return held("follow-up-disabled");
          stage = "template";
          // Use the ordinary scheduled-follow-up resolver. Supplying an attempt
          // ID would select the merchant-command-only offer verification path.
          const selected = await this.ports.template.prepare({
            shopId: scope.shopId,
            recoveryId: scope.recoveryId,
            stage: "FOLLOW_UP",
            policy,
            conversationLanguageTag: recovery.conversation.languageTag,
          });
          if (selected.kind !== "prepared")
            return held(`template:${selected.reason}`);
          const registration = selected.send.templateRegistration;
          if (
            !registration ||
            registration.shopId !== scope.shopId ||
            !registration.purpose.startsWith("FOLLOW_UP_") ||
            registration.providerTemplateName !== selected.send.templateName ||
            registration.providerLanguageCode !== selected.send.languageCode ||
            registration.senderWabaId !==
              (await this.ports.provider.getProviderAccountId())
          )
            return held("template-registration-unavailable");
          // The existing moderated body snapshots text and URLs, but not an
          // image link. Do not regenerate an unfrozen media payload on restart.
          if (selected.send.imageHeader)
            return held("follow-up-retry-media-unsupported");
          const prepared = prepareAutomatedTemplateInput({
            ...selected.send,
            to: recipient,
          });
          if (
            selected.admissionToken &&
            !(await this.ports.template.validateAdmission(
              selected.admissionToken,
              AbortSignal.timeout(15_000),
            ))
          )
            return held("offer-admission-stale");
          const second = await this.preflight(recovery, recipient);
          if (second.kind === "held" || second.revision !== first.revision)
            return held("preflight-changed");
          stage = "funding";
          if (!preparedAlready) {
            const funded = await this.funding.claimAndFund(scope);
            if (funded.kind === "held") return held(funded.reason);
            if (funded.attemptId !== attemptId || funded.blockId !== blockId)
              throw new Error("FOLLOW_UP_RETRY_FUNDING_IDENTITY_MISMATCH");
          }
          stage = "prepare_opening";
          const opener = await this.opening.prepare(
            scope,
            prepared.effectiveText,
          );
          if (opener.kind === "held") return held(opener.reason);
          Object.assign(fields, { outboundMessageId: opener.messageId });
          stage = "moderation";
          const subject = {
            kind: "AUTOMATION_MESSAGE" as const,
            messageId: opener.messageId,
          };
          const policyVersion = moderationConfig().policyVersion;
          const decision = await this.ports.moderation.assessText({
            subject,
            shopId: scope.shopId,
            conversationId: scope.conversationId,
            effectiveText: prepared.effectiveText,
            inputKind: "TEXT",
            policyVersion,
            now: this.clock(),
          });
          if (decision.kind === "retry") return held("moderation-retry");
          if (decision.kind !== "allow") {
            await this.opening.refuse(scope, opener.messageId);
            return this.reconciliation.reconcile(blockId);
          }
          if (
            !(await this.ports.moderation.requireCurrentAllowance({
              subject,
              effectiveText: prepared.effectiveText,
              policyVersion,
            }))
          )
            return held("moderation-stale");
          stage = "final_preflight";
          if (
            selected.admissionToken &&
            !(await this.ports.template.validateAdmission(
              selected.admissionToken,
              AbortSignal.timeout(15_000),
            ))
          )
            return held("offer-admission-stale-after-funding");
          // The ordinary scheduled path has no merchant-offer admission token.
          // Re-resolve a promised discount just before the permit; if any frozen
          // parameter or registration changes, hold rather than rewrite the opener.
          if (
            selected.send.recoveryPromise?.kind !== undefined &&
            selected.send.recoveryPromise.kind !== "NO_OFFER"
          ) {
            const currentPolicy = await this.ports.policy.resolve(
              scope.shopId,
              this.clock(),
            );
            if (!currentPolicy.followUpEnabled)
              return held("follow-up-disabled");
            const current = await this.ports.template.prepare({
              shopId: scope.shopId,
              recoveryId: scope.recoveryId,
              stage: "FOLLOW_UP",
              policy: currentPolicy,
              conversationLanguageTag: recovery.conversation.languageTag,
            });
            if (
              current.kind !== "prepared" ||
              current.send.imageHeader ||
              current.send.templateRegistration?.registrationId !==
                registration.registrationId ||
              current.send.templateRegistration?.bindingFingerprint !==
                registration.bindingFingerprint ||
              prepareAutomatedTemplateInput({ ...current.send, to: recipient })
                .effectiveText !== prepared.effectiveText ||
              (current.admissionToken &&
                !(await this.ports.template.validateAdmission(
                  current.admissionToken,
                  AbortSignal.timeout(15_000),
                )))
            )
              return held("follow-up-offer-or-template-changed");
          }
          const final = await this.preflight(recovery, recipient);
          if (final.kind === "held" || final.revision !== first.revision)
            return held("preflight-changed-before-permit");
          stage = "final_permit";
          const permit = await this.ports.fence.admitFinalSend({
            ...scope,
            senderType: "AUTOMATION",
            expectedControlRevision: first.revision,
            expectedInboundVersion: 0,
            messageId: opener.messageId,
            recipient,
            now: this.clock(),
            expectedContent: prepared.effectiveText,
            deliveryKind: "TEMPLATE",
            proactive: {
              verifiedCategory: "MARKETING",
              templateName: prepared.providerInput.templateName,
              languageCode: prepared.providerInput.languageCode,
              consent: final.consent,
              templateRegistration: registration,
              templateParameters: {
                header: prepared.providerInput.textHeader
                  ? [prepared.providerInput.textHeader]
                  : [],
                body: prepared.providerInput.bodyParameters ?? [],
              },
            },
            followUpRetry: {
              outreachAttemptId: attemptId,
              idempotencyKey: `recovery-outreach:${attemptId}`,
              recoveryCreditSourceKey: opener.sourceKey,
              expectedContent: prepared.effectiveText,
            },
          });
          if (permit.kind !== "admitted") {
            // A concurrent caller or a lost SQL acknowledgement might already
            // own this permit. Do not delete evidence or release its reservation.
            return held(`permit:${permit.reason}`);
          }
          stage = "provider_http";
          let receipt;
          try {
            receipt = await this.ports.provider.sendWhatsAppTemplate({
              ...prepared.providerInput,
              expectedSender: permit.sender,
            });
          } catch (error) {
            if (isDefinitiveWhatsAppError(error)) {
              try {
                await this.opening.record(scope, permit, {
                  kind: "rejected",
                  providerCode: error.providerCode ?? null,
                });
                await this.reconciliation.reconcile(blockId);
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  "Follow-up retry provider and reconciliation failure",
                  { cause: error },
                );
              }
            }
            // Unknown transport failures deliberately leave the committed permit
            // and reserved funding intact. Never call Meta again for this opener.
            throw error;
          }
          stage = "receipt_persistence";
          if (!receipt.providerMessageId?.trim())
            throw new Error("FOLLOW_UP_RETRY_PROVIDER_RECEIPT_MISSING");
          await this.opening.record(scope, permit, {
            kind: "accepted",
            providerMessageId: receipt.providerMessageId,
          });
          this.log.info("recovery.delivery_retry.follow_up_provider_accepted", {
            ...fields,
            providerMessageId: receipt.providerMessageId,
            deliveryConfirmed: false,
          });
          stage = "settlement";
          return this.reconciliation.reconcile(blockId);
        },
      );
      this.log.debug("recovery.delivery_retry.follow_up_execution_result", {
        ...fields,
        outcome: result.kind,
        ...("reason" in result ? { reason: result.reason } : {}),
      });
      return result;
    } catch (error) {
      this.log.error("recovery.delivery_retry.follow_up_execution_failed", {
        ...fields,
        stage,
        sourceError: initialOutreachDiagnostic(error),
      });
      throw error;
    }
  }

  private async preflight(recovery: Recovery, recipient: string) {
    if (
      !recovery.conversation ||
      !recovery.customerId ||
      recovery.status !== "MESSAGE_SENT" ||
      recovery.completedAt ||
      recovery.expiredAt ||
      !/^[1-9][0-9]{6,14}$/.test(recipient)
    )
      return { kind: "held", reason: "recovery-ineligible" } as const;
    if (recovery.shop.platform === "WOOCOMMERCE") {
      if (
        (
          await this.ports.wooOrders.read({
            shopId: recovery.shopId,
            checkoutToken: recovery.checkoutToken,
          })
        ).kind !== "none-observed"
      )
        return { kind: "held", reason: "woo-observed-order-terminal" } as const;
    } else if (recovery.shop.platform === "SHOPIFY") {
      if (
        await this.ports.shopifyOrders.hasOrderProcessed(
          recovery.shopId,
          recovery.checkoutToken,
        )
      )
        return {
          kind: "held",
          reason: "shopify-observed-order-terminal",
        } as const;
    } else return { kind: "held", reason: "platform-unsupported" } as const;
    const execution = await this.ports.execution.evaluate(
      recovery.shopId,
      recovery.shop.status,
      "recovery",
    );
    if (!execution.allowed)
      return { kind: "held", reason: execution.reason } as const;
    if (
      (
        await this.ports.suppression.evaluate(
          recovery.shopId,
          recipient,
          this.clock(),
        )
      ).kind !== "allowed"
    )
      return { kind: "held", reason: "recipient-suppressed" } as const;
    const owner = await this.ports.ownership.readTurnOwnership(
      recovery.conversation.id,
    );
    if (
      !owner ||
      owner.shopId !== recovery.shopId ||
      owner.recoveryId !== recovery.id ||
      owner.mode !== "AI"
    )
      return { kind: "held", reason: "owner-ineligible" } as const;
    const consent = await this.ports.consent.preflight({
      shopId: recovery.shopId,
      recoveryId: recovery.id,
      recipient,
    });
    if (consent.kind !== "allowed" || !consent.snapshot)
      return {
        kind: "held",
        reason:
          consent.kind === "denied" ? consent.reason : "consent-unavailable",
      } as const;
    return {
      kind: "ready",
      revision: owner.revision,
      consent: consent.snapshot,
    } as const;
  }

  async runDuePage(input: { limit: number; after?: Cursor }) {
    const candidates = await listDueScheduledFollowUpRetries(this.db, {
      ...input,
      now: this.clock(),
    });
    const outcomes: Array<{
      intentId: string;
      kind: Result["kind"] | "error";
    }> = [];
    for (const candidate of candidates) {
      try {
        outcomes.push({
          intentId: candidate.id,
          kind: (await this.execute(candidate.id)).kind,
        });
      } catch (error) {
        this.log.error("recovery.delivery_retry.follow_up_sweep_item_failed", {
          retryIntentId: candidate.id,
          sourceError: initialOutreachDiagnostic(error),
        });
        outcomes.push({ intentId: candidate.id, kind: "error" });
      }
    }
    const last = candidates.at(-1);
    return {
      outcomes,
      next:
        candidates.length === input.limit && last?.notBeforeAt
          ? { id: last.id, notBeforeAt: last.notBeforeAt }
          : null,
    };
  }
}
