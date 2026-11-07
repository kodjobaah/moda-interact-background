import { META_TEMPLATE_SAMPLE_ASSET as asset, readPackagedMetaTemplateSample, validateMetaTemplateSample } from './sample-asset.js';
import { metaTemplateSampleUrl } from './sample-source.js';
import { createSafeImageFetcher } from '../shop-brand-media/safe-fetch.js';
import { createBrandR2S3Transport, putGuardedImmutableR2Object, type BrandR2Transport } from '../shop-brand-media/r2-writer.js';
import { loadShopBrandR2Credentials } from '../shop-brand-media/r2-config.js';
import { readR2Configuration, readShopBrandPublicMediaConfiguration } from '../platform-configuration/consumers.js';
import { resolveDeploymentEnvironmentName } from '../../runtime/deployment-environment.js';
export type ProvisionMode = 'plan' | 'apply' | 'verify';
export interface ProvisionSampleOptions { environment: string; mode: ProvisionMode; confirmProduction?: boolean }
export function parseProvisionSampleArguments(args: string[]): ProvisionSampleOptions {
  let environment = '', mode: ProvisionMode = 'plan', confirmProduction = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!; if (seen.has(key)) throw new Error('ARGUMENT_INVALID'); seen.add(key);
    if (key === '--confirm-production') confirmProduction = true;
    else if (key === '--environment') environment = args[++i] ?? '';
    else if (key === '--mode') { const value = args[++i]; if (!['plan','apply','verify'].includes(value ?? '')) throw new Error('ARGUMENT_INVALID'); mode = value as ProvisionMode; }
    else throw new Error('ARGUMENT_INVALID');
  }
  if (!['development','test','production'].includes(environment)) throw new Error('ENVIRONMENT_INVALID');
  return { environment, mode, confirmProduction };
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('DEADLINE'));
  return new Promise((resolve,reject) => { const abort = () => reject(new Error('DEADLINE')); signal.addEventListener('abort',abort,{once:true});
    promise.then(v=>{signal.removeEventListener('abort',abort);resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);}); });
}
export async function provisionMetaTemplateSample(options: ProvisionSampleOptions, dependencies: {
  environment?: () => string; readAsset?: () => Promise<Buffer>;
  readPolicy?: typeof readShopBrandPublicMediaConfiguration; readCredentials?: typeof readR2Configuration;
  transport?: typeof createBrandR2S3Transport; fetcher?: Pick<ReturnType<typeof createSafeImageFetcher>,'fetch'>;
} = {}) {
  if (options.environment !== (dependencies.environment ?? resolveDeploymentEnvironmentName)()) throw new Error('ENVIRONMENT_MISMATCH');
  if (options.mode === 'apply' && options.environment === 'production' && !options.confirmProduction) throw new Error('PRODUCTION_CONFIRMATION_REQUIRED');
  const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(),60_000);
  const signal = controller.signal; let transport: BrandR2Transport | undefined;
  try {
    const bytes = await bounded((dependencies.readAsset ?? readPackagedMetaTemplateSample)(),signal); validateMetaTemplateSample(bytes,asset.contentType);
    const policy = await bounded((dependencies.readPolicy ?? readShopBrandPublicMediaConfiguration)(),signal);
    const url = metaTemplateSampleUrl(policy.publicOrigin);
    const receipt = {schemaVersion:1 as const,environment:options.environment,assetVersion:1 as const,objectKey:asset.objectKey,sha256:asset.sha256,sizeBytes:asset.sizeBytes,contentType:asset.contentType,bucketName:policy.bucketName,publicOrigin:policy.publicOrigin,mode:options.mode};
    if (options.mode === 'plan') return {...receipt,outcome:'PLANNED' as const};
    let uploaded = false;
    if (options.mode === 'apply') {
      const credentials = loadShopBrandR2Credentials(await bounded((dependencies.readCredentials ?? readR2Configuration)(),signal));
      transport = (dependencies.transport ?? createBrandR2S3Transport)(credentials);
      const raw = transport;
      const operation = async <T>(work: (s: AbortSignal) => Promise<T>): Promise<T> => {
        const abort = new AbortController(); const timeout = setTimeout(()=>abort.abort(),15_000);
        const s = AbortSignal.any([signal,abort.signal]);
        try { return await bounded(work(s),s); } finally { clearTimeout(timeout); }
      };
      const guarded: BrandR2Transport = {
        head: input => operation(s=>raw.head(input,s)),
        put: async input => {await operation(s=>raw.put(input,s)); uploaded=true;},
      };
      await bounded(putGuardedImmutableR2Object({ transportOrFactory:guarded,bucket:policy.bucketName,objectKey:asset.objectKey,
        image:{bytes,contentType:asset.contentType,width:asset.width,height:asset.height,sizeBytes:asset.sizeBytes,contentSha256:asset.sha256},
        acceptsKey:key=>key===asset.objectKey,expectedDimensions:{width:asset.width,height:asset.height},signal }),signal);
    }
    const result = await bounded((dependencies.fetcher ?? createSafeImageFetcher({maxBytes:5_000_000,maxRedirects:0})).fetch(url,signal),signal);
    validateMetaTemplateSample(result.bytes,result.declaredContentType);
    return {...receipt,outcome:options.mode==='verify'?'VERIFIED' as const:uploaded?'UPLOADED' as const:'UNCHANGED' as const};
  } finally { clearTimeout(timer);transport?.close?.(); }
}
export function provisionFailureReason(error: unknown): string {
  const known = ['ENVIRONMENT_MISMATCH','ENVIRONMENT_INVALID','ARGUMENT_INVALID','PRODUCTION_CONFIRMATION_REQUIRED','DEADLINE'];
  if(error instanceof Error && known.includes(error.message)) return error.message;
  return 'META_SAMPLE_PROVISION_FAILED';
}
