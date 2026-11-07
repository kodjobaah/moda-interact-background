import { describe,it,expect,vi } from 'vitest';
import { parseProvisionSampleArguments,provisionMetaTemplateSample } from '../../../../src/services/meta-template-management/provision-sample.js';
import { readPackagedMetaTemplateSample,META_TEMPLATE_SAMPLE_ASSET as asset } from '../../../../src/services/meta-template-management/sample-asset.js';
import { SHOP_BRAND_CACHE_CONTROL } from '../../../../src/services/shop-brand-media/r2-writer.js';
const policy={bucketName:'public-media',publicOrigin:'https://media.example.com'};
const credentials={endpoint:'https://account.r2.cloudflarestorage.com',accessKeyId:'access-canary',secretAccessKey:'secret-canary',bucket:'private-bucket'};
async function fixture(existing=false){const bytes=await readPackagedMetaTemplateSample();let present=existing;const head=vi.fn(async()=>{if(!present)throw Object.assign(new Error('missing'),{$metadata:{httpStatusCode:404}});return {ContentLength:asset.sizeBytes,ContentType:asset.contentType,CacheControl:SHOP_BRAND_CACHE_CONTROL,Metadata:{sha256:asset.sha256}};});const put=vi.fn(async()=>{present=true;});const close=vi.fn();const readCredentials=vi.fn(async()=>credentials);const fetcher={fetch:vi.fn(async()=>({bytes,declaredContentType:'image/jpeg'}))};return{head,put,close,readCredentials,fetcher,deps:{environment:()=> 'development',readAsset:async()=>bytes,readPolicy:(async()=>policy) as never,readCredentials:readCredentials as never,transport:()=>({head,put,close}),fetcher}};}
describe('sample provision modes',()=>{
 it('defaults plan and disallows arbitrary overrides',()=>{expect(parseProvisionSampleArguments(['--environment','development']).mode).toBe('plan');expect(()=>parseProvisionSampleArguments(['--environment','development','--url','https://evil.example'])).toThrow();});
 it('plans without credentials, PUT or public network',async()=>{const f=await fixture();expect(await provisionMetaTemplateSample({environment:'development',mode:'plan'},f.deps)).toMatchObject({outcome:'PLANNED',bucketName:'public-media'});expect(f.readCredentials).not.toHaveBeenCalled();expect(f.fetcher.fetch).not.toHaveBeenCalled();});
 it('guards conditional immutable PUT and idempotent rerun',async()=>{const f=await fixture();const receipt=await provisionMetaTemplateSample({environment:'development',mode:'apply'},f.deps);expect(receipt).toMatchObject({outcome:'UPLOADED'});expect(JSON.stringify(receipt)).not.toMatch(/canary|private-bucket/);expect(f.put).toHaveBeenCalledWith(expect.objectContaining({Bucket:'public-media',Key:asset.objectKey,IfNoneMatch:'*'}),expect.any(AbortSignal));expect(await provisionMetaTemplateSample({environment:'development',mode:'apply'},f.deps)).toMatchObject({outcome:'UNCHANGED'});expect(f.put).toHaveBeenCalledTimes(1);expect(f.close).toHaveBeenCalledTimes(2);});
 it('verify performs public GET but no credentials/writes',async()=>{const f=await fixture();expect(await provisionMetaTemplateSample({environment:'development',mode:'verify'},f.deps)).toMatchObject({outcome:'VERIFIED'});expect(f.readCredentials).not.toHaveBeenCalled();expect(f.put).not.toHaveBeenCalled();});
 it('rejects foreign environment or unconfirmed production before config',async()=>{const f=await fixture();await expect(provisionMetaTemplateSample({environment:'test',mode:'apply'},f.deps)).rejects.toThrow('ENVIRONMENT_MISMATCH');await expect(provisionMetaTemplateSample({environment:'production',mode:'apply'},{...f.deps,environment:()=> 'production'})).rejects.toThrow('PRODUCTION_CONFIRMATION_REQUIRED');expect(f.readCredentials).not.toHaveBeenCalled();});
 it('rejects collisions without overwriting and closes transport',async()=>{const f=await fixture(true);f.head.mockResolvedValue({...await f.head(),ContentLength:1});await expect(provisionMetaTemplateSample({environment:'development',mode:'apply'},f.deps)).rejects.toThrow('R2_OBJECT_MISMATCH');expect(f.put).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();});
});

it('bounds noncooperative R2 operations and closes transport',async()=>{
 const f=await fixture();vi.useFakeTimers();try {
 f.head.mockImplementation(()=>new Promise(()=>{}));
 const run=provisionMetaTemplateSample({environment:'development',mode:'apply'},f.deps);
 const assertion=expect(run).rejects.toThrow('R2_UNAVAILABLE');
 await vi.advanceTimersByTimeAsync(15_001);await assertion;expect(f.close).toHaveBeenCalledOnce();
 }finally{vi.useRealTimers();}
});
it('bounds total provisioning including hanging configuration',async()=>{
 const f=await fixture();vi.useFakeTimers();try {
 const run=provisionMetaTemplateSample({environment:'development',mode:'plan'},{...f.deps,readPolicy:()=>new Promise(()=>{})});
 const assertion=expect(run).rejects.toThrow('DEADLINE');await vi.advanceTimersByTimeAsync(60_001);await assertion;
 }finally{vi.useRealTimers();}
});
it('never reports verification success for a modified public body',async()=>{
 const f=await fixture(true);f.fetcher.fetch.mockResolvedValue({bytes:Buffer.from('tampered'),declaredContentType:'image/jpeg'});
 await expect(provisionMetaTemplateSample({environment:'development',mode:'verify'},f.deps)).rejects.toThrow('META_SAMPLE_INVALID');
});
