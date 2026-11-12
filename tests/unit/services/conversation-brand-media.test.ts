import { ConversationWrapperService } from '../../../src/services/conversation-wrappers/service.js';
import { composeAiOutbound } from '../../../src/services/conversation-wrappers/compose-ai-outbound.js';
import { digest, stableJson } from '../../../src/services/conversation-wrappers/projection.js';
import type { PreparedWrapper, WrapperSlot, VerifiedWrapperContext } from '../../../src/services/conversation-wrappers/contracts.js';
import { describe, expect, it, vi } from 'vitest';
import { ConversationMediaDeliveryPlanSchema, ConversationDeliveryPlanSchema } from '@modainteract/moda-interact-shared/commerce/presentation';
import { prepareRecoveryBrandPlan, frozenBrandPlanCurrent } from '../../../src/services/conversation-brand-media.js';
import { verifiedReadyConversationBrandImage } from '../../../src/services/shop-brand-media-runtime/resolver.js';
import { freezeBrandMedia, readFrozenBrandMedia, readPersistedConversationPlan, validConversationPlan, messageBrandReceipt, asMessageDeliveryReceipt } from '../../../src/services/conversation-delivery-plan.js';
const hash = 'a'.repeat(64), fingerprint = `sha256:${'b'.repeat(64)}`;
const body = 'Test Shop\nhttps://shop.example\n──────────\n\nYour reply\n\n──────────\nhttps://shop.example/checkout';
const header = {schemaVersion:1 as const,shopId:'shop-1',name:'Test Shop',websiteUrl:'https://shop.example'};
export function logo(role:'LOGO'|'SQUARE_LOGO'|'COVER_IMAGE'='LOGO') {
 const image = verifiedReadyConversationBrandImage({shopId:'shop-1',domain:'shop.example',role,publicOrigin:new URL('https://brands.example/'),whatsAppMedia:{schemaVersion:1,roles:{[role]:{
 source:{url:'https://source.example/logo.png',reference:null,generation:3,fingerprint,observedAt:'2026-11-12T09:00:00Z'},
 work:{status:'READY',attempts:1,retryAfter:null,leaseOwner:null,leaseUntil:null,failureCode:null,lastCheckedAt:'2026-11-12T09:02:00Z'},
 ready:{sourceGeneration:3,sourceFingerprint:fingerprint,objectKey:`shop-brands/shop.example/${role.toLowerCase()}/sha256-${hash}.jpg`,contentType:'image/jpeg',width:1125,height:600,sizeBytes:42000,contentSha256:hash,verifiedAt:'2026-11-12T09:02:00Z'}
 }}}});
 if (!image && role !== 'COVER_IMAGE') throw new Error('Invalid fixture');
 return image;
}
const policy={environment:'test',key:'shopBrand.publicMedia' as const,id:'policy-1',version:1,publicOrigin:'https://brands.example'};
const resolved=()=>({image:logo()!,policyRef:policy});
const receipt = {shopId:'shop-1',conversationId:'conversation-1',messageId:'message-1',inboundVersion:2,controlRevision:4,firstPair:null};
async function plan() { const result = await prepareRecoveryBrandPlan({shopId:'shop-1',body,header},async()=>resolved()); if(result?.kind!=='BRAND_IMAGE') throw new Error('Missing logo'); return result; }
describe('ARCH073 verified conversational logo preparation',()=>{
 it('uses the actual published brand contract and preserves the full caption',async()=>{
  const result=await plan(); expect(ConversationMediaDeliveryPlanSchema.safeParse(result).success).toBe(true);
  expect(ConversationDeliveryPlanSchema.safeParse(result).success).toBe(false); // Previous Background boundary rejected this additive published variant.
  expect(result.body).toBe(body); expect(validConversationPlan(result,body,'shop-1')).toBe(true);
  expect(validConversationPlan(result,body,'other')).toBe(false);
 });
 it('does not resolve images for overlong Unicode captions or unknown recovery headers',async()=>{
  const resolve=vi.fn(async()=>resolved());
  const long='😀'.repeat(1025); expect(await prepareRecoveryBrandPlan({shopId:'shop-1',body:long,header},resolve)).toBeUndefined();
  expect(await prepareRecoveryBrandPlan({shopId:'shop-1',body},resolve)).toBeUndefined(); expect(resolve).not.toHaveBeenCalled();
  expect((await prepareRecoveryBrandPlan({shopId:'shop-1',body:'😀'.repeat(1024),header},resolve))?.kind).toBe('BRAND_IMAGE');
 });
 it('preserves text for unavailable, foreign, cover or failed configuration',async()=>{
  const text={schemaVersion:1 as const,kind:'TEXT' as const,body};
  for(const resolve of [async()=>null,async()=>({image:{...logo()!,origin:{...logo()!.origin,shopId:'foreign'}},policyRef:policy}),async()=>({image:{...logo()!,origin:{...logo()!.origin,role:'COVER_IMAGE' as const}},policyRef:policy}),async()=>{throw new Error('config');}])
   expect(await prepareRecoveryBrandPlan({shopId:'shop-1',body,header,plan:text},resolve)).toEqual(text);
  expect(logo('COVER_IMAGE')).toBeNull();
 });
 it('keeps verified product imagery ahead of logos without another resolver read',async()=>{
  const image={schemaVersion:1 as const,shopId:'shop-1',productId:'gid://shopify/Product/1',variantId:null,publicUrl:'https://media.example/tree.jpg',objectKey:`conversation-products/v1/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}.jpg`,contentSha256:'c'.repeat(64),contentType:'image/jpeg' as const,byteLength:100,width:1125 as const,height:600 as const};
  const product={schemaVersion:1 as const,kind:'IMAGE' as const,body,image}; const resolve=vi.fn(async()=>resolved());
  expect(await prepareRecoveryBrandPlan({shopId:'shop-1',body,header,plan:product},resolve)).toBe(product);expect(resolve).not.toHaveBeenCalled();
 });
 it('revalidates the same frozen role without substitution or downgrade',async()=>{
  const frozen=await plan(), resolve=vi.fn(async()=>({image:logo('SQUARE_LOGO')!,policyRef:policy}));
  expect(await frozenBrandPlanCurrent(frozen,resolve)).toBe(false); expect(resolve).toHaveBeenCalledWith('shop-1','LOGO');
  expect(await frozenBrandPlanCurrent(frozen,async()=>resolved())).toBe(true);
  expect(await frozenBrandPlanCurrent(frozen,async()=>null)).toBe(false);
 });
 it('rehydrates original MESSAGE authority and rejects raw new plans or tampering',async()=>{
  const frozen=freezeBrandMedia(await plan(),messageBrandReceipt(receipt),header,policy);
  expect(asMessageDeliveryReceipt(readFrozenBrandMedia(JSON.parse(JSON.stringify(frozen)))!.receipt)).toEqual(receipt);
  expect(readPersistedConversationPlan(frozen)?.plan.body).toBe(body); expect(readPersistedConversationPlan(frozen.plan)).toBeNull();
  for(const changed of [{...frozen,schemaVersion:2},{...frozen,kind:'unknown'},{...frozen,extra:true},{...frozen,planDigest:'x'},{...frozen,policyRef:undefined},{...frozen,policyRef:{...policy,environment:'production'}},{...frozen,recoveryShopHeader:undefined},{...frozen,recoveryShopHeader:{...header,name:'Wrong'}},{...frozen,receipt:{...frozen.receipt,shopId:'other'}},{...frozen,receipt:{...frozen.receipt,sourceKind:'unknown'}},{...frozen,plan:{...frozen.plan,body:'changed'}}]) expect(readFrozenBrandMedia(changed)).toBeNull();
 });
 it('binds HUMAN command identity without changing inbound provenance into MESSAGE authority',async()=>{
  const frozen=freezeBrandMedia(await plan(),{...messageBrandReceipt(receipt),sourceKind:'HUMAN_COMMAND',sourceId:'command-1'},header,policy);
  expect(readFrozenBrandMedia(frozen)?.receipt.inboundVersion).toBe(2); expect(asMessageDeliveryReceipt(frozen.receipt)).toBeNull();
 });
 it('preserves legacy frozen text exactly despite newly available branding',()=>{
  const legacy={schemaVersion:1,kind:'TEXT',body:'old immutable reply'};
  expect(readPersistedConversationPlan(legacy)).toEqual({plan:legacy});
 });
});

