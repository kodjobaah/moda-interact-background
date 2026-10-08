import {
  checkoutOrderCompletedKey,
  checkoutOrderLockKey,
} from "../../domain/pending-recovery-candidate.js";
import { connectionRedis } from "../../lib/redis.js";

const CHECKOUT_LOCK_TTL_MS = 10_000;
const CHECKOUT_LOCK_RETRIES = 30;
const CHECKOUT_LOCK_RETRY_DELAY_MS = 100;
const ORDER_COMPLETED_TOMBSTONE_TTL_MS = 60 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CheckoutOrderGuardService {
  async withCheckoutLock<T>(
    shopId: string,
    checkoutToken: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = checkoutOrderLockKey({ shopId, checkoutToken });
    const owner = `${Date.now()}-${Math.random()}`;

    for (let attempt = 0; attempt < CHECKOUT_LOCK_RETRIES; attempt += 1) {
      const acquired = await connectionRedis.set(
        lockKey,
        owner,
        "PX",
        CHECKOUT_LOCK_TTL_MS,
        "NX",
      );

      if (acquired === "OK") {
        try {
          return await fn();
        } finally {
          const value = await connectionRedis.get(lockKey);
          if (value === owner) {
            await connectionRedis.del(lockKey);
          }
        }
      }

      await sleep(CHECKOUT_LOCK_RETRY_DELAY_MS);
    }

    throw new Error(
      `Timed out acquiring checkout lock for ${shopId}:${checkoutToken}`,
    );
  }

  async markOrderProcessed(shopId: string, checkoutToken: string) {
    await connectionRedis.set(
      checkoutOrderCompletedKey({ shopId, checkoutToken }),
      "1",
      "PX",
      ORDER_COMPLETED_TOMBSTONE_TTL_MS,
    );
  }

  async hasOrderProcessed(shopId: string, checkoutToken: string) {
    const value = await connectionRedis.get(
      checkoutOrderCompletedKey({ shopId, checkoutToken }),
    );
    return value != null;
  }
}
