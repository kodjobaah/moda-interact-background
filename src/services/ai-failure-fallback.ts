import type { PrismaClient } from '@prisma/client';
import type { CommonRecoveryLayoutReference } from '@modainteract/moda-interact-shared/commerce/presentation';
import type { ModaSupportedLanguageTag } from '@modainteract/moda-interact-shared/internationalization';
import prisma from '../lib/db.js';
import { CommerceHostError } from '../commerce/mcp-client.js';
import { PrismaConversationWrapperReadRepository } from './conversation-wrappers/repository.js';
import type { WrapperReadPort } from './conversation-wrappers/contracts.js';
import { selectedCommonLayout } from './recovery-multipart/composition.js';
import { formatWholeCheckoutItemsSummary } from './recovery-template-preparation/recovery-template-items-summary.js';

export const AI_FAILURE_DELIVERY_RESERVE_MS = 15_000;
export const AI_FAILURE_MIN_PREPARATION_SEND_MS = 10_000;
export class GenerationBudgetTimeout extends Error {
 constructor(cause?:unknown){super("AI generation budget exhausted",{cause});this.name="GenerationBudgetTimeout";}
}
/** Abort generation at its child deadline; the parent claim is never renewed. */
export async function withGenerationBudget<T>(deadlineAt:number,run:(signal:AbortSignal)=>Promise<T>,now:()=>number=Date.now):Promise<T>{
 const remaining=deadlineAt-now();
 if(!Number.isFinite(remaining)||remaining<=0)throw new GenerationBudgetTimeout();
 const signal=AbortSignal.timeout(Math.ceil(remaining));
 try{return await run(signal);}catch(error){
  if(signal.aborted && (error===signal.reason || (error instanceof CommerceHostError &&
    error.diagnostic?.stage==='host.lifecycle' && ['HOST_CANCELLED','HOST_DEADLINE_EXCEEDED'].includes(error.diagnostic.reasonCode))))throw new GenerationBudgetTimeout(error);
  throw error;
 }
}
/** This is an application recovery decision, not a relaxation of the runner. */
export function eligibleGenerationFailure(error: unknown): boolean {
  if (error instanceof GenerationBudgetTimeout) return true;
  if (!(error instanceof CommerceHostError)) return false;
  const diagnostic = error.diagnostic;
  if ([401,403].includes(error.sourceFailure?.httpStatus ?? diagnostic?.statusCode ?? 0)) return false;
  if (!diagnostic || ['DENIED','CANCELLED','INVALID_INPUT','CONFIGURATION','INCOMPATIBLE_VERSION'].includes(error.code)) return false;
  if (['host.authorization','host.turn_state','host.grant','host.release','configuration','presentation.verify'].includes(diagnostic.stage)) return false;
  if (diagnostic.stage === 'host.lifecycle') return diagnostic.reasonCode === 'HOST_DEADLINE_EXCEEDED';
  if (diagnostic.stage === 'host.runner_result') return diagnostic.reasonCode === 'HOST_RUNNER_FAILURE' &&
    !/DENIED|CANCEL|STALE|AUTHORIZ|LEASE/u.test(diagnostic.runnerDiagnostic?.reasonCode ?? '');
  // Only actual tool execution/transport failures, never authentication or grants.
  return ['mcp.tool_call','mcp.tool_result'].includes(diagnostic.stage) &&
    !['MCP_HTTP_UNAUTHENTICATED','MCP_HTTP_FORBIDDEN','HOST_TOOL_GRANT_MISMATCH','HOST_TOOL_NOT_GRANTED'].includes(diagnostic.reasonCode);
}

