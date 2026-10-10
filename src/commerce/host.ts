import { isStableLanguageSignal } from "../services/conversation-language.service.js";
import { renderStoreReferral } from "./referral.js";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  canonicalJson,
  CommerceTurnIdentitySchema,
  finalResponseSchema,
  type CommerceToolResult,
  verifyResponseContract,
} from "@modainteract/moda-interact-shared/commerce";
import {
  runCommerceTurn,
  type CommerceModelInvoker,
} from "@modainteract/moda-interact-shared/commerce/runner";
import prisma from "../lib/db.js";
import type {
  CommerceAgentResult,
  RecoveryAgentContext,
} from "../agents/types.js";
import {
  CommerceHostError,
  CommerceMcpClient,
  mcpConfiguration,
  type McpConfiguration,
} from "./mcp-client.js";
import { hostDiagnostic, logCommerceHostFailure } from "./host-diagnostics.js";
import {
  logCommerceModelBridgeMilestone,
  observeCommerceModelBridgePhase,
} from "./model-bridge-diagnostics.js";
import {
  digest,
  readGrant,
  persistGrant,
  validateRelease,
  manifestMatchesGrant,
} from "./grants.js";
import { RECOVERY_INSTRUCTIONS } from "./recovery-instructions.js";
import { resolveCommerceEnvironment } from "./model-environment.js";
import {
  extractTrustedEvidence,
  recordEvidenceRefreshOutcome,
  TurnEvidenceRegistry,
  type EvidenceExtractor,
} from "./evidence.js";

