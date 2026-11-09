import { expect, it } from 'vitest';
import { exampleFinal } from '@modainteract/moda-interact-shared/commerce';
import { composeCommerceWhatsAppPreview } from '@modainteract/moda-interact-shared/commerce/presentation';
import { presentationCandidates } from './presentation-receipt.js';
import type { CommercePresentationInput } from '../services/conversation-wrappers/contracts.js';
it('matches Shared recommendation candidate bodies and retains native order without parsing titles or URLs', () => {
 const pairs = [{productId:'30',variantId:null},{productId:'10',variantId:'11'}];
 const input: CommercePresentationInput = { envelope:{...exampleFinal,answerKind:'ANSWER',referralReason:null},productPairs:pairs,
  verified:{schemaVersion:1,brandName:null,locale:'en',disposition:'STANDARD',storeUrl:'https://shop.example',optionFacts:[],productFacts:[],requiresShipping:null,policyUrl:null,includeNoVerifiedOffer:true,
   products:pairs.map((_,index)=>({title:'Tree '+index,url:'https://shop.example/'+index,quantity:1,scope:'PRODUCT_ONLY',currentPrice:null,currency:null}))} };
 const composed=composeCommerceWhatsAppPreview({envelope:input.envelope,presentation:input.verified});
 expect(composed.kind).toBe('ready'); if(composed.kind!=='ready') return;
 const receipts=presentationCandidates(input);
 expect(receipts.map(receipt=>receipt.body)).toEqual(composed.candidates);
 expect(receipts.map(receipt=>receipt.pairs)).toEqual([pairs,pairs.slice(0,1),[]]);
 expect(()=>presentationCandidates({...input,productPairs:[]})).toThrow('PRODUCT_PRESENTATION_RECEIPT_MISSING');
});
it('does not create a presentation from an ordinary unrendered response', () => {
 const input: CommercePresentationInput={envelope:{...exampleFinal,answerKind:'ANSWER',referralReason:null},verified:{schemaVersion:1,brandName:null,locale:'en',disposition:'STANDARD',storeUrl:'https://shop.example',products:[],optionFacts:[],productFacts:[],requiresShipping:null,policyUrl:null,includeNoVerifiedOffer:false}};
 expect(presentationCandidates(input)).toEqual([]);
});
