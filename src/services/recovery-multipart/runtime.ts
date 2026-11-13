import { safeParseNormalizedWhatsAppStatus } from '@modainteract/moda-interact-shared/billing';
import { createLogger } from '@modainteract/moda-interact-shared/logging';
import { resolveDeploymentEnvironmentName } from '../../runtime/deployment-environment.js';
import { RecoveryMultipartDeliveryEngine } from './engine.js';
import { MULTIPART_REPAIR_MS } from './frozen.js';

type Queue = {add(name:string,data:{messageId:string},options:{jobId:string;attempts:number;removeOnComplete:boolean;removeOnFail:number}):Promise<unknown>};
let queue:Queue|null=null;
const log=createLogger({serviceName:'moda-messaging-worker',environment:resolveDeploymentEnvironmentName()});
export const MULTIPART_CONTINUATION_JOB='continue-recovery-delivery';
export const recoveryMultipartEngine=new RecoveryMultipartDeliveryEngine(undefined,undefined,undefined,async messageId=>{
  if(!queue)throw new Error('MULTIPART_QUEUE_UNAVAILABLE');
  // No retained completed job may swallow a later delivery callback. An active
  // job race is harmless: the bounded durable repair scan requeues the root.
  await queue.add(MULTIPART_CONTINUATION_JOB,{messageId},{jobId:`arch075-${messageId}`,attempts:1,removeOnComplete:true,removeOnFail:100});
});
export function bindMultipartQueue(value:Queue):void{queue=value;}
export async function processMultipartStatus(raw:unknown):Promise<boolean>{
  const parsed=safeParseNormalizedWhatsAppStatus(raw);if(!parsed.success)return false;
  const handled=await recoveryMultipartEngine.observe(parsed.data);
  return handled;
}
export function startMultipartRepair(run=()=>recoveryMultipartEngine.repair()):()=>Promise<void>{
  let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;let active:Promise<unknown>|null=null;
  const cycle=async()=>{
    if(stopped)return;
    active=run().catch(()=>{log.error('whatsapp.multipart.repair_failed',{reason:'continuation-unavailable'});});
    await active;active=null;
    if(!stopped){timer=setTimeout(()=>{void cycle();},MULTIPART_REPAIR_MS);timer.unref?.();}
  };
  timer=setTimeout(()=>{void cycle();},MULTIPART_REPAIR_MS);timer.unref?.();
  return async()=>{stopped=true;if(timer)clearTimeout(timer);if(active)await active;};
}
