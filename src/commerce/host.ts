import { PRODUCT_DISCOVERY_INSTRUCTION, shopVoiceInstruction } from "./product-discovery-instructions.js";
import { filterMerchantKnowledgeAvailability } from "./merchant-knowledge-availability.js";
import { conversationLanguageService } from "../services/conversation-language.service.js";
import { renderStoreReferral } from "./referral.js";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  canonicalJson,
  CommerceTurnIdentitySchema,
  finalResponseSchema,
  CommerceToolOutputs,
  productBelongsToDomain,
  isBuiltInTool,
  isTrustedCommerceBuiltInDescriptor,
  isTrustedCommerceBuiltInGrant,
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
import { loadRecommendationContext, refreshRecommendationContext, refreshRecommendationPolicy } from "./recommendations/context.js";
import { TurnRecommendationObservations } from "./recommendations/observations.js";
import { evaluateRecommendationDiscountInspection } from "./recommendations/observations.js";
import { readRecommendationSelection } from "./recommendations/disposition.js";
import { renderRecommendationReply, type RenderRecommendationProduct } from "./recommendations/render.js";
import { buildReplyCandidates } from "./recommendations/candidates.js";
import { planRecommendationRefreshes } from "./recommendations/revalidation.js";
import { decimalToMinorUnits, isValidDecimal, minorUnitsToDecimal, sumPurchaseSubtotal } from "./recommendations/money.js";
import { evaluatePurchaseDiscount, type DiscountEvaluationPurchase, type ObservedDiscount } from "./recommendations/eligibility.js";
import { selectCompatibleOffers } from "./recommendations/combinations.js";
import { selectFallbackRecommendation } from "./recommendations/fallback-selection.js";
import { selectShippingPresentation } from "./recommendations/shipping.js";
import { resolveModaConfigurationLocale } from "@modainteract/moda-interact-shared/internationalization";
import { resolveCommerceEnvironment } from "./model-environment.js";
import { assertLiveBudgetFitsLease, resolveLiveBudget, LiveBudgetPolicyError, type ResolvedLiveBudget } from "./live-budget.js";
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
  /** Host test fixture only. Production resolves from the trusted Shop on each invocation. */
  resolvedBudgetForTest?: ResolvedLiveBudget;
};

type HostProduct = NonNullable<ReturnType<typeof CommerceToolOutputs.commerce_get_product.parse>["product"]>;
type HostDiscountOptions = Extract<ReturnType<typeof CommerceToolOutputs.commerce_get_discount_options.parse>, { mode: string }>;
type HostDiscountDetails = Extract<ReturnType<typeof CommerceToolOutputs.commerce_get_discount_details.parse>, { details: unknown }>;

