import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import {
  mapCartActivityContractInput,
  mapCheckoutCreatedContractInput,
  mapCheckoutUpdatedContractInput,
  parseRuntimeShopifyEvent,
} from "./shopify-contract-adapter.js";

/** Keep the consent signal outside checkout-v2/v3 parsing and recovery logic. */
export interface CheckoutQueueHandlers {
  checkoutCreated(input: ReturnType<typeof mapCheckoutCreatedContractInput>): Promise<unknown>;
  checkoutUpdated(input: ReturnType<typeof mapCheckoutUpdatedContractInput>): Promise<unknown>;
  cartActivity(input: ReturnType<typeof mapCartActivityContractInput>): Promise<unknown>;
  consentSync(data: unknown): Promise<unknown>;
}

export async function dispatchCheckoutQueueJob(
  job: { name: string; data: unknown },
  handlers: CheckoutQueueHandlers,
): Promise<void> {
  switch (job.name) {
    case SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC.jobName:
      // Its own Shared schema and current-state synchroniser own validation.
      // Never parse as a checkout event or enqueue a candidate/recovery.
      await handlers.consentSync(job.data);
      return;

    case SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName:
      await handlers.checkoutCreated(mapCheckoutCreatedContractInput(parseRuntimeShopifyEvent(job.data)));
      return;

    case SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.jobName:
      await handlers.checkoutUpdated(mapCheckoutUpdatedContractInput(parseRuntimeShopifyEvent(job.data)));
      return;

    case SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CART_ACTIVITY_EVENTS.jobName:
      await handlers.cartActivity(mapCartActivityContractInput(parseRuntimeShopifyEvent(job.data)));
      return;

    default:
      // Never include unknown job names or data in error/log output.
      throw new Error("Unknown checkout-events queue job name");
  }
}
