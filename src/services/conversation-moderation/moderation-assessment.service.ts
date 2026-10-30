import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { openAiModerateText, type ModerateText } from "./moderation-client.js";
import { ModerationDependencyFailure, moderationExceptionLogFields, moderationFailureDiagnostic } from "./moderation-failure-diagnostics.js";
import { readModerationOperation, type ModerationOperationReader } from "./moderation-operation.js";
import {
  classifyModeration, moderationConfig, MODERATION_TIMEOUT_MS,
  type ModerationActor, type ClassifiedModeration,
} from "./moderation-policy.js";

const deploymentEnvironment = resolveDeploymentEnvironmentName();
const logger = createLogger({ serviceName: "moda-messaging-worker", environment: deploymentEnvironment });
const LEASE_MS = 45_000;
const BACKOFF_MS = [10_000, 30_000, 120_000] as const;
export const sha256Text = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export type ModerationSubject =
  | { kind: "CUSTOMER_MESSAGE" | "AGENT_MESSAGE" | "AUTOMATION_MESSAGE"; messageId: string }
  | { kind: "HUMAN_COMMAND"; commandId: string };
export type ModerationResult =
  | { kind: "allow"; assessmentId: string; digest: string; policyVersion: string }
  | { kind: "block"; assessmentId: string; reasonCode: string }
  | { kind: "review_required"; assessmentId: string; reasonCode: string }
  | { kind: "retry"; assessmentId: string; retryAt: Date };
export interface ModerationAssessmentService {
  assessText(input: { subject: ModerationSubject; shopId: string; conversationId: string;
    effectiveText: string; inputKind: "TEXT" | "TRANSCRIPT" | "TEMPLATE_PARAMETERS";
    policyVersion: string; now: Date }): Promise<ModerationResult>;
  effectiveText(subject: ModerationSubject): Promise<string>;
  requireCurrentAllowance(input: { subject: ModerationSubject; effectiveText: string;
    policyVersion: string }): Promise<boolean>;
}

type AssessmentRow = { id: string; decision: string; contentSha256: string; policyVersion: string;
  requestedModel: string; reasonCode: string | null; nextAttemptAt: Date | null;
  leaseExpiresAt: Date | null; attemptCount: number };
type Canonical = { content: string; shopId: string; conversationId: string;
  inputKind: "TEXT" | "TRANSCRIPT" | "TEMPLATE_PARAMETERS" };

/** All source text comes from persisted records; shopId/effectiveText are assertions, not authority. */
export class PostgresModerationAssessmentService implements ModerationAssessmentService {
  constructor(private readonly database: PrismaClient = prisma,
    private readonly moderate: ModerateText = openAiModerateText,
    private readonly clock: () => Date = () => new Date(),
    private readonly readOperation: ModerationOperationReader = readModerationOperation) {}

  private async canonical(subject: ModerationSubject): Promise<Canonical> {
    if (subject.kind === "HUMAN_COMMAND") {
      const command = await this.database.merchantConversationSendCommand.findUnique({
        where: { id: subject.commandId },
        select: {
          shopId: true, conversationId: true, kind: true, preparedTextBody: true,
          templateName: true, templateLanguageCode: true, templateParameters: true,
          conversation: { select: { shopId: true, checkoutRecovery: { select: { shopId: true } } } },
        },
      });
      if (!command || !command.conversation.checkoutRecovery ||
        command.shopId !== command.conversation.checkoutRecovery.shopId ||
        (command.conversation.shopId && command.conversation.shopId !== command.shopId)) {
        throw new Error("moderation_subject_invalid");
      }
      if (command.kind === "HUMAN_TEXT") {
        if (!command.preparedTextBody?.trim()) throw new Error("moderation_prepared_body_missing");
        return { shopId: command.shopId, conversationId: command.conversationId,
          content: command.preparedTextBody ?? "", inputKind: "TEXT" };
      }
      const rendered = await this.database.$queryRaw<Array<{ text: string }>>(Prisma.sql`
        SELECT "whatsapp".arch040_moderation_template_input_v1(
          ${command.templateName}, ${command.templateLanguageCode},
          ${command.templateParameters === null
            ? null : JSON.stringify(command.templateParameters)}::jsonb
        ) AS "text"`);
      if (!rendered[0]?.text || !command.templateName || !command.templateLanguageCode) {
        throw new Error("moderation_template_invalid");
      }
      return { shopId: command.shopId, conversationId: command.conversationId,
        content: rendered[0].text, inputKind: "TEMPLATE_PARAMETERS" };
    }
    const message = await this.database.conversationMessage.findUnique({
      where: { id: subject.messageId },
      select: {
        conversationId: true, direction: true, senderType: true, content: true,
        contentType: true, transcriptionStatus: true,
        conversation: { select: { shopId: true, checkoutRecovery: { select: { shopId: true } } } },
      },
    });
    const actorMatch = subject.kind === "CUSTOMER_MESSAGE"
      ? message?.direction === "INBOUND" && message.senderType === "CUSTOMER"
      : message?.direction === "OUTBOUND" && message.senderType ===
        (subject.kind === "AGENT_MESSAGE" ? "AGENT" : "AUTOMATION");
    const shopId = message?.conversation.checkoutRecovery?.shopId ?? message?.conversation.shopId;
    if (!message || !actorMatch || !shopId ||
      (message.conversation.shopId && message.conversation.checkoutRecovery &&
        message.conversation.shopId !== message.conversation.checkoutRecovery.shopId)) {
      throw new Error("moderation_subject_invalid");
    }
    const isAudio = message.contentType === "AUDIO";
    if (isAudio && (subject.kind !== "CUSTOMER_MESSAGE" || message.transcriptionStatus !== "COMPLETED")) {
      throw new Error("moderation_media_unsupported");
    }
    if (message.contentType !== "TEXT" && !isAudio) throw new Error("moderation_media_unsupported");
    return { shopId, conversationId: message.conversationId, content: message.content,
      inputKind: isAudio ? "TRANSCRIPT" : "TEXT" };
  }

