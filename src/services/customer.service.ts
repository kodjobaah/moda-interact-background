import type { CheckoutCreatedEvent } from "../events/checkout-events.js";
import prisma from "../lib/db.js";

export class CustomerService {

  async resolveCustomer(event: CheckoutCreatedEvent) {
    const customer = event.customer;

    if (!customer.phone) {
      return null;
    }

    return prisma.customer.upsert({
      where: {
        shop_phone: {
          shop: event.shop,
          phone: customer.phone,
        },
      },

      create: {
        shop: event.shop,

        phone: customer.phone,
        email: customer.email,

        firstName: customer.firstName,
        lastName: customer.lastName,

        shopifyCustomerId: customer.shopifyCustomerId,
      },

      update: {
        email: customer.email,

        firstName: customer.firstName,
        lastName: customer.lastName,

        shopifyCustomerId: customer.shopifyCustomerId,
      },
    });
  }

}

export const customerService =
  new CustomerService();