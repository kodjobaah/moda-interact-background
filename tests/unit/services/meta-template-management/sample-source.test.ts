import { describe,it,expect,vi } from 'vitest';
import { createProductionMetaTemplateSampleSource,metaTemplateSampleUrl } from '../../../../src/services/meta-template-management/sample-source.js';
import { readPackagedMetaTemplateSample,META_TEMPLATE_SAMPLE_ASSET as asset } from '../../../../src/services/meta-template-management/sample-asset.js';
import { MetaImageHeaderSampleUploader,isTrustedMetaImageSampleHandle } from '../../../../src/services/meta-template-management/image-header-sample.js';
import { createSafeImageFetcher } from '../../../../src/services/shop-brand-media/safe-fetch.js';
import sharp from 'sharp';
import { Readable } from 'node:stream';
const policy={bucketName:'public-media',publicOrigin:'https://media.example.com'};
describe('fixed R2 sample source',()=>{
 it('validates exact bytes and composes source through Meta with no website request',async()=>{
  const bytes=await readPackagedMetaTemplateSample();const fetcher={fetch:vi.fn(async()=>({bytes,declaredContentType:'image/jpeg'}))};
  const readConfiguration=vi.fn(async()=>policy);const source=createProductionMetaTemplateSampleSource({readConfiguration:readConfiguration as never,fetcher});
  expect(readConfiguration).not.toHaveBeenCalled();const request=vi.fn().mockResolvedValueOnce(Response.json({id:'upload:abcdefgh'})).mockResolvedValueOnce(Response.json({h:'4::opaque-handle'}));
  const handle=await new MetaImageHeaderSampleUploader(request,source).upload({appId:'123',accessToken:'secret-canary',graphBase:'https://graph.facebook.com/v25.0'});
  expect(isTrustedMetaImageSampleHandle(handle)).toBe(true);expect(isTrustedMetaImageSampleHandle({value:handle.value})).toBe(false);
  expect(fetcher.fetch).toHaveBeenCalledWith(`https://media.example.com/${asset.objectKey}`,undefined);expect(request).toHaveBeenCalledTimes(2);expect(request.mock.calls.map(c=>String(c[0])).join()).not.toContain('modainteract.com');
 });
 it.each(['https://media.example.com/path','http://media.example.com','https://user:pass@media.example.com','https://media.example.com/?q=x'])('rejects unsafe configured origin %s',origin=>expect(()=>metaTemplateSampleUrl(origin)).toThrow());
 it.each(['hash','mime','empty','png','html'])('rejects %s before Meta',async kind=>{
 const original=await readPackagedMetaTemplateSample();const bytes=kind==='hash'?Buffer.from(original):kind==='empty'?Buffer.alloc(0):kind==='png'?Buffer.from([137,80,78,71]):kind==='html'?Buffer.from('<html>'):original;if(kind==='hash')bytes[30]^=1;
 const source=createProductionMetaTemplateSampleSource({readConfiguration:(async()=>policy) as never,fetcher:{fetch:async()=>({bytes,declaredContentType:kind==='mime'?'image/png':'image/jpeg'})}});const request=vi.fn();await expect(new MetaImageHeaderSampleUploader(request,source).upload({appId:'123',accessToken:'secret',graphBase:'https://graph.facebook.com'})).rejects.toMatchObject({disposition:'blocked'});expect(request).not.toHaveBeenCalled();
 });
 it.each([404,429,503,302])('uses safe fetch HTTP %i classification',async status=>{
 const fetcher=createSafeImageFetcher({maxBytes:5_000_000,maxRedirects:0,resolveAll:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({statusCode:status,headers:{location:'https://www.modainteract.com'},body:Readable.from([]),peerAddress:'8.8.8.8'})});
 const source=createProductionMetaTemplateSampleSource({readConfiguration:(async()=>policy) as never,fetcher});await expect(new MetaImageHeaderSampleUploader(vi.fn(),source).upload({appId:'123',accessToken:'secret',graphBase:'https://graph.facebook.com'})).rejects.toMatchObject({disposition:status===429||status===503?'uncertain':'blocked'});
 });
 it('bounds never-ending Meta body by caller cancellation',async()=>{
 const bytes=await readPackagedMetaTemplateSample();const controller=new AbortController();const request=vi.fn(async()=>new Response(new ReadableStream({start(){}})));const promise=new MetaImageHeaderSampleUploader(request,{read:async()=>({bytes,declaredContentType:'image/jpeg'})}).upload({appId:'123',accessToken:'secret',graphBase:'https://graph.facebook.com',signal:controller.signal});setTimeout(()=>controller.abort(),5);await expect(promise).rejects.toMatchObject({disposition:'uncertain'});
 });
});

it('packaged hash implies canonical 505x757 JPEG dimensions',async()=>{
 const metadata=await sharp(await readPackagedMetaTemplateSample()).metadata();expect(metadata).toMatchObject({width:505,height:757,format:'jpeg'});
});
it('rejects oversized success JSON and bounds stalled failure body',async()=>{
 const bytes=await readPackagedMetaTemplateSample();const source={read:async()=>({bytes,declaredContentType:'image/jpeg' as const})};
 const request=vi.fn(async()=>new Response(' '.repeat(8193)));
 await expect(new MetaImageHeaderSampleUploader(request,source).upload({appId:'123',accessToken:'secret',graphBase:'https://graph.facebook.com'})).rejects.toMatchObject({disposition:'uncertain'});
 const controller=new AbortController();const pending=new MetaImageHeaderSampleUploader(vi.fn(async()=>new Response(new ReadableStream({start(){}}),{status:503})),source).upload({appId:'123',accessToken:'secret',graphBase:'https://graph.facebook.com',signal:controller.signal});
 setTimeout(()=>controller.abort(),5);await expect(pending).rejects.toMatchObject({disposition:'uncertain'});
});

it('blocks private DNS before any HTTP and never uses the website',async()=>{
 const request=vi.fn();const source=createProductionMetaTemplateSampleSource({readConfiguration:(async()=>policy) as never,fetcher:createSafeImageFetcher({maxBytes:5_000_000,maxRedirects:0,resolveAll:async()=>[{address:'127.0.0.1',family:4}],request})});
 await expect(new MetaImageHeaderSampleUploader(vi.fn(),source).upload({appId:'123',accessToken:'token-canary',graphBase:'https://graph.facebook.com'})).rejects.toMatchObject({disposition:'blocked'});expect(request).not.toHaveBeenCalled();
});
