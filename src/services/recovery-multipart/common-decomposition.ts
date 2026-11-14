import type { RecoveryCompositeMultipartDeliveryPlanV2 } from '@modainteract/moda-interact-shared/commerce/presentation';
import { commonLayoutBody,type CommonLayoutReceipt } from './common-layout.js';
import { validRecoveryCheckoutFooterUrl } from '../conversation-wrappers/recovery-checkout-footer.js';
/** Application policy: the trusted checkout is the last canonical footer line. */
export function hasCanonicalCompositeFooter(common:CommonLayoutReceipt):boolean{const url=common.variables['checkout.url'];return validRecoveryCheckoutFooterUrl(url)&&(common.boundaries.footer===url||common.boundaries.footer.endsWith('\n'+url));}
/** Exact legacy and consolidated decompositions; independent of writer rollout. */
export function exactCommonDecomposition(plan:RecoveryCompositeMultipartDeliveryPlanV2,common:CommonLayoutReceipt):boolean {
 const {parts}=plan,{boundaries}=common,body=commonLayoutBody(common);
 if(parts.length===1){const p=parts[0]!.plan;return p.kind==='COMPOSITE_IMAGE'?parts[0]!.role==='HEADER'&&p.image.schemaVersion===2&&hasCanonicalCompositeFooter(common)&&p.logicalBody===body&&p.body===boundaries.body+boundaries.footer:p.body===body;}
 if(parts.length===2&&parts[0]!.role==='HEADER'&&parts[1]!.role==='PRODUCT'&&parts[0]!.plan.body===body&&parts[1]!.plan.body===boundaries.footer)return true;
 return parts[0]!.plan.body===boundaries.header+boundaries.footer&&parts.at(-1)!.plan.body===boundaries.body+boundaries.footer&&(parts.length!==3||parts[1]!.plan.body===boundaries.footer);
}
