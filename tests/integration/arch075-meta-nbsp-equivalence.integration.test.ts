import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {describe,it,expect,vi} from 'vitest';
import {MetaTemplateRepository} from '../../src/services/meta-template-management/repository.js';
import {MetaTemplateManagementService} from '../../src/services/meta-template-management/service.js';
import {observedContentHash,fingerprint,type MetaComponent} from '../../src/services/meta-template-management/contracts.js';
import {PrismaRecoveryTemplateRepository} from '../../src/services/recovery-template-preparation/recovery-template-repository.js';
import {selectRecoveryAssignment} from '../../src/services/recovery-template-preparation/recovery-template-selection.js';
import {checkFinalTemplateRegistration,type FinalTemplateIdentity} from '../../src/services/recovery-template-integration/final-template-registration.service.js';
const url=process.env.TEST_DATABASE_URL;
const suite=url&&process.env.MODA_DISPOSABLE_INTEGRATION==='1'?describe:describe.skip;
suite('durable NBSP equivalence preserves raw selector/finalpermit domain',()=>{
 it('records hash-only evidence and admits only fresh equivalent content without rewriting frozen identities',async()=>{
  const db=new PrismaClient({datasourceUrl:url!}),suffix=randomUUID().replaceAll('-',''),name=`nbsp_${suffix}`;
  let adminId:string|undefined,definitionId:string|undefined,shopId:string|undefined,registrationId:string|undefined;
  const expected:MetaComponent[]=[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Boutique\u00a0: Exemple\nPanier\u00a0: {{1}}'},{type:'BUTTONS',buttons:[{type:'URL',text:'Voir\u00a0: panier',url:'https://example.invalid/{{1}}'}]}];
  const observed:MetaComponent[]=[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Boutique : Exemple\nPanier : {{1}}'},{type:'BUTTONS',buttons:[{type:'URL',text:'Voir : panier',url:'https://example.invalid/{{1}}'}]}];
  const bindings={headerMediaRole:'LOGO',header:[],body:[{position:1,variable:'checkout.url'}],buttons:[{index:0,subType:'url',variable:'checkout.url'}]};
  const submitted=fingerprint({schemaVersion:1,family:'META_RECOVERY',category:'MARKETING',components:expected,parameterBindings:bindings}),sourceHash=fingerprint({source:suffix});
  try{
   const admin=await db.platformAdmin.create({data:{email:`nbsp-${suffix}@example.invalid`}});adminId=admin.id;
   const def=await db.whatsAppTemplateDefinition.create({data:{kind:'META_RECOVERY',purpose:'FOLLOW_UP',offerType:'NO_OFFER',providerTemplateName:name,category:'MARKETING',sourceLanguageTag:'en',astSchemaVersion:1,sourceHash,status:'PUBLISHED',publishedAt:new Date(),createdByAdminId:admin.id}});definitionId=def.id;
   const locale=await db.whatsAppTemplateLocale.create({data:{definitionId:def.id,languageTag:'fr',providerLanguageCode:'fr',contentHash:submitted,status:'REVIEWED',reviewedAt:new Date(),reviewedByAdminId:admin.id}});
   const reg=await db.whatsAppTemplateMetaRegistration.create({data:{localeId:locale.id,wabaId:'123456789',providerTemplateName:name,providerLanguageCode:'fr',category:'MARKETING',componentsSnapshot:expected as never,parameterBindingsSnapshot:bindings,submittedContentHash:submitted,submissionState:'READY_TO_SUBMIT'}});registrationId=reg.id;
   const repo=new MetaTemplateRepository(db),claim=await repo.claim(reg.id,reg.wabaId);if(!claim)throw Error('claim');await repo.recordPostIntent(claim);await repo.finishSubmission(claim,{kind:'submitted',providerId:'987654321'});
   const shop=await db.shop.create({data:{domain:`nbsp-${suffix}.example.invalid`,status:'ACTIVE',defaultLanguageTag:'fr'}});shopId=shop.id;
   const variant=await db.whatsAppTemplateVariant.create({data:{shopId:shop.id,providerAccountId:reg.wabaId,purpose:'FOLLOW_UP_NO_OFFER',languageTag:'fr',providerLanguageCode:'fr',providerTemplateName:name,providerTemplateId:'987654321',metaRegistrationId:reg.id,status:'APPROVED',enabled:true}});
   let components=observed,category='MARKETING',id='987654321',status='APPROVED';
   const provider={verifyWaba:async()=>{},create:vi.fn(async()=>({id})),find:vi.fn(async()=>({kind:'found' as const,template:{wabaId:reg.wabaId,name,language:'fr',id,category,status,components}}))};
   const service=new MetaTemplateManagementService(repo,provider,{info:()=>{},warn:()=>{},error:()=>{}} as never);
   const identity:FinalTemplateIdentity={shopId:shop.id,senderWabaId:reg.wabaId,purpose:'FOLLOW_UP_NO_OFFER',variantId:variant.id,registrationId:reg.id,definitionId:def.id,providerTemplateId:'987654321',providerTemplateName:name,providerLanguageCode:'fr',submittedContentHash:submitted,bindingFingerprint:submitted};
   const permit=(value=identity)=>db.$transaction(tx=>checkFinalTemplateRegistration(tx,value,new Date()));
   const selection=async()=>{const catalogue=await new PrismaRecoveryTemplateRepository(db).readCatalogue({shopId:shop.id,senderWabaId:reg.wabaId,purpose:'FOLLOW_UP_NO_OFFER'});return selectRecoveryAssignment({shop:catalogue.shop!,shopId:shop.id,senderWabaId:reg.wabaId,purpose:'FOLLOW_UP_NO_OFFER',variants:catalogue.variants,stage:'FOLLOW_UP',offer:'NO_OFFER',conversationLanguageTag:'fr',merchantLanguageTag:'fr',platformFallbackEnabled:false,platformFallbackLanguageTag:null,logger:{warn:()=>{}} as never});};
   expect(await service.reconcileRegistration(reg.id)).toEqual({kind:'current',status:'APPROVED'});
   const row=await repo.load(reg.id);expect(row?.lastObservedContentHash).toBe(observedContentHash(expected));expect(row?.lastObservedContentHash).not.toBe(observedContentHash(observed));expect(row?.driftDetectedAt).toBeNull();
   const event=await db.whatsAppTemplateMetaEvent.findFirstOrThrow({where:{registrationId:reg.id,eventType:'RECONCILE'},orderBy:{receivedAt:'desc'}});
   expect(event.evidence).toEqual({normalizationKind:'U+00A0_TO_U+0020_TEXT_ONLY',rawObservedContentHash:observedContentHash(observed),expectedContentHash:observedContentHash(expected)});expect(event.outcome).toBe('CURRENT');
   expect(await selection()).toMatchObject({outcome:'selected'});expect(await permit()).toBeNull();
   expect(await db.$transaction(tx=>checkFinalTemplateRegistration(tx,identity,new Date(Date.now()+61*60000)))).toBe('TEMPLATE_PROVIDER_STATUS_STALE');
   expect(await permit({...identity,bindingFingerprint:'0'.repeat(64)})).toBe('TEMPLATE_REGISTRATION_UNAVAILABLE');
   const badEvidence={normalizationKind:'U+00A0_TO_U+0020_TEXT_ONLY' as const,rawObservedContentHash:observedContentHash(observed),expectedContentHash:'0'.repeat(64)};
   await expect(repo.recordReconciliation(row!,{kind:'found',providerId:id,status:'APPROVED',category,observedHash:observedContentHash(expected),drift:false,equivalenceEvidence:badEvidence})).rejects.toMatchObject({code:'INVALID_PROVIDER_EQUIVALENCE_EVIDENCE'});
   for(const change of ['body','url','category','provider-id'] as const){
    components=structuredClone(observed);category=change==='category'?'UTILITY':'MARKETING';id=change==='provider-id'?'111111111':'987654321';
    if(change==='body')components[1]={type:'BODY',text:'Autre panier {{1}}'};
    if(change==='url')components[2]={type:'BUTTONS',buttons:[{type:'URL',text:'Voir : panier',url:'https://other.invalid/{{1}}'}]};
    expect(await service.reconcileRegistration(reg.id)).toEqual({kind:'drift',status:'APPROVED'});
    expect(await selection()).toMatchObject({outcome:'unavailable'});expect(await permit()).toBe('TEMPLATE_PROVIDER_STATUS_UNRESOLVED');
    components=observed;category='MARKETING';id='987654321';expect(await service.reconcileRegistration(reg.id)).toEqual({kind:'current',status:'APPROVED'});expect(await permit()).toBeNull();
   }
   status='PAUSED';expect(await service.reconcileRegistration(reg.id)).toEqual({kind:'current',status:'PAUSED'});expect(await selection()).toMatchObject({outcome:'unavailable'});expect(await permit()).toBe('TEMPLATE_PROVIDER_STATUS_UNRESOLVED');
   status='APPROVED';await service.reconcileRegistration(reg.id);
   await db.whatsAppTemplateVariant.update({where:{id:variant.id},data:{enabled:false}});expect(await permit()).toBe('TEMPLATE_REGISTRATION_UNAVAILABLE');
   const frozen=await repo.load(reg.id);expect(frozen?.componentsSnapshot).toEqual(expected);expect(frozen?.parameterBindingsSnapshot).toEqual(bindings);expect(frozen?.submittedContentHash).toBe(submitted);expect(frozen?.locale.contentHash).toBe(submitted);expect(frozen?.locale.definition.sourceHash).toBe(sourceHash);expect(provider.create).not.toHaveBeenCalled();
  }finally{
   if(registrationId){await db.whatsAppTemplateMetaEvent.deleteMany({where:{registrationId}});await db.whatsAppTemplateVariant.deleteMany({where:{metaRegistrationId:registrationId}});await db.whatsAppTemplateMetaRegistration.delete({where:{id:registrationId}});}
   if(definitionId){await db.whatsAppTemplateLocale.deleteMany({where:{definitionId}});await db.whatsAppTemplateDefinition.delete({where:{id:definitionId}});}if(shopId)await db.shop.delete({where:{id:shopId}});if(adminId)await db.platformAdmin.delete({where:{id:adminId}});await db.$disconnect();
  }
 });
});
