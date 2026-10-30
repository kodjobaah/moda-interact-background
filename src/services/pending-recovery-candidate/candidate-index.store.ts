import {
  pendingCandidateCartIndexKey,
  pendingCandidateCheckoutIndexKey,
  pendingCandidateIndexTtlMs,
  pendingCandidateShopIndexKey,
} from "../../domain/pending-recovery-candidate.js";
import { connectionRedis } from "../../lib/redis.js";

/** Identity-only storage: Woo and Shopify share the index keys but not their
 * candidate payloads. The Woo source is retained in its BullMQ job data. */
type CandidateIndexIdentity = {
  shopId: string;
  checkoutToken: string;
  cartToken?: string | null;
};

export class PendingRecoveryCandidateIndexStore {
  async findByCheckout(input: { shopId: string; checkoutToken: string }) {
    return connectionRedis.get(
      pendingCandidateCheckoutIndexKey({
        shopId: input.shopId,
        checkoutToken: input.checkoutToken,
      }),
    );
  }

  async findByCart(input: { shopId: string; cartToken: string }) {
    return connectionRedis.get(
      pendingCandidateCartIndexKey({
        shopId: input.shopId,
        cartToken: input.cartToken,
      }),
    );
  }

  async upsert(input: {
    candidate: CandidateIndexIdentity;
    jobId: string;
    delayMinutes: number;
    dueAtMs: number;
    shouldIndexShop: boolean;
    /** Woo's outage/replay horizon can exceed the legacy Shopify index TTL. */
    retentionMs?: number;
  }) {
    const ttlMs = input.retentionMs ?? pendingCandidateIndexTtlMs(input.delayMinutes);

    await connectionRedis.set(
      pendingCandidateCheckoutIndexKey({
        shopId: input.candidate.shopId,
        checkoutToken: input.candidate.checkoutToken,
      }),
      input.jobId,
      "PX",
      ttlMs,
    );

    if (input.candidate.cartToken) {
      await connectionRedis.set(
        pendingCandidateCartIndexKey({
          shopId: input.candidate.shopId,
          cartToken: input.candidate.cartToken,
        }),
        input.jobId,
        "PX",
        ttlMs,
      );
    }

    if (input.shouldIndexShop) {
      await connectionRedis.zadd(
        pendingCandidateShopIndexKey(input.candidate.shopId),
        input.dueAtMs,
        input.jobId,
      );
    } else {
      await this.removeShopMember(input.candidate.shopId, input.jobId);
    }
  }

  async remove(
    candidate: CandidateIndexIdentity,
    jobId?: string,
  ) {
    const keys = [
      pendingCandidateCheckoutIndexKey({
        shopId: candidate.shopId,
        checkoutToken: candidate.checkoutToken,
      }),
    ];

    if (candidate.cartToken) {
      keys.push(
        pendingCandidateCartIndexKey({
          shopId: candidate.shopId,
          cartToken: candidate.cartToken,
        }),
      );
    }

    await connectionRedis.del(...keys);

    if (jobId) {
      await this.removeShopMember(candidate.shopId, jobId);
    }
  }

  /** Woo cleanup may only clear the checkout pointer while it still owns it. */
  async compareAndRemoveCheckout(input: { shopId: string; checkoutToken: string }, jobId: string): Promise<boolean> {
    const key = pendingCandidateCheckoutIndexKey(input);
    const removed = await connectionRedis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      key,
      jobId,
    );
    if (Number(removed) === 1) {
      await this.removeShopMember(input.shopId, jobId);
      return true;
    }
    return false;
  }

  async removeShopMember(shopId: string, jobId: string) {
    await connectionRedis.zrem(pendingCandidateShopIndexKey(shopId), jobId);
  }

  async removeCartAlias(shopId: string, cartToken: string) {
    await connectionRedis.del(
      pendingCandidateCartIndexKey({ shopId, cartToken }),
    );
  }

  async addCartAlias(shopId: string, cartToken: string, jobId: string, delayMinutes: number) {
    await connectionRedis.set(
      pendingCandidateCartIndexKey({ shopId, cartToken }),
      jobId,
      "PX",
      pendingCandidateIndexTtlMs(delayMinutes),
    );
  }
}
