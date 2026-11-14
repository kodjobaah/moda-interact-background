import {profiles,templateProfile} from './composite-profile.fixture.js';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
// Exercise the same installed decoder instance as the accepted Shared renderer.
const sharp=createRequire(import.meta.resolve('@modainteract/moda-interact-shared/commerce/presentation/node'))('sharp') as typeof import('sharp').default;
import {describe,it,expect,vi} from 'vitest';
import {CommerceProductSchema} from '@modainteract/moda-interact-shared/commerce';
import {conversationProductObjectKey,prepareRecoveryCompositeImageV2,createShopBrandPublicMediaProbe} from '@modainteract/moda-interact-shared/commerce/presentation/node';
import {prepareCompositeReply,compositeTrustedContextV2} from '../../../../src/services/recovery-multipart/composite.js';
import type {CommonLayoutReceipt} from '../../../../src/services/recovery-multipart/common-layout.js';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
describe('actual packed composite renderer through Background host',()=>{
 it.each([...profiles.flatMap(profile=>[false,true].map(product=>({profile,product,overflow:false}))),{profile:{...profiles[1]!,headerOnlyHeight:480,withProductHeight:1120,textHeight:320,productTop:520},product:false,overflow:true}])('renders/probes configured layout $profile.headerOnlyHeight (product $product, overflow $overflow)',async ({profile,product,overflow})=>{
  const logoBytes=await sharp({create:{width:1125,height:600,channels:3,background:'#146847'}}).jpeg().toBuffer(),productBytes=await sharp({create:{width:1125,height:600,channels:3,background:'#dcab37'}}).jpeg().toBuffer();
  const origin='https://media.example',logoKey=`shop-brands/shop.example/logo/sha256-${hash(logoBytes)}.jpg`;
  const logo={schemaVersion:1 as const,origin:{kind:'SHOP_BRAND' as const,shopId:'shop',shopDomain:'shop.example',role:'LOGO' as const,sourceGeneration:1,sourceFingerprint:`sha256:${'a'.repeat(64)}`},status:'READY' as const,kind:'R2_DERIVATIVE' as const,publicOrigin:origin,publicUrl:`${origin}/${logoKey}`,objectKey:logoKey,contentSha256:hash(logoBytes),contentType:'image/jpeg' as const,width:1125 as const,height:600 as const,sizeBytes:logoBytes.length,verifiedAt:'2026-11-13T00:00:00Z'};
  const pair={productId:'selected',variantId:null},productKey=conversationProductObjectKey({kind:'SOURCE',shopId:'shop',platform:'SHOPIFY',...pair,sourceUrl:'https://shop.example/product.jpg'},hash(productBytes));
  const image={schemaVersion:1 as const,shopId:'shop',...pair,publicUrl:`${origin}/${productKey}`,objectKey:productKey,contentSha256:hash(productBytes),contentType:'image/jpeg' as const,byteLength:productBytes.length,width:1125 as const,height:600 as const};
  const boundaries={header:'Example Shop\nhttps://shop.example\n──────────\n\n',body:'This is the complete answer, including https://other.example as authored.',footer:'\n\n──────────\nhttps://shop.example/checkout'};
  const common={schemaVersion:2,kind:'RECOVERY_COMMON_LAYOUT',shopId:'shop',commonRef:{definitionId:'fixture',prepared:templateProfile(profile)},variables:{'checkout.url':'https://shop.example/checkout','shop.websiteUrl':'https://shop.example'},boundaries} as unknown as CommonLayoutReceipt;
  const sourceProduct=CommerceProductSchema.parse({...pair,title:'Selected product',observedAt:new Date().toISOString(),imageUrl:'https://shop.example/product.jpg',url:null,available:true,unitPrice:null,currency:null,productType:null,vendor:null});
  const sourceBytes=new Map([[logo.publicUrl,logoBytes],[image.publicUrl,productBytes]]),objects=new Map<string,{body:Buffer;metadata:unknown}>();
  const fetcher={fetch:async(url:string)=>{const bytes=sourceBytes.get(url)??objects.get(new URL(url).pathname.slice(1))?.body;if(!bytes)throw Error('missing offline object');return {bytes,declaredContentType:'image/jpeg'};}};
  const put=vi.fn(async(input:{Key?:string;Body?:unknown;ContentType?:string;CacheControl?:string;Metadata?:unknown})=>{const body=Buffer.from(input.Body as Uint8Array);objects.set(input.Key!,{body,metadata:{ContentType:input.ContentType,ContentLength:body.length,CacheControl:input.CacheControl,Metadata:input.Metadata}});});
  const transport={head:async(input:{Key?:string})=>{const stored=objects.get(input.Key!);if(!stored)throw Object.assign(Error('NotFound'),{name:'NotFound',$metadata:{httpStatusCode:404}});return stored.metadata as never;},put};
  const probe=createShopBrandPublicMediaProbe(fetcher);
  const prepare=vi.fn((input:Parameters<typeof prepareRecoveryCompositeImageV2>[0])=>prepareRecoveryCompositeImageV2(input,{fetcher,transportFactory:()=>transport,probe}));
  const input={common,presentedPairs:product?[pair]:[],deadlineAt:Date.now()+15000,...(product?{presentation:{verifiedProducts:{shopId:'shop',platform:'SHOPIFY' as const,products:[sourceProduct]}} as never}:{})};
  const deps={logoResolver:async()=>({image:logo,policyRef:{environment:'test',key:'shopBrand.publicMedia' as const,id:'policy',version:1,publicOrigin:origin}}),product:async(p:{body:string})=>({plan:{schemaVersion:1 as const,kind:'IMAGE' as const,body:p.body,image},mediaStage:'READY',durationMs:1}),prepare,settings:async()=>({publicOrigin:origin,bucketName:'offline-media'}),credentials:async()=>({endpoint:'https://fixture.r2.cloudflarestorage.com',accessKeyId:'offline',secretAccessKey:'offline'})};
  const result=await prepareCompositeReply(input,deps);if(overflow){expect(await prepare.mock.results[0]?.value).toMatchObject({kind:'OMITTED',reason:'HEADER_OVERFLOW',stage:'TRANSFORM'});expect(result).toBeNull();expect(put).not.toHaveBeenCalled();return;}if(result===null)expect(await prepare.mock.results[0]?.value).toEqual({kind:'READY'});expect(result).not.toBeNull();const plan=result!.plan.parts[0]!.plan;if(plan.kind!=='COMPOSITE_IMAGE')throw Error('composite');
  expect(plan.body).toBe(boundaries.body+boundaries.footer);expect(plan.logicalBody).toBe(boundaries.header+boundaries.body+boundaries.footer);expect(result!.receipt.logo).toEqual(logo);expect(plan.image.contentSha256).toBe(hash(objects.get(plan.image.objectKey)!.body));
  const meta=await sharp(objects.get(plan.image.objectKey)!.body).metadata();expect(meta).toMatchObject({format:'jpeg',width:profile.canvasWidth,height:product?profile.withProductHeight:profile.headerOnlyHeight});expect(meta.exif).toBeUndefined();
  expect(compositeTrustedContextV2(result!.receipt,common,result!.policy,product?pair:null)).not.toBeNull();
  // Deterministic rendering still runs, while immutable R2 reuses exact bytes.
  const replay=await prepareCompositeReply({...input,deadlineAt:Date.now()+15000},deps);expect(replay!.plan).toEqual(result!.plan);expect(prepare).toHaveBeenCalledTimes(2);expect(put).toHaveBeenCalledOnce();
 },5000);
});
