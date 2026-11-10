import { buildConversationDeliveryPlan, chooseConversationProductImageSource, type ConversationDeliveryPlan, type ConversationProductImageBinding, type ConversationVerifiedProducts } from '@modainteract/moda-interact-shared/commerce/presentation';
import { prepareConversationProductImage } from '@modainteract/moda-interact-shared/commerce/presentation/node';
import { readR2Configuration, readShopBrandPublicMediaConfiguration } from './platform-configuration/consumers.js';
import { loadShopBrandR2Credentials } from './shop-brand-media/r2-config.js';

/** Internal media I/O uses the remaining turn deadline, never model/tool budget. */
export async function prepareConversationDelivery(input: {
 body: string; binding?: ConversationProductImageBinding | undefined; shopId: string;
 displayedPairs: {productId: string; variantId: string | null}[];
 verifiedProducts?: ConversationVerifiedProducts | undefined; deadlineAt: number; signal?: AbortSignal | undefined;
}, deps = { readR2Configuration, readShopBrandPublicMediaConfiguration, prepareConversationProductImage }) {
 const base = { body: input.body, ...(input.binding ? {binding: input.binding} : {}), shopId: input.shopId, displayedPairs: input.displayedPairs };
 const text = {...buildConversationDeliveryPlan(base), mediaStage: "PLAN", durationMs: 0};
 if (!input.binding || !input.displayedPairs.length || Array.from(input.body).length > 1024) return text;
 if (!input.verifiedProducts) return text;
 const source = chooseConversationProductImageSource({shopId: input.shopId, platform: input.verifiedProducts.platform,
  displayedPairs: input.displayedPairs, verifiedProducts: input.verifiedProducts});
 if (source.kind === 'OMITTED') return {...text, mediaOmission: source.reason, mediaStage: 'SOURCE'};
 const budget = Math.min(5000, input.deadlineAt - Date.now() - 1000);
 if (budget <= 0 || input.signal?.aborted) return {...text, mediaOmission: 'MEDIA_DEADLINE' as const, mediaStage: 'CONFIGURATION'};
 const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(budget)]) : AbortSignal.timeout(budget);
 let config;
 try {
  const operation = Promise.all([deps.readShopBrandPublicMediaConfiguration(), deps.readR2Configuration()]);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    if (signal.aborted) listener(); else signal.addEventListener('abort', listener, {once: true});
  });
  const [settings, credentials] = await Promise.race([operation, aborted]).finally(() => { if (listener) signal.removeEventListener('abort', listener); });
  config = {publicOrigin: settings.publicOrigin, bucketName: settings.bucketName, r2: loadShopBrandR2Credentials(credentials)};
 } catch { return {...text, mediaOmission: signal.aborted ? 'MEDIA_DEADLINE' as const : 'CONFIGURATION_UNAVAILABLE' as const, mediaStage: 'CONFIGURATION'}; }
 const result = await deps.prepareConversationProductImage({source, ...config, signal, deadlineAt: input.deadlineAt});
 return result.kind === 'READY' ? {...buildConversationDeliveryPlan({...base, image: result.image}), mediaStage: result.stage, durationMs: result.durationMs}
  : {...text, mediaOmission: result.reason, mediaStage: result.stage, durationMs: result.durationMs};
}
export type { ConversationDeliveryPlan };
