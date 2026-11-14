import { type ModaSupportedLanguageTag, resolveModaConfigurationLocale } from '@modainteract/moda-interact-shared/internationalization';
import type { CommercePresentationInput } from '../services/conversation-wrappers/contracts.js';
import type { CommonLayoutReceipt } from '../services/recovery-multipart/common-layout.js';
import { presentationCandidates } from './presentation-receipt.js';

/** Application-owned conversation copy; this promises no unobserved catalogue facts. */
export const PRODUCT_SHOW_MORE: Readonly<Record<ModaSupportedLanguageTag, string>> = {
 'zh-Hans':'想了解更多商品，可以问我。','zh-Hant':'想了解更多商品，可以問我。',
 cs:'Chcete další možnosti? Zeptejte se mě.',da:'Spørg mig gerne om flere muligheder.',nl:'Vraag me gerust naar meer opties.',
 en:'Ask me for more options.',fi:'Kysy minulta lisää vaihtoehtoja.',fr:'Demandez-moi d’autres options.',de:'Fragen Sie mich nach weiteren Optionen.',
 it:'Chiedimi altre opzioni.',ja:'ほかの選択肢についてもお尋ねください。',ko:'다른 옵션이 궁금하면 물어보세요.',nb:'Spør meg gjerne om flere alternativer.',
 pl:'Zapytaj mnie o więcej opcji.','pt-BR':'Peça mais opções.','pt-PT':'Peça mais opções.',es:'Pregúntame por más opciones.',sv:'Fråga mig gärna om fler alternativ.',th:'สอบถามตัวเลือกเพิ่มเติมได้',tr:'Daha fazla seçenek için bana sorabilirsiniz.',
};
type Boundaries = CommonLayoutReceipt['boundaries'];
const pairKey = (pair: { productId: string; variantId: string | null }) => JSON.stringify([pair.productId, pair.variantId]);

/** Complete verified entries only. Never parse/truncate the model's product prose. */
export function fitVerifiedProductCaption(input: CommercePresentationInput, render: (body: string) => Boundaries | null): {
 boundaries: Boundaries; pairs: { productId: string; variantId: string | null }[]; presentation: CommercePresentationInput;
} | null {
 const candidates = presentationCandidates(input, { completePrefixes: true });
 for (const candidate of candidates) {
  if (!candidate.pairs.length) continue;
  const middle = candidate.body + `\n\n${PRODUCT_SHOW_MORE[resolveModaConfigurationLocale(input.verified.locale)]}`;
  const boundaries = render(middle);
  if (!boundaries || Array.from(boundaries.body + boundaries.footer).length > 1024) continue;
  const pairs = candidate.pairs.map(pair => ({ ...pair }));
  const retained = new Set(pairs.map(pairKey));
  const presentation: CommercePresentationInput = { ...input, productPairs: pairs,
   verified: { ...input.verified, products: input.verified.products.slice(0, pairs.length),
    productFacts: (input.verified.productFacts ?? []).filter(pair => retained.has(pairKey(pair))),
    optionFacts: input.verified.optionFacts.filter(pair => retained.has(pairKey(pair))) },
   ...(input.verifiedProducts ? { verifiedProducts: { ...input.verifiedProducts,
    products: input.verifiedProducts.products.filter(pair => retained.has(pairKey(pair))) } } : {}),
  };
  return { boundaries, pairs, presentation };
 }
 return null;
}
