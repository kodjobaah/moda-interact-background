import type { RecoveryMultipartDeliveryPlan } from '@modainteract/moda-interact-shared/commerce/presentation';
import { commonLayoutBody,type CommonLayoutReceipt } from './common-layout.js';
/** Exact legacy and consolidated decompositions; independent of writer rollout. */
export function exactCommonDecomposition(plan:RecoveryMultipartDeliveryPlan,common:CommonLayoutReceipt):boolean {
 const {parts}=plan,{boundaries}=common,body=commonLayoutBody(common);
 if(parts.length===1)return parts[0]!.plan.body===body;
 if(parts.length===2&&parts[0]!.role==='HEADER'&&parts[1]!.role==='PRODUCT'&&parts[0]!.plan.body===body&&parts[1]!.plan.body===boundaries.footer)return true;
 return parts[0]!.plan.body===boundaries.header+boundaries.footer&&parts.at(-1)!.plan.body===boundaries.body+boundaries.footer&&(parts.length!==3||parts[1]!.plan.body===boundaries.footer);
}
