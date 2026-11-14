import { readRecoveryCommonReference } from '../recovery-multipart/common-layout-policy.js';
import { type CommonRecoveryLayoutReference } from '@modainteract/moda-interact-shared/commerce/presentation';
import { currentCommonReferenceMatches } from '../recovery-multipart/common-layout.js';
import { recoveryDatabase } from '../recovery-conversation/recovery-conversation.sql.js';
/** Read only the explicit Admin-owned reference. Missing on a frozen legacy
 * source remains legacy; malformed explicit data never falls back. */
export function readMetaCommonReference(raw:unknown):{kind:'absent'}|{kind:'invalid'}|{kind:'present';reference:CommonRecoveryLayoutReference}{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {kind:'absent'};
 const authoring=(raw as Record<string,unknown>).authoring;
 if(!authoring||typeof authoring!=='object'||Array.isArray(authoring)||!Object.hasOwn(authoring,'commonLayout'))return {kind:'absent'};
 const parsed=readRecoveryCommonReference((authoring as Record<string,unknown>).commonLayout);return parsed.kind==='ok'?{kind:'present',reference:parsed.reference}:{kind:'invalid'};
}
export const currentMetaCommonReference=(reference:CommonRecoveryLayoutReference)=>recoveryDatabase.$transaction(tx=>currentCommonReferenceMatches(tx,reference));
import { canonicalJson } from '@modainteract/moda-interact-shared/commerce';
import { commonLayoutVariables,type CommonLayoutVariables } from '../recovery-multipart/common-layout.js';
export type MetaCommonIdentity={reference:CommonRecoveryLayoutReference;variables:CommonLayoutVariables;parameters:{header:readonly string[];body:readonly string[]}};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function readMetaCommonIdentity(raw:unknown,shopId:string):MetaCommonIdentity|null{
 if(!object(raw)||Object.keys(raw).length!==3||!object(raw.variables)||!object(raw.parameters)||Object.keys(raw.variables).length!==3||Object.keys(raw.parameters).length!==2)return null;
 const ref=readRecoveryCommonReference(raw.reference);if(ref.kind!=='ok')return null;
 const v=raw.variables;const variables=typeof v['shop.name']==='string'&&typeof v['shop.websiteUrl']==='string'&&typeof v['checkout.url']==='string'?commonLayoutVariables(shopId,v['shop.websiteUrl'],v['shop.name'],v['checkout.url']):null;
 if(!variables||canonicalJson(variables)!==canonicalJson(v))return null;
 const {header,body}=raw.parameters;if(!Array.isArray(header)||!Array.isArray(body)||header.length>1||body.length>10||[...header,...body].some(x=>typeof x!=='string'||x.length>4096))return null;
 return {reference:ref.reference,variables,parameters:{header,body}};
}
export function commonTemplateParametersMatch(common:MetaCommonIdentity,bindings:unknown,actual?:{header:readonly string[];body:readonly string[]}):boolean{
 if(!actual||!object(bindings)||canonicalJson(common.parameters)!==canonicalJson(actual))return false;
 const seen:string[]=[];
 for(const section of ['header','body'] as const){const rows=bindings[section];if(!Array.isArray(rows))return false;
  for(const row of rows){if(!object(row)||typeof row.variable!=='string'||typeof row.position!=='number')return false;
   if(Object.hasOwn(common.variables,row.variable)){const key=row.variable as keyof CommonLayoutVariables;if(common.parameters[section][row.position-1]!==common.variables[key])return false;seen.push(key);}
  }
 }
 return Object.keys(common.variables).every(key=>seen.includes(key));
}
