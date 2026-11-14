import {templateProfile} from './composite-profile.fixture.js';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {prepareCompositeReply,compositeReplyEnabled} from '../../../../src/services/recovery-multipart/composite.js';
import type {CommonLayoutReceipt} from '../../../../src/services/recovery-multipart/common-layout.js';
const common={commonRef:{prepared:templateProfile()},variables:{'checkout.url':'https://shop.example/checkout'},shopId:'shop',boundaries:{header:'Shop\n',body:'Answer',footer:'\nhttps://shop.example/checkout'}} as CommonLayoutReceipt;
describe('composite original optional budget',()=>{
 afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});
 function fakeClock(){vi.useFakeTimers();vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});}
 it.each([NaN,Infinity,-Infinity,0,999])('refuses invalid/expired deadline %s before any media I/O',async deadlineAt=>{const resolve=vi.fn();expect(await prepareCompositeReply({common,presentedPairs:[],deadlineAt},{logoResolver:resolve,now:()=>1000})).toBeNull();expect(resolve).not.toHaveBeenCalled();});
 it('refuses an invalid host clock before timeout creation',async()=>{expect(await prepareCompositeReply({common,presentedPairs:[],deadlineAt:100000},{now:()=>NaN})).toBeNull();});
 it('uses fullTEXT fallback before media when the selected template has no profile',async()=>{const logoResolver=vi.fn();expect(await prepareCompositeReply({common:{...common,commonRef:{...common.commonRef,prepared:{} as never}},presentedPairs:[],deadlineAt:10000},{now:()=>1000,logoResolver})).toBeNull();expect(logoResolver).not.toHaveBeenCalled();});
 it('caps the entire optional stage at 5s and prevents late logo work from starting the next stage',async()=>{
  fakeClock();vi.setSystemTime(1000);let resolveLogo!:(v:null)=>void;const logoResolver=vi.fn(()=>new Promise<null>(r=>{resolveLogo=r;})),settings=vi.fn();
  const result=prepareCompositeReply({common,presentedPairs:[],deadlineAt:100000},{logoResolver,settings});await vi.advanceTimersByTimeAsync(5000);expect(await result).toBeNull();resolveLogo(null);await vi.advanceTimersByTimeAsync(0);expect(settings).not.toHaveBeenCalled();
 });
 it('uses remaining original lease rather than granting a fresh 5s',async()=>{fakeClock();vi.setSystemTime(1000);const logoResolver=vi.fn(()=>new Promise<null>(()=>{}));const result=prepareCompositeReply({common,presentedPairs:[],deadlineAt:3500},{logoResolver});await vi.advanceTimersByTimeAsync(1499);let completed=false;void result.then(()=>{completed=true;});expect(completed).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(await result).toBeNull();});
 it.each([undefined,'false','TRUE','1',' true '])('does not enable writer for %s',value=>{vi.stubEnv('RECOVERY_COMPOSITE_REPLY_ENABLED',value);expect(compositeReplyEnabled()).toBe(false);});
});
