import { canonicalJson, CommerceProductSchema } from '@modainteract/moda-interact-shared/commerce';
import { CommerceVerifiedPresentationSchema, formatObservedMoney, stockFactMessages, verifyCommerceProductFacts } from '@modainteract/moda-interact-shared/commerce/presentation';
import { createInternationalizationRuntime, resolveModaConfigurationLocale, type ModaSupportedLanguageTag } from '@modainteract/moda-interact-shared/internationalization';
import type { CommercePresentationInput } from '../services/conversation-wrappers/contracts.js';

/** Application presentation copy, never a claim that omitted facts are unavailable. */
export const BRIEF_PRODUCT_COPY: Readonly<Record<ModaSupportedLanguageTag, readonly [string,string,string]>> = {
 'zh-Hans':['商品简要列表','价格','类别'],'zh-Hant':['商品簡要清單','價格','類別'],
 cs:['Stručný přehled produktů','Cena','Kategorie'],da:['Kort produktoversigt','Pris','Kategori'],nl:['Kort productoverzicht','Prijs','Categorie'],
 en:['Brief product list','Price','Category'],fi:['Lyhyt tuoteluettelo','Hinta','Luokka'],fr:['Résumé des produits','Prix','Catégorie'],de:['Kurze Produktübersicht','Preis','Kategorie'],
 it:['Breve elenco dei prodotti','Prezzo','Categoria'],ja:['商品の概要一覧','価格','カテゴリ'],ko:['간단한 상품 목록','가격','카테고리'],nb:['Kort produktoversikt','Pris','Kategori'],
 pl:['Krótka lista produktów','Cena','Kategoria'],'pt-BR':['Resumo dos produtos','Preço','Categoria'],'pt-PT':['Resumo dos produtos','Preço','Categoria'],
 es:['Resumen de productos','Precio','Categoría'],sv:['Kort produktöversikt','Pris','Kategori'],th:['รายการสินค้าฉบับย่อ','ราคา','หมวดหมู่'],tr:['Kısa ürün listesi','Fiyat','Kategori'],
};
const key = (p:{productId:string;variantId:string|null}) => JSON.stringify([p.productId,p.variantId]);
/** Called only by the overflowing AI caption path. Original cardinality, not a
 * reduced prefix or inferred customer intent, controls list-summary eligibility. */
export function briefProductDetailCandidates(input:CommercePresentationInput): {body:string;pairs:{productId:string;variantId:string|null}[]}[] | undefined {
 const p=CommerceVerifiedPresentationSchema.parse(input.verified),facts=p.productFacts;
 if(input.envelope.answerKind!=='ANSWER'||p.disposition!=='PRODUCT_DETAILS'||new Set(facts.map(f=>f.productId)).size<2)return undefined;
 const pairs=facts.map(({productId,variantId})=>({productId,variantId}));
 const proof=input.verifiedProducts?.products??[];
 const verified=verifyCommerceProductFacts(pairs,proof);
 if(verified.kind!=='verified'||canonicalJson(verified.productFacts)!==canonicalJson(facts))return [];
 const locale=resolveModaConfigurationLocale(p.locale),copy=BRIEF_PRODUCT_COPY[locale],stock=stockFactMessages[locale];
 const runtime=createInternationalizationRuntime({locale,catalogue:{}}),entries:string[]=[];
 for(const fact of facts){
  const product=CommerceProductSchema.safeParse(proof.find(item=>key(item)===key(fact)));if(!product.success)return [];
  const lines=[fact.title];
  if(product.data.unitPrice!==null&&product.data.currency!==null){
   const money=formatObservedMoney(product.data.unitPrice,product.data.currency,runtime);if(money===null)return [];
   lines.push(`${copy[1]}: ${money} ${product.data.currency}`);
  }
  lines.push(fact.stock.status==='KNOWN'?`${fact.stock.scope==='VARIANT'?stock[1]:stock[0]}: ${runtime.formatNumber(fact.stock.quantity)}`:fact.stock.status==='NOT_TRACKED'?stock[2]:stock[3]);
  if(product.data.productType?.trim())lines.push(`${copy[2]}: ${product.data.productType}`);
  entries.push(lines.join('\n'));
 }
 return Array.from({length:entries.length},(_,index)=>{
  const count=entries.length-index;return {body:copy[0]+'\n\n'+entries.slice(0,count).join('\n\n'),pairs:pairs.slice(0,count)};
 });
}
