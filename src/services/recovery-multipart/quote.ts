import { Prisma, type PrismaClient } from '@prisma/client';
import { readFrozenMultipart } from './frozen.js';
export type MultipartQuote = {kind:'matched';conversationId:string;recipient:string;acknowledgedAt:Date}|{kind:'invalid'}|null;
/** Lookup precedes current-global sender filtering, but does not authorize a
 * new outgoing sender. Frozen historical account+phone are mandatory here. */
export async function resolveMultipartQuote(database:Pick<PrismaClient,'$queryRaw'>,input:{providerMessageId:string;providerAccountId:string;providerPhoneNumberId:string}):Promise<MultipartQuote>{
 const rows=await database.$queryRaw<Array<{conversationId:string;outboundPresentation:unknown;providerAccountId:string;providerPhoneNumberId:string;state:string;acknowledgedAt:Date|null}>>(Prisma.sql`
   SELECT root."conversationId",root."outboundPresentation",part."providerAccountId",part."providerPhoneNumberId",part."state"::text,part."acknowledgedAt"
   FROM "whatsapp"."ConversationDeliveryPart" part JOIN "whatsapp"."ConversationMessage" root ON root."id"=part."messageId"
   WHERE part."providerMessageId"=${input.providerMessageId} LIMIT 1`);
 const row=rows[0];if(!row)return null;
 const source=readFrozenMultipart(row.outboundPresentation);
 if(!source || !row.acknowledgedAt || !Number.isFinite(row.acknowledgedAt.getTime()) || row.providerAccountId!==input.providerAccountId || row.providerPhoneNumberId!==input.providerPhoneNumberId ||
   source.sender.providerAccountId!==input.providerAccountId || source.sender.providerPhoneNumberId!==input.providerPhoneNumberId ||
   source.receipt.conversationId!==row.conversationId || !['ACKNOWLEDGED','DELIVERED','READ','FAILED'].includes(row.state))return {kind:'invalid'};
 return {kind:'matched',conversationId:row.conversationId,recipient:source.recipient,acknowledgedAt:row.acknowledgedAt};
}
