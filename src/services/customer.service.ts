import type { UpsertShopifyCustomerInput } from "../domain/types.js";
import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import prisma from "../lib/db.js";
import type { Customer } from "@prisma/client";
import { customerPhoneService } from "./customer.phone.service.js";
export class CustomerService {

async resolveCustomer(
  event: RecoveryCheckoutSeed,
): Promise<Customer | null> {
  const incoming = event.customer;

  if (!incoming) {
    return null;
  }

  const shop = await prisma.shop.findUnique({
    where: {
      domain: event.shop,
    },
  });

  if (!shop) {
    throw new Error(
      `Shop not found for domain ${event.shop}`,
    );
  }

  const {
    shopifyCustomerId,
    phone,
    email,
    firstName,
    lastName,
  } = incoming;

  /*
   * 1. Shopify customer ID is our strongest identity.
   */
  if (shopifyCustomerId) {
    const existingCustomer =
      await prisma.customer.findUnique({
        where: {
          shopId_shopifyCustomerId: {
            shopId: shop.id,
            shopifyCustomerId,
          },
        },
      });

    if (existingCustomer) {
      const customer =
        await prisma.customer.update({
          where: {
            id: existingCustomer.id,
          },

          data: {
            ...(email !== undefined && { email }),
            ...(firstName !== undefined && { firstName }),
            ...(lastName !== undefined && { lastName }),
          },
        });

      if (phone) {
        await customerPhoneService.setCurrentPhone({
          customerId: customer.id,
          phone,
        });
      }

      return customer;
    }
  }

  /*
   * 2. If we don't already know the Shopify customer,
   *    try to resolve an existing customer by their
   *    current phone number.
   *
   *    This is important for customers originally created
   *    from a checkout before Shopify supplied a customer ID.
   */
  if (phone) {
    const customerByPhone =
      await customerPhoneService.findCurrentCustomerByPhone({
        shopId: shop.id,
        phone,
      });

    if (customerByPhone) {
      const customer =
        await prisma.customer.update({
          where: {
            id: customerByPhone.id,
          },

          data: {
            ...(shopifyCustomerId !== undefined && {
              shopifyCustomerId,
            }),

            ...(email !== undefined && { email }),
            ...(firstName !== undefined && { firstName }),
            ...(lastName !== undefined && { lastName }),
          },
        });

      return customer;
    }
  }

  /*
   * 3. We couldn't identify an existing customer.
   *
   *    If we have neither Shopify identity nor phone,
   *    there isn't enough information to create a useful
   *    customer record yet.
   */
  if (!shopifyCustomerId && !phone) {
    return null;
  }

  const customer =
    await prisma.customer.create({
      data: {
        shopId: shop.id,

        ...(shopifyCustomerId !== undefined && {
          shopifyCustomerId,
        }),

        ...(email !== undefined && { email }),
        ...(firstName !== undefined && { firstName }),
        ...(lastName !== undefined && { lastName }),
      },
    });

  if (phone) {
    await customerPhoneService.setCurrentPhone({
      customerId: customer.id,
      phone,
    });
  }

  return customer;
}



async upsertShopifyCustomer(
  input: UpsertShopifyCustomerInput,
): Promise<Customer> {
  const {
    shopId,
    shopifyCustomerId,
    phone,
    email,
    firstName,
    lastName,
  } = input;

const updateData = {
  ...(email !== undefined && { email }),
  ...(firstName !== undefined && { firstName }),
  ...(lastName !== undefined && { lastName }),
};

const customer = await prisma.customer.upsert({
  where: {
    shopId_shopifyCustomerId: {
      shopId,
      shopifyCustomerId,
    },
  },

  update: updateData,

  create: {
    shopId,
    shopifyCustomerId,
    ...(email !== undefined && { email }),
    ...(firstName !== undefined && { firstName }),
    ...(lastName !== undefined && { lastName }),
  },
});

  if (phone) {
    let currentPhone = {
      customerId: customer.id,
      phone,
    }
    await customerPhoneService.setCurrentPhone(currentPhone);
  }

  return customer;
}

}
function normalizePhone(phone: string): string {
  return phone.trim();
}
export const customerService =
  new CustomerService();