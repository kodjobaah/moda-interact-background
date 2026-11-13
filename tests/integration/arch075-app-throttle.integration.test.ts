import { randomInt, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MetaAppOperationRepository, MetaAppSampleOperation, type MetaAppScope } from "../../src/services/meta-template-management/app-operation.js";
import { MetaImageHeaderSampleUploader } from "../../src/services/meta-template-management/image-header-sample.js";
import { MetaTemplateRepository } from "../../src/services/meta-template-management/repository.js";
import { MetaTemplateManagementService } from "../../src/services/meta-template-management/service.js";
import { MetaPreclaimRecovery } from "../../src/services/meta-template-management/preclaim-recovery.js";
import { MetaThrottlePreclaimRecovery, THROTTLE_ATTESTATION, type ExternalThrottleEvidence } from "../../src/services/meta-template-management/throttle-recovery.js";
import { readPackagedMetaTemplateSample } from "../../src/services/meta-template-management/sample-asset.js";
import { fingerprint } from "../../src/services/meta-template-management/contracts.js";
const pg=process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const proof={service:"moda-messaging-worker",reference:"synthetic:deployment"} as const;
const reporting={info(){},warn(){},error(){}};
async function fixture(run:(f:Awaited<ReturnType<typeof seed>>,db:PrismaClient)=>Promise<void>){
  const db=new PrismaClient({datasourceUrl:process.env.TEST_DATABASE_URL!}); const f=await seed(db);
  try{await run(f,db);}finally{
    const ids=(await db.whatsAppTemplateMetaRegistration.findMany({where:{locale:{definitionId:f.definition.id}},select:{id:true}})).map(r=>r.id);
    await db.whatsAppTemplateMetaEvent.deleteMany({where:{registrationId:{in:ids}}});
    await db.whatsAppTemplateMetaRegistration.deleteMany({where:{id:{in:ids}}});
    await db.whatsAppTemplateLocale.deleteMany({where:{definitionId:f.definition.id}});
    await db.whatsAppTemplateDefinition.delete({where:{id:f.definition.id}});
    await db.platformAdmin.delete({where:{id:f.admin.id}}); await db.$disconnect();
  }
}
async function seed(db:PrismaClient){
  const suffix=randomUUID().replaceAll("-",""); const scope:MetaAppScope={environment:"TEST",appId:String(randomInt(100000000,999999999))};
  const config={appId:scope.appId,wabaId:"123456789"};
  const admin=await db.platformAdmin.create({data:{email:`${suffix}@example.invalid`}});
  const definition=await db.whatsAppTemplateDefinition.create({data:{kind:"META_RECOVERY",purpose:"INITIAL",category:"MARKETING",providerTemplateName:`throttle_${suffix}`,
    sourceLanguageTag:"en",astSchemaVersion:1,sourceHash:"b".repeat(64),status:"SAVED",createdByAdminId:admin.id}});
  const add=async(language:string)=>{
    const locale=await db.whatsAppTemplateLocale.create({data:{definitionId:definition.id,languageTag:language,providerLanguageCode:language,
      contentHash:"a".repeat(64),status:"REVIEWED",reviewedAt:new Date(),reviewedByAdminId:admin.id}});
    return db.whatsAppTemplateMetaRegistration.create({data:{localeId:locale.id,wabaId:config.wabaId,providerTemplateName:definition.providerTemplateName!,providerLanguageCode:language,
      category:"MARKETING",componentsSnapshot:[{type:"HEADER",format:"IMAGE"},{type:"BODY",text:"Synthetic recovery"}],parameterBindingsSnapshot:{},
      submittedContentHash:"a".repeat(64),submissionState:"READY_TO_SUBMIT"}});
  };
  const rows=[await add("en"),await add("fr")];
  const repository=new MetaTemplateRepository(db);
  const evidence:ExternalThrottleEvidence={sha256:"d".repeat(64),reference:"protected:synthetic-evidence",attestation:THROTTLE_ATTESTATION,
    operation:"sample_session",httpStatus:403,providerErrorCode:4,registrationIds:rows.map(r=>r.id)};
  const recovery=new MetaThrottlePreclaimRecovery(db,async()=>config,()=>"TEST");
  return {scope,config,admin,definition,rows,add,repository,evidence,recovery};
}
async function historical(f:Awaited<ReturnType<typeof seed>>, db:PrismaClient){
  for(const row of f.rows)await f.repository.blockReadyRegistration(row.id,"META_APP_ID_MISSING_OR_INVALID");
  const old=new MetaPreclaimRecovery(db,async()=>f.config);
  const plan=await old.plan(f.rows.map(r=>r.id),"synthetic:operator",proof);
  await old.recover(plan.manifest,{apply:true,digest:plan.digest});
  for(const row of f.rows)await f.repository.blockReadyRegistration(row.id,"META_SAMPLE_SESSION_REJECTED");
}
pg("ARCH075 durable app-scoped sample throttle",()=>{
  it("admits one replica, fences stale generations and duplicate completion",async()=>{
    await fixture(async(f,db)=>{
      const repo=new MetaAppOperationRepository(db);
      const acquired=await Promise.allSettled([repo.acquire(f.scope),repo.acquire(f.scope)]);
      expect(acquired.filter(r=>r.status==="fulfilled")).toHaveLength(1);
      const lease=(acquired.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof repo.acquire>>>).value;
      await db.$executeRaw`UPDATE whatsapp."MetaTemplateAppOperationState" SET "leaseUntil"=clock_timestamp()+interval '10 milliseconds' WHERE environment='TEST'::commerce."CommerceEnvironment" AND "appId"=${f.scope.appId}`;
      await new Promise(resolve=>setTimeout(resolve,40));
      const next=await repo.acquire(f.scope);expect(next.generation).toBeGreaterThan(lease.generation);
      await expect(repo.verify(lease)).rejects.toMatchObject({code:"META_SAMPLE_LEASE_LOST"});
      await expect(repo.finish(lease,true)).rejects.toMatchObject({code:"META_SAMPLE_LEASE_LOST"});
      await repo.finish(next,true);
      await expect(repo.finish(next,true)).rejects.toMatchObject({code:"META_SAMPLE_LEASE_LOST"});
    });
  });
  it("persists bounded backoff/saturation, expiry admission and environment isolation",async()=>{
    await fixture(async(f,db)=>{
      const repo=new MetaAppOperationRepository(db);
      for(const count of [0,1,2,3,4,5,31]){
        const scope={...f.scope,appId:`${f.scope.appId}${count}`};
        await db.metaTemplateAppOperationState.create({data:{...scope,consecutiveThrottleCount:count,cooldownUntil:new Date(0),lastThrottleAt:new Date(0)}});
        const lease=await repo.acquire(scope);const start=Date.now();const until=await repo.throttle(lease);
        const expected=Math.min(21600,900*(2**Math.min(count,5)))*1000;
        expect(until.getTime()-start).toBeGreaterThanOrEqual(expected-2000);expect(until.getTime()-start).toBeLessThan(expected+2000);
        const state=await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:scope}});
        expect(state.consecutiveThrottleCount).toBe(Math.min(31,count+1));
        await expect(repo.acquire(scope)).rejects.toMatchObject({code:"META_SAMPLE_OPERATION_DEFERRED"});
        await expect(repo.throttle(lease)).rejects.toMatchObject({code:"META_SAMPLE_LEASE_LOST"});
        expect((await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:scope}})).consecutiveThrottleCount).toBe(state.consecutiveThrottleCount);
        const other=await repo.acquire({...scope,environment:"PRODUCTION"});await repo.finish(other,false);
      }
      const successfulScope={...f.scope,appId:`${f.scope.appId}88`};
      await db.metaTemplateAppOperationState.create({data:{...successfulScope,consecutiveThrottleCount:3,cooldownUntil:new Date(0),lastThrottleAt:new Date(0)}});
      const success=await repo.acquire(successfulScope);await repo.finish(success,true);
      expect((await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:successfulScope}})).consecutiveThrottleCount).toBe(0);
      const lease=await repo.acquire(f.scope);
      await db.metaTemplateAppOperationState.update({where:{environment_appId:f.scope},data:{consecutiveThrottleCount:3,cooldownUntil:new Date(Date.now()+900000)}});
      await expect(repo.finish(lease,true)).rejects.toMatchObject({code:"META_SAMPLE_LEASE_LOST"});
      expect((await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:f.scope}})).consecutiveThrottleCount).toBe(3);
    });
  });
  it("stops sample requests after first code4 across replicas/cycles and newly created rows, before intent",async()=>{
    await fixture(async(f,db)=>{
      const bytes=await readPackagedMetaTemplateSample();let calls=0;let reads=0;
      const uploader=new MetaImageHeaderSampleUploader((async()=>{calls++;return new Response(JSON.stringify({error:{code:4,message:"synthetic"}}),{status:403});}) as typeof fetch,
        {read:async()=>{reads++;return {bytes,declaredContentType:"image/jpeg"};}});
      const provider={verifyWaba:async()=>undefined,
        uploadImageHeaderSample:async()=>new MetaAppSampleOperation(new MetaAppOperationRepository(db)).run(f.scope,(signal,beforeHttp)=>uploader.upload({appId:f.scope.appId,accessToken:"synthetic",graphBase:"https://example.invalid",signal,beforeHttp})),
        find:async()=>{throw new Error("unexpected template GET");},create:async()=>{throw new Error("unexpected template POST");}};
      const service=new MetaTemplateManagementService(f.repository,provider,reporting as never);
      await service.processDueRegistrations(25);expect(calls).toBe(1);expect(reads).toBe(1);
      const state=await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:f.scope}});
      const rows=await db.whatsAppTemplateMetaRegistration.findMany({where:{id:{in:f.rows.map(r=>r.id)}}});
      expect(rows.every(r=>r.submissionState==="READY_TO_SUBMIT" && r.nextRetryAt!>=state.cooldownUntil! && !r.lastSubmittedAt)).toBe(true);
      const event=await db.whatsAppTemplateMetaEvent.findFirstOrThrow({where:{registrationId:{in:f.rows.map(r=>r.id)},eventType:"SAMPLE_APP_THROTTLED"}});
      expect(event).toMatchObject({httpStatus:403,evidence:{appId:f.scope.appId,environment:"TEST",providerErrorCode:4,operation:"sample_session"}});
      const second=new MetaTemplateManagementService(new MetaTemplateRepository(db),provider,reporting as never);
      await second.processDueRegistrations(25);const added=await f.add("de");await second.processDueRegistrations(25);
      expect(calls).toBe(1);expect(reads).toBe(1);
      expect((await f.repository.load(added.id))!.nextRetryAt!>=state.cooldownUntil!).toBe(true);
      expect(await db.whatsAppTemplateMetaEvent.count({where:{registrationId:{in:[...f.rows.map(r=>r.id),added.id]},eventType:{in:["CREATE_INTENT","POST_INTENT"]}}})).toBe(0);
      // Direct calls must also respect future per-registration due state.
      expect(await service.submitPreparedRegistration(added.id)).toEqual({kind:"busy",code:"NOT_DUE_TO_SUBMIT"});expect(calls).toBe(1);
    });
  });
  it("recovers only exact externally attested historical cohort, retains BG005 provenance and seeds one cooldown",async()=>{
    await fixture(async(f,db)=>{
      await historical(f,db);const ids=f.rows.map(r=>r.id);const plan=await f.recovery.plan(ids,"synthetic:operator",proof,f.evidence);
      expect(await db.metaTemplateAppOperationState.count({where:f.scope})).toBe(0);
      expect((await f.recovery.recover(plan.manifest)).mode).toBe("dry-run");expect(await db.metaTemplateAppOperationState.count({where:f.scope})).toBe(0);
      await expect(f.recovery.recover(plan.manifest,{apply:true,digest:"0".repeat(64)})).rejects.toMatchObject({code:"RECOVERY_DIGEST_MISMATCH"});
      await f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest});
      const state=await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:f.scope}});expect(state.consecutiveThrottleCount).toBe(1);
      const rows=await db.whatsAppTemplateMetaRegistration.findMany({where:{id:{in:ids}}});expect(rows.every(r=>r.nextRetryAt!.getTime()===state.cooldownUntil!.getTime()&&r.submissionState==="READY_TO_SUBMIT")).toBe(true);
      expect(await db.whatsAppTemplateMetaEvent.count({where:{registrationId:{in:ids}}})).toBe(8);
      expect((await f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest})).outcome).toBe("already-applied");
      expect((await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:f.scope}})).cooldownUntil).toEqual(state.cooldownUntil);
      expect(await db.whatsAppTemplateMetaEvent.count({where:{registrationId:{in:ids}}})).toBe(8);
    });
  });
  it.each(["CREATE_INTENT","POST_INTENT","CREATE_RESULT","UNRECOGNIZED"])("refuses historical %s evidence",async(eventType)=>{
    await fixture(async(f,db)=>{
      await historical(f,db);const plan=await f.recovery.plan(f.rows.map(r=>r.id),"synthetic:operator",proof,f.evidence);
      await db.whatsAppTemplateMetaEvent.create({data:{eventIdentity:randomUUID(),registrationId:f.rows[0]!.id,source:"BACKGROUND",eventType,wabaId:f.config.wabaId}});
      await expect(f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest})).rejects.toThrow();expect(await db.metaTemplateAppOperationState.count({where:f.scope})).toBe(0);
    });
  });
  it("rejects missing/incorrect attestations, exact IDs, configuration and changed source/state",async()=>{
    await fixture(async(f,db)=>{
      await historical(f,db);const ids=f.rows.map(r=>r.id);
      for(const bad of [{...f.evidence,attestation:""},{...f.evidence,providerErrorCode:190},{...f.evidence,registrationIds:ids.slice(1)},{...f.evidence,sha256:"bad"}])
        await expect(f.recovery.plan(ids,"synthetic:operator",proof,bad as never)).rejects.toThrow();
      const plan=await f.recovery.plan(ids,"synthetic:operator",proof,f.evidence);
      const foreign=new MetaThrottlePreclaimRecovery(db,async()=>({...f.config,appId:"999"}),()=>"TEST");await expect(foreign.recover(plan.manifest)).rejects.toMatchObject({code:"RECOVERY_CONFIGURATION_CHANGED"});
      await db.whatsAppTemplateMetaRegistration.update({where:{id:ids[0]},data:{providerTemplateId:"555"}});
      await expect(f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest})).rejects.toMatchObject({code:"RECOVERY_NOT_PROVEN_PRECLAIM"});
      expect(await db.metaTemplateAppOperationState.count({where:f.scope})).toBe(0);
    });
  });
  it("refuses stale/source changes, forged old recovery provenance and active lease",async()=>{
    await fixture(async(f,db)=>{
      await historical(f,db);const ids=f.rows.map(r=>r.id);const plan=await f.recovery.plan(ids,"synthetic:operator",proof,f.evidence);
      const stale={...plan.manifest,preclaim:{...plan.manifest.preclaim,entries:plan.manifest.preclaim.entries.map((entry,i)=>i===0?{...entry,updatedAt:new Date(0).toISOString()}:entry)}};
      await expect(f.recovery.recover(stale,{apply:true,digest:fingerprint(stale)})).rejects.toMatchObject({code:"RECOVERY_SNAPSHOT_CHANGED"});
      const leaseRepo=new MetaAppOperationRepository(db);const lease=await leaseRepo.acquire(f.scope);
      await expect(f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest})).rejects.toMatchObject({code:"RECOVERY_APP_LEASE_BUSY"});await leaseRepo.finish(lease,false);
      const old=await db.whatsAppTemplateMetaEvent.findFirstOrThrow({where:{registrationId:ids[0],eventType:"PRECLAIM_APP_RECOVERY"}});
      await db.whatsAppTemplateMetaEvent.update({where:{id:old.id},data:{requestDigest:"f".repeat(64)}});
      await expect(f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest})).rejects.toMatchObject({code:"RECOVERY_SUBMISSION_EVIDENCE"});
      await db.whatsAppTemplateMetaEvent.update({where:{id:old.id},data:{requestDigest:old.requestDigest}});
      await db.whatsAppTemplateLocale.update({where:{id:f.rows[0]!.localeId},data:{status:"SOURCE_SAVED"}});
      await expect(f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest})).rejects.toMatchObject({code:"RECOVERY_SOURCE_NOT_REVIEWED"});
      expect((await f.repository.load(ids[1]!))!.submissionState).toBe("BLOCKED");
    });
  });
  it("serializes concurrent historical apply and refuses unknown evidence on replay",async()=>{
    await fixture(async(f,db)=>{
      await historical(f,db);const plan=await f.recovery.plan(f.rows.map(r=>r.id),"synthetic:operator",proof,f.evidence);
      const outcomes=await Promise.allSettled([1,2].map(()=>f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest})));
      expect(outcomes.some(result=>result.status==="fulfilled")).toBe(true);
      expect(await db.whatsAppTemplateMetaEvent.count({where:{registrationId:{in:f.rows.map(r=>r.id)},eventType:"PRECLAIM_THROTTLE_RECOVERY"}})).toBe(2);
      expect((await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:f.scope}})).consecutiveThrottleCount).toBe(1);
      await db.whatsAppTemplateMetaEvent.create({data:{eventIdentity:randomUUID(),registrationId:f.rows[0]!.id,wabaId:f.config.wabaId,source:"BACKGROUND",eventType:"POST_INTENT"}});
      await expect(f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest})).rejects.toMatchObject({code:"RECOVERY_SUBMISSION_EVIDENCE"});
    });
  });
  it("rolls back app seed and whole cohort on audit failure/CAS loss; never shortens existing cooldown",async()=>{
    await fixture(async(f,db)=>{
      await historical(f,db);const plan=await f.recovery.plan(f.rows.map(r=>r.id),"synthetic:operator",proof,f.evidence);
      const failing=db.$extends({query:{whatsAppTemplateMetaEvent:{create(){throw new Error("synthetic audit failure");}}}});
      await expect(new MetaThrottlePreclaimRecovery(failing as never,async()=>f.config,()=>"TEST").recover(plan.manifest,{apply:true,digest:plan.digest})).rejects.toThrow("synthetic audit failure");
      expect(await db.metaTemplateAppOperationState.count({where:f.scope})).toBe(0);
      expect((await f.repository.load(f.rows[0]!.id))!.submissionState).toBe("BLOCKED");
      const stale=db.$extends({query:{whatsAppTemplateMetaRegistration:{updateMany(){return {count:0};}}}});
      await expect(new MetaThrottlePreclaimRecovery(stale as never,async()=>f.config,()=>"TEST").recover(plan.manifest,{apply:true,digest:plan.digest})).rejects.toMatchObject({code:"RECOVERY_CAS_LOST"});
      expect(await db.metaTemplateAppOperationState.count({where:f.scope})).toBe(0);
      const until=new Date(Date.now()+21600000);await db.metaTemplateAppOperationState.create({data:{...f.scope,cooldownUntil:until,consecutiveThrottleCount:7,lastThrottleAt:new Date()}});
      await f.recovery.recover(plan.manifest,{apply:true,digest:plan.digest});
      const state=await db.metaTemplateAppOperationState.findUniqueOrThrow({where:{environment_appId:f.scope}});expect(state.cooldownUntil).toEqual(until);expect(state.consecutiveThrottleCount).toBe(7);
      const changed={...plan.manifest,externalEvidence:{...plan.manifest.externalEvidence,reference:"another:reference"}};
      await expect(f.recovery.recover(changed,{apply:true,digest:fingerprint(changed)})).rejects.toThrow();
    });
  });
});
