import {digestRecoveryCompositeProfile,type RecoveryCompositeProfile} from '@modainteract/moda-interact-shared/commerce/presentation';
import {digest} from '../../../../src/services/conversation-wrappers/projection.js';
/** Test-authored choices only: production has no Background visual defaults. */
export const profiles:RecoveryCompositeProfile[]=[
 {schemaVersion:1,fontId:'DEJAVU_SANS_2_37',canvasWidth:1125,headerOnlyHeight:300,withProductHeight:900,logoLeft:48,logoTop:72,logoWidth:180,logoHeight:140,textLeft:264,textTop:20,textWidth:813,textHeight:240,fontSize:44,textLineSpacingPt:0,productLeft:262,productTop:300,productWidth:600,productHeight:600},
 {schemaVersion:1,fontId:'DEJAVU_SANS_2_37',canvasWidth:1125,headerOnlyHeight:600,withProductHeight:1240,logoLeft:472,logoTop:12,logoWidth:180,logoHeight:100,textLeft:40,textTop:128,textWidth:1045,textHeight:440,fontSize:34,textLineSpacingPt:46,productLeft:112,productTop:640,productWidth:900,productHeight:600},
];
export const templateProfile=(profile=profiles[0]!)=>({compositeProfile:profile,compositeProfileSha256:digestRecoveryCompositeProfile(profile,digest)});
