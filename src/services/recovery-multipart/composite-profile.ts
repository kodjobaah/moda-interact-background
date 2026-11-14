import { RecoveryCompositeProfileSchema, assertRecoveryCompositeProfileSafety, digestRecoveryCompositeProfile } from '@modainteract/moda-interact-shared/commerce/presentation';
import type { CommonLayoutReceipt } from './common-layout.js';
import { digest } from '../conversation-wrappers/projection.js';
/** Geometry is authored and hashed with the same saved template as header/footer.
 * No independent active policy, cached selection or Background visual default. */
export function readTemplateCompositeProfile(common:CommonLayoutReceipt){
 const prepared=common.commonRef.prepared;
 const parsed=RecoveryCompositeProfileSchema.safeParse(prepared.compositeProfile);
 if(!parsed.success||typeof prepared.compositeProfileSha256!=='string')return null;
 try{assertRecoveryCompositeProfileSafety(parsed.data);return digestRecoveryCompositeProfile(parsed.data,digest)===prepared.compositeProfileSha256?{profile:parsed.data,profileSha256:prepared.compositeProfileSha256}:null;}catch{return null;}
}