  private async find(subject: ModerationSubject, digest: string, policyVersion: string): Promise<AssessmentRow | null> {
    return this.database.conversationModerationAssessment.findFirst({
      where: { ...(subject.kind === "HUMAN_COMMAND"
        ? { merchantSendCommandId: subject.commandId } : { conversationMessageId: subject.messageId }),
        policyVersion, contentSha256: digest },
      select: { id: true, decision: true, contentSha256: true, policyVersion: true,
        requestedModel: true, reasonCode: true, nextAttemptAt: true, leaseExpiresAt: true, attemptCount: true },
    });
  }

  async effectiveText(subject: ModerationSubject): Promise<string> {
    return (await this.canonical(subject)).content;
  }

  async requireCurrentAllowance(input: { subject: ModerationSubject; effectiveText: string;
    policyVersion: string }): Promise<boolean> {
    try {
      const current = await this.canonical(input.subject);
      if (current.content !== input.effectiveText) return false;
      const assessment = await this.find(input.subject, sha256Text(current.content), input.policyVersion);
      const operation = await this.readOperation();
      return assessment?.decision === "ALLOW" &&
        assessment.requestedModel === operation.moderation.value.modelId;
    } catch (error) {
      logger.warn("conversation.moderation.allowance_recheck_failed", {
        actor: input.subject.kind, errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
      return false;
    }
  }

  async assessText(input: { subject: ModerationSubject; shopId: string; conversationId: string;
    effectiveText: string; inputKind: "TEXT" | "TRANSCRIPT" | "TEMPLATE_PARAMETERS";
    policyVersion: string; now: Date }): Promise<ModerationResult> {
    // One ARCH-043 read resolves model/endpoint and sealed provider key together.
    // Missing, disabled or revoked config fails before assessment creation/Meta admission.
    const operation = await this.readOperation();
    const cfg = moderationConfig();
    const model = operation.moderation.value.modelId;
    const source = await this.canonical(input.subject);
    if (source.shopId !== input.shopId || source.conversationId !== input.conversationId ||
        source.inputKind !== input.inputKind || source.content !== input.effectiveText ||
        cfg.policyVersion !== input.policyVersion) throw new Error("moderation_content_identity_mismatch");
    const digest = sha256Text(source.content);
    const subject = input.subject;
    const ids = subject.kind === "HUMAN_COMMAND"
      ? { messageId: null, commandId: subject.commandId } : { messageId: subject.messageId, commandId: null };
    const created = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_create_or_reuse(
        ${randomUUID()},${source.shopId},${source.conversationId},
        ${subject.kind}::"whatsapp"."ConversationModerationSubject",
        ${ids.messageId},${ids.commandId},${digest},${source.inputKind},${model},${cfg.policyVersion}
      ) AS "id"`);
    const id = created[0]?.id;
    if (!id) throw new Error("moderation_assessment_unavailable");
    const row = await this.find(subject, digest, cfg.policyVersion);
    if (!row || row.id !== id || row.requestedModel !== model) throw new Error("moderation_assessment_identity_mismatch");
    const terminal = resultFromPersisted(row, digest, cfg.policyVersion);
    if (terminal) return terminal;
    const now = this.clock();
    if ((row.nextAttemptAt && row.nextAttemptAt > now) ||
        (row.decision === "CHECKING" && row.leaseExpiresAt && row.leaseExpiresAt > now)) {
      return { kind: "retry", assessmentId: id, retryAt: row.nextAttemptAt ?? row.leaseExpiresAt ?? new Date(now.getTime() + 5_000) };
    }
    const lease = randomUUID();
    const acquired = await this.database.$executeRaw(Prisma.sql`
      UPDATE "whatsapp"."ConversationModerationAssessment" SET
        "decision"='CHECKING',"attemptCount"="attemptCount"+1,
        "leaseToken"=${lease},"leaseExpiresAt"=${new Date(now.getTime() + LEASE_MS)},
        "nextAttemptAt"=NULL,"updatedAt"=clock_timestamp(),
        "assessedAt"=NULL,"reasonCode"=NULL,"returnedModel"=NULL,
        "flagged"=NULL,"categories"=NULL,"categoryScores"=NULL,"providerRequestId"=NULL
      WHERE "id"=${id} AND (
        ("decision" IN ('PENDING','RETRYABLE_ERROR') AND
          ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=clock_timestamp())) OR
        ("decision"='CHECKING' AND "leaseExpiresAt"<=clock_timestamp())
      )`);
    if (!acquired) return { kind: "retry", assessmentId: id, retryAt: new Date(now.getTime() + 5_000) };
    let classified: ClassifiedModeration;
    let retryAt: Date | null = null;
    try {
      if (!source.content.trim()) {
        classified = { decision: "REVIEW_REQUIRED", flagged: null, reasonCode: "moderation_empty_input",
          categories: null, scores: null, returnedModel: "not-invoked", requestId: null };
      } else {
        const response = await this.moderate({ text: source.content, model, timeoutMs: MODERATION_TIMEOUT_MS, operation });
        try { classified = classifyModeration(response, subject.kind as ModerationActor); }
        catch (error) {
          throw new ModerationDependencyFailure("moderation_response_invalid", {
            stage: "provider_response", code: "provider_response_invalid", providerRequestAttempted: true,
          }, error);
        }
      }
    } catch (error) {
      const attempt = row.attemptCount + 1;
      if (attempt >= BACKOFF_MS.length) {
        classified = { decision: "REVIEW_REQUIRED", flagged: null, reasonCode: "moderation_dependency_unavailable",
          categories: null, scores: null, returnedModel: "not-invoked", requestId: null };
      } else {
        retryAt = new Date(this.clock().getTime() + BACKOFF_MS[attempt - 1]!);
        classified = { decision: "REVIEW_REQUIRED", flagged: null, reasonCode: "moderation_dependency_retry",
          categories: null, scores: null, returnedModel: null, requestId: null };
      }
      // Provide a 512-character exception-message excerpt in test/development.
      // The excerpt is scrubbed; raw Error objects/stacks/causes are never logged.
      const diagnostic = moderationFailureDiagnostic(error);
      logger.warn("conversation.moderation.dependency_unavailable", {
        assessmentId: id, shopId: input.shopId, conversationId: input.conversationId,
        actor: subject.kind, assessmentAttempt: attempt, maxAssessmentAttempts: BACKOFF_MS.length,
        failureStage: diagnostic.stage, failureCode: diagnostic.code,
        providerRequestAttempted: diagnostic.providerRequestAttempted,
        ...(diagnostic.httpStatus === undefined ? {} : { providerHttpStatus: diagnostic.httpStatus }),
        retryScheduled: retryAt !== null,
        moderationConfigVersion: operation.moderation.version,
        providerCredentialVersion: operation.providerVersion,
        ...moderationExceptionLogFields(error, deploymentEnvironment),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    const decision = retryAt ? "RETRYABLE_ERROR" : classified.decision;
    const completed = await this.database.$queryRaw<Array<{ completed: boolean }>>(Prisma.sql`
      SELECT "whatsapp".arch040_moderation_complete(
        ${id},${lease},${decision}::"whatsapp"."ConversationModerationDecision",
        ${classified.returnedModel},${classified.flagged},
        ${classified.categories === null ? null : JSON.stringify(classified.categories)}::jsonb,
        ${classified.scores === null ? null : JSON.stringify(classified.scores)}::jsonb,
        ${classified.reasonCode},${classified.requestId},${retryAt}
      ) AS "completed"`);
    if (!completed[0]?.completed) return { kind: "retry", assessmentId: id, retryAt: new Date(this.clock().getTime() + 5_000) };
    logger.info(`conversation.moderation.${decision.toLowerCase()}`, {
      assessmentId: id, shopId: input.shopId, conversationId: input.conversationId,
      actor: subject.kind, reasonCode: classified.reasonCode,
      moderationConfigVersion: operation.moderation.version,
      providerCredentialVersion: operation.providerVersion,
    });
    if (retryAt) return { kind: "retry", assessmentId: id, retryAt };
    return resultFromDecision(id, digest, cfg.policyVersion, classified.decision, classified.reasonCode);
  }
}

function resultFromDecision(id: string, digest: string, policyVersion: string,
  decision: "ALLOW" | "BLOCK" | "REVIEW_REQUIRED", reasonCode: string | null): ModerationResult {
  if (decision === "ALLOW") return { kind: "allow", assessmentId: id, digest, policyVersion };
  if (decision === "BLOCK") return { kind: "block", assessmentId: id, reasonCode: reasonCode ?? "moderation_blocked" };
  return { kind: "review_required", assessmentId: id, reasonCode: reasonCode ?? "moderation_review_required" };
}
function resultFromPersisted(row: AssessmentRow, digest: string, policyVersion: string): ModerationResult | null {
  if (row.decision === "ALLOW" || row.decision === "BLOCK" || row.decision === "REVIEW_REQUIRED") {
    return resultFromDecision(row.id, digest, policyVersion, row.decision, row.reasonCode);
  }
  return null;
}

export const moderationAssessmentService = new PostgresModerationAssessmentService();
