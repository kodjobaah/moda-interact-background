import type { Prisma } from '@prisma/client';
import { canonicalJson, prepareCurrentCustomerMessages } from '@modainteract/moda-interact-shared/commerce';
import { OpenRouterModelClient, type OpenRouterModelClientOptions } from '@modainteract/moda-interact-shared/commerce/model/node';
import { CommerceModelInvocationFailure, type CommerceModelInvoker } from '@modainteract/moda-interact-shared/commerce/runner';
import { createLogger, type StructuredLogger } from '@modainteract/moda-interact-shared/logging';
import { sourceFailureFields } from '../../commerce/production-model.js';
import type { OpenRouterCredentialResolver } from '../../commerce/openrouter-credential.js';
import type { RoutingPolicySnapshot } from './routing-policy.js';

export type RoutingRole = 'SELECT_ONLY' | 'NEW_QUESTION' | 'SELECT_AND_QUESTION' | 'CLARIFY';
export type RoutingCandidate = Readonly<{ optionKey: string; conversationId: string; shopId: string; routeId: string; facts: Prisma.JsonValue }>;
export type RoutingPromptEvidence = Readonly<{
  turnId: string; originalTurnId: string; confirmedProviderMessageId: string;
  candidateFingerprint: string; requestToken: string; optionKeys: readonly string[];
}>;
export type RoutingClassifierInput = Readonly<{
  currentTurnId: string; text: string; verifiedShopId: string | null;
  candidates: readonly RoutingCandidate[]; prompts: readonly RoutingPromptEvidence[];
  history: readonly Readonly<{ role: 'user' | 'assistant'; content: string }>[];
}>;
export type RoutingClassification = Readonly<{
  role: RoutingRole; confidence: number;
  originalTurnId: string | null; promptTurnId: string | null; confirmedPromptProviderMessageId: string | null;
  selectedConversationId: string | null; selectedRouteId: string | null; offeredOptionKey: string | null;
  newQuestionClause: { start: number; end: number } | null;
}>;
export type RoutingClassifierResult = { kind: 'decision'; decision: RoutingClassification } | { kind: 'clarify'; reason: string };

const nullableId = { type: ['string','null'] };
/** This terminal tool is structural output only; it executes no merchant operation. */
export const ROUTING_DECISION_TOOL = {
  name: 'finalResponse', description: 'Return one structural checkout-routing role decision. Never paraphrase a customer clause; reference exact UTF-16 offsets.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    required: ['role','confidence','originalTurnId','promptTurnId','confirmedPromptProviderMessageId','selectedConversationId','selectedRouteId','offeredOptionKey','newQuestionClause'],
    properties: {
      role: { type: 'string', enum: ['SELECT_ONLY','NEW_QUESTION','SELECT_AND_QUESTION','CLARIFY'] },
      confidence: { type: 'integer', minimum: 0, maximum: 100 },
      originalTurnId: nullableId, promptTurnId: nullableId, confirmedPromptProviderMessageId: nullableId,
      selectedConversationId: nullableId, selectedRouteId: nullableId, offeredOptionKey: nullableId,
      newQuestionClause: { anyOf: [{ type:'null' }, { type:'object', additionalProperties:false, required:['start','end'], properties:{ start:{type:'integer',minimum:0},end:{type:'integer',minimum:1} } }] },
    },
  },
};

