import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { connectionRedis } from "../../lib/redis.js";
import { whatsAppService } from "../whatsapp.service.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import { recoveryOutreachAttemptService, type RecoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
import { MerchantSendCommandService, type HumanCommand } from "./merchant-send-command.service.js";
import { RecoveryFollowUpPolicyService } from "./recovery-follow-up-policy.service.js";
import { HumanSendPolicyService } from "./human-send-policy.service.js";
import { HumanCommandEvaluationService } from "./human-command-evaluation.service.js";
import { OutboundSendFenceService } from "./outbound-send-fence.service.js";
import { HumanSendReconciliationService } from "./human-send-reconciliation.service.js";
import { RecoveryFollowUpBillingService } from "./recovery-follow-up-billing.service.js";
import { recoveryRuntimeEligibility } from "./recovery-runtime-eligibility.service.js";
import { moderationAssessmentService, type ModerationAssessmentService } from "../conversation-moderation/moderation-assessment.service.js";
import { humanModerationAdmission } from "../conversation-moderation/moderation-decision-adapter.js";
import { moderationConfig } from "../conversation-moderation/moderation-policy.js";
import { first, rows, changed, recoveryDatabase, readRecoveryContext, type RecoveryDatabase } from "./recovery-conversation.sql.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";

const logger = createLogger({ serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName() });
const POLL_MS = 3_000;
const MAX_PER_POLL = 25;
const MAX_IN_FLIGHT = 4;

export type HumanDispatcherDependencies = {
  database: RecoveryDatabase;
  outreach: Pick<RecoveryOutreachAttemptService, "markWaitingAfterConfirmedSend">;
  commands: MerchantSendCommandService;
  evaluator: HumanCommandEvaluationService;
  followUps: RecoveryFollowUpPolicyService;
  fence: OutboundSendFenceService;
  reconciliation: HumanSendReconciliationService;
  billing: RecoveryFollowUpBillingService;
  provider: Pick<typeof whatsAppService, "sendWhatsAppText" | "sendWhatsAppTemplate">;
  execution: Pick<typeof shopExecutionEligibilityService, "evaluate">;
  now: () => Date;
  moderation: ModerationAssessmentService;
};

export function createHumanDispatcherDependencies(): HumanDispatcherDependencies {
  const commands = new MerchantSendCommandService();
  const followUps = new RecoveryFollowUpPolicyService();
  const policy = new HumanSendPolicyService(recoveryDatabase, connectionRedis);
  return {
    database: recoveryDatabase, outreach: recoveryOutreachAttemptService,
    commands, followUps,
    evaluator: new HumanCommandEvaluationService(commands, followUps, policy),
    fence: new OutboundSendFenceService(recoveryDatabase, recoveryRuntimeEligibility),
    reconciliation: new HumanSendReconciliationService(),
    billing: new RecoveryFollowUpBillingService(),
    provider: whatsAppService,
    execution: shopExecutionEligibilityService,
    now: () => new Date(),
    moderation: moderationAssessmentService,
  };
}

/** One platform-neutral PostgreSQL dispatcher per existing messaging-worker process.
 * The lease and committed provider permit—not an in-memory flag—enforce
 * cross-replica ownership. The dispatcher never discovers commands in Redis.
 */
