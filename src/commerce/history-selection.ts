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

export function priorCommerceHistorySelection(conversationId:string,boundary:Date):{where:Prisma.ConversationMessageWhereInput;orderBy:Prisma.ConversationMessageOrderByWithRelationInput[];take:number}{
 return {where:{AND:[commerceHistoryVisible,{conversationId,OR:[{contentType:{not:'AUDIO'},createdAt:{lt:boundary}},{contentType:'AUDIO',transcriptionCompletedAt:{lt:boundary}}]}]},orderBy:[{createdAt:'desc'},{id:'desc'}],take:20};
}