function isPermittedNativeSale(
  product: HostProduct,
  policy: { mode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE"; authorisedDiscountIds: readonly string[] },
): boolean {
  if (policy.mode === "NONE" || policy.mode === "FIXED" && policy.authorisedDiscountIds.length === 0 ||
      !product.currency || !product.unitPrice || !product.saleEvidence?.regularPrice ||
      !product.saleEvidence.salePrice || product.saleEvidence.salePrice !== product.unitPrice) return false;
  const regular = decimalToMinorUnits(product.saleEvidence.regularPrice, product.currency);
  const sale = decimalToMinorUnits(product.saleEvidence.salePrice, product.currency);
  const current = decimalToMinorUnits(product.unitPrice, product.currency);
  return regular !== null && sale !== null && current !== null && regular > sale && sale === current;
}

export async function executeCommerceHost(
  context: RecoveryAgentContext,
  deps: HostDependencies,
): Promise<CommerceAgentResult> {
  try {
    return await execute(context, deps);
  } catch (error) {
    const failure = error instanceof CommerceHostError ? error
      : error instanceof LiveBudgetPolicyError
        ? new CommerceHostError("UNAVAILABLE", false,
          hostDiagnostic("host.lifecycle", "HOST_LIVE_POLICY_REJECTED"), error)
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
        }, error);
    } catch { /* Failure reporting must not modify the underlying outcome. */ }
    throw failure;
  }
}
async function execute(
  context: RecoveryAgentContext,
  deps: HostDependencies,
): Promise<CommerceAgentResult> {
  const current = await prisma.conversation.findUnique({
    where: { id: context.conversation.conversationId },
    include: {
      checkoutRecovery: {
        include: {
          shop: { select: { id: true, domain: true, platform: true, brand: { select: { brandName: true } } } },
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
  if (current.controlMode !== "AI") throw new CommerceHostError("CANCELLED", false,
    hostDiagnostic("host.turn_state", "HOST_CANCELLED"));
  const capturedControlRevision = current.controlRevision;
  if (current.inboundVersion !== context.conversation.version ||
    current.processingInboundVersion !== current.inboundVersion)
    throw new CommerceHostError("STALE_TURN", false,
      hostDiagnostic("host.turn_state", "HOST_VERSION_STALE"));
  if (!current.processingStartedAt) throw new CommerceHostError("STALE_TURN", false,
    hostDiagnostic("host.turn_state", "HOST_PROCESSING_LEASE_MISSING"));
  if (Date.now() - current.processingStartedAt.getTime() >= 120_000)
    throw new CommerceHostError("STALE_TURN", false,
      hostDiagnostic("host.turn_state", "HOST_PROCESSING_LEASE_EXPIRED"));
  // Resolve LIVE policy once for this invocation, after trusted Shop and
  // processing-version checks. A later invocation may use updated policy;
  // no Redis key or persistent policy snapshot is created.
  let budget: ResolvedLiveBudget;
  try {
    if (deps.resolvedBudgetForTest) {
      budget = deps.resolvedBudgetForTest;
      if (budget.environment !== resolveCommerceEnvironment())
        throw new LiveBudgetPolicyError("TEST_BUDGET_ENVIRONMENT_MISMATCH");
      if (budget.shopId !== recovery.shopId || budget.conversationId !== current.id ||
        budget.recoveryId !== recovery.id || budget.inboundVersion !== current.inboundVersion)
        throw new LiveBudgetPolicyError("TEST_BUDGET_IDENTITY_MISMATCH");
    } else {
      budget = await resolveLiveBudget({
        db: prisma, environment: resolveCommerceEnvironment(),
        shopId: recovery.shopId, conversationId: current.id,
        recoveryId: recovery.id, inboundVersion: current.inboundVersion,
      });
    }
    assertLiveBudgetFitsLease(budget, current.processingStartedAt);
  } catch (error) {
    if (error instanceof LiveBudgetPolicyError) {
      try {
        (deps.logger ?? createLogger({ serviceName: "moda-messaging-worker", environment: resolveCommerceEnvironment() }))
          .error("commerce.turn.budget_rejected", {
            reasonCode: error.reasonCode, shopId: recovery.shopId,
            conversationId: current.id, inboundVersion: current.inboundVersion,
          });
      } catch { /* logging must not change the failure */ }
    }
    throw error;
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(budget.deadlineMs),
    ...(deps.signal ? [deps.signal] : []),
  ]);
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
  try { logger.info("commerce.turn.budget_resolved", {
    shopId: budget.shopId, conversationId: budget.conversationId,
    inboundVersion: budget.inboundVersion, environment: budget.environment,
    deadlineMs: budget.deadlineMs, outputTokens: budget.outputTokens,
    deadlineSource: budget.deadlineSource, outputTokenSource: budget.outputTokenSource,
    merchantPricingPlanId: budget.merchantPricingPlanId,
    policyEditVersions: budget.policyEditVersions, resolvedAt: budget.resolvedAt,
  }); } catch { /* best-effort telemetry */ }
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
    const publishedDescriptors = [
      ...new Map(
        manifest.capabilities.map((capability) => [
          capability.toolDescriptor.name,
          capability.toolDescriptor,
        ]),
      ).values(),
    ];
    const descriptors = [...publishedDescriptors, ...manifest.builtInTools];
    let runnerHostFailure: CommerceHostError | undefined;
    let runnerOriginalError: unknown;
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
    const preserveRunnerFailure = async <T>(action: () => Promise<T>): Promise<T> => {
      try { return await action(); }
      catch (error) {
        if (error instanceof CommerceHostError) retain(error);
        else runnerOriginalError = error;
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
          controlMode: true,
          controlRevision: true,
          languageTag: true,
          languageSource: true,
        },
      }).catch((error: unknown) => {
        throw retain(new CommerceHostError("UNAVAILABLE", true,
          hostDiagnostic("host.turn_state", "HOST_STATE_LOOKUP_FAILED"), error));
      });
      if (!state || state.inboundVersion !== turn.inboundVersion ||
        state.processingInboundVersion !== turn.inboundVersion)
        throw retain(new CommerceHostError("STALE_TURN", false,
          hostDiagnostic("host.turn_state", "HOST_VERSION_STALE")));
      if (state.controlMode !== "AI" || state.controlRevision !== capturedControlRevision)
        throw retain(new CommerceHostError("CANCELLED", false,
          hostDiagnostic("host.turn_state", "HOST_CANCELLED")));
      if (!state.processingStartedAt)
        throw retain(new CommerceHostError("STALE_TURN", false,
          hostDiagnostic("host.turn_state", "HOST_PROCESSING_LEASE_MISSING")));
      if (Date.now() - state.processingStartedAt.getTime() >= 120_000)
        throw retain(new CommerceHostError("STALE_TURN", false,
          hostDiagnostic("host.turn_state", "HOST_PROCESSING_LEASE_EXPIRED")));
      return state;
    };
    const recommendationContext = await loadRecommendationContext({
      recovery: recovery as typeof recovery & { shop: { platform: string; domain: string } },
      turn, grant, db: prisma, environment: resolveCommerceEnvironment(), signal,
      assertCurrent,
    });
    const recommendationObservations = new TurnRecommendationObservations({
      shopId: turn.shopId, provider: recommendationContext.provider, turn,
      grantId: grant.id, releaseId: grant.releaseId,
    });
    const available = async (requestSignal = signal) => {
      await assertCurrent();
      const listed = await observeMcp(() => client.tools(requestSignal));
      for (const entry of listed) {
        const descriptor = descriptors.find((d) => d.name === entry.name);
        if (!descriptor) throw retain(new CommerceHostError("DENIED", false,
          hostDiagnostic("host.authorization", "HOST_TOOL_NOT_GRANTED")));
        const builtin = "kind" in descriptor ? descriptor : undefined;
        const expectedGrant = builtin
          ? grant.grantedTools.find((candidate) => isBuiltInTool(candidate) &&
            candidate.toolName === builtin.name && candidate.definitionVersion === builtin.definitionVersion &&
            isTrustedCommerceBuiltInGrant(candidate))
          : grant.grantedTools.find((candidate) => !isBuiltInTool(candidate) && "toolId" in descriptor &&
            candidate.toolId === descriptor.toolId &&
            candidate.toolRevisionId === descriptor.toolRevisionId &&
            candidate.toolName === descriptor.name &&
            candidate.definitionVersion === descriptor.definitionVersion);
        if (!expectedGrant) throw retain(new CommerceHostError("DENIED", false,
          hostDiagnostic("host.authorization", "HOST_TOOL_GRANT_MISMATCH")));
        if (builtin && !isTrustedCommerceBuiltInDescriptor(builtin))
          throw retain(new CommerceHostError("INCOMPATIBLE_VERSION", false,
            hostDiagnostic("host.authorization", "HOST_TOOL_DESCRIPTOR_CHANGED")));
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
      if (listed.length !== descriptors.length || descriptors.some((descriptor) =>
        !listed.some((entry) => entry.name === descriptor.name)))
        throw retain(new CommerceHostError("DENIED", false,
          hostDiagnostic("host.authorization", "HOST_TOOL_LIST_UNAUTHORIZED")));
      const names = new Set(listed.map((t) => t.name));
      if (recommendationContext.policy.mode === "NONE" ||
          recommendationContext.policy.mode === "FIXED" && recommendationContext.policy.authorisedDiscountIds.length === 0) {
        names.delete("commerce_get_discount_options");
        names.delete("commerce_get_discount_details");
      }
      return filterMerchantKnowledgeAvailability(prisma, turn.shopId, names);
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
      hostInstructions: [...RECOVERY_INSTRUCTIONS, PRODUCT_DISCOVERY_INSTRUCTION, recommendationContext.platformText,
        ...(recommendationContext.shopText ? [recommendationContext.shopText] : []), shopVoiceInstruction(recovery.shop.brand?.brandName)],
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
        commerceProvider: recommendationContext.provider,
        recoveryOfferMode: recommendationContext.policy.mode,
        authorisedDiscountIds: recommendationContext.policy.authorisedDiscountIds,
        basket: recommendationContext.basket,
        currentMessages: context.conversation.messages,
      },
      history: context.conversation.history ?? [],
      // Legacy explicit-source rows remain readable, without imposing preference
      // precedence on recovery. Supply their retained tag as context instead.
      language: current.languageSource === "CUSTOMER_EXPLICIT" ? { tag: null, source: null } : language,
      budgets: { deadlineMs: budget.deadlineMs, outputTokens: budget.outputTokens, remoteCalls: 6 },
      dependencies: {
        model: {
          invoke: async (request, modelSignal) => preserveRunnerFailure(async () => {
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
          }),
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
          isAuthorized: async (authorizedGrant, toolSignal) => preserveRunnerFailure(async () => {
            toolSignal.throwIfAborted();
            if (!(await available(toolSignal)).has(descriptor.name)) return false;
            return grant.grantedTools.some((candidate) =>
              canonicalJson(candidate) === canonicalJson(authorizedGrant) &&
              (isBuiltInTool(candidate)
                ? isTrustedCommerceBuiltInGrant(candidate) && manifest.builtInTools.some((builtin) =>
                  builtin.name === descriptor.name && builtin.definitionVersion === candidate.definitionVersion)
                : "toolId" in descriptor && candidate.toolId === descriptor.toolId &&
                  candidate.toolRevisionId === descriptor.toolRevisionId &&
                  candidate.toolName === descriptor.name &&
                  candidate.definitionVersion === descriptor.definitionVersion));
          }),
          execute: async (args, toolSignal): Promise<CommerceToolResult> => preserveRunnerFailure(async () => {
            toolSignal.throwIfAborted();
            await assertCurrent();
            if (!(await available(toolSignal)).has(descriptor.name))
              throw retain(new CommerceHostError("DENIED", false,
                hostDiagnostic("host.authorization", "HOST_TOOL_NOT_GRANTED")));
            const builtin = "kind" in descriptor;
            const isDiscount = builtin && (descriptor.name === "commerce_get_discount_options" ||
              descriptor.name === "commerce_get_discount_details");
            if (isDiscount) {
              await refreshRecommendationPolicy({ context: recommendationContext, db: prisma, signal: toolSignal, assertCurrent });
              if (descriptor.name === "commerce_get_discount_details") {
                const offerId = args.offerId;
                const options = recommendationObservations.all("commerce_get_discount_options");
                const permitted = options.some((observation) => {
                  const output = observation.output as ReturnType<typeof CommerceToolOutputs.commerce_get_discount_options.parse>;
                  return !(("outcome" in output)) && output.offers.some((offer) => offer.offerId === offerId) &&
                    (recommendationContext.policy.mode !== "FIXED" || recommendationContext.policy.authorisedDiscountIds.includes(String(offerId)));
                });
                if (typeof offerId !== "string" || !permitted)
                  throw retain(new CommerceHostError("DENIED", false,
                    hostDiagnostic("host.authorization", "HOST_TOOL_NOT_GRANTED")));
              }
            }
            const result = await observeMcp(() => client.call(descriptor.name, args, toolSignal));
            if (isDiscount) await refreshRecommendationPolicy({
              context: recommendationContext, db: prisma, signal: toolSignal, assertCurrent,
            });
            if (result.status === "OK") {
              const observationTool = descriptor.name as string;
              if (["commerce_get_product", "commerce_search_products", "commerce_get_discount_options",
                "commerce_get_discount_details", "commerce_get_shipping_information"].includes(observationTool)) {
                const toolName = observationTool as Parameters<typeof recommendationObservations.record>[0]["toolName"];
                const parsed = CommerceToolOutputs[toolName].safeParse(result.data);
                if (!parsed.success) throw retain(new CommerceHostError("INCOMPATIBLE_VERSION", false,
                  hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID"), parsed.error));
                if (isDiscount && descriptor.name === "commerce_get_discount_options" &&
                    "mode" in parsed.data && parsed.data.mode !== recommendationContext.policy.mode) {
                  throw retain(new CommerceHostError("DENIED", false,
                    hostDiagnostic("host.authorization", "HOST_TOOL_NOT_GRANTED")));
                }
                if (isDiscount && descriptor.name === "commerce_get_discount_details" && "details" in parsed.data) {
                  const requested = args.offerId;
                  if (parsed.data.details && parsed.data.details.offer.offerId !== requested)
                    throw retain(new CommerceHostError("INCOMPATIBLE_VERSION", false,
                      hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID")));
                }
                recommendationObservations.record({ toolName, descriptorIdentity: canonicalJson(descriptor),
                  arguments: args, output: parsed.data });
              }
            }
            if ("toolRevisionId" in descriptor) evidence.record(descriptor, args, result, extractEvidence);
            return result;
          }),
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
      if (runnerHostFailure) {
        const source = runnerHostFailure.diagnostic;
        throw new CommerceHostError(runnerHostFailure.code, runnerHostFailure.retryable,
          source ? hostDiagnostic(source.stage, source.reasonCode, {
            ...(source.operation === undefined ? {} : { operation: source.operation }),
            ...(source.statusCode === undefined ? {} : { statusCode: source.statusCode }),
            cause: runnerHostFailure,
            ...(result.error.diagnostic ? { runnerDiagnostic: result.error.diagnostic } : {}),
          }) : hostDiagnostic("host.runner_result", "HOST_RUNNER_FAILURE", {
            ...(result.error.diagnostic ? { runnerDiagnostic: result.error.diagnostic } : {}),
          }), runnerHostFailure, runnerHostFailure.sourceFailure);
      }
      throw new CommerceHostError(result.error.code, result.error.retryable,
        hostDiagnostic("host.runner_result", "HOST_RUNNER_FAILURE", {
          ...(result.error.diagnostic ? { runnerDiagnostic: result.error.diagnostic } : {}),
        }), runnerOriginalError);
    }
    signal.throwIfAborted();
    const latest = await assertCurrent();
    let envelope = result.result;
    let usedCalls = result.usage.remoteCalls;
    if (envelope.answerKind === "ANSWER" && envelope.evidenceIds.length > 0) {
      const refresh = await evidence.refresh(envelope.evidenceIds, {
        remoteCalls: usedCalls,
        maxRemoteCalls: 10,
        now: Date.now,
        assertCurrent: async () => { await assertCurrent(); },
        isCancelled: () => deps.signal?.aborted === true,
        replay: async ({ name, arguments: args }) => {
          usedCalls += 1;
          return client.call(name, args, signal);
        },
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
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    const languageEvaluation = conversationLanguageService.evaluateDetectedLanguage({
      recoveryConversation: true,
      message: languageMessage,
      currentLanguageTag: latest.languageTag,
      currentLanguageSource: latest.languageSource
        ? latest.languageSource.toLowerCase().replaceAll("_", "-") as "customer-explicit" | "detected" | "shopify" | "merchant-default" | "platform-default"
        : null,
      detectedLanguageTag: envelope.detectedLanguageTag,
      detectedLanguageConfidence: envelope.detectedLanguageConfidence,
    });
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
    if (languageEvaluation.reason !== "accepted") {
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
    }
    let hostComposedReplyCandidates: readonly string[] | undefined;
    if (envelope.answerKind === "ANSWER") {
      const details = envelope.details && typeof envelope.details === "object" && !Array.isArray(envelope.details)
        ? envelope.details as Record<string, unknown> : {};
      const selection = readRecommendationSelection(details);
      const ownsPresentation = ["productRecommendationVersion", "productRecommendations", "responseDisposition",
        "shippingInformationSelection"].some((key) => Object.hasOwn(details, key));
      const observationsLatch = recommendationObservations.all("commerce_get_product").length > 0 ||
        recommendationObservations.all("commerce_search_products").length > 0 ||
        recommendationObservations.all("commerce_get_discount_options").length > 0 ||
        recommendationObservations.all("commerce_get_discount_details").length > 0 ||
        recommendationObservations.all("commerce_get_shipping_information").some((item) => item.arguments.productId !== null);
      const controlled = ownsPresentation || observationsLatch ||
        selection?.responseDisposition === "OUT_OF_SCOPE_REDIRECT" ||
        selection?.responseDisposition === "SHIPPING_INFORMATION_UNVERIFIED";
      if (controlled) {
        await assertCurrent();
        await refreshRecommendationPolicy({ context: recommendationContext, db: prisma, signal, assertCurrent });
        const inspection = evaluateRecommendationDiscountInspection(recommendationObservations, recommendationContext.policy);
        const proposed = inspection === "NOT_REQUIRED" || inspection === "SATISFIED"
          ? selection?.productRecommendations ?? [] : [];
        type ProductProposal = NonNullable<typeof proposed>[number];
        type Product = NonNullable<ReturnType<typeof CommerceToolOutputs.commerce_get_product.parse>["product"]>;
        const retained: Array<{ proposal: ProductProposal; product: Product; renderFacts: {
          title: string; url: string; quantity: number; scope: ProductProposal["scope"];
          currentPrice: string | null; currency: string | null; regularPrice?: string | null;
          offerTerms?: NonNullable<RenderRecommendationProduct["offerTerms"]>;
        } }> = [];
        const initialProductObservations = [
          ...recommendationObservations.all("commerce_get_product"),
          ...recommendationObservations.all("commerce_search_products"),
        ];
        const hasInitialProduct = (proposal: ProductProposal) => initialProductObservations.some((observation) => {
          if (observation.arguments.productId === proposal.productId && observation.arguments.variantId === proposal.variantId) return true;
          const output = observation.output as { products?: Product[]; product?: Product | null };
          return output.product?.productId === proposal.productId && output.product.variantId === proposal.variantId ||
            output.products?.some((product) => product.productId === proposal.productId && product.variantId === proposal.variantId) === true;
        });
        let currentBasket = recommendationContext.basket;
        const seenProposalKeys = new Set<string>();
        const budgetedCandidates = proposed.filter((proposal) => {
          if (!hasInitialProduct(proposal) || recommendationContext.provider === "SHOPIFY" && proposal.variantId === null) return false;
          if ((proposal.scope === "PRODUCT_ONLY" || proposal.scope === "ADD_TO_BASKET") && proposal.basketLineId !== null) return false;
          if (proposal.scope === "REPLACE_BASKET_LINE" && (!currentBasket || !proposal.basketLineId ||
              !currentBasket.lines.some((line) => line.lineKey === proposal.basketLineId))) return false;
          if (proposal.scope !== "PRODUCT_ONLY" && (!currentBasket || currentBasket.lines.some((line) =>
              !line.productId || !line.quantity || recommendationContext.provider === "SHOPIFY" && !line.variantId))) return false;
          if (proposal.promotionKind !== "DISCOUNT" && proposal.offerIds.length > 0 ||
              proposal.promotionKind === "DISCOUNT" && (proposal.offerIds.length < 1 || proposal.offerIds.length > 3)) return false;
          const key = canonicalJson({ productId: proposal.productId, variantId: proposal.variantId,
            scope: proposal.scope, basketLineId: proposal.basketLineId });
          if (seenProposalKeys.has(key)) return false;
          seenProposalKeys.add(key);
          return true;
        });
        const softDisposition = selection?.responseDisposition === "OUT_OF_SCOPE_REDIRECT" ||
          selection?.responseDisposition === "SHIPPING_INFORMATION_UNVERIFIED";
        const currentContextProductIds = new Set(initialProductObservations
          .filter((observation) => observation.toolName === "commerce_get_product" || observation.arguments.browse !== true)
          .flatMap((observation) => {
            const output = observation.output as { product?: Product | null; products?: Product[] };
            return [output.product?.productId, ...(output.products ?? []).map((product) => product.productId)]
              .filter((productId): productId is string => Boolean(productId));
          }));
        const basketProductIdentities = new Set((currentBasket?.lines ?? [])
          .filter((line) => line.productId !== null)
          .map((line) => canonicalJson({ productId: line.productId, variantId: line.variantId })));
        const fallbackProposal = softDisposition ? selectFallbackRecommendation({
          selection: budgetedCandidates,
          observations: recommendationObservations,
          currentProductIds: currentContextProductIds,
          basketProductIdentities,
        }) : null;
        const proposalsToRefresh = softDisposition ? (fallbackProposal ? [fallbackProposal] : []) : budgetedCandidates;
        const availableOptions = new Map<string, HostDiscountOptions["offers"][number]>();
        for (const observation of recommendationObservations.all("commerce_get_discount_options")) {
          const output = observation.output as ReturnType<typeof CommerceToolOutputs.commerce_get_discount_options.parse>;
          if ("outcome" in output || output.mode !== recommendationContext.policy.mode) continue;
          for (const offer of output.offers) {
            if (recommendationContext.policy.mode !== "FIXED" || recommendationContext.policy.authorisedDiscountIds.includes(offer.offerId))
              availableOptions.set(offer.offerId, offer);
          }
        }
        const shippingSelection = selection?.shippingInformationSelection;
        const shippingArgs = shippingSelection
          ? { productId: shippingSelection.productId, variantId: shippingSelection.variantId } : null;
        const shippingObserved = shippingArgs && recommendationObservations.latest("commerce_get_shipping_information", shippingArgs);
        const planRefreshes = (proposals: readonly ProductProposal[], shippingCallKey: string | null) => planRecommendationRefreshes({
          proposals: proposals.map((proposal) => ({
            proposal,
            productCallKey: canonicalJson({ name: "commerce_get_product", arguments: {
              productId: proposal.productId, variantId: proposal.variantId,
            } }),
            basketCallKeys: proposal.scope === "PRODUCT_ONLY" ? [] : (currentBasket?.lines ?? []).map((line) => canonicalJson({
              name: "commerce_get_product", arguments: { productId: line.productId, variantId: line.variantId },
            })),
            offerIds: proposal.promotionKind === "DISCOUNT" ? proposal.offerIds.filter((id) => availableOptions.has(id)) : [],
          })),
          ...(shippingCallKey ? { shippingCallKey } : shippingObserved && shippingArgs ? { shippingCallKey: canonicalJson({
            name: "commerce_get_shipping_information", arguments: shippingArgs,
          }) } : {}),
          availableCalls: Math.max(0, 10 - usedCalls),
        });
        let refreshPlan = planRefreshes(proposalsToRefresh, null);
        if (refreshPlan.proposals.some((item) => item.proposal.scope !== "PRODUCT_ONLY")) {
          const refreshedBasket = await refreshRecommendationContext({ context: recommendationContext,
            recoveryId: recovery.id, db: prisma, signal, assertCurrent });
          if (refreshedBasket.basketChanged) {
            currentBasket = null;
            refreshPlan = planRecommendationRefreshes({
              proposals: refreshPlan.proposals.filter((item) => item.proposal.scope === "PRODUCT_ONLY"),
              ...(refreshPlan.shippingCallKey ? { shippingCallKey: refreshPlan.shippingCallKey } : {}),
              availableCalls: Math.max(0, 10 - usedCalls),
            });
          } else currentBasket = refreshedBasket.basket;
        }
        const budgeted = refreshPlan.proposals.map((item) => ({ ...item.proposal, offerIds: item.offerIds,
          promotionKind: item.proposal.promotionKind === "DISCOUNT" && item.offerIds.length === 0 ? "NONE" as const : item.proposal.promotionKind }));
        const shippingPlanned = refreshPlan.shippingCallKey !== null;
        const refreshedProducts = new Map<string, Product | null>();
        const productKey = (productId: string | null, variantId: string | null) => canonicalJson({ productId, variantId });
        const refreshProduct = async (productId: string, variantId: string | null, requireInitialObservation: boolean): Promise<Product | null> => {
          const key = productKey(productId, variantId);
          if (refreshedProducts.has(key)) return refreshedProducts.get(key) ?? null;
          if (requireInitialObservation && !initialProductObservations.some((observation) => {
            if (observation.arguments.productId === productId && observation.arguments.variantId === variantId) return true;
            const output = observation.output as { products?: Product[]; product?: Product | null };
            return output.product?.productId === productId && output.product.variantId === variantId ||
              output.products?.some((item) => item.productId === productId && item.variantId === variantId) === true;
          })) return null;
          await assertCurrent();
          if (!(await available()).has("commerce_get_product"))
            throw retain(new CommerceHostError("DENIED", false, hostDiagnostic("host.authorization", "HOST_TOOL_NOT_GRANTED")));
          if (usedCalls >= 10) return null;
          usedCalls += 1;
          const args = { productId, variantId };
          const fresh = await observeMcp(() => client.call("commerce_get_product", args, signal));
          await assertCurrent();
          if (fresh.status !== "OK") throw new CommerceHostError(fresh.code, fresh.retryable,
            hostDiagnostic("host.runner_result", "HOST_RUNNER_FAILURE"));
          const parsed = CommerceToolOutputs.commerce_get_product.safeParse(fresh.data);
          if (!parsed.success) throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
            hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID"), parsed.error);
          if (parsed.data.product && (parsed.data.product.productId !== productId || parsed.data.product.variantId !== variantId))
            throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
              hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID"));
          recommendationObservations.record({ toolName: "commerce_get_product", descriptorIdentity: canonicalJson(
            descriptors.find((descriptor) => descriptor.name === "commerce_get_product")), arguments: args, output: parsed.data });
          const product = parsed.data.product;
          const safe = product?.available === true && product.url !== null && productBelongsToDomain(product, recovery.shop.domain)
            // Product titles are untrusted catalogue text; control characters are not rendered.
            // eslint-disable-next-line no-control-regex
            && !/[\u0000-\u001f\u007f]/.test(product.title) ? product : null;
          refreshedProducts.set(key, safe);
          return safe;
        };
        for (const proposal of budgeted) {
          const product = await refreshProduct(proposal.productId, proposal.variantId, true);
          if (!product) continue;
          retained.push({ proposal, product, renderFacts: {
            title: product.title, url: product.url!, quantity: proposal.quantity, scope: proposal.scope,
            currentPrice: product.unitPrice, currency: product.currency,
          } });
        }
        if (currentBasket && retained.some(({ proposal }) => proposal.scope !== "PRODUCT_ONLY")) {
          const basketLines = [...currentBasket.lines].sort((a, b) => a.lineKey.localeCompare(b.lineKey));
          for (const line of basketLines) {
            if (!line.productId || !line.quantity || recommendationContext.provider === "SHOPIFY" && !line.variantId) continue;
            await refreshProduct(line.productId, line.variantId, false);
          }
        }
        const optionsById = availableOptions;
        const refreshedDetails = new Map<string, HostDiscountDetails["details"]>();
        const retainedOfferIds = new Set(retained.flatMap(({ proposal }) => proposal.offerIds));
        const plannedOfferIds = [...new Set(refreshPlan.proposals.flatMap((item) => item.offerIds)
          .filter((offerId) => retainedOfferIds.has(offerId)))];
        for (const offerId of plannedOfferIds) {
          if (!optionsById.has(offerId)) continue;
          if (!(await available()).has("commerce_get_discount_details"))
            throw retain(new CommerceHostError("DENIED", false, hostDiagnostic("host.authorization", "HOST_TOOL_NOT_GRANTED")));
          await refreshRecommendationPolicy({ context: recommendationContext, db: prisma, signal, assertCurrent });
          if (recommendationContext.policy.mode === "FIXED" && !recommendationContext.policy.authorisedDiscountIds.includes(offerId))
            throw retain(new CommerceHostError("DENIED", false, hostDiagnostic("host.authorization", "HOST_TOOL_NOT_GRANTED")));
          if (usedCalls >= 10) continue;
          usedCalls += 1;
          const refreshed = await observeMcp(() => client.call("commerce_get_discount_details", { offerId }, signal));
          await refreshRecommendationPolicy({ context: recommendationContext, db: prisma, signal, assertCurrent });
          if (refreshed.status !== "OK") throw new CommerceHostError(refreshed.code, refreshed.retryable,
            hostDiagnostic("host.runner_result", "HOST_RUNNER_FAILURE"));
          const output = CommerceToolOutputs.commerce_get_discount_details.safeParse(refreshed.data);
          if (!output.success) throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
            hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID"), output.error);
          if ("outcome" in output.data) {
            if (output.data.reasonCode !== "TEMPORARY_UNAVAILABLE") throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
              hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID"));
          } else if (output.data.details && output.data.details.offer.offerId !== offerId) {
            throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
              hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID"));
          }
          recommendationObservations.record({ toolName: "commerce_get_discount_details",
            descriptorIdentity: canonicalJson(descriptors.find((descriptor) => descriptor.name === "commerce_get_discount_details")),
            arguments: { offerId }, output: output.data });
          refreshedDetails.set(offerId, "outcome" in output.data ? null : output.data.details);
        }
        for (const item of retained) {
          const proposal = item.proposal;
          const productCurrency = item.product.currency;
          const isSale = (product: Product | null): boolean => {
            if (!product || !product.currency || product.currency !== productCurrency || !product.unitPrice || !product.saleEvidence?.regularPrice ||
                !product.saleEvidence.salePrice || product.saleEvidence.salePrice !== product.unitPrice) return false;
            const regular = decimalToMinorUnits(product.saleEvidence.regularPrice, product.currency);
            const sale = decimalToMinorUnits(product.saleEvidence.salePrice, product.currency);
            return regular !== null && sale !== null && regular > sale;
          };
          type PurchaseLine = { lineKey: string; productId: string | null; variantId: string | null; quantity: number | null;
            categoryIds: readonly string[] | null; collectionIds: readonly string[] | null; isSaleItem: boolean | null; product: Product | null };
          const productLine: PurchaseLine = { lineKey: `proposal-${proposal.productId}`, productId: item.product.productId,
            variantId: item.product.variantId, quantity: proposal.quantity,
            categoryIds: item.product.categoryIds ?? null,
            collectionIds: recommendationContext.provider === "SHOPIFY" && (item.product.collectionIds?.length ?? 0) >= 20
              ? null : item.product.collectionIds ?? null,
            isSaleItem: isSale(item.product) ? true : null, product: item.product };
          const purchaseLines: PurchaseLine[] = proposal.scope === "PRODUCT_ONLY" ? [productLine] : (currentBasket?.lines ?? [])
            .filter((line) => proposal.scope !== "REPLACE_BASKET_LINE" || line.lineKey !== proposal.basketLineId)
            .map((line) => {
              const product = line.productId ? refreshedProducts.get(productKey(line.productId, line.variantId)) ?? null : null;
              return { lineKey: line.lineKey, productId: product?.productId ?? null, variantId: product?.variantId ?? null,
                quantity: line.quantity, categoryIds: product?.categoryIds ?? null,
                collectionIds: recommendationContext.provider === "SHOPIFY" && (product?.collectionIds?.length ?? 0) >= 20
                  ? null : product?.collectionIds ?? null, isSaleItem: isSale(product) ? true : null, product };
            });
          if (proposal.scope !== "PRODUCT_ONLY") purchaseLines.push(productLine);
          const lineProducts = purchaseLines.map((line) => line.product);
          const allPriced = lineProducts.every((product) => product && product.unitPrice && product.currency && product.currency === productCurrency) &&
            (proposal.scope === "PRODUCT_ONLY" || currentBasket?.currency === productCurrency) &&
            purchaseLines.every((line) => Number.isSafeInteger(line.quantity) && line.quantity !== null);
          const subtotalMinor = allPriced && productCurrency ? sumPurchaseSubtotal(purchaseLines.map((line, index) => ({
            amountDecimal: lineProducts[index]!.unitPrice!, quantity: line.quantity!,
          })), productCurrency) : null;
          const subtotal = allPriced && productCurrency && subtotalMinor !== null
            ? minorUnitsToDecimal(subtotalMinor, productCurrency) : null;
          const purchase: DiscountEvaluationPurchase = {
            provider: recommendationContext.provider, mode: recommendationContext.policy.mode,
            authorisedDiscountIds: recommendationContext.policy.authorisedDiscountIds, currency: allPriced ? productCurrency : null,
            lines: purchaseLines.map(({ product: _product, ...line }) => line),
            currentMerchandiseSubtotal: subtotal !== null && productCurrency ? { amountDecimal: subtotal, currency: productCurrency } : null,
          };
          const candidateDiscounts: ObservedDiscount[] = [];
          for (const offerId of proposal.offerIds) {
            const offer = optionsById.get(offerId);
            const discountDetails = refreshedDetails.get(offerId) ?? null;
            if (!offer || !discountDetails) continue;
            const eligibility = evaluatePurchaseDiscount({ purchase, offerFromOptions: offer, details: discountDetails, evaluatedAt: new Date() });
            candidateDiscounts.push({ offer, details: discountDetails, eligibility });
          }
          const combination = proposal.promotionKind === "DISCOUNT" && candidateDiscounts.length
            ? selectCompatibleOffers({ candidates: candidateDiscounts, proposedOfferIds: proposal.offerIds }) : null;
          const terms: NonNullable<RenderRecommendationProduct["offerTerms"]>[number][] = [];
          if (combination?.verdict === "SUPPORTED") for (const id of combination.offerIds) {
            const candidate = candidateDiscounts.find((discount) => discount.offer.offerId === id);
            if (!candidate) continue;
            const facts = candidate.details.facts;
            const code = candidate.offer.method === "CODE" ? candidate.offer.code : null;
            if (candidate.offer.method === "CODE" && (!code || !code.trim() || /[\r\n]/.test(code))) continue;
            if (facts.discountKind === "PERCENTAGE" && facts.discountValue && isValidDecimal(facts.discountValue)) {
              const value = Number(facts.discountValue);
              if (Number.isFinite(value) && value > 0 && value <= 100)
                terms.push({ kind: "percent", value: facts.discountValue, code, automatic: candidate.offer.method === "AUTOMATIC" });
              continue;
            }
            if (facts.discountKind === "FIXED_AMOUNT" && facts.discountValue && facts.discountCurrency && isValidDecimal(facts.discountValue) &&
                decimalToMinorUnits(facts.discountValue, facts.discountCurrency) !== null && decimalToMinorUnits(facts.discountValue, facts.discountCurrency)! > 0n)
              terms.push({ kind: "amount", value: facts.discountValue, currency: facts.discountCurrency,
                code, automatic: candidate.offer.method === "AUTOMATIC" });
            if (facts.discountKind === "FREE_SHIPPING")
              terms.push({ kind: "free-shipping", code, automatic: candidate.offer.method === "AUTOMATIC" });
          }
          if (terms.length > 0) item.renderFacts = { ...item.renderFacts, offerTerms: terms };
          if (isPermittedNativeSale(item.product, recommendationContext.policy) && proposal.promotionKind === "NATIVE_SALE")
            item.renderFacts = { ...item.renderFacts, regularPrice: item.product.saleEvidence!.regularPrice! };
        }
        await refreshRecommendationPolicy({ context: recommendationContext, db: prisma, signal, assertCurrent });
        let shippingPresentation: ReturnType<typeof selectShippingPresentation> | undefined;
        if (shippingSelection && shippingArgs) {
          const args = shippingArgs;
          const observed = recommendationObservations.latest("commerce_get_shipping_information", args);
          if (shippingPlanned && observed && usedCalls < 10 && (await available()).has("commerce_get_shipping_information")) {
            await assertCurrent();
            usedCalls += 1;
            const refreshed = await observeMcp(() => client.call("commerce_get_shipping_information", args, signal));
            await assertCurrent();
            if (refreshed.status !== "OK") throw new CommerceHostError(refreshed.code, refreshed.retryable,
              hostDiagnostic("host.runner_result", "HOST_RUNNER_FAILURE"));
            const output = CommerceToolOutputs.commerce_get_shipping_information.safeParse(refreshed.data);
            if (!output.success) throw new CommerceHostError("INCOMPATIBLE_VERSION", false,
              hostDiagnostic("mcp.tool_result", "MCP_TOOL_RESULT_SCHEMA_INVALID"), output.error);
            recommendationObservations.record({ toolName: "commerce_get_shipping_information",
              descriptorIdentity: canonicalJson(descriptors.find((descriptor) => descriptor.name === "commerce_get_shipping_information")),
              arguments: args, output: output.data });
            if ("product" in output.data) shippingPresentation = selectShippingPresentation({
              selection: shippingSelection,
              observation: observed.output as ReturnType<typeof CommerceToolOutputs.commerce_get_shipping_information.parse>,
              refreshed: output.data as ReturnType<typeof CommerceToolOutputs.commerce_get_shipping_information.parse>,
            });
          }
        }
        await refreshRecommendationPolicy({ context: recommendationContext, db: prisma, signal, assertCurrent });
        const locale = resolveModaConfigurationLocale(languageEvaluation.languageTag);
        const disposition = selection?.responseDisposition ?? "STANDARD";
        const renderedProducts: RenderRecommendationProduct[] = retained.map(({ renderFacts }) => renderFacts);
        const includeNoVerifiedOffer = inspection === "SATISFIED" &&
          recommendationObservations.all("commerce_get_discount_options").length > 0 && retained.length > 0 &&
          retained.some((item) => item.proposal.promotionKind === "DISCOUNT") &&
          retained.every((item) => !item.renderFacts.offerTerms?.length);
        const fullBody = renderRecommendationReply({ locale, disposition, storeUrl: recommendationContext.storeUrl,
          products: renderedProducts,
          includeNoVerifiedOffer,
          ...(shippingPresentation ? { requiresShipping: shippingPresentation.requiresShipping,
            policyUrl: shippingPresentation.policyUrl } : {}) });
        const firstBody = renderedProducts.length > 1
          ? renderRecommendationReply({ locale, disposition, storeUrl: recommendationContext.storeUrl, products: [renderedProducts[0]!],
            includeNoVerifiedOffer,
            ...(shippingPresentation ? { requiresShipping: shippingPresentation.requiresShipping,
              policyUrl: shippingPresentation.policyUrl } : {}) })
          : renderedProducts[0] ? fullBody : null;
        const minimalBody = renderRecommendationReply({ locale, disposition, storeUrl: recommendationContext.storeUrl, products: [],
          ...(shippingPresentation ? { requiresShipping: shippingPresentation.requiresShipping,
            policyUrl: shippingPresentation.policyUrl } : {}) });
        hostComposedReplyCandidates = buildReplyCandidates({ fullBody, firstProductBody: firstBody, minimalBody });
      }
    }
    // Custom details are intentionally not returned to the delivery adapter.
    return {
      answerKind: envelope.answerKind,
      referralReason: envelope.referralReason,
      evidenceIds: envelope.evidenceIds,
      replyText: hostComposedReplyCandidates?.[0] ?? (envelope.answerKind === "REFER_TO_STORE"
          ? renderStoreReferral(
              recovery.shop.domain,
              language,
              context.conversation.messages,
              envelope,
            )
          : envelope.replyText),
      ...(hostComposedReplyCandidates ? { hostComposedReplyCandidates } : {}),
      detectedLanguageTag: envelope.detectedLanguageTag,
      detectedLanguageConfidence: envelope.detectedLanguageConfidence,
    };
  } finally {
    await client.close();
  }
}
