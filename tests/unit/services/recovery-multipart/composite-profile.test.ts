import {describe,it,expect} from 'vitest';
import {profiles,templateProfile} from './composite-profile.fixture.js';
import {readTemplateCompositeProfile} from '../../../../src/services/recovery-multipart/composite-profile.js';
import type {CommonLayoutReceipt} from '../../../../src/services/recovery-multipart/common-layout.js';
const common=(prepared:unknown)=>({commonRef:{prepared}} as CommonLayoutReceipt);
describe('saved common template composite profile',()=>{
 it.each(profiles)('retains exact template-authored choices including centered/top logo',profile=>{
  const saved=templateProfile(profile);expect(readTemplateCompositeProfile(common(saved))).toEqual({profile,profileSha256:saved.compositeProfileSha256});
 });
 it.each([{}, {compositeProfile:profiles[0]}, {compositeProfileSha256:'a'.repeat(64)}, {...templateProfile(),compositeProfileSha256:'0'.repeat(64)}, {...templateProfile(),compositeProfile:profiles[1]}])('refuses missing or mismatched optional template metadata',prepared=>{expect(readTemplateCompositeProfile(common(prepared))).toBeNull();});
 it.each([Infinity,1e20])('refuses unsafe allocation %s within the host failure boundary',canvasWidth=>{expect(readTemplateCompositeProfile(common({...templateProfile(),compositeProfile:{...profiles[0]!,canvasWidth}}))).toBeNull();});
});
