export interface CheckoutCreatedEvent {
  shop: string;

  checkoutToken: string;
  cartToken: string | null;

  detectedAt: string;

  currency: string | null;
  totalPrice: string | null;
  checkoutUrl: string | null;

  completedAt: string | null;

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
