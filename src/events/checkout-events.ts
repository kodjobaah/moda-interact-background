// Internal seed shape retained for legacy recovery-message helpers only.
// Cross-service queue contracts are parsed from @modainteract/moda-interact-shared.
import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";

export interface RecoveryCheckoutSeed {
  shop: string;

  checkoutToken: string;
  cartToken: string | null;

  detectedAt: string;

  currency: string | null;
  totalPrice: string | null;
  checkoutUrl: string | null;

  completedAt: string | null;

  internationalContext?: InternationalContext;

  customer: {
    shopifyCustomerId: string | null;
    phone: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };

  lineItems: Array<{
    productId: string | null;
    variantId: string | null;
    title: string | null;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    price: string | null;
  }>;
}
