import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";

import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";
import {
  candidateActivityDueAtMs,
  canonicalCandidateActivityAt,
  mergeCandidateInternationalContext,
  optionalCandidateInternationalContext,
} from "./candidate-activity.js";

export type CandidateActivityInput = {
  shopId: string;
  checkoutToken: string | null;
  cartToken: string | null;
  activityAt: string;
  isEmpty: boolean | null;
  internationalContext?: InternationalContext;
};

export type CandidateActivityResult =
  | { outcome: "rescheduled"; jobId: string; candidate: PendingRecoveryCandidate }
  | { outcome: "stale"; jobId: string; candidate: PendingRecoveryCandidate }
  | { outcome: "not-found" }
  | { outcome: "not-reschedulable"; state: string; jobId: string }
  | { outcome: "cancelled"; jobId: string };

type ResolvedCandidate = {
  jobId: string;
  candidate: PendingRecoveryCandidate;
};

type CandidateActivityJob = {
  getState(): Promise<string>;
  updateData(candidate: PendingRecoveryCandidate): Promise<unknown>;
  changeDelay(delayMs: number): Promise<unknown>;
};

type CandidateActivityQueue = {
  getJob(jobId: string): Promise<CandidateActivityJob | null | undefined>;
};

type CandidateActivityIndexStore = {
  upsert(input: {
    candidate: PendingRecoveryCandidate;
    jobId: string;
    delayMinutes: number;
    dueAtMs: number;
    shouldIndexShop: boolean;
  }): Promise<unknown>;
};

type CandidateActivityDependencies = {
  resolveCandidate(input: {
    shopId: string;
    checkoutToken: string | null;
    cartToken: string | null;
  }): Promise<ResolvedCandidate | null>;
  withCheckoutLock<T>(
    shopId: string,
    checkoutToken: string,
    callback: () => Promise<T>,
  ): Promise<T>;
  cancelCandidate(candidate: ResolvedCandidate): Promise<unknown>;
  resolveDelayMinutes(shopId: string): Promise<number>;
  getQueue(): CandidateActivityQueue;
  candidateIndexStore: CandidateActivityIndexStore;
  now?: () => number;
};

export class PendingRecoveryCandidateActivityService {
  private readonly now: () => number;

  constructor(private readonly dependencies: CandidateActivityDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async refresh(input: CandidateActivityInput): Promise<CandidateActivityResult> {
    const initialMatch = await this.dependencies.resolveCandidate(input);
    if (!initialMatch || initialMatch.candidate.shopId !== input.shopId) {
      return { outcome: "not-found" };
    }

    return this.dependencies.withCheckoutLock(
      input.shopId,
      initialMatch.candidate.checkoutToken,
      async () => {
        const matched = await this.dependencies.resolveCandidate(input);
        if (!matched || matched.candidate.shopId !== input.shopId) {
          return { outcome: "not-found" };
        }
        return this.refreshResolvedCandidate(input, matched);
      },
    );
  }

  private async refreshResolvedCandidate(
    input: CandidateActivityInput,
    matched: ResolvedCandidate,
  ): Promise<CandidateActivityResult> {
    if (input.cartToken && matched.candidate.cartToken !== input.cartToken) {
      return { outcome: "not-found" };
    }

    const incomingActivityAt = canonicalCandidateActivityAt(
      input.activityAt,
      this.now(),
    );
    const existingActivityAt = matched.candidate.lastActivityAt
      ?? matched.candidate.checkoutCreatedAt;
    if (
      existingActivityAt
      && Date.parse(incomingActivityAt) <= Date.parse(existingActivityAt)
    ) {
      return {
        outcome: "stale",
        jobId: matched.jobId,
        candidate: matched.candidate,
      };
    }

    const job = await this.dependencies.getQueue().getJob(matched.jobId);
    if (!job) {
      return { outcome: "not-found" };
    }

    const state = await job.getState();
    if (input.isEmpty === true && input.cartToken) {
      if (state !== "delayed" && state !== "waiting") {
        return { outcome: "not-reschedulable", state, jobId: matched.jobId };
      }
      await this.dependencies.cancelCandidate(matched);
      return { outcome: "cancelled", jobId: matched.jobId };
    }

    if (state !== "delayed") {
      return { outcome: "not-reschedulable", state, jobId: matched.jobId };
    }

    const delayMinutes = await this.dependencies.resolveDelayMinutes(input.shopId);
    const candidate: PendingRecoveryCandidate = {
      ...matched.candidate,
      ...optionalCandidateInternationalContext(
        mergeCandidateInternationalContext(
          matched.candidate.internationalContext,
          input.internationalContext,
        ),
      ),
      lastActivityAt: incomingActivityAt,
    };
    const dueAtMs = candidateActivityDueAtMs(
      incomingActivityAt,
      delayMinutes,
      this.now(),
    );
    await job.updateData(candidate);
    await job.changeDelay(Math.max(0, dueAtMs - this.now()));
    await this.dependencies.candidateIndexStore.upsert({
      candidate,
      jobId: matched.jobId,
      delayMinutes,
      dueAtMs,
      shouldIndexShop: true,
    });

    return { outcome: "rescheduled", jobId: matched.jobId, candidate };
  }
}
