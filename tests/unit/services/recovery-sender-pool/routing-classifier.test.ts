import { describe, expect, it, vi } from 'vitest';
import type { StructuredLogger } from '@modainteract/moda-interact-shared/logging';
import type { CommerceModelInvoker } from '@modainteract/moda-interact-shared/commerce/runner';
import { classifyRouting, validateRoutingClassification, type RoutingClassifierInput } from '../../../../src/services/recovery-sender-pool/routing-classifier.js';
import type { RoutingPolicySnapshot } from '../../../../src/services/recovery-sender-pool/routing-policy.js';

const snapshot = (): RoutingPolicySnapshot => ({
  rowId:'config-a',version:3,environment:'test',decisionTTLms:60000,retentionMs:120000,verifiedShopId:'shop-a',commerceEnvironment:'TEST',
  policy:{schemaVersion:1,enabled:true,modelBinding:{kind:'FIXED_CATALOGUE',modelCatalogueEntryId:'model-a'},promptRevisionId:'prompt-a',wrapperAudience:'ROUTER',confidenceThreshold:83,budget:{deadlineMs:200,outputTokens:512,toolCalls:1},retry:{maxAttempts:2,backoffMs:0},input:{maxHistoryMessages:5,maxInputCharacters:30000,maxCandidates:12},decisionTTLms:60000,retentionMs:120000},
  prompt:{revisionId:'prompt-a',contentHash:'hash-a',promptText:'Use the configured routing role contract.'},
  model:{resolved:{environment:'TEST',sourceScope:'PLATFORM',sourceShopId:null,catalogueEntryId:'model-a',provider:'deepseek',providerModelId:'deepseek-chat',configurationSchemaVersion:1,configuration:{temperature:0.1}},catalogueEditVersion:4,availabilityId:'available-a',availabilityEditVersion:2,selectionSource:'FIXED_CATALOGUE'},configurationSnapshot:{schemaVersion:1},
});
const input = (text='running shoes'): RoutingClassifierInput => ({currentTurnId:'q2',text,verifiedShopId:'shop-a',history:[],candidates:[{optionKey:'2',conversationId:'conversation-a',shopId:'shop-a',routeId:'route-a',facts:{items:[{title:'Running shoes'}]}}],prompts:[{turnId:'q1',originalTurnId:'q1',confirmedProviderMessageId:'prompt-provider',candidateFingerprint:'fingerprint',requestToken:'request-a',optionKeys:['2']}]});
const decision = (role='SELECT_ONLY') => ({role,confidence:95,originalTurnId:'q1',promptTurnId:'q1',confirmedPromptProviderMessageId:'prompt-provider',selectedConversationId:'conversation-a',selectedRouteId:'route-a',offeredOptionKey:'2',newQuestionClause:null});
const dependencies = (value:unknown=decision()) => ({logger:{warn:vi.fn()} as unknown as StructuredLogger,credentialResolver:{resolve:vi.fn().mockResolvedValue('fixture-credential')},invoker:{invoke:vi.fn().mockResolvedValue({calls:[{name:'finalResponse',arguments:value}],outputTokens:20})} satisfies CommerceModelInvoker});

