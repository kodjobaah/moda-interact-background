import { isStableLanguageSignal } from "../services/conversation-language.service.js";
import { renderStoreReferral } from "./referral.js";
import {
  generateText,
  jsonSchema,
  tool,
  type LanguageModel,
  type JSONSchema7,
} from "ai";
import {
  canonicalJson,
  CommerceTurnIdentitySchema,
  finalResponseSchema,
  type CommerceToolResult,
  verifyResponseContract,
} from "@modainteract/moda-interact-shared/commerce";
import {
  runCommerceTurn,
  type ModelRequest,
  type ModelStep,
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
import {
  digest,
  readGrant,
  persistGrant,
  validateRelease,
  manifestMatchesGrant,
} from "./grants.js";
import { RECOVERY_INSTRUCTIONS } from "./recovery-instructions.js";
import {
  extractTrustedEvidence,
  recordEvidenceRefreshOutcome,
  TurnEvidenceRegistry,
  type EvidenceExtractor,
} from "./evidence.js";

export function modelAdapter(model: LanguageModel) {
  return {
    async invoke(
      request: ModelRequest,
      signal: AbortSignal,
    ): Promise<ModelStep> {
      const result = await generateText({
        model,
        abortSignal: signal,
        maxRetries: 0,
        messages: request.messages as any,
        tools: Object.fromEntries(
          request.tools.map((t) => [
            t.name,
            tool({
              description: t.description,
              inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
            }),
          ]),
        ),
      });
      return {
        calls: result.toolCalls.map((call) => ({
          name: call.toolName,
          arguments: call.input,
        })),
        outputTokens: result.usage.outputTokens ?? request.maxOutputTokens,
      };
    },
  };
}
export type HostDependencies = {
  model: {
    invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelStep>;
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
    if (error instanceof CommerceHostError) throw error;
    if (deps.signal?.aborted) throw new CommerceHostError("CANCELLED");
    if (error instanceof Error && error.name === "TimeoutError")
      throw new CommerceHostError("DEADLINE", true);
    throw new CommerceHostError("UNAVAILABLE", true);
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
  if (
    !current ||
    !recovery ||
    recovery.id !== context.recovery.id ||
    ["standalone", "product-only"].includes(recovery.id)
  )
    throw new CommerceHostError("DENIED");
  if (
    current.inboundVersion !== context.conversation.version ||
    current.processingInboundVersion !== current.inboundVersion ||
    !current.processingStartedAt ||
    Date.now() - current.processingStartedAt.getTime() >= 120_000
  )
    throw new CommerceHostError("STALE_TURN");
  const turn = CommerceTurnIdentitySchema.parse({
    contractVersion: "commerce.v1",
    shopId: recovery.shopId,
    checkoutRecoveryId: recovery.id,
    conversationId: current.id,
    inboundVersion: current.inboundVersion,
  });
  const config = deps.config ?? mcpConfiguration();
  let grant = await readGrant(turn);
  if (!grant) {
    const resolver = new CommerceMcpClient(config, turn, signal);
    try {
      await resolver.connect();
      grant = await persistGrant(turn, await resolver.manifest());
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
      throw new CommerceHostError("INCOMPATIBLE_VERSION");
    await validateRelease(manifest);
    const descriptors = [
      ...new Map(
        manifest.capabilities
          .flatMap((c) => c.toolDescriptors)
          .map((t) => [t.name, t]),
      ).values(),
    ];
    const assertCurrent = async () => {
      if (deps.signal?.aborted) throw new CommerceHostError("CANCELLED");
      signal.throwIfAborted();
      const state = await prisma.conversation.findUnique({
        where: { id: current.id },
        select: {
          inboundVersion: true,
          processingInboundVersion: true,
          processingStartedAt: true,
        },
      });
      if (
        !state ||
        state.inboundVersion !== turn.inboundVersion ||
        state.processingInboundVersion !== turn.inboundVersion ||
        !state.processingStartedAt ||
        Date.now() - state.processingStartedAt.getTime() >= 120_000
      )
        throw new CommerceHostError("STALE_TURN");
    };
    const available = async (requestSignal = signal) => {
      await assertCurrent();
      const listed = await client.tools(requestSignal);
      for (const entry of listed) {
        const descriptor = descriptors.find((d) => d.name === entry.name);
        if (
          !descriptor ||
          !grant.grantedTools.some(
            (g) =>
              g.toolName === entry.name &&
              g.toolRevisionId === descriptor.toolRevisionId,
          ) ||
          canonicalJson(entry) !==
            canonicalJson({
              name: descriptor.name,
              description: descriptor.description,
              inputSchema: descriptor.inputSchema,
            })
        )
          throw new CommerceHostError("DENIED");
      }
      if (new Set(listed.map((t) => t.name)).size !== listed.length)
        throw new CommerceHostError("INVALID_INPUT");
      return new Set(listed.map((t) => t.name));
    };
    await available();
    const prompts = [];
    for (const capability of [...manifest.capabilities].sort(
      (a, b) => a.position - b.position,
    ))
      prompts.push(await client.prompt(capability.promptName));
    const language = {
      tag: current.languageTag,
      source:
        current.languageSource === "CUSTOMER_EXPLICIT" ? null :
        current.languageSource?.toLowerCase().replaceAll("_", "-") ?? null,
    };
    const result = await runCommerceTurn({
      turn,
      grant,
      manifest,
      prompts,
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
            await assertCurrent();
            const step = await deps.model.invoke(request, modelSignal);
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
        },
        now: Date.now,
        digest,
        tools: descriptors.map((descriptor) => ({
          descriptor,
          isAuthorized: async (_grant, toolSignal) => {
            toolSignal.throwIfAborted();
            return (await available(toolSignal)).has(descriptor.name);
          },
          execute: async (args, toolSignal): Promise<CommerceToolResult> => {
            toolSignal.throwIfAborted();
            await assertCurrent();
            const result = await client.call(descriptor.name, args, toolSignal);
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
        throw new CommerceHostError("DEADLINE", true);
      throw new CommerceHostError(result.error.code, result.error.retryable);
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
    if (!isStableLanguageSignal(context.conversation.messages.map((m) => m.content).join("\n"))) {
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
