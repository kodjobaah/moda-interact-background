import type { Prisma } from "@prisma/client";

export type MerchantPricingPublicationTransaction = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

export type MerchantPricingTranslationPublicationOutcome =
  | {
      status: "published";
      runId: string;
      planId: string;
      planTranslationCount: number;
      highlightTranslationCount: number;
    }
  | {
      status: "failure-recorded";
      runId: string;
      planId: string;
      failureCode: string;
    }
  | {
      status: "stale";
      runId: string;
      planId: string;
      failureCode: "SOURCE_CHANGED";
    }
  | {
      status: "failed";
      runId: string;
      planId: string;
      failureCode: string;
    }
  | { status: "skipped"; runId: string };
