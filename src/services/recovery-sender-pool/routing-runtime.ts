import { prepareRoutingAudio } from "./routing-audio.js";
import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type RecoveryBasketRoutingTurn,
} from "@prisma/client";
import prisma from "../../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type { WhatsAppInboundEvent } from "../../integration/whatsapp/types.js";
import { createOpenRouterCredentialResolver } from "../../commerce/openrouter-credential.js";
import { readCanonicalCredentialKeyring } from "../../commerce/credential-keyring.js";
import {
  readRoutingPolicy,
  assertCurrentRoutingPolicy,
  type RoutingPolicySnapshot,
} from "./routing-policy.js";
import {
  classifyRouting,
  type RoutingClassification,
  type RoutingPromptEvidence,
} from "./routing-classifier.js";
import { persistRoutingHandoff } from "./routing-handoff.js";
import {
  readRoutingPrompt,
  sendRoutingPrompt,
  assertCurrentRoutingTemplate,
  type PreparedRoutingPrompt,
} from "./routing-prompt.js";
import { readDispatchSenderSnapshot } from "./dispatch-sender.js";
import type { SenderHandoff } from "./inbound-authority.js";
import {
  readRoutingCandidates,
  freezeRoutingDecision,
  admitRoutingDecision,
  fingerprint,
  textOf,
  routingAudioOf,
  readRoutingAudioSourceHash,
  routingMessageId,
  routingAssessmentId,
  scrubRoutingPayload,
  type FrozenRoutingDecision,
  type RoutingCandidate,
  type RoutingAllowedAssessment,
} from "./routing-store.js";
import { readModerationOperation } from "../conversation-moderation/moderation-operation.js";
import { openAiModerateText } from "../conversation-moderation/moderation-client.js";
import {
  classifyModeration,
  moderationConfig,
  MODERATION_TIMEOUT_MS,
} from "../conversation-moderation/moderation-policy.js";
import { sha256 } from "../recovery-multipart/frozen.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
export type RoutingRuntimeDependencies = {
  audio: typeof prepareRoutingAudio;
  readPolicy: typeof readRoutingPolicy;
  currentPolicy: typeof assertCurrentRoutingPolicy;
  classify: (
    input: Parameters<typeof classifyRouting>[0],
    policy: RoutingPolicySnapshot,
  ) => ReturnType<typeof classifyRouting>;
  moderate: (text: string) => Promise<RoutingAllowedAssessment | null>;
  readPrompt: typeof readRoutingPrompt;
  sendPrompt: typeof sendRoutingPrompt;
  senderSnapshot: typeof readDispatchSenderSnapshot;
  shopActive: (id: string) => Promise<boolean>;
};
async function moderateRoutingText(
  text: string,
): Promise<RoutingAllowedAssessment | null> {
  const operation = await readModerationOperation();
  const provider = await prisma.platformConfiguration.findUnique({
    where: {
      environment_key: {
        environment: resolveDeploymentEnvironmentName(),
        key: "ai.providers",
      },
    },
    select: { id: true, version: true },
  });
  if (!provider || provider.version !== operation.providerVersion) return null;
  const result = classifyModeration(
    await openAiModerateText({
      text,
      model: operation.moderation.value.modelId,
      timeoutMs: MODERATION_TIMEOUT_MS,
      operation,
    }),
    "CUSTOMER_MESSAGE",
  );
  if (result.decision !== "ALLOW") return null;
  return {
    id: routingAssessmentId(),
    hash: sha256(text),
    policyVersion: moderationConfig().policyVersion,
    requestedModel: operation.moderation.value.modelId,
    returnedModel: result.returnedModel!,
    operationRows: [
      ...(operation.moderation.rowId
        ? [
            {
              id: operation.moderation.rowId,
              version: operation.moderation.version,
            },
          ]
        : []),
      { id: provider.id, version: provider.version },
    ],
    categories: result.categories ?? {},
    scores: result.scores ?? {},
    providerRequestId: result.requestId,
  };
}
const defaults: RoutingRuntimeDependencies = {
  audio: prepareRoutingAudio,
  readPolicy: readRoutingPolicy,
  currentPolicy: assertCurrentRoutingPolicy,
  classify: async (input, policy) =>
    classifyRouting(input, policy, {
      credentialResolver: createOpenRouterCredentialResolver({
        db: prisma,
        keyring: await readCanonicalCredentialKeyring(),
      }),
    }),
  moderate: moderateRoutingText,
  readPrompt: readRoutingPrompt,
  sendPrompt: sendRoutingPrompt,
  senderSnapshot: readDispatchSenderSnapshot,
  shopActive: (id) =>
    shopExecutionEligibilityService.isShopExecutionActive(id, "recovery"),
};
const terminal = (state: string) =>
  ["RESOLVED", "EXPIRED", "IGNORED"].includes(state);
