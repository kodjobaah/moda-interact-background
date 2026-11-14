import {describe,it,expect} from 'vitest';
import {CommerceProductSchema,exampleFinal} from '@modainteract/moda-interact-shared/commerce';
import {verifyCommerceProductFacts} from '@modainteract/moda-interact-shared/commerce/presentation';
import {MODA_SUPPORTED_LANGUAGE_TAGS} from '@modainteract/moda-interact-shared/internationalization';
import {briefProductDetailCandidates,BRIEF_PRODUCT_COPY} from './brief-product-list.js';
import {fitVerifiedProductCaption,PRODUCT_SHOW_MORE} from './compact-product-presentation.js';
import type {CommercePresentationInput} from '../services/conversation-wrappers/contracts.js';
function details(count=3):CommercePresentationInput{
 const products=Array.from({length:count},(_,i)=>CommerceProductSchema.parse({productId:`p${i}`,variantId:null,title:`Whole snowboard ${i}`,observedAt:'2026-11-14T16:00:00Z',description:{status:'AVAILABLE',text:`Full narrative ${i}. `.repeat(120)},attributes:{status:'AVAILABLE',items:[{name:'Material',values:['Whole canonical material']}]},options:{status:'NOT_PROVIDED',items:[]},selectedOptions:[],stock:{status:'KNOWN',quantity:50+i,scope:'PRODUCT'},unitPrice:'885.95',currency:'USD',productType:'Snowboard',vendor:null,url:null,imageUrl:'https://shop.example/product.jpg',available:true}));
 const pairs=products.map(({productId,variantId})=>({productId,variantId}));const verified=verifyCommerceProductFacts(pairs,products);if(verified.kind!=='verified')throw Error('fixture');
 return {envelope:{...exampleFinal,answerKind:'ANSWER',referralReason:null,replyText:'Arbitrary long model prose '.repeat(80),details:{productDetailSelections:pairs}},verified:{schemaVersion:1,brandName:null,locale:'en',disposition:'PRODUCT_DETAILS',storeUrl:'https://shop.example',products:[],productFacts:verified.productFacts,optionFacts:[],requiresShipping:null,policyUrl:null,includeNoVerifiedOffer:false},verifiedProducts:{shopId:'shop',platform:'SHOPIFY',products}};
}
const footer='\nReply STOP to opt out.\nWebsite: https://shop.example\nCheckout:\nhttps://shop.example/checkouts/current';
describe('overflow-only multi-product verified detail summaries',()=>{
 it('uses whole matched verified facts in a marked brief list without fabricating unavailable description or editing proof',()=>{
  const input=details(),before=structuredClone(input);const fit=fitVerifiedProductCaption(input,body=>({header:'Saved',body,footer}));
  expect(fit).not.toBeNull();expect(fit!.boundaries.body).toContain('Brief product list');expect(fit!.boundaries.body).toContain('885.95');expect(fit!.boundaries.body).toContain('USD');expect(fit!.boundaries.body).toContain('Stock (product): 50');expect(fit!.boundaries.body).toContain('Category: Snowboard');
  expect(fit!.boundaries.body).not.toContain('Full narrative');expect(fit!.boundaries.body).not.toMatch(/description.*unavailable/i);expect(fit!.boundaries.body).toContain(PRODUCT_SHOW_MORE.en);
  expect(Array.from(fit!.boundaries.body+fit!.boundaries.footer).length).toBeLessThanOrEqual(1024);expect(fit!.boundaries.footer).toBe(footer);expect(fit!.presentation.verifiedProducts!.products).toEqual(before.verifiedProducts!.products);expect(fit!.presentation.verified.productFacts).toEqual(before.verified.productFacts);expect(input).toEqual(before);
 });
 it('keeps summary eligibility from original multi-product selection even when budget retains only one complete item',()=>{
  const input=details();const fit=fitVerifiedProductCaption(input,body=>body.includes('Whole snowboard 1')?null:{header:'',body,footer});
  expect(fit!.pairs).toEqual([{productId:'p0',variantId:null}]);expect(fit!.presentation.verifiedProducts!.products).toEqual(input.verifiedProducts!.products.slice(0,1));expect(fit!.presentation.verified.productFacts).toEqual(input.verified.productFacts!.slice(0,1));expect(fit!.presentation.verified.productFacts![0]!.description.status).toBe('AVAILABLE');expect(fit!.presentation.verified.productFacts![0]!.description.text).toContain('Full narrative');
 });
 it('does not summarize one original product, including two variant detail rows of the same product',()=>{
  const single=details(1);expect(briefProductDetailCandidates(single)).toBeUndefined();expect(fitVerifiedProductCaption(single,body=>({header:'',body,footer}))).toBeNull();
  const variants=details(2);variants.verifiedProducts!.products[1]!.productId='p0';variants.verifiedProducts!.products[1]!.variantId='v2';variants.verified.productFacts![1]!.productId='p0';variants.verified.productFacts![1]!.variantId='v2';expect(briefProductDetailCandidates(variants)).toBeUndefined();
 });
 it.each(['missing','duplicate','changed-fact'] as const)('refuses unproven brief summary inputs %s',mode=>{
  const input=details();if(mode==='missing')input.verifiedProducts!.products.pop();if(mode==='duplicate')input.verifiedProducts!.products.push(input.verifiedProducts!.products[0]!);if(mode==='changed-fact')input.verified.productFacts![0]!.description.text='forged';expect(briefProductDetailCandidates(input)).toEqual([]);
 });
 it('never slices whole titles/category or mandatory footer to force a fit',()=>{
  const input=details();for(const product of input.verifiedProducts!.products)product.title='😀'.repeat(250);for(const fact of input.verified.productFacts!)fact.title='😀'.repeat(250);
  expect(fitVerifiedProductCaption(input,body=>({header:'',body,footer:footer+'x'.repeat(800)}))).toBeNull();expect(fitVerifiedProductCaption(details(),body=>({header:'',body,footer:'x'.repeat(1025)}))).toBeNull();
 });
 it.each(MODA_SUPPORTED_LANGUAGE_TAGS)('has explicit localized brief/price/category copy and canonical facts for %s',locale=>{
  const input=details(2);input.verified.locale=locale;const candidates=briefProductDetailCandidates(input)!;expect(candidates[0]!.body).toContain(BRIEF_PRODUCT_COPY[locale][0]);expect(candidates[0]!.body).toContain(BRIEF_PRODUCT_COPY[locale][1]);expect(candidates[0]!.body).toContain(BRIEF_PRODUCT_COPY[locale][2]);expect(candidates[0]!.pairs).toHaveLength(2);
 });
 it('omits genuinely absent optional price/category without inventing values or a fake unavailable narrative',()=>{
  const input=details(2);for(const product of input.verifiedProducts!.products){product.unitPrice=null;product.currency=null;product.productType=null;}
  const body=briefProductDetailCandidates(input)![0]!.body;expect(body).not.toContain('Price:');expect(body).not.toContain('Category:');expect(body).toContain('Whole snowboard 0');expect(body).not.toContain('unavailable');
 });
 it('does not change referral/non-detail presentation selection',()=>{
  const input=details();expect(briefProductDetailCandidates({...input,envelope:exampleFinal})).toBeUndefined();expect(briefProductDetailCandidates({...input,verified:{...input.verified,disposition:'PRODUCT_OPTIONS'}})).toBeUndefined();
 });
});
