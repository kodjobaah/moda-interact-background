import {describe,it,expect,vi} from 'vitest';
import {readCommonRecoveryLayoutReference,type PreparedWrapper,type CommonRecoveryLayoutReference} from '@modainteract/moda-interact-shared/commerce/presentation';
import {digest,stableJson} from '../../../../src/services/conversation-wrappers/projection.js';
import {readRecoveryCommonReference} from '../../../../src/services/recovery-multipart/common-layout-policy.js';
import {commonLayoutVariables,renderCommonLayoutBoundaries,readCommonLayoutReceipt,currentCommonReferenceMatches} from '../../../../src/services/recovery-multipart/common-layout.js';
import {readMetaCommonReference,readMetaCommonIdentity,commonTemplateParametersMatch} from '../../../../src/services/recovery-template-preparation/recovery-template-common.js';
const prepared:PreparedWrapper={schemaVersion:1,family:'MODA_CONVERSATION_WRAPPER',responseSlot:'response.body',header:[{kind:'text',value:'Shop: '},{kind:'variable',name:'shop.name'},{kind:'text',value:'\n──────────'}],body:[{kind:'responseSlot',name:'response.body'}],footer:[],conditionals:[{when:'checkout.available',tokens:[{kind:'text',value:'Website: '},{kind:'variable',name:'shop.websiteUrl'},{kind:'text',value:'\nCheckout:\n'},{kind:'variable',name:'checkout.url'}]}]};
const reference=(p=prepared):CommonRecoveryLayoutReference=>({schemaVersion:1,definitionId:'def',sourceHash:digest('source'),localeId:'locale',languageTag:'en',contentHash:digest(stableJson(p)),prepared:p});
const url='https://store.example/checkouts/trusted';
describe('Background owning common layout policy',()=>{
 it('reads website in authored caption, preserves bytes and exact trusted native parameters',()=>{
  const ref=reference(),before=structuredClone(ref),variables=commonLayoutVariables('shop','store.example','Shop Name',url)!;
  expect(readRecoveryCommonReference(ref)).toEqual({kind:'ok',reference:ref});
  const boundaries=renderCommonLayoutBoundaries(ref,variables,'Exact answer\nReply STOP to opt out.','shop')!;
  expect(boundaries.header).not.toContain('https://');expect(boundaries.footer).toBe('\nWebsite: https://store.example\nCheckout:\n'+url);
  expect(boundaries.body).toBe('Exact answer\nReply STOP to opt out.');
  const common={schemaVersion:2,kind:'RECOVERY_COMMON_LAYOUT',shopId:'shop',commonRef:ref,variables,boundaries};
  expect(readCommonLayoutReceipt(common)).toEqual(common);expect(ref).toEqual(before);
  expect(readMetaCommonReference({authoring:{commonLayout:ref}})).toEqual({kind:'present',reference:ref});
  const parameters={header:[],body:['Shop Name','https://store.example',url]};
  const identity=readMetaCommonIdentity({reference:ref,variables,parameters},'shop')!;
  expect(identity).not.toBeNull();
  expect(commonTemplateParametersMatch(identity,{header:[],body:[{variable:'shop.name',position:1},{variable:'shop.websiteUrl',position:2},{variable:'checkout.url',position:3}]},parameters)).toBe(true);
 });
 it('accepts only semantically empty static footer tokens without rewriting hash-bound source',()=>{
  const p={...prepared,footer:[{kind:'text' as const,value:''},{kind:'text' as const,value:''}]};
  const ref=reference(p),before=structuredClone(ref),variables=commonLayoutVariables('shop','store.example','Shop Name',url)!;
  expect(readRecoveryCommonReference(ref)).toEqual({kind:'ok',reference:ref});expect(ref).toEqual(before);
  expect(renderCommonLayoutBoundaries(ref,variables,'Answer','shop')).toEqual(renderCommonLayoutBoundaries(reference(),variables,'Answer','shop'));
  expect(ref.contentHash).not.toBe(reference().contentHash);
  expect(readRecoveryCommonReference({...ref,contentHash:reference().contentHash}).kind).toBe('invalid');
 });
 it('retains old reviewed header-site sources without changing hashes',()=>{
  const p=structuredClone(prepared);p.header.push({kind:'variable',name:'shop.websiteUrl'});p.conditionals[0]!.tokens=p.conditionals[0]!.tokens.filter(t=>t.kind!=='variable'||t.name!=='shop.websiteUrl');
  const ref=reference(p);expect(readRecoveryCommonReference(ref)).toEqual({kind:'ok',reference:ref});
 });
 const invalids:PreparedWrapper[]=[
  {...prepared,header:[]},
  {...prepared,header:[...prepared.header,{kind:'variable',name:'shop.websiteUrl'}]},
  {...prepared,header:[...prepared.header,{kind:'variable',name:'customer.firstName'}]},
  {...prepared,footer:[{kind:'text',value:'unprojected footer'}]},
  {...prepared,footer:[{kind:'text',value:' '}]},
  {...prepared,footer:[{kind:'variable',name:'shop.websiteUrl'}]},
  {...prepared,conditionals:[]},
  {...prepared,conditionals:[{when:'checkout.available',tokens:[{kind:'variable',name:'shop.websiteUrl'},{kind:'variable',name:'checkout.url'}]}]},
  {...prepared,conditionals:[{when:'checkout.available',tokens:[...prepared.conditionals[0]!.tokens,{kind:'text',value:'after checkout'}]}]},
  {...prepared,conditionals:[{when:'checkout.available',tokens:[...prepared.conditionals[0]!.tokens,{kind:'variable',name:'checkout.url'}]}]},
  {...prepared,conditionals:[{when:'checkout.available',tokens:prepared.conditionals[0]!.tokens.filter(t=>t.kind!=='variable'||t.name!=='shop.websiteUrl')}]},
 ];
 it.each(invalids)('rejects app-invalid content after Shared technical acceptance',async p=>{
  const ref=reference(p);expect(readCommonRecoveryLayoutReference(ref,digest).kind).toBe('ok');
  expect(readRecoveryCommonReference(ref)).toEqual({kind:'invalid'});expect(readMetaCommonReference({authoring:{commonLayout:ref}})).toEqual({kind:'invalid'});
  const variables=commonLayoutVariables('shop','store.example','Shop Name',url)!;
  expect(renderCommonLayoutBoundaries(ref,variables,'Answer','shop')).toBeNull();
  const tx={$queryRawUnsafe:vi.fn()};expect(await currentCommonReferenceMatches(tx as never,ref)).toBe(false);expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
 });
 it('rejects tampered reference hash before policy or frozen/native authority',()=>{const ref={...reference(),contentHash:'0'.repeat(64)};expect(readRecoveryCommonReference(ref).kind).toBe('invalid');expect(readMetaCommonIdentity({reference:ref,variables:commonLayoutVariables('shop','store.example','Name',url),parameters:{header:[],body:[]}},'shop')).toBeNull();});
});