/** Business authorization stays in the application and is rechecked by the owner transaction. */
export function validateRoutingClassification(raw: unknown, input: RoutingClassifierInput, threshold: number): RoutingClassification | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const fields = ROUTING_DECISION_TOOL.inputSchema.required;
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row,key))) return null;
  if (!['SELECT_ONLY','NEW_QUESTION','SELECT_AND_QUESTION','CLARIFY'].includes(String(row.role)) || typeof row.confidence !== 'number' || !Number.isSafeInteger(row.confidence) || row.confidence < threshold || row.confidence > 100) return null;
  for (const key of ['originalTurnId','promptTurnId','confirmedPromptProviderMessageId','selectedConversationId','selectedRouteId','offeredOptionKey']) {
    if (row[key] !== null && (typeof row[key] !== 'string' || !row[key] || (row[key] as string).length > 191)) return null;
  }
  const candidate = input.candidates.find(item => item.conversationId === row.selectedConversationId);
  if (row.role === 'CLARIFY') {
    if (row.selectedConversationId !== null || row.selectedRouteId !== null || row.offeredOptionKey !== null || row.newQuestionClause !== null) return null;
  } else {
    if (!candidate || candidate.shopId !== input.verifiedShopId || candidate.routeId !== row.selectedRouteId) return null;
    if (row.offeredOptionKey !== null && candidate.optionKey !== row.offeredOptionKey) return null;
  }
  if (row.role === 'SELECT_ONLY' || row.role === 'SELECT_AND_QUESTION') {
    const prompt = input.prompts.find(item => item.turnId === row.promptTurnId && item.originalTurnId === row.originalTurnId && item.confirmedProviderMessageId === row.confirmedPromptProviderMessageId);
    if (!prompt || !candidate || row.originalTurnId === input.currentTurnId || !row.offeredOptionKey || !prompt.optionKeys.includes(String(row.offeredOptionKey))) return null;
    if (input.prompts.filter(item => item.optionKeys.includes(String(row.offeredOptionKey))).length !== 1) return null;
  } else if (row.role === 'NEW_QUESTION') {
    if (row.originalTurnId !== null || row.promptTurnId !== null || row.confirmedPromptProviderMessageId !== null || row.newQuestionClause !== null) return null;
  }
  if (row.role === 'SELECT_AND_QUESTION') {
    const clause = row.newQuestionClause;
    if (!clause || typeof clause !== 'object' || Array.isArray(clause)) return null;
    const offsets = clause as Record<string,unknown>;
    if (Object.keys(offsets).length !== 2 || !Number.isSafeInteger(offsets.start) || !Number.isSafeInteger(offsets.end) || (offsets.start as number) < 0 || (offsets.end as number) <= (offsets.start as number) || (offsets.end as number) > input.text.length || !input.text.slice(offsets.start as number, offsets.end as number).trim()) return null;
    // Never split an astral character when preserving an exact clause.
    for (const offset of [offsets.start as number, offsets.end as number]) {
      if (offset > 0 && offset < input.text.length && /[\uD800-\uDBFF]/.test(input.text[offset-1]!) && /[\uDC00-\uDFFF]/.test(input.text[offset]!)) return null;
    }
  } else if (row.newQuestionClause !== null) return null;
  return structuredClone(row) as unknown as RoutingClassification;
}

