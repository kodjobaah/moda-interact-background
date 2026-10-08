import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";

type ResolvedCandidate = {
  jobId: string;
  candidate: PendingRecoveryCandidate;
};

type CandidateLifecycleJob = {
  data: PendingRecoveryCandidate;
  getState(): Promise<string>;
  remove(): Promise<unknown>;
};

type CandidateLifecycleQueue = {
  getJob(jobId: string): Promise<CandidateLifecycleJob | null | undefined>;
};

type CandidateLifecycleIndexStore = {
  findByCheckout(input: { shopId: string; checkoutToken: string }): Promise<string | null>;
  findByCart(input: { shopId: string; cartToken: string }): Promise<string | null>;
  remove(
    candidate: Pick<PendingRecoveryCandidate, "shopId" | "checkoutToken" | "cartToken">,
    jobId?: string,
  ): Promise<unknown>;
};

type CandidateLifecycleDependencies = {
  getQueue(): CandidateLifecycleQueue;
  candidateIndexStore: CandidateLifecycleIndexStore;
  withCheckoutLock<T>(
    shopId: string,
    checkoutToken: string,
    callback: () => Promise<T>,
  ): Promise<T>;
};

export class PendingRecoveryCandidateLifecycleService {
  constructor(private readonly dependencies: CandidateLifecycleDependencies) {}

  async findByCheckout(input: { shopId: string; checkoutToken: string }) {
    return this.dependencies.candidateIndexStore.findByCheckout(input);
  }

  async findByCart(input: { shopId: string; cartToken: string }) {
    return this.dependencies.candidateIndexStore.findByCart(input);
  }

  async resolve(input: {
    shopId: string;
    checkoutToken: string | null;
    cartToken: string | null;
  }): Promise<ResolvedCandidate | null> {
    let jobId: string | null = null;

    if (input.checkoutToken) {
      jobId = await this.findByCheckout({
        shopId: input.shopId,
        checkoutToken: input.checkoutToken,
      });
    }

    if (!jobId && input.cartToken) {
      jobId = await this.findByCart({
        shopId: input.shopId,
        cartToken: input.cartToken,
      });
    }

    if (!jobId) return null;

    const job = await this.dependencies.getQueue().getJob(jobId);
    if (!job) return null;

    return { jobId, candidate: job.data };
  }

  async cancel(input: ResolvedCandidate): Promise<{ removed: true }> {
    const job = await this.dependencies.getQueue().getJob(input.jobId);
    if (job) await job.remove();

    await this.dependencies.candidateIndexStore.remove(input.candidate, input.jobId);
    return { removed: true } as const;
  }

  async cancelByCheckout(input: {
    shopId: string;
    checkoutToken: string;
  }): Promise<{ removed: false } | { removed: true }> {
    const jobId = await this.findByCheckout(input);
    if (!jobId) return { removed: false } as const;

    const job = await this.dependencies.getQueue().getJob(jobId);
    if (job) await job.remove();

    await this.dependencies.candidateIndexStore.remove(
      job?.data ?? {
        shopId: input.shopId,
        checkoutToken: input.checkoutToken,
        cartToken: null,
      },
      jobId,
    );

    return { removed: true } as const;
  }

  async cancelByCart(input: {
    shopId: string;
    cartToken: string;
  }): Promise<
    | { outcome: "cancelled"; jobId: string }
    | { outcome: "not-found" }
    | { outcome: "not-reschedulable"; state: string; jobId: string }
  > {
    const initialMatch = await this.resolve({
      shopId: input.shopId,
      checkoutToken: null,
      cartToken: input.cartToken,
    });
    if (!this.matchesCart(input, initialMatch)) return { outcome: "not-found" };

    return this.dependencies.withCheckoutLock(
      input.shopId,
      initialMatch.candidate.checkoutToken,
      async () => {
        const matched = await this.resolve({
          shopId: input.shopId,
          checkoutToken: null,
          cartToken: input.cartToken,
        });
        if (!this.matchesCart(input, matched)) return { outcome: "not-found" };

        const job = await this.dependencies.getQueue().getJob(matched.jobId);
        if (!job) return { outcome: "not-found" };

        const state = await job.getState();
        if (state !== "delayed" && state !== "waiting") {
          return { outcome: "not-reschedulable", state, jobId: matched.jobId };
        }

        await this.cancel(matched);
        return { outcome: "cancelled", jobId: matched.jobId };
      },
    );
  }

  private matchesCart(
    input: { shopId: string; cartToken: string },
    matched: ResolvedCandidate | null,
  ): matched is ResolvedCandidate {
    return Boolean(
      matched
      && matched.candidate.shopId === input.shopId
      && matched.candidate.cartToken === input.cartToken,
    );
  }
}
