import type {Prisma} from '@prisma/client';
/** Shared repository-local mixed-history window; moderation must not scan farther. */
export const commerceHistoryVisible: Prisma.ConversationMessageWhereInput = {
  contentType: { not: "UNSUPPORTED" },
  transcriptionStatus: { in: ["NOT_REQUIRED", "COMPLETED"] },
  OR: [
    { direction: "INBOUND", senderType: "CUSTOMER" },
    { direction: "OUTBOUND", sentAt: { not: null } },
  ],
};

export function priorCommerceHistorySelection(conversationId:string,boundary:Date,anchor?:{id:string;createdAt:Date}):{where:Prisma.ConversationMessageWhereInput;orderBy:Prisma.ConversationMessageOrderByWithRelationInput[];take:number}{
 const before:Prisma.ConversationMessageWhereInput[]=[
  {contentType:{not:'AUDIO'},createdAt:{lt:boundary}},
  {contentType:'AUDIO',transcriptionCompletedAt:{lt:boundary}},
 ];
 if(anchor){
  // Include stable predecessors at equal readiness, including merchant replies.
  if(anchor.createdAt.getTime()===boundary.getTime())before.push({contentType:{not:'AUDIO'},createdAt:boundary,id:{lt:anchor.id}});
  before.push({contentType:'AUDIO',transcriptionCompletedAt:boundary,OR:[
   {createdAt:{lt:anchor.createdAt}},{createdAt:anchor.createdAt,id:{lt:anchor.id}},
  ]});
 }
 return {where:{AND:[commerceHistoryVisible,{conversationId,OR:before}]},orderBy:[{createdAt:'desc'},{id:'desc'}],take:20};
}

/** The inbound version advances when an audio transcript becomes ready. Use the
 * same readiness chronology for objective selection, with stable identity ties. */
export type CommerceHistoryActivity = {id:string;createdAt?:Date;contentType?:string;transcriptionCompletedAt?:Date|null};
export function commerceHistoryActivityAt(row:CommerceHistoryActivity):Date|undefined {
 return row.contentType==='AUDIO' ? row.transcriptionCompletedAt??row.createdAt : row.createdAt;
}
export function orderCommerceHistory<T extends CommerceHistoryActivity>(rows:readonly T[]):T[]{
 return [...rows].sort((a,b)=>{
  const left=commerceHistoryActivityAt(a)?.getTime(),right=commerceHistoryActivityAt(b)?.getTime();
  // Unit/adaptor rows without timestamps retain their explicitly supplied order.
  if(left===undefined||right===undefined)return 0;
  return left-right||(a.createdAt?.getTime()??left)-(b.createdAt?.getTime()??right)||a.id.localeCompare(b.id);
 });
}
