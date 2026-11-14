import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {describe,it,expect,vi} from 'vitest';
import {MetaTemplateRepository} from '../../src/services/meta-template-management/repository.js';
import {MetaTemplateManagementService} from '../../src/services/meta-template-management/service.js';
import {MetaManagementError,fingerprint} from '../../src/services/meta-template-management/contracts.js';
const url=process.env.TEST_DATABASE_URL;
const suite=url&&process.env.MODA_DISPOSABLE_INTEGRATION==='1'?describe:describe.skip;
async function fixture(ready=false){
 const db=new PrismaClient({datasourceUrl:url!}),suffix=randomUUID().replaceAll('-',''),name=`admin_${suffix}`;
 let now=new Date();const components=[{type:'BODY',text:'Votre panier {{1}}'}],hash=fingerprint({components});
 const admin=await db.platformAdmin.create({data:{email:`admin-request-${suffix}@example.invalid`}});
 const definition=await db.whatsAppTemplateDefinition.create({data:{kind:'META_RECOVERY',purpose:'FOLLOW_UP',offerType:'NO_OFFER',providerTemplateName:name,category:'MARKETING',sourceLanguageTag:'en',astSchemaVersion:1,sourceHash:fingerprint({suffix}),status:'PUBLISHED',publishedAt:now,createdByAdminId:admin.id}});
 const locale=await db.whatsAppTemplateLocale.create({data:{definitionId:definition.id,languageTag:'fr',providerLanguageCode:'fr',contentHash:hash,status:'REVIEWED',reviewedAt:now,reviewedByAdminId:admin.id}});
 const registration=await db.whatsAppTemplateMetaRegistration.create({data:{localeId:locale.id,wabaId:'123456789',providerTemplateName:name,providerLanguageCode:'fr',category:'MARKETING',componentsSnapshot:components,parameterBindingsSnapshot:{},submittedContentHash:hash,submissionState:'READY_TO_SUBMIT'}});
 const repo=new MetaTemplateRepository(db,()=>now);if(!ready){const claim=await repo.claim(registration.id,registration.wabaId);if(!claim)throw Error('claim');await repo.recordPostIntent(claim);await repo.finishSubmission(claim,{kind:'submitted',providerId:'987654321'});}
 await db.whatsAppTemplateMetaRegistration.update({where:{id:registration.id},data:{lastReconciledAt:now,nextRetryAt:new Date(+now+6*3600000)}});
 const control:{fail?:boolean;onFind?:()=>Promise<void>}={};
 const provider={verifyWaba:vi.fn(async()=>{}),create:vi.fn(async()=>({id:'987654321'})),find:vi.fn(async()=>{if(control.onFind)await control.onFind();if(control.fail)throw new MetaManagementError('META_TRANSPORT_UNKNOWN','uncertain');return {kind:'found' as const,template:{wabaId:registration.wabaId,name,language:'fr',id:'987654321',category:'MARKETING',status:'APPROVED',components}};})};
 const service=new MetaTemplateManagementService(repo,provider,{info:()=>{},warn:()=>{},error:()=>{}} as never);
 const request=(overrides:Record<string,unknown>={})=>db.whatsAppTemplateMetaEvent.create({data:{eventIdentity:`admin_reconcile_${randomUUID()}`,registrationId:registration.id,source:'ADMIN',eventType:'RECONCILE_REQUESTED',wabaId:registration.wabaId,providerTemplateId:'987654321',providerTemplateName:name,providerLanguageCode:'fr',requestDigest:hash,receivedAt:now,...overrides}});
 return {db,repo,service,provider,control,registration,locale,request,advance:(ms:number)=>{now=new Date(+now+ms);},close:async()=>{await db.whatsAppTemplateMetaEvent.deleteMany({where:{registrationId:registration.id}});await db.whatsAppTemplateMetaRegistration.delete({where:{id:registration.id}});await db.whatsAppTemplateLocale.delete({where:{id:locale.id}});await db.whatsAppTemplateDefinition.delete({where:{id:definition.id}});await db.platformAdmin.delete({where:{id:admin.id}});await db.$disconnect();}};
}
suite('durable Admin Meta reconciliation through normal bounded timer',()=>{
 it('refreshes a future-six-hour submitted registration and exact receipt without CREATE, then replay is idle',async()=>{
  const f=await fixture();try{expect(await f.repo.listDue()).toEqual([]);const request=await f.request();
   expect(await f.service.processDueRegistrations(1)).toEqual({inspected:1,processed:1});
   expect(await f.repo.load(f.registration.id)).toMatchObject({providerStatus:'APPROVED',failureCode:null});
   expect(await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:request.id}})).toMatchObject({processedAt:expect.any(Date),outcome:'RECONCILED'});
   expect(await f.service.processDueRegistrations(1)).toEqual({inspected:0,processed:0});expect(f.provider.find).toHaveBeenCalledOnce();expect(f.provider.create).not.toHaveBeenCalled();
  }finally{await f.close();}
 });
 it('concurrent workers may GET twice but commit exactly one projection/event and covered receipt',async()=>{
  const f=await fixture();try{const request=await f.request();let entered=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.control.onFind=async()=>{if(++entered===2)release();await gate;};
   const results=await Promise.all([f.service.processDueRegistrations(1),f.service.processDueRegistrations(1)]);
   expect(results.reduce((sum,result)=>sum+result.processed,0)).toBe(1);expect(f.provider.find).toHaveBeenCalledTimes(2);expect(f.provider.create).not.toHaveBeenCalled();
   expect(await f.db.whatsAppTemplateMetaEvent.count({where:{registrationId:f.registration.id,eventType:'RECONCILE'}})).toBe(1);
   expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:request.id}})).processedAt).not.toBeNull();
  }finally{await f.close();}
 });
 it('does not consume a newer request inserted during the authoritative observation',async()=>{
  const f=await fixture();try{const first=await f.request();let newer:string|undefined;f.control.onFind=async()=>{f.control.onFind=undefined;newer=(await f.request()).id;};
   await f.service.processDueRegistrations(1);expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:first.id}})).processedAt).not.toBeNull();
   expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:newer!}})).processedAt).toBeNull();
   await f.service.processDueRegistrations(1);expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:newer!}})).processedAt).not.toBeNull();expect(f.provider.find).toHaveBeenCalledTimes(2);
  }finally{await f.close();}
 });
 it.each(['wabaId','providerTemplateId','providerTemplateName','providerLanguageCode','requestDigest'] as const)('rejects mismatched %s without Graph or success and leaves a later valid request usable',async key=>{
  const f=await fixture();try{const invalid=await f.request({[key]:'invalid'});expect(await f.service.processDueRegistrations(1)).toEqual({inspected:1,processed:0});
   expect(await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:invalid.id}})).toMatchObject({outcome:'REJECTED',processedAt:expect.any(Date),failureCode:'ADMIN_RECONCILE_IDENTITY_STALE'});expect(f.provider.find).not.toHaveBeenCalled();expect(f.provider.verifyWaba).not.toHaveBeenCalled();
   const valid=await f.request();await f.service.processDueRegistrations(1);expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:valid.id}})).outcome).toBe('RECONCILED');expect(f.provider.create).not.toHaveBeenCalled();
  }finally{await f.close();}
 });
 it('a never-submitted request cannot turn the normal timer into a CREATE path',async()=>{
  const f=await fixture(true);try{const request=await f.request({providerTemplateId:null});expect(await f.service.processDueRegistrations(1)).toEqual({inspected:1,processed:0});
   expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:request.id}})).outcome).toBe('REJECTED');
   expect(f.provider.find).not.toHaveBeenCalled();expect(f.provider.create).not.toHaveBeenCalled();expect((await f.repo.load(f.registration.id))?.submissionState).toBe('READY_TO_SUBMIT');
  }finally{await f.close();}
 });
 it('an externally handled selected receipt cannot authorize a later projection or be consumed again',async()=>{
  const f=await fixture();try{const request=await f.request();f.control.onFind=async()=>{await f.db.whatsAppTemplateMetaEvent.update({where:{id:request.id},data:{processedAt:new Date(),outcome:'REJECTED'}});};
   expect(await f.service.processDueRegistrations(1)).toEqual({inspected:1,processed:0});expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:request.id}})).outcome).toBe('REJECTED');
   expect(await f.db.whatsAppTemplateMetaEvent.count({where:{registrationId:f.registration.id,eventType:'RECONCILE'}})).toBe(0);
  }finally{await f.close();}
 });
 it('provider failure retains pending command and durable backoff before a successful later timer',async()=>{
  const f=await fixture();try{const request=await f.request();f.control.fail=true;await expect(f.service.processDueRegistrations(1)).rejects.toThrow('Meta template due processing failed');
   expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:request.id}})).processedAt).toBeNull();expect(await f.repo.load(f.registration.id)).toMatchObject({providerStatus:'UNKNOWN',failureCode:'PROVIDER_RECONCILIATION_FAILED'});
   expect(await f.service.processDueRegistrations(1)).toEqual({inspected:0,processed:0});expect(f.provider.find).toHaveBeenCalledOnce();
   f.advance(61000);f.control.fail=false;await f.service.processDueRegistrations(1);expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:request.id}})).outcome).toBe('RECONCILED');expect(f.provider.find).toHaveBeenCalledTimes(2);expect(f.provider.create).not.toHaveBeenCalled();
  }finally{await f.close();}
 });
 it('a concurrent registration update rejects stale status and leaves its command pending',async()=>{
  const f=await fixture();try{const request=await f.request();f.control.onFind=async()=>{await f.db.whatsAppTemplateMetaRegistration.update({where:{id:f.registration.id},data:{providerStatus:'PAUSED',updatedAt:new Date(Date.now()+1000)}});};
   expect(await f.service.processDueRegistrations(1)).toEqual({inspected:1,processed:0});expect((await f.repo.load(f.registration.id))?.providerStatus).toBe('PAUSED');expect((await f.db.whatsAppTemplateMetaEvent.findUniqueOrThrow({where:{id:request.id}})).processedAt).toBeNull();expect(await f.db.whatsAppTemplateMetaEvent.count({where:{registrationId:f.registration.id,eventType:'RECONCILE'}})).toBe(0);
  }finally{await f.close();}
 });
});
