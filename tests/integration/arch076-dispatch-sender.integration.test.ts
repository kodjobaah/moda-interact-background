import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import { sha256 } from "../../src/services/recovery-multipart/frozen.js";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const config = vi.hoisted(() => ({ rowId:"", version:1, account:"9001", phone:"8001" }));
vi.mock("../../src/services/platform-configuration/consumers.js", async (importOriginal) => ({...await importOriginal<Record<string,unknown>>(),platformConsumerConfiguration:{read:async()=>({rowId:config.rowId,version:config.version,value:{businessAccountId:config.account,phoneNumberId:config.phone,accessToken:"fixture-token"}})}}));
import { seedWooInitialPermit } from "./fixtures/woo-initial-send-fence.fixture.js";
import { WooInitialSendFenceService } from "../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";
vi.mock("../../src/runtime/deployment-environment.js", () => ({resolveDeploymentEnvironmentName:()=>"test"}));
import { GeneralOutboundSendFenceService } from "../../src/services/outbound-whatsapp-admission/general-outbound-send-fence.service.js";
import { checkDispatchSender, readDispatchSenderSnapshot } from "../../src/services/recovery-sender-pool/dispatch-sender.js";
import { RecoverySenderPoolService } from "../../src/services/recovery-sender-pool/sender-pool.service.js";
import { WhatsAppService } from "../../src/services/whatsapp.service.js";
const suite=process.env.MODA_DISPOSABLE_INTEGRATION==='1'&&process.env.TEST_DATABASE_URL?describe:describe.skip;
suite('ARCH076 dispatch identity and enrollment serialization',()=>{
 const db=new PrismaClient({datasourceUrl:process.env.TEST_DATABASE_URL!}); const shops:string[]=[]; const recipients:string[]=[];
 const phone='8001', account='9001'; const now=new Date();
 async function fixture(recovery=false){const shop=randomUUID();shops.push(shop);await db.shop.create({data:{id:shop,domain:`${shop}.fixture.test`}});const r=recovery?await db.checkoutRecovery.create({data:{shopId:shop,checkoutToken:randomUUID(),status:'MESSAGE_SENT',lastExternalActivityAt:now}}):null;const c=await db.conversation.create({data:{shopId:shop,...(r?{checkoutRecoveryId:r.id,type:'RECOVERY' as const}:{type:'PRODUCT_SUPPORT' as const}),controlMode:'AI'}});const m=await db.conversationMessage.create({data:{conversationId:c.id,direction:'OUTBOUND',senderType:'AGENT',status:'PENDING',content:'fixture answer'}});return {shop,c,m,r};}
 const input=(f:Awaited<ReturnType<typeof fixture>>)=>({shopId:f.shop,conversationId:f.c.id,messageId:f.m.id,recipient:'447700900001',expectedContent:'fixture answer'});
 beforeAll(async()=>{const row=await db.platformConfiguration.upsert({where:{environment_key:{environment:'test',key:'messaging.sender'}},create:{environment:'test',key:'messaging.sender',value:{fixture:true}},update:{version:1}});config.rowId=row.id;await db.backgroundRuntimeConfig.upsert({where:{id:'default'},create:{id:'default',checkoutRecoveryLifetimeDays:30},update:{checkoutRecoveryLifetimeDays:30}});});
 afterAll(async()=>{await db.$disconnect();});

 it('actual standalone permit stamps sender once; restart replay cannot dispatch again',async()=>{const f=await fixture();const service=new GeneralOutboundSendFenceService(db);const p=await service.admitFinalSend(input(f));expect(p).toEqual({kind:'admitted',sender:{providerAccountId:account,providerPhoneNumberId:phone}});expect(await new GeneralOutboundSendFenceService(db).admitFinalSend(input(f))).toEqual({kind:'suppressed',reason:'already-admitted-or-sent'});expect(await db.conversationMessage.findUnique({where:{id:f.m.id}})).toMatchObject({dispatchProviderAccountId:account,dispatchProviderPhoneNumberId:phone});});
 it('disabled inventory prevents new standalone permits',async()=>{await db.whatsAppPoolSender.create({data:{providerPhoneNumberId:phone,providerAccountId:account,verifiedAt:now,allocationEnabled:false}});const f=await fixture();expect((await new GeneralOutboundSendFenceService(db).admitFinalSend(input(f))).kind).toBe('suppressed');expect((await db.conversationMessage.findUniqueOrThrow({where:{id:f.m.id}})).providerDispatchKey).toBeNull();await db.whatsAppPoolSender.delete({where:{providerPhoneNumberId:phone}});});
 it('first disabled enrollment wins the membership lock and blocks actual standalone permit',async()=>{const racePhone='8005';config.phone=racePhone;const f=await fixture();let release!:()=>void;let locked!:()=>void;const ready=new Promise<void>(r=>locked=r);const gate=new Promise<void>(r=>release=r);const enrollment=db.$transaction(async tx=>{await tx.$queryRawUnsafe(`WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended('whatsapp-pool-membership:'||$1::text,0))) SELECT COUNT(*)::integer FROM locked`,racePhone);await tx.whatsAppPoolSender.create({data:{providerPhoneNumberId:racePhone,providerAccountId:account,verifiedAt:now,allocationEnabled:false}});locked();await gate;},{timeout:15000});await ready;const permit=new GeneralOutboundSendFenceService(db).admitFinalSend(input(f));release();await enrollment;expect((await permit).kind).toBe('suppressed');await db.whatsAppPoolSender.delete({where:{providerPhoneNumberId:racePhone}});config.phone=phone;});
 it('pooled assignment pins exact phone despite drain; current singleton is never selected',async()=>{await db.whatsAppPoolSender.create({data:{providerPhoneNumberId:'8002',providerAccountId:account,verifiedAt:now,allocationEnabled:true}});const f=await fixture(true);const to='447700900002';recipients.push(to);const pool=new RecoverySenderPoolService(db,()=>now,async()=>({accountId:account,rowId:config.rowId,version:1,environment:'test'}));expect((await pool.allocate({conversationId:f.c.id,canonicalRecipient:to})).kind).toBe('assigned');const second=await fixture(true);const secondTo='447700900003';recipients.push(secondTo);expect((await pool.allocate({conversationId:second.c.id,canonicalRecipient:secondTo})).kind).toBe('assigned');await db.whatsAppPoolSender.update({where:{providerPhoneNumberId:'8002'},data:{allocationEnabled:false}});const snapshot=await readDispatchSenderSnapshot();const check=(recipient=to,snap=snapshot)=>db.$transaction(tx=>checkDispatchSender(tx,{snapshot:snap,conversationId:f.c.id,recipient,recovery:true}));expect(await check()).toEqual({providerAccountId:account,providerPhoneNumberId:'8002'});expect(await check('447700900003')).toBeNull();expect(await check(to,{...snapshot,providerAccountId:'9999'})).toBeNull();const requests:RequestInfo[]=[];const provider=new WhatsAppService((async(url)=>{requests.push(url as RequestInfo);return new Response(JSON.stringify({messages:[{id:'wamid-fixture'}]}),{status:200});}) as typeof fetch,{error:()=>{}});await provider.sendWhatsAppText({to,text:'fixture answer',expectedSender:(await check())!});expect(String(requests[0])).toContain('/8002/messages');});
 it('unassigned new recovery never falls back, and stale credential snapshot refuses',async()=>{const f=await fixture(true);const snapshot=await readDispatchSenderSnapshot();expect(await db.$transaction(tx=>checkDispatchSender(tx,{snapshot,conversationId:f.c.id,recipient:'447700900001',recovery:true}))).toBeNull();const g=await fixture();expect(await db.$transaction(tx=>checkDispatchSender(tx,{snapshot:{...snapshot,version:999},conversationId:g.c.id,recipient:'447700900001',recovery:false}))).toBeNull();});
 it('historical singleton receipts never authorise unassigned recovery dispatch',async()=>{
  const f=await fixture(true),to='447700900004',past=new Date(Date.now()-1000);
  const root=await db.conversationMessage.create({data:{conversationId:f.c.id,direction:'OUTBOUND',senderType:'AUTOMATION',status:'SENT',content:'old reminder',sentAt:past,providerMessageId:randomUUID(),providerDispatchKey:randomUUID(),providerDispatchAdmittedAt:past,providerDispatchControlRevision:0,dispatchProviderAccountId:account,dispatchProviderPhoneNumberId:phone}});
  await db.recoveryOutreachAttempt.create({data:{checkoutRecoveryId:f.r!.id,recipient:to,sequence:1,trigger:'INITIAL',configuredOfferMode:'NONE',status:'WAITING_FOR_RESPONSE',sentAt:past,outboundMessageId:root.id}});
  const snapshot=await readDispatchSenderSnapshot();
  const result=await db.$transaction(tx=>checkDispatchSender(tx,{snapshot,conversationId:f.c.id,recipient:to,recovery:true}));
  expect(result).toBeNull();expect(await db.recoverySenderAssignment.count({where:{conversationId:f.c.id}})).toBe(0);
 });

 it('actual Woo initial permit freezes its assigned phone and duplicate restart cannot send twice',async()=>{
  const f=await seedWooInitialPermit(db);shops.push(f.shopId);config.account=f.input.templateRegistration.senderWabaId;
  await db.whatsAppPoolSender.create({data:{providerPhoneNumberId:'8003',providerAccountId:config.account,verifiedAt:new Date(Date.now()-1000),allocationEnabled:true}});
  const pool=new RecoverySenderPoolService(db,()=>new Date(),async()=>({accountId:config.account,rowId:config.rowId,version:1,environment:'test'}));
  recipients.push(f.input.recipient);expect((await pool.allocate({conversationId:f.input.conversationId,canonicalRecipient:f.input.recipient})).kind).toBe('assigned');
  const service=new WooInitialSendFenceService(db,undefined,undefined,undefined,async()=>null);
  const permit=await service.admitFinalSend(f.input);expect(permit).toEqual({kind:'admitted',sender:{providerAccountId:config.account,providerPhoneNumberId:'8003'}});
  expect((await db.conversationMessage.findUniqueOrThrow({where:{id:f.input.messageId}}))).toMatchObject({dispatchProviderAccountId:config.account,dispatchProviderPhoneNumberId:'8003'});
  expect(await service.admitFinalSend(f.input)).toEqual({kind:'suppressed',reason:'already-admitted-or-sent'});
  config.account=account;
 });

 it('actual standalone permit wins enrollment race and exposes immutable protected use',async()=>{
  const racePhone='8004';config.phone=racePhone;const f=await fixture();let release!:()=>void;let reached!:()=>void;const ready=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);
  const observed=new Proxy(db,{get(target,key){if(key==='$transaction')return (fn:(tx:unknown)=>Promise<unknown>)=>target.$transaction(async tx=>fn(new Proxy(tx,{get(t,k){if(k==='$queryRawUnsafe')return async(sql:string,...args:unknown[])=>{const result=await t.$queryRawUnsafe(sql,...args);if(sql.includes('UPDATE "whatsapp"."ConversationMessage"')){reached();await gate;}return result;};const value=Reflect.get(t,k);return typeof value==='function'?value.bind(t):value;}})),{timeout:15000});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const permit=new GeneralOutboundSendFenceService(observed).admitFinalSend(input(f));await ready;
  const enrollment=db.$transaction(async tx=>{await tx.$queryRawUnsafe(`WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended('whatsapp-pool-membership:'||$1::text,0))) SELECT COUNT(*)::integer FROM locked`,racePhone);const protectedUse=await tx.conversationMessage.count({where:{dispatchProviderPhoneNumberId:racePhone,providerDispatchAdmittedAt:{not:null}}});if(protectedUse)return 'protected';await tx.whatsAppPoolSender.create({data:{providerPhoneNumberId:racePhone,providerAccountId:account,verifiedAt:now,allocationEnabled:false}});return 'enrolled';},{timeout:15000});
  release();expect((await permit).kind).toBe('admitted');expect(await enrollment).toBe('protected');expect(await db.whatsAppPoolSender.findUnique({where:{providerPhoneNumberId:racePhone}})).toBeNull();config.phone=phone;
 });


 it('multipart historical proof cannot bypass an absent sender assignment',async()=>{
  const f=await fixture(true),to='447400123456',past=new Date(Date.now()-1000);
  const source={schemaVersion:1,kind:'RECOVERY_MULTIPART_PREPARATION',messageId:f.m.id,body:f.m.content,recipient:to,sender:{providerAccountId:account,providerPhoneNumberId:phone},receipt:{shopId:f.shop,conversationId:f.c.id}};
  await db.conversationMessage.update({where:{id:f.m.id},data:{outboundPresentation:source,providerDispatchKey:randomUUID(),providerDispatchAdmittedAt:past,providerDispatchControlRevision:0}});
  const payload={kind:'TEXT',body:'old part'};
  await db.conversationDeliveryPart.create({data:{messageId:f.m.id,ordinal:0,role:'HEADER',payload,payloadDigest:sha256(canonicalJson(payload)),sourceIdentity:{schemaVersion:1,sourceDigest:sha256(canonicalJson(source)),shopId:f.shop,conversationId:f.c.id},deadlineAt:new Date(Date.now()+60000),providerAccountId:account,providerPhoneNumberId:phone,state:'ACKNOWLEDGED',providerDispatchKey:randomUUID(),providerDispatchAdmittedAt:past,providerMessageId:randomUUID(),acknowledgedAt:past}});
  const snapshot=await readDispatchSenderSnapshot();
  expect(await db.$transaction(tx=>checkDispatchSender(tx,{snapshot,conversationId:f.c.id,recipient:to,recovery:true}))).toBeNull();
 });

 it('retains uncertain provider admission and never repeats transport on restart',async()=>{
  const f=await fixture(),fence=new GeneralOutboundSendFenceService(db);const permit=await fence.admitFinalSend(input(f));if(permit.kind!=='admitted')throw new Error('fixture permit refused');
  let requests=0;const provider=new WhatsAppService((async()=>{requests++;return new Response('invalid successful response',{status:200});}) as typeof fetch,{error:()=>{}});
  await expect(provider.sendWhatsAppText({to:'447400123456',text:'fixture answer',expectedSender:permit.sender})).rejects.toBeInstanceOf(SyntaxError);
  expect((await db.conversationMessage.findUniqueOrThrow({where:{id:f.m.id}}))).toMatchObject({status:'PENDING',providerDispatchKey:expect.any(String),dispatchProviderAccountId:account,dispatchProviderPhoneNumberId:phone});
  expect(await new GeneralOutboundSendFenceService(db).admitFinalSend(input(f))).toEqual({kind:'suppressed',reason:'already-admitted-or-sent'});expect(requests).toBe(1);
 });
 it('database rejects an acknowledged part without its provider receipt witness',async()=>{
  const f=await fixture(true),past=new Date(Date.now()-1000);
  await expect(db.conversationDeliveryPart.create({data:{id:randomUUID(),messageId:f.m.id,ordinal:0,role:'HEADER',payload:{kind:'TEXT',body:'old part'},payloadDigest:'a'.repeat(64),sourceIdentity:{schemaVersion:1,sourceDigest:'b'.repeat(64),shopId:f.shop,conversationId:f.c.id},deadlineAt:new Date(Date.now()+60000),providerAccountId:account,providerPhoneNumberId:phone,state:'ACKNOWLEDGED',providerDispatchKey:randomUUID(),providerDispatchAdmittedAt:past,acknowledgedAt:past}})).rejects.toThrow();
  expect(await db.conversationDeliveryPart.count({where:{messageId:f.m.id}})).toBe(0);
 });
 it('final sender configuration share lock serializes credential CAS after permit authority',async()=>{
  const f=await fixture();const snapshot=await readDispatchSenderSnapshot();let release!:()=>void,reached!:()=>void,updating!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>reached=r),started=new Promise<void>(r=>updating=r);let pid=0;
  const permit=db.$transaction(async tx=>{expect(await checkDispatchSender(tx,{snapshot,conversationId:f.c.id,recipient:'447700900001',recovery:false})).not.toBeNull();reached();await gate;},{timeout:15000});await ready;
  const update=db.$transaction(async tx=>{pid=(await tx.$queryRawUnsafe<Array<{pid:number}>>('SELECT pg_backend_pid() AS pid'))[0]!.pid;updating();await tx.platformConfiguration.update({where:{id:config.rowId},data:{version:{increment:1}}});},{timeout:15000});await started;
  try{let blocked=false;const deadline=Date.now()+5000;while(Date.now()<deadline){const rows=await db.$queryRawUnsafe<Array<{wait_event_type:string|null}>>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',pid);if(rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);}finally{release();await permit;await update;config.version++;}
  expect(await db.$transaction(tx=>checkDispatchSender(tx,{snapshot,conversationId:f.c.id,recipient:'447700900001',recovery:false}))).toBeNull();
 });

});