export async function classifyRouting(input: RoutingClassifierInput, snapshot: RoutingPolicySnapshot, dependencies: {
  credentialResolver: OpenRouterCredentialResolver;
  createClient?: (options: OpenRouterModelClientOptions) => CommerceModelInvoker;
  invoker?: CommerceModelInvoker;
  signal?: AbortSignal;
  logger?: StructuredLogger;
}): Promise<RoutingClassifierResult> {
  const clarify = (reason: string): RoutingClassifierResult => ({kind:'clarify',reason});
  if (!snapshot.policy.enabled || !snapshot.model || !input.verifiedShopId || snapshot.verifiedShopId !== input.verifiedShopId) return clarify('verified-shop-model-required');
  if (snapshot.policy.budget.toolCalls < 1) return clarify('terminal-tool-budget-unavailable');
  if (!input.text.trim() || input.candidates.length === 0 || input.candidates.length > snapshot.policy.input.maxCandidates || input.history.length > snapshot.policy.input.maxHistoryMessages) return clarify('complete-input-limit');
  if (input.candidates.some(candidate => candidate.shopId !== input.verifiedShopId) || new Set(input.candidates.map(item=>item.optionKey)).size !== input.candidates.length || new Set(input.candidates.map(item=>item.conversationId)).size !== input.candidates.length) return clarify('candidate-scope-invalid');
  const context = {currentTurnId:input.currentTurnId,verifiedShopId:input.verifiedShopId,candidates:input.candidates,prompts:input.prompts};
  const serialized = canonicalJson({context,history:input.history,text:input.text});
  if (serialized.length > snapshot.policy.input.maxInputCharacters || new TextEncoder().encode(serialized).length > 131072) return clarify('complete-input-limit');
  let currentCustomerMessages: ReturnType<typeof prepareCurrentCustomerMessages>;
  try { currentCustomerMessages = prepareCurrentCustomerMessages([{role:'user',content:input.text}]); }
  catch { return clarify('provider-structural-input-limit'); }
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), snapshot.policy.budget.deadlineMs);
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal,controller.signal]) : controller.signal;
  let remainingTokens = snapshot.policy.budget.outputTokens;
  let credential: string | undefined;
  const logger = dependencies.logger ?? createLogger({serviceName:'moda-messaging-worker',environment:snapshot.environment});
  const logFailure = (error: unknown, attempt: number, stage: 'credential' | 'initialize' | 'invoke') => {
    try {
      logger.warn('recovery.routing.model_failed', {
        requestId: input.currentTurnId, configurationId: snapshot.rowId, configurationVersion: snapshot.version,
        modelCatalogueEntryId: snapshot.model!.resolved.catalogueEntryId, promptRevisionId: snapshot.prompt.revisionId,
        attempt, stage,
        ...sourceFailureFields(error instanceof CommerceModelInvocationFailure ? error.cause ?? error : error,
          snapshot.model!.resolved.provider, stage === 'credential' ? 'ROUTING_MODEL_CREDENTIAL_UNAVAILABLE' : stage === 'initialize' ? 'ROUTING_MODEL_ADAPTER_UNAVAILABLE' : 'ROUTING_MODEL_INVOCATION_FAILED',
          [...(credential ? [credential] : []), input.text, snapshot.prompt.promptText, ...input.history.map(row=>row.content)], stage === 'invoke' ? 'sdk_exception' : 'internal'),
      });
    } catch { /* Shared/injected logging sink failure cannot alter routing or retries. */ }
  };
  let initializationStage: 'credential' | 'initialize' = 'credential';
  try {
    const model = snapshot.model.resolved;
    if (!dependencies.invoker) credential = await dependencies.credentialResolver.resolve({environment:snapshot.commerceEnvironment,signal});
    initializationStage = 'initialize';
    const invoker = dependencies.invoker ?? (dependencies.createClient ?? (options=>new OpenRouterModelClient(options)))({
      provider:model.provider,providerModelId:model.providerModelId,configurationSchemaVersion:model.configurationSchemaVersion,
      configuration:model.configuration,credential:credential!,
    });
    for (let attempt=0; attempt<snapshot.policy.retry.maxAttempts && !signal.aborted; attempt+=1) {
      try {
        const result = await invoker.invoke({requiredToolName:'finalResponse', instructions:[snapshot.prompt.promptText],context,history:input.history,
          currentCustomerMessages,messages:[],tools:[ROUTING_DECISION_TOOL],maxOutputTokens:remainingTokens},signal);
        if (!Number.isSafeInteger(result.outputTokens) || result.outputTokens < 0 || result.outputTokens > remainingTokens || result.calls.length > snapshot.policy.budget.toolCalls) return clarify('model-budget-exhausted');
        remainingTokens -= result.outputTokens;
        if (result.calls.length !== 1 || result.calls[0]?.name !== 'finalResponse') return clarify('invalid-structured-decision');
        const decision = validateRoutingClassification(result.calls[0].arguments,input,snapshot.policy.confidenceThreshold);
        return decision ? {kind:'decision',decision} : clarify('unverified-role-or-selection');
      } catch (error) {
        logFailure(error,attempt+1,'invoke');
        if (signal.aborted || attempt+1 >= snapshot.policy.retry.maxAttempts || remainingTokens < 1) break;
        await new Promise<void>((resolve)=>{
          const finish=()=>{clearTimeout(wait);signal.removeEventListener('abort',finish);resolve();};
          const wait=setTimeout(finish,snapshot.policy.retry.backoffMs);
          signal.addEventListener('abort',finish,{once:true});
        });
      }
    }
    return clarify(signal.aborted ? 'model-deadline-or-cancelled' : 'model-unavailable');
  } catch (error) { logFailure(error,0,initializationStage); return clarify('model-unavailable'); }
  finally { clearTimeout(timer); }
}