export class RoutingRuntime {
  private readonly dependencies: RoutingRuntimeDependencies;
  constructor(
    private readonly db: PrismaClient = prisma,
    dependencies: Partial<RoutingRuntimeDependencies> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dependencies = { ...defaults, ...dependencies };
  }
  async receivingScope(
    event: WhatsAppInboundEvent,
  ): Promise<SenderHandoff | null> {
    const recipient = event.customerPhone.replace(/^\+/, "");
    const [thread] = await this.db.$queryRawUnsafe<SenderHandoff[]>(
      `SELECT t.id AS "threadId",NULL::text AS "routeId",t."canonicalRecipient",t."providerPhoneNumberId",s."providerAccountId" FROM whatsapp."RecoverySenderThread" t JOIN whatsapp."WhatsAppPoolSender" s ON s."providerPhoneNumberId"=t."providerPhoneNumberId" WHERE t."canonicalRecipient"=$1 AND t."providerPhoneNumberId"=$2 AND s."providerAccountId"=$3 AND t."closedAt" IS NULL`,
      recipient,
      event.providerPhoneNumberId,
      event.providerAccountId,
    );
    return thread ?? null;
  }
  async accept(
    event: WhatsAppInboundEvent,
    scope: SenderHandoff,
    enqueue: (id: string, version: number) => Promise<unknown>,
  ) {
    const route = scope.routeId
      ? await this.db.recoverySenderRoute.findUnique({
          where: { id: scope.routeId },
          select: { shopId: true },
        })
      : null;
    const policy = await this.dependencies.readPolicy(this.db, {
      environment: resolveDeploymentEnvironmentName(),
      ...(route ? { verifiedShopId: route.shopId } : {}),
    });
    const persisted = await persistRoutingHandoff(
      this.db,
      event,
      scope,
      policy,
      this.now(),
    );
    if (persisted.kind !== "persisted") return persisted;
    return this.process(persisted.turn.inboundProviderMessageId, enqueue);
  }
  async process(
    id: string,
    enqueue: (id: string, version: number) => Promise<unknown>,
  ) {
    const now = this.now();
    const row = await this.db.recoveryBasketRoutingTurn.findUnique({
      where: { inboundProviderMessageId: id },
      include: { thread: { include: { sender: true } } },
    });
    if (!row || terminal(row.state)) return { kind: "terminal" as const };
    if (row.expiresAt <= now) {
      await this.expire(id, now);
      return { kind: "expired" as const };
    }
    if (row.promptAdmittedAt) return { kind: "prompt-pending" as const };
    const route = row.routeId
      ? await this.db.recoverySenderRoute.findUnique({
          where: { id: row.routeId },
          select: { shopId: true },
        })
      : null;
    const snapshotShop = (
      row.configurationSnapshot as {
        verifiedShopId?: string | null;
      } | null
    )?.verifiedShopId;
    const policy = await this.dependencies.readPolicy(this.db, {
      environment: resolveDeploymentEnvironmentName(),
      ...(snapshotShop ? { verifiedShopId: snapshotShop } : {}),
    });
    if (!policy)
      return { kind: "held" as const, reason: "routing-policy-unavailable" };
    // Initial snapshot remains immutable; model edits never reinterpret a captured request.
    if (
      fingerprint(policy.configurationSnapshot) !==
      fingerprint(row.configurationSnapshot)
    )
      return { kind: "held" as const, reason: "routing-policy-changed" };
    const token = randomUUID();
    const claimed = await this.db.recoveryBasketRoutingTurn.updateMany({
      where: {
        inboundProviderMessageId: id,
        state: "RECEIVED",
        OR: [{ workLeaseUntil: null }, { workLeaseUntil: { lte: now } }],
      },
      data: {
        workToken: token,
        workLeaseUntil: new Date(
          now.getTime() + policy.policy.budget.deadlineMs,
        ),
        repairAttempt: { increment: 1 },
        nextRepairAt: new Date(now.getTime() + policy.policy.retry.backoffMs),
      },
    });
    if (!claimed.count)
      return { kind: "held" as const, reason: "routing-worker-owned" };
    try {
      const scope: SenderHandoff = {
        threadId: row.threadId,
        routeId: row.routeId,
        canonicalRecipient: row.thread.canonicalRecipient,
        providerPhoneNumberId: row.thread.providerPhoneNumberId,
        providerAccountId: row.thread.sender.providerAccountId,
      };
      const complete = await readRoutingCandidates(this.db, scope, now);
      let candidates =
        (row.candidatesJson as unknown as RoutingCandidate[] | null) ??
        complete;
      if (fingerprint(candidates) !== fingerprint(complete))
        return { kind: "held" as const, reason: "routing-candidates-changed" };
      if (!row.moderationJson) {
        const event = row.inputJson as unknown as WhatsAppInboundEvent;
        const sourceHash =
          event.content.type === "audio"
            ? await readRoutingAudioSourceHash(this.db, id)
            : null;
        if (event.content.type === "audio" && !sourceHash)
          return {
            kind: "held" as const,
            reason: "routing-audio-source-unavailable",
          };
        const audio =
          event.content.type === "audio"
            ? await this.dependencies.audio(event, scope, sourceHash!)
            : null;
        const inputText =
          event.content.type === "text"
            ? event.content.text
            : (audio?.text ?? null);
        if (inputText === null)
          return {
            kind: "held" as const,
            reason: "routing-content-unavailable",
          };
        const assessment = await this.dependencies.moderate(inputText);
        if (!assessment)
          return {
            kind: "held" as const,
            reason: "routing-current-moderation-not-allowed",
          };
        const frozen = {
          schemaVersion: 1,
          current: assessment,
          ...(audio ? { audioTranscript: audio } : {}),
        };
        const captured = await this.db.recoveryBasketRoutingTurn.updateMany({
          where: {
            inboundProviderMessageId: id,
            workToken: token,
            moderationJson: { equals: Prisma.DbNull },
          },
          data: { moderationJson: frozen as unknown as Prisma.InputJsonValue },
        });
        if (!captured.count)
          return {
            kind: "held" as const,
            reason: "routing-moderation-already-captured",
          };
        row.moderationJson = frozen as unknown as Prisma.JsonValue;
      }
      const capturedAudio = routingAudioOf(row);
      if (
        capturedAudio &&
        capturedAudio.provenance.sourceSha256 !==
          (await readRoutingAudioSourceHash(this.db, id))
      )
        return {
          kind: "held" as const,
          reason: "routing-audio-source-changed",
        };
      const text = textOf(row);
      const currentAssessment = (
        row.moderationJson as unknown as {
          current: RoutingAllowedAssessment;
        }
      ).current;
      if (
        text === null ||
        !currentAssessment ||
        currentAssessment.hash !== sha256(text)
      )
        return {
          kind: "held" as const,
          reason: "routing-current-moderation-invalid",
        };
      const prompts = await this.confirmedPrompts(row, text);
      let classification: RoutingClassification = {
        role: "CLARIFY",
        confidence: 100,
        originalTurnId: null,
        promptTurnId: null,
        confirmedPromptProviderMessageId: null,
        selectedConversationId: null,
        selectedRouteId: null,
        offeredOptionKey: null,
        newQuestionClause: null,
      };
      let parentId: string | null = null,
        chosenRoute: string | null = row.routeId;
      const priorDecision = row.routingDecision as FrozenRoutingDecision | null;
      const overLimit =
        candidates.length > policy.policy.input.maxCandidates ||
        JSON.stringify({ candidates, text }).length >
          policy.policy.input.maxInputCharacters;
      if (!priorDecision && text && !overLimit) {
        if (!route) {
          // Only exact frozen offered keys may prove a shop. No model or catalogue is read here.
          const matches = prompts.flatMap((p) => {
            const offered = p.candidatesJson as unknown as
              RoutingCandidate[] | null;
            const options = [...new Set(offered?.map((c) => c.routeId) ?? [])];
            return options
              .map((key, index) => ({ key, option: String(index + 1) }))
              .filter(
                ({ option }) =>
                  text.trim() === option ||
                  text.trim() === `${p.inboundProviderMessageId}:${option}`,
              )
              .map(({ key }) => ({ p, key }));
          });
          if (matches.length === 1) {
            parentId =
              matches[0]!.p.parentProviderMessageId ??
              matches[0]!.p.inboundProviderMessageId;
            chosenRoute = matches[0]!.key;
            classification = {
              ...classification,
              originalTurnId: parentId,
              promptTurnId: matches[0]!.p.inboundProviderMessageId,
              confirmedPromptProviderMessageId:
                matches[0]!.p.promptProviderMessageId,
              selectedRouteId: chosenRoute,
            };
            candidates = await readRoutingCandidates(
              this.db,
              { ...scope, routeId: chosenRoute },
              now,
            );
          }
        } else {
          if (!row.candidatesJson)
            await this.db.recoveryBasketRoutingTurn.updateMany({
              where: {
                inboundProviderMessageId: id,
                workToken: token,
                candidatesJson: { equals: Prisma.DbNull },
              },
              data: {
                candidatesJson: candidates as unknown as Prisma.InputJsonValue,
              },
            });
          const result = await this.dependencies.classify(
            {
              currentTurnId: id,
              text,
              verifiedShopId: route.shopId,
              candidates,
              prompts: prompts.map((p) => this.promptEvidence(p)),
              history: await this.routingHistory(prompts),
            },
            policy,
          );
          if (result.kind === "decision") {
            classification = result.decision;
            parentId = classification.originalTurnId;
            if (
              classification.role === "SELECT_ONLY" ||
              classification.role === "SELECT_AND_QUESTION"
            ) {
              const offeredPrompt = prompts.find(
                (prompt) =>
                  prompt.inboundProviderMessageId ===
                  classification.promptTurnId,
              );
              if (
                !offeredPrompt ||
                fingerprint(offeredPrompt.candidatesJson) !==
                  fingerprint(candidates)
              )
                classification = {
                  ...classification,
                  role: "CLARIFY",
                  selectedConversationId: null,
                  selectedRouteId: null,
                  offeredOptionKey: null,
                  newQuestionClause: null,
                };
            }
          }
        }
      }
      if (priorDecision) {
        parentId = priorDecision.originalTurnId;
        classification = {
          ...classification,
          role: priorDecision.role,
          selectedConversationId:
            priorDecision.selectedAssignmentConversationId,
          offeredOptionKey: priorDecision.offeredOptionKey,
          newQuestionClause: priorDecision.clause,
        };
      }
      if (!row.candidatesJson)
        await this.db.recoveryBasketRoutingTurn.updateMany({
          where: {
            inboundProviderMessageId: id,
            workToken: token,
            candidatesJson: { equals: Prisma.DbNull },
          },
          data: {
            candidatesJson: candidates as unknown as Prisma.InputJsonValue,
          },
        });
      const original = parentId
        ? await this.db.recoveryBasketRoutingTurn.findUnique({
            where: { inboundProviderMessageId: parentId },
          })
        : row;
      if (
        !original ||
        original.threadId !== row.threadId ||
        original.resolvedAt
      )
        return {
          kind: "held" as const,
          reason: "routing-original-unavailable",
        };
      const originalText = textOf(original) ?? "";
      let assessment = priorDecision?.assessments as unknown as
        | {
            original: RoutingAllowedAssessment;
            current: RoutingAllowedAssessment;
            clause?: RoutingAllowedAssessment;
          }
        | undefined;
      if (!assessment) {
        const originalAssessment = parentId
          ? (
              original.moderationJson as unknown as {
                current?: RoutingAllowedAssessment;
              } | null
            )?.current
          : currentAssessment;
        if (
          !originalAssessment ||
          originalAssessment.hash !== sha256(originalText)
        )
          return {
            kind: "held" as const,
            reason: "routing-original-moderation-invalid",
          };
        const clause = classification.newQuestionClause
          ? text.slice(
              classification.newQuestionClause.start,
              classification.newQuestionClause.end,
            )
          : null;
        const clauseAssessment = clause
          ? await this.dependencies.moderate(clause)
          : null;
        if (clause && !clauseAssessment)
          return {
            kind: "held" as const,
            reason: "routing-clause-not-allowed",
          };
        assessment = {
          original: originalAssessment,
          current: currentAssessment,
          ...(clauseAssessment
            ? {
                clause:
                  clauseAssessment.hash === currentAssessment.hash
                    ? currentAssessment
                    : clauseAssessment,
              }
            : {}),
        };
      }
      const selected = candidates.find(
        (c) => c.conversationId === classification.selectedConversationId,
      );
      // A shop-selection child holds Q1's star parent and presents a basket prompt; no original admission yet.
      const promptCandidates = candidates;
      const shopLabels = new Map(
        candidates.map((c) => [
          c.shopId,
          (
            c.facts as {
              shopLabel?: string;
            } | null
          )?.shopLabel ?? c.shopId,
        ]),
      );
      const body = overLimit
        ? "I cannot safely identify the basket from all the available choices. Please reply with the shop name and the items in the basket you mean."
        : chosenRoute || route
          ? promptCandidates
              .map(
                (c, index) =>
                  `${index + 1}. ${row.inboundProviderMessageId}:${c.optionKey} ${JSON.stringify(c.facts)}`,
              )
              .join("\n")
          : [...new Set(candidates.map((c) => c.routeId))]
              .map(
                (key, index) =>
                  `${row.inboundProviderMessageId}:${index + 1} ${shopLabels.get(candidates.find((c) => c.routeId === key)!.shopId) ?? key}`,
              )
              .join("\n");
      const frozenCandidates = candidates;
      const activeSlot =
        await this.db.whatsAppConversationWrapperActiveSlot.findUnique({
          where: { audience: "ROUTER" },
          select: { definition: { select: { sourceLanguageTag: true } } },
        });
      if (!activeSlot)
        return {
          kind: "held" as const,
          reason: "routing-template-unavailable",
        };
      const prepared = await this.dependencies.readPrompt(this.db, {
        languageTag: activeSlot.definition.sourceLanguageTag,
        responseBody: body || id,
      });
      if (!prepared)
        return {
          kind: "held" as const,
          reason: "routing-template-unavailable",
        };
      if (
        priorDecision &&
        fingerprint(priorDecision.template) !==
          fingerprint(this.templateEvidence(prepared))
      )
        return { kind: "held" as const, reason: "routing-template-changed" };
      const decision: FrozenRoutingDecision = priorDecision ?? {
        schemaVersion: 1,
        role: classification.role,
        currentInboundProviderMessageId: id,
        originalTurnId: parentId,
        originalInboundProviderMessageId: parentId,
        promptTurnId: classification.promptTurnId,
        confirmedPromptProviderMessageId:
          classification.confirmedPromptProviderMessageId,
        selectedAssignmentConversationId: selected?.conversationId ?? null,
        offeredOptionKey: classification.offeredOptionKey,
        candidateFingerprint: fingerprint(frozenCandidates),
        originalTextSha256: sha256(originalText),
        currentTextSha256: sha256(text ?? ""),
        associatedMessages: {
          originalMessageId: routingMessageId(
            original.inboundProviderMessageId,
          ),
          currentMessageId: routingMessageId(id),
        },
        clause:
          classification.newQuestionClause && text
            ? {
                ...classification.newQuestionClause,
                sha256: sha256(
                  text.slice(
                    classification.newQuestionClause.start,
                    classification.newQuestionClause.end,
                  ),
                ),
              }
            : null,
        controlRevision: selected?.controlRevision ?? null,
        configuration: policy.configurationSnapshot,
        assessments: assessment as unknown as Prisma.InputJsonObject,
        audioCurrent:
          (routingAudioOf(row)
            ?.provenance as unknown as Prisma.InputJsonValue) ?? null,
        audioOriginal:
          (routingAudioOf(original)
            ?.provenance as unknown as Prisma.InputJsonValue) ?? null,
        moderation: {
          original: {
            id: assessment.original.id,
            hash: assessment.original.hash,
          },
          current: {
            id: parentId ? assessment.current!.id : assessment.original.id,
            hash: parentId
              ? assessment.current!.hash
              : assessment.original.hash,
          },
          clause: assessment.clause
            ? { id: assessment.clause.id, hash: assessment.clause.hash }
            : null,
        },
        template: this.templateEvidence(prepared),
        decidedAt: now.toISOString(),
      };
      const current = async (tx: Prisma.TransactionClient) => {
        await this.dependencies.currentPolicy(tx, policy);
        const lease = await tx.recoveryBasketRoutingTurn.findUnique({
          where: { inboundProviderMessageId: id },
          select: { workToken: true, workLeaseUntil: true },
        });
        const currentCandidates = await readRoutingCandidates(
          tx as unknown as PrismaClient,
          { ...scope, routeId: chosenRoute },
          this.now(),
        );
        if (fingerprint(currentCandidates) !== fingerprint(frozenCandidates))
          return false;
        return (
          lease?.workToken === token &&
          lease.workLeaseUntil !== null &&
          lease.workLeaseUntil > this.now() &&
          (await assertCurrentRoutingTemplate(tx, prepared))
        );
      };
      if (!priorDecision) {
        const frozen = await freezeRoutingDecision(
          this.db,
          id,
          {
            decision,
            candidates: frozenCandidates,
            moderation: row.moderationJson as Prisma.InputJsonValue,
            parentId,
            routeId: chosenRoute,
          },
          current,
        );
        if (fingerprint(frozen.routingDecision) !== fingerprint(decision))
          return {
            kind: "held" as const,
            reason: "routing-decision-already-frozen",
          };
      }
      if (
        decision.role !== "CLARIFY" &&
        decision.selectedAssignmentConversationId
      ) {
        if (!selected || !(await this.dependencies.shopActive(selected.shopId)))
          return { kind: "held" as const, reason: "shop-inactive" };
        const admitted = await admitRoutingDecision(
          this.db,
          id,
          assessment,
          current,
          now,
        );
        if (admitted.kind === "admitted")
          await enqueue(admitted.conversationId, admitted.version);
        return admitted;
      }
      return await this.dependencies.sendPrompt(this.db, {
        turnId: id,
        prompt: prepared,
        senderSnapshot: await this.dependencies.senderSnapshot(),
        deadlineMs: policy.policy.budget.deadlineMs,
        moderationHash: fingerprint(row.moderationJson),
        configurationCurrent: current,
        workToken: token,
        now,
      });
    } finally {
      await this.db.recoveryBasketRoutingTurn.updateMany({
        where: { inboundProviderMessageId: id, workToken: token },
        data: { workToken: null, workLeaseUntil: null },
      });
    }
  }
  private async routingHistory(prompts: RecoveryBasketRoutingTurn[]) {
    const history: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];
    for (const prompt of prompts) {
      const originalId =
        prompt.parentProviderMessageId ?? prompt.inboundProviderMessageId;
      const original = await this.db.recoveryBasketRoutingTurn.findUnique({
        where: { inboundProviderMessageId: originalId },
      });
      const text = original ? textOf(original) : null;
      if (text !== null) history.push({ role: "user", content: text });
      if (prompt.promptText)
        history.push({ role: "assistant", content: prompt.promptText });
    }
    return history;
  }
  private templateEvidence(p: PreparedRoutingPrompt) {
    return {
      definitionId: p.definitionId,
      localeId: p.localeId,
      languageTag: p.languageTag,
      sourceHash: p.sourceHash,
      contentHash: p.contentHash,
      slotEditVersion: p.slotEditVersion,
      preparedHash: p.preparedHash,
    };
  }
  private promptEvidence(p: RecoveryBasketRoutingTurn): RoutingPromptEvidence {
    const candidates = p.candidatesJson as unknown as RoutingCandidate[];
    return {
      turnId: p.inboundProviderMessageId,
      originalTurnId: p.parentProviderMessageId ?? p.inboundProviderMessageId,
      confirmedProviderMessageId: p.promptProviderMessageId!,
      candidateFingerprint: fingerprint(candidates),
      requestToken: p.inboundProviderMessageId,
      optionKeys: candidates.map((c) => c.optionKey),
    };
  }
  private async confirmedPrompts(row: RecoveryBasketRoutingTurn, text: string) {
    const input = row.inputJson as unknown as WhatsAppInboundEvent;
    const prompts = await this.db.recoveryBasketRoutingTurn.findMany({
      where: {
        threadId: row.threadId,
        resolvedAt: null,
        state: "PROMPT_ADMITTED",
        promptSentAt: { not: null },
        promptProviderMessageId: { not: null },
        expiresAt: { gt: this.now() },
        ...(input.contextMessageId
          ? { promptProviderMessageId: input.contextMessageId }
          : row.routeId
            ? { promptScopeRouteId: row.routeId }
            : {}),
      },
      orderBy: { inboundProviderMessageId: "asc" },
    });
    // A quoted provider ID proves neither the merchant nor the original request's owner.
    // Scope *before* constructing model history, including on the quoted-ID path.
    const scoped: RecoveryBasketRoutingTurn[] = [];
    for (const prompt of prompts) {
      if (row.routeId) {
        if (
          prompt.routeId !== row.routeId ||
          (prompt.promptScopeRouteId !== row.routeId &&
            prompt.promptScopeRouteId !== null)
        )
          continue;
      } else if (prompt.routeId !== null || prompt.promptScopeRouteId !== null)
        continue;
      const originalId =
        prompt.parentProviderMessageId ?? prompt.inboundProviderMessageId;
      const original = await this.db.recoveryBasketRoutingTurn.findUnique({
        where: { inboundProviderMessageId: originalId },
      });
      // The original Q1 may be neutral even after its direct child Q2
      // becomes shop-bound. Never accept a parent owned by another shop.
      if (
        !original ||
        original.threadId !== row.threadId ||
        (original.routeId !== null && original.routeId !== row.routeId)
      )
        continue;
      if (
        original.routeId === null &&
        prompt.parentProviderMessageId !== null &&
        prompt.promptScopeRouteId !== row.routeId
      )
        continue;
      scoped.push(prompt);
    }
    const explicit = scoped.filter((p) =>
      text.includes(p.inboundProviderMessageId + ":"),
    );
    return explicit.length ? explicit : scoped;
  }
  async expire(id: string, now = this.now()) {
    return this.db.recoveryBasketRoutingTurn.updateMany({
      where: {
        inboundProviderMessageId: id,
        state: { in: ["RECEIVED", "PROMPT_ADMITTED", "PROMPT_UNKNOWN"] },
        expiresAt: { lte: now },
      },
      data: { ...scrubRoutingPayload, state: "EXPIRED" },
    });
  }
  async repairPass(enqueue: (id: string, version: number) => Promise<unknown>) {
    const now = this.now();
    // Privacy expiry cannot depend on a currently enabled AI policy.
    await this.db.recoveryBasketRoutingTurn.updateMany({
      where: {
        state: { in: ["RECEIVED", "PROMPT_ADMITTED", "PROMPT_UNKNOWN"] },
        expiresAt: { lte: now },
      },
      data: { ...scrubRoutingPayload, state: "EXPIRED" },
    });
    const policy = await this.dependencies.readPolicy(this.db, {
      environment: resolveDeploymentEnvironmentName(),
    });
    if (!policy) return;
    const rows = await this.db.recoveryBasketRoutingTurn.findMany({
      where: {
        state: { in: ["RECEIVED", "PROMPT_ADMITTED", "PROMPT_UNKNOWN"] },
        OR: [
          { expiresAt: { lte: now } },
          {
            state: "RECEIVED",
            nextRepairAt: { lte: now },
            repairAttempt: { lt: policy.policy.retry.maxAttempts },
          },
        ],
      },
      orderBy: { inboundProviderMessageId: "asc" },
      take: policy.policy.input.maxCandidates,
    });
    for (const row of rows) {
      if (row.expiresAt <= now)
        await this.expire(row.inboundProviderMessageId, now);
      else await this.process(row.inboundProviderMessageId, enqueue);
    }
  }
}
export const routingRuntime = new RoutingRuntime();
