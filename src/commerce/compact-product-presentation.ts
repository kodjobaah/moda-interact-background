import { briefProductDetailCandidates } from "./brief-product-list.js";
import {
  type ModaSupportedLanguageTag,
  resolveModaConfigurationLocale,
} from "@modainteract/moda-interact-shared/internationalization";
import type { CommercePresentationInput } from "../services/conversation-wrappers/contracts.js";
import type { CommonLayoutReceipt } from "../services/recovery-multipart/common-layout.js";
import { presentationCandidates } from "./presentation-receipt.js";

/** Application-owned conversation copy; this promises no unobserved catalogue facts. */
export const PRODUCT_SHOW_MORE: Readonly<
  Record<ModaSupportedLanguageTag, string>
> = {
  "zh-Hans": "想了解更多商品，可以问我。",
  "zh-Hant": "想了解更多商品，可以問我。",
  cs: "Chcete další možnosti? Zeptejte se mě.",
  da: "Spørg mig gerne om flere muligheder.",
  nl: "Vraag me gerust naar meer opties.",
  en: "Ask me for more options.",
  fi: "Kysy minulta lisää vaihtoehtoja.",
  fr: "Demandez-moi d’autres options.",
  de: "Fragen Sie mich nach weiteren Optionen.",
  it: "Chiedimi altre opzioni.",
  ja: "ほかの選択肢についてもお尋ねください。",
  ko: "다른 옵션이 궁금하면 물어보세요.",
  nb: "Spør meg gjerne om flere alternativer.",
  pl: "Zapytaj mnie o więcej opcji.",
  "pt-BR": "Peça mais opções.",
  "pt-PT": "Peça mais opções.",
  es: "Pregúntame por más opciones.",
  sv: "Fråga mig gärna om fler alternativ.",
  th: "สอบถามตัวเลือกเพิ่มเติมได้",
  tr: "Daha fazla seçenek için bana sorabilirsiniz.",
};
export const PRODUCT_CAPTION_TARGET = 400;
export const PRODUCT_CAPTION_LINE_TARGET = 8;
/** App target only: WhatsApp may fold even a shorter caption after URL wrapping. */
export function captionWithinDisplayTarget(caption: string): boolean {
  return (
    Array.from(caption).length <= PRODUCT_CAPTION_TARGET &&
    caption
      .split(/\r\n|[\n\r\u2028\u2029]/u)
      .filter((line) => line.trim().length > 0).length <=
      PRODUCT_CAPTION_LINE_TARGET
  );
}
type Boundaries = CommonLayoutReceipt["boundaries"];
const pairKey = (pair: { productId: string; variantId: string | null }) =>
  JSON.stringify([pair.productId, pair.variantId]);

/** Complete verified entries only. Never parse/truncate the model's product prose. */
export function fitVerifiedProductCaption(
  input: CommercePresentationInput,
  render: (body: string) => Boundaries | null,
): {
  targetMet: boolean;
  boundaries: Boundaries;
  pairs: { productId: string; variantId: string | null }[];
  presentation: CommercePresentationInput;
} | null {
  // Mixed detail/policy contracts must keep their complete original body; the
  // ordinary recommendation renderer already carries mandatory terms verbatim.
  const details = input.envelope.details;
  if (
    input.verified.disposition === "PRODUCT_DETAILS" &&
    (input.verified.requiresShipping != null ||
      input.verified.policyUrl != null ||
      input.verified.includeNoVerifiedOffer ||
      Object.hasOwn(details, "shippingInformationSelection") ||
      details.responseDisposition === "SHIPPING_INFORMATION_UNVERIFIED" ||
      details.responseDisposition === "OUT_OF_SCOPE_REDIRECT" ||
      input.verified.products.some(
        (product) => (product.offerTerms ?? []).length,
      ))
  )
    return null;
  const candidates =
    briefProductDetailCandidates(input, { concise: true }) ??
    presentationCandidates(input, { completePrefixes: true });
  const locale = resolveModaConfigurationLocale(input.verified.locale);
  const invitation =
    input.verified.disposition === "PRODUCT_DETAILS" &&
    new Set(input.verified.productFacts?.map((pair) => pair.productId)).size ===
      1
      ? ""
      : PRODUCT_SHOW_MORE[locale];
  type Fit = {
    targetMet: boolean;
    boundaries: Boundaries;
    pairs: { productId: string; variantId: string | null }[];
    presentation: CommercePresentationInput;
  };
  let shortestSafe: Fit | null = null;
  for (const candidate of candidates) {
    if (!candidate.pairs.length) continue;
    const middle = candidate.body + (invitation ? `\n\n${invitation}` : "");
    const boundaries = render(middle);
    if (
      !boundaries ||
      Array.from(boundaries.body + boundaries.footer).length > 1024
    )
      continue;
    const pairs = candidate.pairs.map((pair) => ({ ...pair }));
    const retained = new Set(pairs.map(pairKey));
    const presentation: CommercePresentationInput = {
      ...input,
      productPairs: pairs,
      verified: {
        ...input.verified,
        products: input.verified.products.slice(0, pairs.length),
        productFacts: (input.verified.productFacts ?? []).filter((pair) =>
          retained.has(pairKey(pair)),
        ),
        optionFacts: input.verified.optionFacts.filter((pair) =>
          retained.has(pairKey(pair)),
        ),
      },
      ...(input.verifiedProducts
        ? {
            verifiedProducts: {
              ...input.verifiedProducts,
              products: input.verifiedProducts.products.filter((pair) =>
                retained.has(pairKey(pair)),
              ),
            },
          }
        : {}),
    };
    const fitted = {
      targetMet: captionWithinDisplayTarget(
        boundaries.body + boundaries.footer,
      ),
      boundaries,
      pairs,
      presentation,
    };
    if (fitted.targetMet) return fitted;
    shortestSafe = fitted;
  }
  return shortestSafe;
}