// Application-owned copy. The locale is the selected saved common locale, never
// a failed model's language guess. Entries describe a historical saved snapshot.
export const FAILURE_COPY: Readonly<Record<ModaSupportedLanguageTag, readonly [string,string,string]>> = {
 en:['Unfortunately, I’m unable to answer your question right now.','Here are the details of your abandoned basket.','Saved basket snapshot'],
 fr:['Malheureusement, je ne peux pas répondre à votre question pour le moment.','Voici les détails de votre panier abandonné.','Panier enregistré'],
 de:['Leider kann ich Ihre Frage gerade nicht beantworten.','Hier sind die Details Ihres verlassenen Warenkorbs.','Gespeicherter Warenkorb'],
 es:['Lamentablemente, no puedo responder a tu pregunta en este momento.','Estos son los detalles de tu carrito abandonado.','Carrito guardado'],
 it:['Purtroppo non riesco a rispondere alla tua domanda in questo momento.','Ecco i dettagli del tuo carrello abbandonato.','Carrello salvato'],
 nl:['Helaas kan ik je vraag momenteel niet beantwoorden.','Hier zijn de gegevens van je achtergelaten winkelmandje.','Opgeslagen winkelmandje'],
 da:['Desværre kan jeg ikke besvare dit spørgsmål lige nu.','Her er oplysningerne om din forladte kurv.','Gemt kurv'],
 fi:['Valitettavasti en voi vastata kysymykseesi juuri nyt.','Tässä ovat hylätyn ostoskorisi tiedot.','Tallennettu ostoskori'],
 nb:['Dessverre kan jeg ikke svare på spørsmålet ditt akkurat nå.','Her er detaljene for den forlatte handlekurven din.','Lagret handlekurv'],
 sv:['Tyvärr kan jag inte besvara din fråga just nu.','Här är uppgifterna om din övergivna varukorg.','Sparad varukorg'],
 cs:['Bohužel teď nemohu odpovědět na vaši otázku.','Zde jsou podrobnosti o vašem opuštěném košíku.','Uložený košík'],
 pl:['Niestety nie mogę teraz odpowiedzieć na Twoje pytanie.','Oto szczegóły Twojego porzuconego koszyka.','Zapisany koszyk'],
 'pt-BR':['Infelizmente, não consigo responder à sua pergunta agora.','Aqui estão os detalhes do seu carrinho abandonado.','Carrinho salvo'],
 'pt-PT':['Infelizmente, não consigo responder à sua pergunta neste momento.','Aqui estão os detalhes do seu carrinho abandonado.','Carrinho guardado'],
 tr:['Ne yazık ki şu anda sorunuzu yanıtlayamıyorum.','İşte terk ettiğiniz sepetinizin ayrıntıları.','Kaydedilmiş sepet'],
 ja:['申し訳ありませんが、現在ご質問にお答えできません。','放棄されたカートの詳細をご案内します。','保存されたカート'],
 ko:['죄송하지만 지금은 질문에 답변할 수 없습니다.','남겨 두신 장바구니의 내역입니다.','저장된 장바구니'],
 'zh-Hans':['很抱歉，我现在无法回答您的问题。','以下是您未完成购物车的详情。','已保存的购物车快照'],
 'zh-Hant':['很抱歉，我現在無法回答您的問題。','以下是您未完成購物車的詳情。','已儲存的購物車快照'],
 th:['ขออภัย ขณะนี้ฉันไม่สามารถตอบคำถามของคุณได้','นี่คือรายละเอียดตะกร้าสินค้าที่คุณยังไม่ได้ดำเนินการต่อ','ข้อมูลตะกร้าที่บันทึกไว้'],
};
export type AiFailureFallback = Readonly<{replyText:string;commonRef:CommonRecoveryLayoutReference}>;
export type AiFailureFallbackInput = Readonly<{conversationId:string;shopId:string;checkoutRecoveryId:string|null;deadlineAt:number}>;
export class AiFailureFallbackService {
 constructor(private readonly db: Pick<PrismaClient,'conversation'> = prisma,
   private readonly wrappers:WrapperReadPort = new PrismaConversationWrapperReadRepository(),
   private readonly now:()=>number = Date.now) {}
 async prepare(input:AiFailureFallbackInput):Promise<AiFailureFallback|null>{
  // Leave a real delivery budget within the ORIGINAL claim. No renewed lease.
  if(!Number.isSafeInteger(input.deadlineAt)||!input.checkoutRecoveryId || input.deadlineAt-this.now()<AI_FAILURE_MIN_PREPARATION_SEND_MS)return null;
  const context=await this.wrappers.loadContext(input.conversationId);
  if(!context||context==='TENANT_MISMATCH'||context.shopId!==input.shopId||!context.checkoutAvailable)return null;
  const selected=selectedCommonLayout(await this.wrappers.loadSlots(),context);
  if(!selected)return null;
  const row=await this.db.conversation.findUnique({where:{id:input.conversationId},select:{shopId:true,customerId:true,checkoutRecoveryId:true,checkoutRecovery:{select:{id:true,shopId:true,customerId:true,status:true,lineItems:true}}}});
  const recovery=row?.checkoutRecovery;
  if(!row||(row.shopId!==null&&row.shopId!==input.shopId)||row.checkoutRecoveryId!==input.checkoutRecoveryId||!recovery||recovery.id!==input.checkoutRecoveryId||recovery.shopId!==input.shopId||!recovery.customerId||(row.customerId!==null&&row.customerId!==recovery.customerId)||!['DETECTED','MESSAGE_SENT','ENGAGED'].includes(recovery.status))return null;
  const copy=FAILURE_COPY[selected.reference.languageTag as ModaSupportedLanguageTag];if(!copy)return null;
  const hasBasket=recovery.lineItems!==null;
  const items=hasBasket?formatWholeCheckoutItemsSummary(recovery.lineItems,selected.reference.languageTag):null;
  // Missing/unsafe snapshot facts produce inability-only; identity and checkout
  // authority above remain mandatory. No invented item can enter the body.
  if(input.deadlineAt-this.now()<AI_FAILURE_MIN_PREPARATION_SEND_MS)return null;
  return {replyText:items?`${copy[0]} ${copy[1]}\n\n${copy[2]}\n${items}`:copy[0],commonRef:selected.reference};
 }
}
