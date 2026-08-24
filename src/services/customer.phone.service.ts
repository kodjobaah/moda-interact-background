import type {
  Customer,
  CustomerPhone,
} from "@prisma/client";

import prisma from "../lib/db.js";
import type { FindCustomerByPhoneInput, SetCurrentPhoneInput } from "../domain/types.js";


class CustomerPhoneService {
  async getCurrentPhone(
    customerId: string,
  ): Promise<CustomerPhone | null> {
    return prisma.customerPhone.findFirst({
      where: {
        customerId,
        endedAt: null,
      },

      orderBy: {
        startedAt: "desc",
      },
    });
  }

  async setCurrentPhone({
    customerId,
    phone,
  }: SetCurrentPhoneInput): Promise<CustomerPhone> {
    const normalizedPhone =
      normalizePhone(phone);

    return prisma.$transaction(async (tx) => {
      const current =
        await tx.customerPhone.findFirst({
          where: {
            customerId,
            endedAt: null,
          },

          orderBy: {
            startedAt: "desc",
          },
        });

      // Nothing has changed.
      if (current?.phone === normalizedPhone) {
        return current;
      }

      const now = new Date();

      /*
       * Close any currently-active phone.
       *
       * updateMany is intentional here. Under normal operation
       * there should only be one, but this also cleans up an
       * inconsistent state if more than one somehow exists.
       */
      await tx.customerPhone.updateMany({
        where: {
          customerId,
          endedAt: null,
        },

        data: {
          endedAt: now,
        },
      });

      return tx.customerPhone.create({
        data: {
          customerId,
          phone: normalizedPhone,
          startedAt: now,
        },
      });
    });
  }

  async findCurrentCustomerByPhone({
    shopId,
    phone,
  }: FindCustomerByPhoneInput): Promise<Customer | undefined | null> {
    const normalizedPhone =
      normalizePhone(phone);

    const matches =
      await prisma.customerPhone.findMany({
        where: {
          phone: normalizedPhone,
          endedAt: null,

          customer: {
            shopId,
          },
        },

        include: {
          customer: true,
        },

        take: 2,
      });

    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple customers found for phone ${normalizedPhone} in shop ${shopId}`,
      );
    }

    return matches[0]?.customer;
  }
}

function normalizePhone(
  phone: string,
): string {
  const trimmed = phone.trim();

  if (!trimmed) {
    throw new Error(
      "Phone number cannot be empty",
    );
  }

  return trimmed;
}

export const customerPhoneService =
  new CustomerPhoneService();