export class HumanCommandDispatcherService {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollPromise: Promise<void> | undefined;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: HumanDispatcherDependencies = createHumanDispatcherDependencies()) {}

  start() {
    if (this.stopped) throw new Error("ARCH040 dispatcher cannot restart after close");
    if (this.timer || this.pollPromise) return;
    this.queuePoll(0);
  }

  private queuePoll(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pollPromise = this.poll().catch((error: unknown) => {
        logger.error("arch040.human_dispatcher.poll_failed", { reason: "poll_failed", errorType: error instanceof Error ? error.name : "unknown" });
      }).finally(() => {
        this.pollPromise = undefined;
        this.queuePoll(POLL_MS);
      });
    }, delay);
  }

  async poll(): Promise<void> {
    const available = Math.max(0, MAX_IN_FLIGHT - this.inFlight.size);
    if (!available || this.stopped) return;
    await this.reconcileExpiredPermits();
    await this.reconcileConfirmedFollowUps();
    const commands = await this.deps.commands.claimDueHumanCommands({
      limit: Math.min(MAX_PER_POLL, available), now: this.deps.now(),
    });
    for (const claim of commands) {
      const active: Promise<void> = this.processClaim(claim.id, claim.leaseToken).catch((error: unknown) => {
        logger.error("arch040.human_dispatcher.command_failed", {
          commandId: claim.id, errorType: error instanceof Error ? error.name : "unknown",
        });
      }).finally(() => { this.inFlight.delete(active); });
      this.inFlight.add(active);
    }
  }

  /** A committed permit with an expired worker lease has an unknowable HTTP
   * outcome. Mark it UNKNOWN for explicit provider reconciliation; do not queue
   * it for another Meta submission. Concurrent replicas converge by CAS.
   */
  async reconcileExpiredPermits(): Promise<void> {
    const expired = await rows<{ id: string; leaseToken: string }>(this.deps.database, `
      SELECT "id", "leaseToken" FROM "whatsapp"."MerchantConversationSendCommand"
      WHERE "state"='DISPATCH_ADMITTED' AND "providerDispatchKey" IS NOT NULL
        AND "leaseToken" IS NOT NULL AND "leaseExpiresAt"<=statement_timestamp()
      ORDER BY "leaseExpiresAt","id" LIMIT 25`);
    for (const command of expired) {
      await this.deps.reconciliation.recordProviderUnknown({
        commandId: command.id, leaseToken: command.leaseToken,
      });
    }
  }

  /** Repair the provider-accepted -> credit-finalisation gap after a crash.
   * An idempotent credit source and the existing attempt CAS converge across
   * multiple polling replicas. This path must never call Meta again.
   */
  async reconcileConfirmedFollowUps(): Promise<void> {
    const waiting = await rows<{
      commandId: string; shopId: string; attemptId: string; recoveryId: string;
      messageId: string; sentAt: Date;
    }>(this.deps.database, `
      SELECT cmd."id" AS "commandId",cmd."shopId",cmd."recoveryOutreachAttemptId" AS "attemptId",
        a."checkoutRecoveryId" AS "recoveryId",m."id" AS "messageId",m."sentAt"
      FROM "whatsapp"."MerchantConversationSendCommand" cmd
      JOIN "commerce"."RecoveryOutreachAttempt" a ON a."id"=cmd."recoveryOutreachAttemptId"
      JOIN "whatsapp"."ConversationMessage" m ON m."id"=cmd."outboundMessageId"
      WHERE cmd."state"='SENT' AND a."status"='PENDING'
        AND m."status" IN ('SENT','DELIVERED','READ') AND m."sentAt" IS NOT NULL
      ORDER BY cmd."createdAt",cmd."id" LIMIT 25`);
    for (const row of waiting) {
      const credit = await this.deps.billing.admitAndRevalidate({
        shopId: row.shopId, recoveryId: row.recoveryId, sequenceTwoAttemptId: row.attemptId,
      });
      if (credit.kind !== "admitted") continue;
      await this.deps.billing.onConfirmedProviderSend({
        admission: credit.admission, recoveryId: row.recoveryId, occurredAt: row.sentAt,
      });
      await this.deps.outreach.markWaitingAfterConfirmedSend(row.attemptId, {
        sentAt: row.sentAt, outboundMessageId: row.messageId,
      });
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pollPromise) await this.pollPromise;
    await Promise.allSettled([...this.inFlight]);
  }

  async processClaim(commandId: string, leaseToken: string): Promise<void> {
    const now = this.deps.now();
    const evaluated = await this.deps.evaluator.evaluateHumanCommand(commandId, leaseToken, now);
    if (evaluated.kind === "terminal") {
      await this.deps.commands.rejectCommand(commandId, leaseToken, safeCode(evaluated.reason));
      return;
    }
    if (evaluated.kind === "retryable") {
      await this.defer(commandId, leaseToken, evaluated.reason);
      return;
    }
    const resolved = await this.deps.commands.loadClaimedCommand(commandId, leaseToken, this.deps.now());
    if (resolved.kind !== "claimed") {
      await this.deps.commands.rejectCommand(commandId, leaseToken, safeCode(resolved.reason));
      return;
    }
    const command = resolved.command;
    const context = await readRecoveryContext(this.deps.database, command.conversationId);
    if (!context || context.shopId !== command.shopId) {
      await this.deps.commands.rejectCommand(commandId, leaseToken, "not_recovery_linked");
      return;
    }
    const eligibility = await this.deps.execution.evaluate(command.shopId, undefined, "recovery");
    if (!eligibility.allowed) {
      await this.deps.commands.rejectCommand(commandId, leaseToken, safeCode(eligibility.reason));
      return;
    }

    // The command's persisted content, NOT UI text, is moderated before any
    // sequence-two reservation, billing admission or provider permit.
    const subject = { kind: "HUMAN_COMMAND" as const, commandId };
    const moderation = this.deps.moderation;
    let effectiveText: string;
    try {
      effectiveText = await moderation.effectiveText(subject);
      const cfg = moderationConfig();
      const decision = humanModerationAdmission(await moderation.assessText({
        subject, shopId: command.shopId, conversationId: command.conversationId,
        effectiveText, inputKind: command.kind === "HUMAN_TEXT" ? "TEXT" : "TEMPLATE_PARAMETERS",
        policyVersion: cfg.policyVersion, now: this.deps.now(),
      }));
      if (decision.kind === "retry") {
        await this.deps.commands.deferCommand(commandId, leaseToken, "moderation_unavailable", decision.retryAt);
        return;
      }
      if (decision.kind === "blocked") {
        await this.deps.commands.rejectCommand(commandId, leaseToken, decision.failureCode.toLowerCase());
        return;
      }
    } catch {
      await this.defer(commandId, leaseToken, "moderation_unavailable");
      return;
    }

    let attemptId: string | null = null;
    let credit: Awaited<ReturnType<RecoveryFollowUpBillingService["admitAndRevalidate"]>> | null = null;
    if (command.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
      const claimed = await this.claimMerchantFollowUp(command, context.recoveryId, now);
      if (!claimed) {
        await this.deps.commands.rejectCommand(commandId, leaseToken, "follow_up_unavailable");
        return;
      }
      attemptId = claimed;
      credit = await this.deps.billing.admitAndRevalidate({
        shopId: command.shopId, recoveryId: context.recoveryId, sequenceTwoAttemptId: attemptId,
      });
      if (credit.kind !== "admitted") {
        await this.defer(commandId, leaseToken, safeCode(credit.reason));
        return;
      }
    }
    // A stale ALLOW cannot survive a concurrent change to persisted text.
    if (!(await moderation.requireCurrentAllowance({
      subject, effectiveText, policyVersion: moderationConfig().policyVersion,
    }))) {
      if (credit?.kind === "admitted") await this.deps.billing.releaseBeforePermit(credit.admission);
      await this.defer(commandId, leaseToken, "moderation_content_stale");
      return;
    }
    // Final provider admission commits before Meta request. No HTTP call or
    // Redis admission is made inside its transaction.
    const permit = await this.deps.fence.admitFinalSend({
      senderType: "HUMAN", conversationId: command.conversationId,
      shopId: command.shopId, recoveryId: context.recoveryId,
      expectedControlRevision: command.expectedControlRevision,
      commandId, leaseToken, recipient: command.recipientSnapshot, now: this.deps.now(),
    });
    if (permit.kind !== "admitted") {
      if (credit?.kind === "admitted") await this.deps.billing.releaseBeforePermit(credit.admission);
      await this.deps.commands.rejectCommand(commandId, leaseToken, safeCode(permit.reason));
      return;
    }
    // From here onwards there is NO safe automatic retry—even if the worker
    // crashes before receiving an HTTP reply. Reconciliation owns UNKNOWN.
    try {
      const response = command.kind === "HUMAN_TEXT"
        ? await this.deps.provider.sendWhatsAppText({
            to: command.recipientSnapshot, text: command.textBody ?? "",
          })
        : await this.deps.provider.sendWhatsAppTemplate({
            to: command.recipientSnapshot, templateName: command.templateName ?? "",
            languageCode: command.templateLanguageCode ?? "en",
            ...(bodyParameters(command.templateParameters).length
              ? { bodyParameters: bodyParameters(command.templateParameters) } : {}),
          });
      const recorded = await this.deps.reconciliation.recordProviderAccepted({
        commandId, leaseToken, providerMessageId: response.providerMessageId, providerVerified: true,
      });
      if (recorded.kind !== "sent") throw new Error("Provider acknowledgment cannot be reconciled");
      await changed(this.deps.database, `UPDATE "whatsapp"."Conversation"
        SET "lastMessageAt"=statement_timestamp() WHERE "id"=$1`, command.conversationId);
      if (attemptId && credit?.kind === "admitted") {
        await this.deps.billing.onConfirmedProviderSend({
          admission: credit.admission, recoveryId: context.recoveryId, occurredAt: new Date(),
        });
        await this.deps.outreach.markWaitingAfterConfirmedSend(attemptId, {
          sentAt: new Date(), outboundMessageId: recorded.messageId,
        });
      }
    } catch (error) {
      const definitive = error instanceof Error && error.name === "WhatsAppServiceError" &&
        ["provider-rejected", "configuration-missing"].includes((error as Error & { code?: string }).code ?? "");
      if (definitive) {
        const outcome = await this.deps.reconciliation.recordDefinitiveFailure({
          commandId, leaseToken, reason: "provider_rejected", definitiveProviderEvidence: true,
        });
        if (outcome.kind === "definitive-failure" && credit?.kind === "admitted") {
          await this.deps.billing.onDefinitiveProviderFailure({ admission: credit.admission, error });
        }
      } else {
        await this.deps.reconciliation.recordProviderUnknown({ commandId, leaseToken });
      }
      logger.warn("arch040.human_dispatcher.provider_outcome", {
        commandId, outcome: definitive ? "definitive_failure" : "unknown",
      });
    }
  }

  private async claimMerchantFollowUp(command: HumanCommand, recoveryId: string, now: Date): Promise<string | null> {
    const claim = await this.deps.followUps.claimSequenceTwo({
      initiator: "merchant_post_window", recoveryId, initiationKey: command.idempotencyKey,
      recipient: command.recipientSnapshot, expectedRevision: command.expectedControlRevision, now,
    });
    let attemptId: string | undefined;
    if (claim.kind === "claimed") attemptId = claim.attemptId;
    if (!attemptId && claim.kind === "suppressed" && claim.reason === "already-claimed") {
      // Restart-safe replay of the SAME merchant command: not another claim.
      const existing = await first<{ id: string }>(this.deps.database, `
        SELECT "id" FROM "commerce"."RecoveryOutreachAttempt"
        WHERE "checkoutRecoveryId"=$1 AND "sequence"=2
          AND "initiatedBy"='HUMAN' AND "initiationKey"=$2
          AND "outboundMessageId" IS NULL AND "status"='PENDING'`, recoveryId, command.idempotencyKey);
      attemptId = existing?.id;
    }
    // DATABASE-001 makes the command's attempt FK immutable. Both producers
    // must supply this already; the dispatcher must never rewrite it.
    return attemptId && command.recoveryOutreachAttemptId === attemptId ? attemptId : null;
  }

  private defer(commandId: string, token: string, reason: string) {
    return this.deps.commands.deferCommand(commandId, token, safeCode(reason),
      new Date(this.deps.now().getTime() + 30_000));
  }
}

function safeCode(value: string): string {
  const bounded = value.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
  return /^[a-z]/.test(bounded) ? bounded : "policy_denied";
}
function bodyParameters(value: unknown): string[] {
  return Array.isArray(value) && value.length <= 16 && value.every((x) => typeof x === "string")
    ? value : [];
}
