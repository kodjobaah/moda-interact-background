import {
  EVALUATE_PENDING_RECOVERY_JOB,
  type PendingRecoveryCandidate,
} from "../../domain/pending-recovery-candidate.js";
import { createPendingRecoveryCandidateJobId } from "@modainteract/moda-interact-shared/shopify/node";
import {
  candidateActivityDueAtMs,
  maxCandidateActivityAt,
  mergeCandidateInternationalContext,
  optionalCandidateInternationalContext,
} from "./candidate-activity.js";

type ResolvedCandidate = {
  jobId: string;
  candidate: PendingRecoveryCandidate;
};

type CandidateLifecycleJob = {
  data: PendingRecoveryCandidate;
  getState(): Promise<string>;
  updateData(candidate: PendingRecoveryCandidate): Promise<unknown>;
  changeDelay(delayMs: number): Promise<unknown>;
  remove(): Promise<unknown>;
};

type CandidateLifecycleQueue = {
  getJob(jobId: string): Promise<CandidateLifecycleJob | null | undefined>;
  add(
    jobName: string,
    candidate: PendingRecoveryCandidate,
    options: { jobId: string; delay: number },
  ): Promise<unknown>;
};

type CandidateLifecycleIndexStore = {
  findByCheckout(input: { shopId: string; checkoutToken: string }): Promise<string | null>;
  findByCart(input: { shopId: string; cartToken: string }): Promise<string | null>;
  removeCartAlias(shopId: string, cartToken: string): Promise<unknown>;
  upsert(input: {
    candidate: PendingRecoveryCandidate;
    jobId: string;
    delayMinutes: number;
    dueAtMs: number;
    shouldIndexShop: boolean;
  }): Promise<unknown>;
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

  async scheduleFromCheckoutUpdated(
    candidate: PendingRecoveryCandidate,
    delayMinutes: number,
  ) {
    const queue = this.dependencies.getQueue();
    const indexed = await this.resolve({
      shopId: candidate.shopId,
      checkoutToken: candidate.checkoutToken,
      cartToken: null,
    });
    const baseJobId = `${candidate.shopId}--${createPendingRecoveryCandidateJobId(
      candidate.shopId,
      candidate.checkoutToken,
    )}`;
    const fallbackJob = indexed ? null : await queue.getJob(baseJobId);
    const current = indexed ?? (fallbackJob
      ? { jobId: baseJobId, candidate: fallbackJob.data }
      : null);
    const currentJob = current ? await queue.getJob(current.jobId) : null;
    const currentState = currentJob ? await currentJob.getState() : null;
    const successorJobId = `${baseJobId}--update-${Date.parse(candidate.lastActivityAt ?? "")}`;

    if (
      current
      && currentJob
      && currentState === "delayed"
    ) {
      const refreshed = this.mergeUpdate(candidate, current.candidate);
      if (current.candidate.cartToken && current.candidate.cartToken !== refreshed.cartToken) {
        await this.dependencies.candidateIndexStore.removeCartAlias(
          candidate.shopId,
          current.candidate.cartToken,
        );
      }
      await currentJob.updateData(refreshed);
      if (currentState === "delayed") {
        const dueAtMs = candidateActivityDueAtMs(refreshed.lastActivityAt, delayMinutes);
        await currentJob.changeDelay(Math.max(0, dueAtMs - Date.now()));
      }
      await this.dependencies.candidateIndexStore.upsert({
        candidate: refreshed,
        jobId: current.jobId,
        delayMinutes,
        dueAtMs: currentState === "delayed"
          ? candidateActivityDueAtMs(refreshed.lastActivityAt, delayMinutes)
          : Date.now(),
        shouldIndexShop: true,
      });
      return {
        outcome: "refreshed" as const,
        jobId: current.jobId,
        delayMinutes,
        candidate: refreshed,
      };
    }

    let jobId = current ? successorJobId : baseJobId;
    let targetJob = await queue.getJob(jobId);
    if (targetJob) {
      const targetState = await targetJob.getState();
      if (targetState !== "delayed" && targetState !== "waiting") {
        jobId = `${successorJobId}-retry`;
        targetJob = await queue.getJob(jobId);
      }
    }

    const updatedCandidate = this.mergeUpdate(
      candidate,
      targetJob?.data ?? current?.candidate,
    );
    const previousCartToken = targetJob?.data.cartToken ?? current?.candidate.cartToken;
    if (previousCartToken && previousCartToken !== updatedCandidate.cartToken) {
      await this.dependencies.candidateIndexStore.removeCartAlias(
        candidate.shopId,
        previousCartToken,
      );
    }
    const dueAtMs = candidateActivityDueAtMs(updatedCandidate.lastActivityAt, delayMinutes);
    if (targetJob) {
      await targetJob.updateData(updatedCandidate);
      if (await targetJob.getState() === "delayed") {
        await targetJob.changeDelay(Math.max(0, dueAtMs - Date.now()));
      }
    } else {
      await queue.add(EVALUATE_PENDING_RECOVERY_JOB, updatedCandidate, {
        jobId,
        delay: Math.max(0, dueAtMs - Date.now()),
      });
    }
    await this.dependencies.candidateIndexStore.upsert({
      candidate: updatedCandidate,
      jobId,
      delayMinutes,
      dueAtMs,
      shouldIndexShop: true,
    });
    return {
      outcome: targetJob ? "refreshed" as const : "enqueued" as const,
      jobId,
      delayMinutes,
      candidate: updatedCandidate,
    };
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

  private mergeUpdate(
    incoming: PendingRecoveryCandidate,
    existing?: PendingRecoveryCandidate,
  ): PendingRecoveryCandidate {
    return {
      ...existing,
      ...incoming,
      cartToken: incoming.cartToken ?? existing?.cartToken ?? null,
      abandonedCheckoutUrl: incoming.abandonedCheckoutUrl
        ?? existing?.abandonedCheckoutUrl
        ?? null,
      checkoutCreatedAt: incoming.checkoutCreatedAt
        ?? existing?.checkoutCreatedAt
        ?? null,
      ...optionalCandidateInternationalContext(
        mergeCandidateInternationalContext(
          existing?.internationalContext,
          incoming.internationalContext,
        ),
      ),
      lastActivityAt: maxCandidateActivityAt(
        existing?.lastActivityAt ?? existing?.checkoutCreatedAt,
        incoming.lastActivityAt,
      ),
    };
  }
}