export type HostDependencies = {
  model: CommerceModelInvoker;
  logger?: StructuredLogger;
  modelSelection?: {
    selectionSource: string;
    selectionShopId: string | null;
    merchantPricingPlanId: string | null;
    shopifyPlanHandle: string | null;
  };
  config?: McpConfiguration;
  signal?: AbortSignal;
  extractEvidence?: EvidenceExtractor;
};
export async function executeCommerceHost(
  context: RecoveryAgentContext,
  deps: HostDependencies,
): Promise<CommerceAgentResult> {
  try {
    return await execute(context, deps);
  } catch (error) {
    const failure = error instanceof CommerceHostError ? error
      : deps.signal?.aborted
        ? new CommerceHostError("CANCELLED", false,
          hostDiagnostic("host.lifecycle", "HOST_CANCELLED"), error)
        : error instanceof Error && error.name === "TimeoutError"
          ? new CommerceHostError("DEADLINE", true,
            hostDiagnostic("host.lifecycle", "HOST_DEADLINE_EXCEEDED"), error)
          : new CommerceHostError("UNAVAILABLE", true,
            hostDiagnostic("host.lifecycle", "HOST_UNEXPECTED_FAILURE", { cause: error }), error);
    // This is an internal operational record only. No customer payload, raw
    // exception message, grant, credentials or MCP response is logged.
    try {
      const logger = deps.logger ?? createLogger({
        serviceName: "moda-messaging-worker",
        environment: resolveCommerceEnvironment(),
      });
      logCommerceHostFailure(logger, failure.code, failure.retryable,
        failure.diagnostic ?? hostDiagnostic("host.lifecycle", "HOST_UNEXPECTED_FAILURE"), {
          shopId: context.shopId,
          recoveryId: context.recovery.id,
          conversationId: context.conversation.conversationId,
          inboundVersion: context.conversation.version,
        });
    } catch { /* Failure reporting must not modify the underlying outcome. */ }
    throw failure;
  }
}
async function execute(
  context: RecoveryAgentContext,
  deps: HostDependencies,
): Promise<CommerceAgentResult> {
  const started = Date.now();
  const signal = AbortSignal.any([
    AbortSignal.timeout(90_000),
    ...(deps.signal ? [deps.signal] : []),
  ]);
  const current = await prisma.conversation.findUnique({
    where: { id: context.conversation.conversationId },
    include: {
      checkoutRecovery: {
        include: {
          shop: { select: { id: true, domain: true } },
          customer: { select: { firstName: true } },
        },
      },
    },
  });
  const recovery = current?.checkoutRecovery;
  if (!current) throw new CommerceHostError("DENIED", false,
    hostDiagnostic("host.authorization", "HOST_CONVERSATION_MISSING"));
  if (!recovery) throw new CommerceHostError("DENIED", false,
    hostDiagnostic("host.authorization", "HOST_RECOVERY_MISSING"));
  if (recovery.id !== context.recovery.id) throw new CommerceHostError("DENIED", false,
    hostDiagnostic("host.authorization", "HOST_RECOVERY_MISMATCH"));
  if (["standalone", "product-only"].includes(recovery.id))
    throw new CommerceHostError("DENIED", false,
      hostDiagnostic("host.authorization", "HOST_RECOVERY_UNSUPPORTED"));
  if (recovery.shopId !== context.shopId) throw new CommerceHostError("DENIED", false,
    hostDiagnostic("host.authorization", "HOST_SHOP_ID_MISMATCH"));
  if (recovery.shop.domain !== context.shop) throw new CommerceHostError("DENIED", false,
    hostDiagnostic("host.authorization", "HOST_SHOP_DOMAIN_MISMATCH"));
  if (current.inboundVersion !== context.conversation.version ||
    current.processingInboundVersion !== current.inboundVersion)
    throw new CommerceHostError("STALE_TURN", false,
      hostDiagnostic("host.turn_state", "HOST_VERSION_STALE"));
  if (!current.processingStartedAt) throw new CommerceHostError("STALE_TURN", false,
    hostDiagnostic("host.turn_state", "HOST_PROCESSING_LEASE_MISSING"));
  if (Date.now() - current.processingStartedAt.getTime() >= 120_000)
    throw new CommerceHostError("STALE_TURN", false,
      hostDiagnostic("host.turn_state", "HOST_PROCESSING_LEASE_EXPIRED"));
  const turn = CommerceTurnIdentitySchema.parse({
    contractVersion: "commerce.v1",
    shopId: recovery.shopId,
    checkoutRecoveryId: recovery.id,
    conversationId: current.id,
    inboundVersion: current.inboundVersion,
  });
  const logger = deps.logger ?? createLogger({
    serviceName: "moda-messaging-worker",
    environment: resolveCommerceEnvironment(),
  });
  const config = deps.config ?? mcpConfiguration();
  let grant: Awaited<ReturnType<typeof readGrant>>;
  try { grant = await readGrant(turn); }
  catch (error) {
    if (error instanceof CommerceHostError && error.diagnostic) throw error;
    throw new CommerceHostError(error instanceof CommerceHostError ? error.code : "UNAVAILABLE",
      error instanceof CommerceHostError ? error.retryable : true,
      hostDiagnostic("host.grant", error instanceof CommerceHostError && error.code === "DENIED"
        ? "HOST_AUTHORIZATION_DENIED" : "HOST_GRANT_READ_FAILED"), error);
  }
  if (!grant) {
    const resolver = new CommerceMcpClient(config, turn, signal);
    try {
      await resolver.connect();
      try { grant = await persistGrant(turn, await resolver.manifest()); }
      catch (error) {
        if (error instanceof CommerceHostError && error.diagnostic) throw error;
        throw new CommerceHostError(error instanceof CommerceHostError ? error.code : "UNAVAILABLE",
          error instanceof CommerceHostError ? error.retryable : true,
          hostDiagnostic("host.grant", "HOST_GRANT_PERSIST_FAILED"), error);
      }
    } finally {
      await resolver.close();
    }
  }
  const client = new CommerceMcpClient(config, turn, signal, grant);
  const evidence = new TurnEvidenceRegistry({
    turn,
    grantId: grant.id,
    releaseId: grant.releaseId,
  });
  const extractEvidence = deps.extractEvidence ?? extractTrustedEvidence;
  try {
    await client.connect();
    const manifest = await client.manifest();
    if (!manifestMatchesGrant(manifest, grant))
      throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
        hostDiagnostic("host.grant", "HOST_MANIFEST_GRANT_MISMATCH"));
    try { await validateRelease(manifest); }
    catch (error) {
      if (error instanceof CommerceHostError && error.diagnostic) throw error;
      throw new CommerceHostError(error instanceof CommerceHostError ? error.code : "UNAVAILABLE",
        error instanceof CommerceHostError ? error.retryable : true,
        hostDiagnostic("host.release", "HOST_RELEASE_VALIDATION_FAILED"), error);
    }
    const descriptors = [
      ...new Map(
        manifest.capabilities.map((capability) => [
          capability.toolDescriptor.name,
          capability.toolDescriptor,
        ]),
      ).values(),
    ];
    let runnerHostFailure: CommerceHostError | undefined;
    const retain = (failure: CommerceHostError) => {
      runnerHostFailure = failure;
      return failure;
    };
    const observeMcp = async <T>(action: () => Promise<T>): Promise<T> => {
      try { return await action(); }
      catch (error) {
        if (error instanceof CommerceHostError) retain(error);
        throw error;
      }
    };
    const assertCurrent = async () => {
      if (deps.signal?.aborted) throw retain(new CommerceHostError("CANCELLED", false,
        hostDiagnostic("host.lifecycle", "HOST_CANCELLED")));
      signal.throwIfAborted();
      const state = await prisma.conversation.findUnique({
        where: { id: current.id },
        select: {
          inboundVersion: true,
          processingInboundVersion: true,
          processingStartedAt: true,
        },
      }).catch((error: unknown) => {
        throw retain(new CommerceHostError("UNAVAILABLE", true,
          hostDiagnostic("host.turn_state", "HOST_STATE_LOOKUP_FAILED"), error));
      });
      if (!state || state.inboundVersion !== turn.inboundVersion ||
        state.processingInboundVersion !== turn.inboundVersion)
        throw retain(new CommerceHostError("STALE_TURN", false,
          hostDiagnostic("host.turn_state", "HOST_VERSION_STALE")));
      if (!state.processingStartedAt)
        throw retain(new CommerceHostError("STALE_TURN", false,
          hostDiagnostic("host.turn_state", "HOST_PROCESSING_LEASE_MISSING")));
      if (Date.now() - state.processingStartedAt.getTime() >= 120_000)
        throw retain(new CommerceHostError("STALE_TURN", false,
          hostDiagnostic("host.turn_state", "HOST_PROCESSING_LEASE_EXPIRED")));
    };
    const available = async (requestSignal = signal) => {
      await assertCurrent();
      const listed = await observeMcp(() => client.tools(requestSignal));
      for (const entry of listed) {
        const descriptor = descriptors.find((d) => d.name === entry.name);
        const expectedGrant = descriptor && grant.grantedTools.find(
          (candidate) =>
            candidate.toolId === descriptor.toolId &&
            candidate.toolRevisionId === descriptor.toolRevisionId &&
            candidate.toolName === descriptor.name &&
            candidate.definitionVersion === descriptor.definitionVersion,
        );
        if (!descriptor) throw retain(new CommerceHostError("DENIED", false,
          hostDiagnostic("host.authorization", "HOST_TOOL_NOT_GRANTED")));
        if (!expectedGrant) throw retain(new CommerceHostError("DENIED", false,
          hostDiagnostic("host.authorization", "HOST_TOOL_GRANT_MISMATCH")));
        if (canonicalJson(entry) !== canonicalJson({
          name: descriptor.name,
          description: descriptor.description,
          inputSchema: descriptor.inputSchema,
        })) throw retain(new CommerceHostError("DENIED", false,
          hostDiagnostic("host.authorization", "HOST_TOOL_DESCRIPTOR_CHANGED")));
      }
      if (new Set(listed.map((t) => t.name)).size !== listed.length)
        throw retain(new CommerceHostError("INVALID_INPUT", false,
          hostDiagnostic("mcp.tool_list", "HOST_TOOL_LIST_DUPLICATE")));
      return new Set(listed.map((t) => t.name));
    };
    await available();
    const language = {
      tag: current.languageTag,
      source:
        current.languageSource === "CUSTOMER_EXPLICIT" ? null :
        current.languageSource?.toLowerCase().replaceAll("_", "-") ?? null,
    };
    const modelBridgeIdentifiers = {
      shopId: context.shopId,
      recoveryId: recovery.id,
      conversationId: current.id,
      inboundVersion: current.inboundVersion,
    };
    const result = await runCommerceTurn({
      turn,
      grant,
      manifest,
      signal,
      hostInstructions: RECOVERY_INSTRUCTIONS,
      context: {
        recovery: {
          id: recovery.id,
          status: recovery.status,
          checkoutToken: recovery.checkoutToken,
          totalPrice: recovery.totalPrice?.toString() ?? null,
          completedAt: recovery.completedAt?.toISOString() ?? null,
        },
        customer: { firstName: recovery.customer?.firstName ?? null },
        conversationType: current.type,
        resolvedConversationLanguage: language.tag,
        verifiedStoreDomain: recovery.shop.domain,
        currentMessages: context.conversation.messages,
      },
      history: context.conversation.history ?? [],
      // Legacy explicit-source rows remain readable, without imposing preference
      // precedence on recovery. Supply their retained tag as context instead.
      language: current.languageSource === "CUSTOMER_EXPLICIT" ? { tag: null, source: null } : language,
      budgets: { deadlineMs: Math.max(1, 90_000 - (Date.now() - started)) },
      dependencies: {
        model: {
          invoke: async (request, modelSignal) => {
            logCommerceModelBridgeMilestone(logger, modelBridgeIdentifiers, "turn_state_check");
            await observeCommerceModelBridgePhase(
              logger, modelBridgeIdentifiers, "turn_state_check", assertCurrent,
            );
            logCommerceModelBridgeMilestone(logger, modelBridgeIdentifiers, "production_model_invoke");
            const step = await observeCommerceModelBridgePhase(
              logger, modelBridgeIdentifiers, "production_model_invoke",
              () => deps.model.invoke(request, modelSignal),
            );
            return observeCommerceModelBridgePhase(
              logger, modelBridgeIdentifiers, "response_postprocess", async () => {
                if (step.calls.length !== 1 || step.calls[0]?.name !== "finalResponse")
                  return step;
                const responseContract = verifyResponseContract(
                  manifest.responseContract,
                  manifest.responseContractHash,
                  digest,
                );
                const parsed = finalResponseSchema(responseContract).safeParse(
                  step.calls[0].arguments,
                );
                if (
                  parsed.success &&
                  parsed.data.answerKind === "ANSWER" &&
                  parsed.data.evidenceIds.length > 0 &&
                  !evidence.hasEligibleEvidence(parsed.data.evidenceIds, Date.now())
                ) {
                  return {
                    ...step,
                    calls: [
                      {
                        name: "finalResponse",
                        arguments: {
                          ...parsed.data,
                          answerKind: "REFER_TO_STORE",
                          referralReason: "UNVERIFIABLE_FACTS",
                          evidenceIds: [],
                          details: {},
                        },
                      },
                    ],
                  };
                }
                return step;
              },
            );
          },
        },
        logger: logger.child({
          component: "commerce-agent-host",
          recoveryId: recovery.id,
          conversationId: current.id,
          modelSelectionSource: deps.modelSelection?.selectionSource ?? null,
          merchantPricingPlanId: deps.modelSelection?.merchantPricingPlanId ?? null,
          shopifyPlanHandle: deps.modelSelection?.shopifyPlanHandle ?? null,
        }),
        now: Date.now,
        digest,
        tools: descriptors.map((descriptor) => ({
          descriptor,
          isAuthorized: async (authorizedGrant, toolSignal) => {
            toolSignal.throwIfAborted();
            if (!(await available(toolSignal)).has(descriptor.name)) return false;
            return grant.grantedTools.some(
              (candidate) =>
                candidate.toolId === authorizedGrant.toolId &&
                candidate.toolRevisionId === authorizedGrant.toolRevisionId &&
                candidate.toolName === authorizedGrant.toolName &&
                candidate.definitionVersion === authorizedGrant.definitionVersion &&
                canonicalJson(candidate.capabilityKeys) ===
                  canonicalJson(authorizedGrant.capabilityKeys) &&
                candidate.toolId === descriptor.toolId &&
                candidate.toolRevisionId === descriptor.toolRevisionId &&
                candidate.toolName === descriptor.name &&
                candidate.definitionVersion === descriptor.definitionVersion,
            );
          },
          execute: async (args, toolSignal): Promise<CommerceToolResult> => {
            toolSignal.throwIfAborted();
            await assertCurrent();
            const result = await observeMcp(() => client.call(descriptor.name, args, toolSignal));
            evidence.record(descriptor, args, result, extractEvidence);
            return result;
          },
          extractEvidence,
        })),
      },
    });
    if (!result.ok) {
      if (
        signal.aborted &&
        signal.reason instanceof Error &&
        signal.reason.name === "TimeoutError"
      )
        throw new CommerceHostError("DEADLINE", true,
          hostDiagnostic("host.lifecycle", "HOST_DEADLINE_EXCEEDED"));
      const source = runnerHostFailure?.diagnostic;
      throw new CommerceHostError(result.error.code, result.error.retryable,
        source ? hostDiagnostic(source.stage, source.reasonCode, {
          ...(source.operation === undefined ? {} : { operation: source.operation }),
          ...(source.statusCode === undefined ? {} : { statusCode: source.statusCode }),
          cause: runnerHostFailure,
          ...(result.error.diagnostic ? { runnerDiagnostic: result.error.diagnostic } : {}),
        }) : hostDiagnostic("host.runner_result", "HOST_RUNNER_FAILURE", {
          ...(result.error.diagnostic ? { runnerDiagnostic: result.error.diagnostic } : {}),
        }));
    }
    signal.throwIfAborted();
    const latest = await prisma.conversation.findUnique({
      where: { id: current.id },
      select: {
        inboundVersion: true,
        processingInboundVersion: true,
        processingStartedAt: true,
      },
    });
    if (
      !latest ||
      latest.inboundVersion !== turn.inboundVersion ||
      latest.processingInboundVersion !== turn.inboundVersion ||
      !latest.processingStartedAt ||
      Date.now() - latest.processingStartedAt.getTime() >= 120_000
    )
      throw new CommerceHostError("STALE_TURN");
    let envelope = result.result;
    if (envelope.answerKind === "ANSWER" && envelope.evidenceIds.length > 0) {
      const refresh = await evidence.refresh(envelope.evidenceIds, {
        remoteCalls: result.usage.remoteCalls,
        maxRemoteCalls: 10,
        now: Date.now,
        assertCurrent,
        isCancelled: () => deps.signal?.aborted === true,
        replay: ({ name, arguments: args }) => client.call(name, args, signal),
        extractEvidence,
      });
      recordEvidenceRefreshOutcome(refresh);
      if (deps.signal?.aborted) throw new CommerceHostError("CANCELLED");
      await assertCurrent();
      if (refresh.kind === "suppress")
        throw new CommerceHostError(refresh.reason);
      if (refresh.kind === "refer")
        envelope = {
          ...envelope,
          answerKind: "REFER_TO_STORE",
          referralReason: "UNVERIFIABLE_FACTS",
          evidenceIds: [],
          details: {},
        };
    }
    // Recovery has no customer-preference setting. Preserve legacy storage values,
    // but do not impose their old precedence on this recovery-only runner.
    const languageMessage = context.conversation.messages
      .map((message) => message.content)
      .join("\n");
    const hasDetectionCandidate =
      envelope.detectedLanguageTag !== null ||
      envelope.detectedLanguageConfidence !== null;
    if (hasDetectionCandidate) {
      logger.debug("whatsapp.language.detection_received", {
        conversationId: current.id,
        observedVersion: turn.inboundVersion,
        currentLanguageTag: language.tag,
        detectedLanguageTag: envelope.detectedLanguageTag,
        detectedLanguageConfidence: envelope.detectedLanguageConfidence,
      });
    }
    if (!isStableLanguageSignal(languageMessage)) {
      if (hasDetectionCandidate) {
        logger.debug("whatsapp.language.detection_rejected", {
          conversationId: current.id,
          observedVersion: turn.inboundVersion,
          currentLanguageTag: language.tag,
          detectedLanguageTag: envelope.detectedLanguageTag,
          detectedLanguageConfidence: envelope.detectedLanguageConfidence,
          reason: "unstable-input",
        });
      }
      envelope.detectedLanguageTag = null;
      envelope.detectedLanguageConfidence = null;
    }
    // Custom details are intentionally not returned to the delivery adapter.
    return {
      answerKind: envelope.answerKind,
      referralReason: envelope.referralReason,
      evidenceIds: envelope.evidenceIds,
      replyText:
        envelope.answerKind === "REFER_TO_STORE"
          ? renderStoreReferral(
              recovery.shop.domain,
              language,
              context.conversation.messages,
              envelope,
            )
          : envelope.replyText,
      detectedLanguageTag: envelope.detectedLanguageTag,
      detectedLanguageConfidence: envelope.detectedLanguageConfidence,
    };
  } finally {
    await client.close();
  }
}
