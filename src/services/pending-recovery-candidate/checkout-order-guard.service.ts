import { randomUUID } from "node:crypto";
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
        let callbackFailed = false;
        let callbackError: unknown;
        let result!: T;
        try {
          result = await fn();
        } catch (error) {
          callbackFailed = true;
          callbackError = error;
        }

        let cleanupFailed = false;
        let cleanupError: unknown;
        try {
          const value = await connectionRedis.get(lockKey);
          if (value === owner) {
            await connectionRedis.del(lockKey);
          }
        } catch (error) {
          cleanupFailed = true;
          cleanupError = error;
        }

        if (callbackFailed && cleanupFailed) {
          const primaryMessage = callbackError instanceof Error
            ? callbackError.message
            : String(callbackError);
          const cleanupMessage = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
          throw new Error(
            `${primaryMessage}: checkout lock cleanup failed: ${cleanupMessage}`,
            { cause: new AggregateError([callbackError, cleanupError], "Callback and checkout lock cleanup failed") },
          );
        }
        if (callbackFailed) throw callbackError;
        if (cleanupFailed) throw cleanupError;
        return result;
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

/**
 * Woo's four business services share this leased checkout lock. Unlike the
 * legacy Shopify lock above, this path renews the lease while work is running
 * and checks/releases ownership with atomic Redis scripts. Never use GET+DEL
 * for Woo: a lease may expire between those two calls.
 */
const WOO_LOCK_RENEW_INTERVAL_MS = 3_000;
const RENEW_OWNED_LOCK = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;
const RELEASE_OWNED_LOCK = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export class WooCheckoutLeaseGuard {
  constructor(private readonly redis: Pick<
    typeof connectionRedis, "set" | "eval"
  > = connectionRedis) {}

  async withCheckoutLock<T>(shopId: string, checkoutToken: string, run: () => Promise<T>): Promise<T> {
    const lockKey = checkoutOrderLockKey({ shopId, checkoutToken });
    const owner = randomUUID();
    for (let attempt = 0; attempt < CHECKOUT_LOCK_RETRIES; attempt += 1) {
      const acquired = await this.redis.set(lockKey, owner, "PX", CHECKOUT_LOCK_TTL_MS, "NX");
      if (acquired !== "OK") {
        await sleep(CHECKOUT_LOCK_RETRY_DELAY_MS);
        continue;
      }

      let leaseError: unknown;
      let renewal: Promise<void> | undefined;
      const renew = () => {
        if (renewal || leaseError) return;
        renewal = Promise.resolve().then(() => this.redis.eval(
          RENEW_OWNED_LOCK, 1, lockKey, owner, String(CHECKOUT_LOCK_TTL_MS),
        )).then((changed) => {
          if (changed !== 1) throw new Error("woo-checkout-lock-lease-lost");
        }).catch((error: unknown) => {
          leaseError = error;
        }).finally(() => {
          renewal = undefined;
        });
      };
      const interval = setInterval(renew, WOO_LOCK_RENEW_INTERVAL_MS);
      interval.unref();

      let primaryError: unknown;
      let failed = false;
      let result!: T;
      try {
        result = await run();
      } catch (error) {
        failed = true;
        primaryError = error;
      } finally {
        clearInterval(interval);
      }

      if (renewal) await renewal;
      let cleanupError: unknown;
      let cleanupFailed = false;
      try {
        // Even on callback failure, release only our own lease. A renewal
        // failure is never treated as a successful, guarded operation.
        const released = await this.redis.eval(RELEASE_OWNED_LOCK, 1, lockKey, owner);
        if (released !== 1) throw new Error("woo-checkout-lock-lease-lost");
        if (leaseError) throw leaseError;
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
      if (failed && cleanupFailed) {
        throw new AggregateError([primaryError, cleanupError],
          "Woo checkout callback and lease cleanup failed", { cause: primaryError });
      }
      if (failed) throw primaryError;
      if (cleanupFailed) throw cleanupError;
      return result;
    }
    throw new Error("woo-checkout-lock-timeout");
  }
}