describe('ARCH073 actual wrapper→AI/HUMAN logo composition',()=>{
 const prepared:PreparedWrapper={schemaVersion:1,family:'MODA_CONVERSATION_WRAPPER',responseSlot:'response.body',header:[],body:[{kind:'responseSlot',name:'response.body'}],footer:[],conditionals:[]};
 const context:VerifiedWrapperContext={conversationId:'conversation-1',shopId:'shop-1',conversationLanguageTag:'en',merchantLanguageTag:'en',variables:{},checkoutAvailable:false,recoveryShopHeader:header};
 const slot:WrapperSlot={audience:'SHARED',definitionId:'shared-def',editVersion:1,definition:{id:'shared-def',kind:'MODA_CONVERSATION_WRAPPER',audience:'SHARED',status:'PUBLISHED',sourceLanguageTag:'en',astSchemaVersion:1,sourceHash:'a'.repeat(64),publishedAt:new Date(),retiredAt:null,createdByAdminId:'admin',locales:[{id:'en',languageTag:'en',status:'SOURCE_SAVED',providerLanguageCode:null,localeAst:{schemaVersion:1,prepared},contentHash:digest(stableJson(prepared)),reviewedAt:null,reviewedByAdminId:null}]}};
 for(const configured of [false,true])it(`composes complete ${configured?'configured':'unconfigured'} AI caption and internal policy before transport`,async()=>{
  const wrapper=new ConversationWrapperService({repository:{loadContext:async()=>context,loadSlots:async()=>configured?[slot]:[]},onMissingSlot:'passthrough',logoResolver:async()=>resolved()});
  const result=await composeAiOutbound(wrapper,{conversationId:'conversation-1',messageId:'message-1',generatedResponse:'Current answer'});
  expect(result).toMatchObject({kind:'ready',brandMediaPolicy:policy,deliveryPlan:{kind:'BRAND_IMAGE'}});
  if(result.kind!=='ready')throw new Error('refused');expect(result.deliveryPlan!.body).toBe(result.text);expect(result.text).toContain('Current answer');expect(result.text.startsWith('Test Shop\nhttps://shop.example\n──────────')).toBe(true);
 });
 it('prepares configured HUMAN captions through the same complete-body logo stage',async()=>{
  const wrapper=new ConversationWrapperService({repository:{loadContext:async()=>context,loadSlots:async()=>[slot]},logoResolver:async()=>resolved()});
  const result=await wrapper.renderConversationResponse({conversationId:'conversation-1',messageIdentity:'command-1',source:'HUMAN',responseBody:'Staff authored answer',allowBrandImage:true});
  expect(result).toMatchObject({kind:'rendered',brandMediaPolicy:policy,deliveryPlan:{kind:'BRAND_IMAGE'}});
  if(result.kind!=='rendered')throw new Error('refused');expect(result.deliveryPlan!.body).toBe(result.body);expect(result.body).toContain('Staff authored answer');
 });
 it('leaves replayed immutable no-logo preparation unchanged',async()=>{
  const resolve=vi.fn(async()=>resolved());const repository={loadContext:async()=>context,loadSlots:async()=>[slot]};
  const old=new ConversationWrapperService({repository,logoResolver:async()=>null});const input={conversationId:'conversation-1',messageIdentity:'old-message',source:'AI' as const,responseBody:'Old answer'};
  const prior=await old.renderConversationResponse(input);if(prior.kind!=='rendered')throw new Error('missing');
  const current=new ConversationWrapperService({repository,logoResolver:resolve});const replay=await current.renderConversationResponse({...input,previousApplication:prior});
  expect(replay).toMatchObject({kind:'rendered',body:prior.body,replayed:true});expect('deliveryPlan' in replay ? replay.deliveryPlan : undefined).toBeUndefined();expect(resolve).not.toHaveBeenCalled();
 });
});
