import {
  pendingCandidateCartIndexKey,
  pendingCandidateCheckoutIndexKey,
  pendingCandidateIndexTtlMs,
  pendingCandidateShopIndexKey,
  type PendingRecoveryCandidate,
} from "../../domain/pending-recovery-candidate.js";
import { connectionRedis } from "../../lib/redis.js";

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
    candidate: PendingRecoveryCandidate;
    jobId: string;
    delayMinutes: number;
    dueAtMs: number;
    shouldIndexShop: boolean;
  }) {
    const ttlMs = pendingCandidateIndexTtlMs(input.delayMinutes);

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
    candidate: Pick<
      PendingRecoveryCandidate,
      "shopId" | "checkoutToken" | "cartToken"
    >,
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

  async removeShopMember(shopId: string, jobId: string) {
    await connectionRedis.zrem(pendingCandidateShopIndexKey(shopId), jobId);
  }

  async removeCartAlias(shopId: string, cartToken: string) {
    await connectionRedis.del(
      pendingCandidateCartIndexKey({ shopId, cartToken }),
    );
  }
}
