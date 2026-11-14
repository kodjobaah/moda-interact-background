import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {type PreparedWrapper,type CommonRecoveryLayoutReference} from '@modainteract/moda-interact-shared/commerce/presentation';
import {humanDispatchFixture} from './fixtures/recovery-human-dispatch.fixture.js';
import {currentCommonReferenceMatches} from '../../src/services/recovery-multipart/common-layout.js';
import {digest,stableJson} from '../../src/services/conversation-wrappers/projection.js';
const suite=process.env.TEST_DATABASE_URL&&process.env.REDIS_URL&&process.env.MODA_DISPOSABLE_INTEGRATION==='1'?describe:describe.skip;
suite('app common footer policy with actual locked source',()=>{
 it('accepts reviewed website-caption source and refuses stale/tampered or business-invalid snapshots',async()=>{
  const f=await humanDispatchFixture('common-footer-policy');let adminId:string|undefined;const definitions:string[]=[];
  try{
   adminId=randomUUID();await f.db.platformAdmin.create({data:{id:adminId,email:`policy-${adminId}@example.test`,role:'SUPER_ADMIN'}});
   const prepared:PreparedWrapper={schemaVersion:1,family:'MODA_CONVERSATION_WRAPPER',responseSlot:'response.body',header:[{kind:'text',value:'Shop: '},{kind:'variable',name:'shop.name'},{kind:'text',value:'\n──────────'}],body:[{kind:'responseSlot',name:'response.body'}],footer:[],conditionals:[{when:'checkout.available',tokens:[{kind:'text',value:'Website: '},{kind:'variable',name:'shop.websiteUrl'},{kind:'text',value:'\nCheckout:\n'},{kind:'variable',name:'checkout.url'}]}]};
   const save=async(p:PreparedWrapper)=>{
    const def=await f.db.whatsAppTemplateDefinition.create({data:{kind:'MODA_CONVERSATION_WRAPPER',audience:'SHARED',status:'PUBLISHED',publishedAt:new Date(),sourceLanguageTag:'en',astSchemaVersion:1,sourceHash:digest(randomUUID()),createdByAdminId:adminId!}});definitions.push(def.id);
    const locale=await f.db.whatsAppTemplateLocale.create({data:{definitionId:def.id,languageTag:'en',status:'SOURCE_SAVED',contentHash:digest(stableJson(p)),localeAst:{schemaVersion:1,prepared:p}}});
    return {schemaVersion:1,definitionId:def.id,sourceHash:def.sourceHash,localeId:locale.id,languageTag:'en',contentHash:locale.contentHash!,prepared:p} satisfies CommonRecoveryLayoutReference;
   };
   const ref=await save(prepared);await f.db.whatsAppConversationWrapperActiveSlot.create({data:{audience:'SHARED',definitionId:ref.definitionId,editVersion:1,updatedByAdminId:adminId}});
   const matches=(r:CommonRecoveryLayoutReference,version=1)=>f.db.$transaction(tx=>currentCommonReferenceMatches(tx,r,version));
   expect(await matches(ref)).toBe(true);expect(await matches(ref,2)).toBe(false);
   expect(await matches({...ref,sourceHash:'0'.repeat(64)})).toBe(false);
   expect(await matches({...ref,contentHash:'0'.repeat(64)})).toBe(false);
   const invalid=structuredClone(prepared);invalid.header.push({kind:'variable',name:'customer.firstName'});
   const bad=await save(invalid);await f.db.whatsAppConversationWrapperActiveSlot.update({where:{audience:'SHARED'},data:{definitionId:bad.definitionId,editVersion:2}});
   expect(await matches(bad,2)).toBe(false);expect(await matches(ref)).toBe(false);
  }finally{
   await f.db.whatsAppConversationWrapperActiveSlot.deleteMany({where:{definitionId:{in:definitions}}});
   await f.db.whatsAppTemplateLocale.deleteMany({where:{definitionId:{in:definitions}}});
   await f.db.whatsAppTemplateDefinition.deleteMany({where:{id:{in:definitions}}});
   if(adminId)await f.db.platformAdmin.delete({where:{id:adminId}});await f.close();
  }
 });
});
