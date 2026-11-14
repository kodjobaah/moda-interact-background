import { describe, expect, it } from 'vitest';
import { CommerceProductSchema, exampleFinal } from '@modainteract/moda-interact-shared/commerce';
import { verifyCommerceProductFacts } from '@modainteract/moda-interact-shared/commerce/presentation';
import { MODA_SUPPORTED_LANGUAGE_TAGS } from '@modainteract/moda-interact-shared/internationalization';
import { presentationCandidates } from './presentation-receipt.js';
import { fitVerifiedProductCaption, PRODUCT_SHOW_MORE } from './compact-product-presentation.js';
import type { CommercePresentationInput } from '../services/conversation-wrappers/contracts.js';
const pairs=Array.from({length:3},(_,i)=>({productId:`p${i}`,variantId:`v${i}`}));
function input(title='Product'):CommercePresentationInput{return {envelope:{...exampleFinal,answerKind:'ANSWER',referralReason:null,replyText:'Unverified fifteen-product lead. '.repeat(40)},productPairs:pairs,
 verified:{schemaVersion:1,brandName:null,locale:'en',disposition:'STANDARD',storeUrl:'https://shop.example',optionFacts:[],productFacts:[],requiresShipping:null,policyUrl:null,includeNoVerifiedOffer:false,
 products:pairs.map((_,i)=>({title:`${title} ${i}`,url:null,quantity:1,scope:'PRODUCT_ONLY',currentPrice:'10.00',currency:'GBP',regularPrice:'20.00',offerTerms:[{kind:'percent',value:'50'}]}))},
 verifiedProducts:{shopId:'shop',platform:'SHOPIFY',products:pairs.map((pair,i)=>({...pair,title:`${title} ${i}`,observedAt:new Date().toISOString(),available:true,url:null,unitPrice:'10.00',currency:'GBP',productType:null,vendor:null,imageUrl:null}))}};}
const footer='\nReply STOP to opt out.\nhttps://shop.example/checkouts/exact';
describe('complete verified product caption fitting',()=>{
 it('removes oversized arbitrary model lead, retains exact largest verified prefix and proof without modifying original',()=>{
  const source=input('😀'.repeat(100)),before=structuredClone(source);
  const fitted=fitVerifiedProductCaption(source,body=>({header:'Saved header',body,footer:'\n'+'f'.repeat(600)+footer}));
  expect(fitted).not.toBeNull();if(!fitted)throw Error('fixture');
  expect(fitted.pairs.length).toBeGreaterThan(0);expect(fitted.pairs.length).toBeLessThan(3);
  expect(fitted.pairs).toEqual(pairs.slice(0,fitted.pairs.length));
  expect(fitted.presentation.verified.products).toEqual(source.verified.products.slice(0,fitted.pairs.length));
  expect(fitted.presentation.verifiedProducts?.products).toEqual(source.verifiedProducts!.products.slice(0,fitted.pairs.length));
  expect(fitted.boundaries.body).not.toContain('Unverified');expect(fitted.boundaries.body).toContain(PRODUCT_SHOW_MORE.en);
  expect(fitted.boundaries.footer).toBe('\n'+'f'.repeat(600)+footer);
  expect(Array.from(fitted.boundaries.body+fitted.boundaries.footer).length).toBeLessThanOrEqual(1024);
  expect(source).toEqual(before);
 });
 it('includes a budgeted more-options invitation even when all three verified selections fit after replacing the fifteen-item lead',()=>{
  const source=input();const fitted=fitVerifiedProductCaption(source,body=>({header:'Saved header',body,footer}));
  expect(fitted?.pairs).toEqual(pairs);expect(fitted?.boundaries.body).toContain(PRODUCT_SHOW_MORE.en);
  expect(fitted?.boundaries.body).not.toContain('Unverified fifteen-product lead');
 });
 it('chooses three then two then one complete entries, with no zero-product candidate',()=>{
  const attempted:number[]=[];const source=input();
  const fitted=fitVerifiedProductCaption(source,body=>{const count=(body.match(/Product [012]/g)??[]).length;attempted.push(count);return count>1?null:{header:'',body,footer};});
  expect(attempted).toEqual([3,2,1]);expect(fitted?.pairs).toEqual(pairs.slice(0,1));
 });
 it.each(['footer','title'])('returns no candidate when a complete %s cannot fit; never slices mandatory content',reason=>{
  const source=input(reason==='title'?'Long '.repeat(100):'Product');
  expect(fitVerifiedProductCaption(source,body=>({header:'',body,footer:reason==='footer'?footer+'😀'.repeat(1024):'f'.repeat(600)+footer}))).toBeNull();
 });
 it('keeps a complete verified long description or declines the compact form, never slices it',()=>{
  const source=input();const pair=pairs[0]!;const description='Exact description. '.repeat(90);
  const product=CommerceProductSchema.parse({...source.verifiedProducts!.products[0],description:{status:'AVAILABLE',text:description}});
  const facts=verifyCommerceProductFacts([pair],[product]);if(facts.kind!=='verified')throw Error('fixture');
  const detail={...source,productPairs:[pair],verified:{...source.verified,disposition:'PRODUCT_DETAILS' as const,products:[],productFacts:facts.productFacts}};
  const canonicalFacts=structuredClone(facts.productFacts);
  expect(fitVerifiedProductCaption(detail,body=>({header:'',body,footer}))).toBeNull();
  expect(facts.productFacts).toEqual(canonicalFacts);
  expect(canonicalFacts[0]!.description.text!.length).toBeGreaterThan(1024);
 });
 it('does not create selections for nonproduct/referral output',()=>{
  const source=input();expect(fitVerifiedProductCaption({...source,envelope:exampleFinal},body=>({header:'',body,footer}))).toBeNull();
  expect(fitVerifiedProductCaption({...source,productPairs:[],verified:{...source.verified,products:[]}},body=>({header:'',body,footer}))).toBeNull();
 });
 it.each(['OUT_OF_SCOPE_REDIRECT','SHIPPING_INFORMATION_UNVERIFIED'] as const)('preserves Shared required limitation and exact discount facts for %s',disposition=>{
  const base=input();const source={...base,verified:{...base.verified,disposition}};
  const expected=presentationCandidates(source,{completePrefixes:true})[0]!.body;
  const fitted=fitVerifiedProductCaption(source,body=>({header:'Saved',body,footer}));
  expect(fitted?.boundaries.body).toBe(expected+'\n\n'+PRODUCT_SHOW_MORE.en);
  expect(fitted?.presentation.verified.products).toEqual(source.verified.products);
 });
 it('has explicit application-owned copy for all twenty supported locales',()=>{
  expect(Object.keys(PRODUCT_SHOW_MORE).sort()).toEqual([...MODA_SUPPORTED_LANGUAGE_TAGS].sort());
  expect(Object.values(PRODUCT_SHOW_MORE).every(value=>value.length>0&&!value.includes('http'))).toBe(true);
 });
});
