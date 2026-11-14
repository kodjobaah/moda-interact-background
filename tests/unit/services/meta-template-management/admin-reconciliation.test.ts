import {describe,it,expect,vi} from 'vitest';
import {adminReconciliationMatches,type AdminReconciliationRequest} from '../../../../src/services/meta-template-management/admin-reconciliation.js';
import type {RegistrationWithLocale} from '../../../../src/services/meta-template-management/repository.js';
import {MetaTemplateRepository} from '../../../../src/services/meta-template-management/repository.js';
const hash='a'.repeat(64),now=new Date('2026-11-14T16:00:00Z');
const row={id:'registration',submissionState:'SUBMITTED',submittedContentHash:hash,wabaId:'123456789',providerTemplateId:'987654321',providerTemplateName:'template_name',providerLanguageCode:'fr',locale:{contentHash:hash,providerLanguageCode:'fr'}} as RegistrationWithLocale;
const request:AdminReconciliationRequest={id:'request',registrationId:row.id,source:'ADMIN',eventType:'RECONCILE_REQUESTED',processedAt:null,wabaId:row.wabaId,providerTemplateId:row.providerTemplateId,providerTemplateName:row.providerTemplateName,providerLanguageCode:'fr',requestDigest:hash};
describe('durable Admin reconciliation command identity and discovery',()=>{
 it('accepts only the frozen exact submitted identity',()=>expect(adminReconciliationMatches(row,request)).toBe(true));
 it.each(['registrationId','source','eventType','wabaId','providerTemplateId','providerTemplateName','providerLanguageCode','requestDigest'] as const)('rejects changed %s without repair/coercion',key=>expect(adminReconciliationMatches(row,{...request,[key]:'other'})).toBe(false));
 it('rejects processed, never-submitted and no-longer-frozen requests',()=>{
  expect(adminReconciliationMatches(row,{...request,processedAt:now})).toBe(false);
  expect(adminReconciliationMatches({...row,submissionState:'READY_TO_SUBMIT'},request)).toBe(false);
  expect(adminReconciliationMatches({...row,locale:{...row.locale,contentHash:'b'.repeat(64)}},request)).toBe(false);
 });
 it('merges bounded oldest due/request rows, deduplicates registrations, and carries only selected receipt IDs',async()=>{
  const findMany=vi.fn(async()=>[{id:'scheduled',submissionState:'SUBMITTED',nextRetryAt:new Date(+now-3000),createdAt:now},{id:'requested',submissionState:'SUBMITTED',nextRetryAt:new Date(+now-1000),createdAt:now}]);
  const events=vi.fn(async()=>[{id:'old',registrationId:'requested',receivedAt:new Date(+now-2000),registration:{submissionState:'SUBMITTED'}},{id:'new',registrationId:'requested',receivedAt:now,registration:{submissionState:'SUBMITTED'}}]);
  const repo=new MetaTemplateRepository({whatsAppTemplateMetaRegistration:{findMany},whatsAppTemplateMetaEvent:{findMany:events}} as never,()=>now);
  expect(await repo.listDue(2)).toEqual([{id:'scheduled',submissionState:'SUBMITTED'},{id:'requested',submissionState:'SUBMITTED',adminReceiptIds:['old','new']}]);
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({take:2}));expect(events).toHaveBeenCalledWith(expect.objectContaining({take:2,orderBy:[{receivedAt:'asc'},{id:'asc'}]}));
 });
});