describe('four routing roles and exact evidence',()=>{
  it('selection-only preserves structural reference rather than a synthetic question',()=>expect(validateRoutingClassification(decision(),input(),83)?.role).toBe('SELECT_ONLY'));
  it('independent new question leaves the original unreferenced',()=>{
    const result=validateRoutingClassification({...decision('NEW_QUESTION'),originalTurnId:null,promptTurnId:null,confirmedPromptProviderMessageId:null,offeredOptionKey:null},input('Do the shoes come in black?'),83);
    expect(result?.originalTurnId).toBeNull();expect(result?.role).toBe('NEW_QUESTION');
  });
  it('selection plus question preserves exact UTF-16 clause offsets, no copied plaintext',()=>{
    const text='2. Can I collect on Saturday?';const result=validateRoutingClassification({...decision('SELECT_AND_QUESTION'),newQuestionClause:{start:3,end:text.length}},input(text),83)!;
    expect(text.slice(result.newQuestionClause!.start,result.newQuestionClause!.end)).toBe('Can I collect on Saturday?');expect(JSON.stringify(result)).not.toContain('Saturday');
  });
  it('clarify has no selected merchant owner',()=>expect(validateRoutingClassification({...decision('CLARIFY'),selectedConversationId:null,selectedRouteId:null,offeredOptionKey:null},input('2'),83)?.role).toBe('CLARIFY'));
  it.each([
    {...decision(),confidence:82},{...decision(),confidence:101},{...decision(),confidence:NaN},
    {...decision(),selectedConversationId:'foreign'},{...decision(),selectedRouteId:'foreign'},
    {...decision(),offeredOptionKey:'3'},{...decision(),promptTurnId:'foreign'},
    {...decision(),confirmedPromptProviderMessageId:'unconfirmed'},{...decision(),originalTurnId:'foreign'},
    {...decision(),role:'OTHER'},{...decision(),clause:'private plaintext'},
    {...decision('SELECT_AND_QUESTION'),newQuestionClause:{start:99,end:100}},
    {...decision('SELECT_AND_QUESTION'),newQuestionClause:{start:0,end:0}},
    {...decision('NEW_QUESTION')},{...decision('CLARIFY')},
  ])('rejects unverified model shape %j',value=>expect(validateRoutingClassification(value,input(),83)).toBeNull());
  it('ambiguous bare number cannot pick an unspecified prompt',()=>{
    expect(validateRoutingClassification({...decision(),promptTurnId:null,confirmedPromptProviderMessageId:null},input('2'),83)).toBeNull();
  });
  it('multiple compatible prompts cannot authorize a bare-number guess',()=>{const message=input('2');expect(validateRoutingClassification(decision(),{...message,prompts:[...message.prompts,{...message.prompts[0]!,turnId:'other-prompt',originalTurnId:'other-original'}]},83)).toBeNull();});
  it('ordinary numeric substantive input remains NEW_QUESTION',()=>expect(validateRoutingClassification({...decision('NEW_QUESTION'),originalTurnId:null,promptTurnId:null,confirmedPromptProviderMessageId:null,offeredOptionKey:null},{...input('2'),prompts:[]},83)?.role).toBe('NEW_QUESTION'));
  it('rejects clause offsets splitting a surrogate pair',()=>expect(validateRoutingClassification({...decision('SELECT_AND_QUESTION'),newQuestionClause:{start:1,end:3}},input('🏂?'),83)).toBeNull());
});
describe('configured model invocation',()=>{
  it('uses only configured prompt/model and authentic latest user message',async()=>{
    const deps=dependencies();const result=await classifyRouting(input(),snapshot(),deps);
    expect(result.kind).toBe('decision');expect(deps.invoker.invoke).toHaveBeenCalledWith(expect.objectContaining({requiredToolName:'finalResponse',instructions:['Use the configured routing role contract.'],currentCustomerMessages:[{role:'user',content:'running shoes'}],maxOutputTokens:512}),expect.any(AbortSignal));
    expect(deps.credentialResolver.resolve).not.toHaveBeenCalled();
  });
  it('creates existing shared client through protected credential resolver',async()=>{
    const deps=dependencies();const createClient=vi.fn(()=>deps.invoker);
    await classifyRouting(input(),snapshot(),{credentialResolver:deps.credentialResolver,createClient});
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({provider:'deepseek',providerModelId:'deepseek-chat',configuration:{temperature:0.1},credential:'fixture-credential'}));
  });
  it.each(['no-shop','foreign-candidate','no-model','zero-tools','too-many-candidates','input-overflow','history-overflow'])('clarifies without model call on %s',async condition=>{
    const value=snapshot();let message=input();
    if(condition==='no-shop')message={...message,verifiedShopId:null};
    if(condition==='foreign-candidate')message={...message,candidates:[{...message.candidates[0]!,shopId:'foreign'}]};
    if(condition==='no-model')value.model=null;
    if(condition==='zero-tools')value.policy.budget.toolCalls=0;
    if(condition==='too-many-candidates')value.policy.input.maxCandidates=0;
    if(condition==='input-overflow')value.policy.input.maxInputCharacters=1;
    if(condition==='history-overflow')message={...message,history:Array.from({length:6},()=>({role:'user' as const,content:'history'}))};
    const deps=dependencies();expect((await classifyRouting(message,value,deps)).kind).toBe('clarify');expect(deps.invoker.invoke).not.toHaveBeenCalled();
  });
  it('retries only configured count and never invents fallback model',async()=>{
    const deps=dependencies();deps.invoker.invoke.mockRejectedValue(new Error('provider unavailable'));
    expect(await classifyRouting(input(),snapshot(),deps)).toEqual({kind:'clarify',reason:'model-unavailable'});expect(deps.invoker.invoke).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed terminal tool and cumulative output overspend',async()=>{
    const deps=dependencies();deps.invoker.invoke.mockResolvedValue({calls:[{name:'other',arguments:{}}],outputTokens:20});expect((await classifyRouting(input(),snapshot(),deps)).kind).toBe('clarify');
    deps.invoker.invoke.mockResolvedValue({calls:[{name:'finalResponse',arguments:decision()}],outputTokens:513});expect(await classifyRouting(input(),snapshot(),deps)).toEqual({kind:'clarify',reason:'model-budget-exhausted'});
  });
  it('does not retry low confidence into a different interpretation',async()=>{const deps=dependencies({...decision(),confidence:40});expect((await classifyRouting(input(),snapshot(),deps)).kind).toBe('clarify');expect(deps.invoker.invoke).toHaveBeenCalledTimes(1);});
  it('logs the original bounded provider failure once while redacting credential and customer input',async()=>{
    const value=snapshot();value.policy.retry.maxAttempts=1;
    const current=input('Private customer collection question');
    const withHistory={...current,history:[{role:'user' as const,content:'Private earlier customer wording'}]};
    const warn=vi.fn();const logger={warn} as unknown as StructuredLogger;
    const upstream=Object.assign(new Error('SDK returned an upstream error'),{status:429,requestId:'request-fixture-1',response:{status:429,data:{error:{code:'rate_limit',message:'Distinct upstream capacity limit; fixture-credential; Private customer collection question; Private earlier customer wording',details:{message:'provider says retry later'}}}}});
    const invoke=vi.fn().mockRejectedValue(upstream);
    const result=await classifyRouting(withHistory,value,{logger,credentialResolver:{resolve:vi.fn().mockResolvedValue('fixture-credential')},createClient:()=>({invoke})});
    expect(result.kind).toBe('clarify');expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('recovery.routing.model_failed',expect.objectContaining({
      requestId:'q2',configurationId:'config-a',modelCatalogueEntryId:'model-a',origin:'provider_response',httpStatus:429,providerRequestId:'request-fixture-1',redactionApplied:true,
      providerError:{code:'rate_limit',message:'Distinct upstream capacity limit; [REDACTED]; [REDACTED]; [REDACTED]',details:{message:'provider says retry later'}},
    }));
    const emitted=JSON.stringify(warn.mock.calls);expect(emitted).not.toContain('fixture-credential');expect(emitted).not.toContain(current.text);expect(emitted).not.toContain(withHistory.history[0]!.content);
  });
  it('logs SDK wording without inventing a provider response and isolates a failed logging sink',async()=>{
    const value=snapshot();value.policy.retry.maxAttempts=1;const deps=dependencies();
    deps.invoker.invoke.mockRejectedValue(new Error('Distinct SDK certificate failure'));
    const warn=vi.fn();await classifyRouting(input(),value,{...deps,logger:{warn} as unknown as StructuredLogger});
    expect(warn.mock.calls[0]?.[1]).toMatchObject({origin:'sdk_exception',sdkError:{name:'Error',message:'Distinct SDK certificate failure'}});
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty('providerError');
    await expect(classifyRouting(input(),value,{...deps,logger:{warn:()=>{throw new Error('sink failed');}} as unknown as StructuredLogger})).resolves.toEqual({kind:'clarify',reason:'model-unavailable'});
  });

});
