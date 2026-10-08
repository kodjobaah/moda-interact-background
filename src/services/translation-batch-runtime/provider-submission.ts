import type {
  TranslationProvider,
  TranslationRequest,
} from "../../providers/translation.provider.js";

import {
  classifyTranslationSubmissionFailure,
  type TranslationSubmitFailureClassification,
} from "./failure-policy.js";

export type TranslationProviderSubmissionResult =
  | {
      kind: "submitted";
      inputFileId: string;
      providerBatchId: string;
    }
  | {
      kind: "failed";
      phase: "prepare" | "create";
      classification: TranslationSubmitFailureClassification;
      error: unknown;
    };

export async function submitTranslationProviderBatch(input: {
  logicalBatchId: string;
  inputFileId: string | null;
  provider: TranslationProvider;
  loadRequests: () => Promise<readonly TranslationRequest[]>;
  persistInputFileId: (inputFileId: string) => Promise<void>;
  persistSubmitted: (input: {
    providerBatchId: string;
    inputFileId: string;
  }) => Promise<void>;
  validateInputFileId?: (inputFileId: string) => void;
}): Promise<TranslationProviderSubmissionResult> {
  let inputFileId = input.inputFileId;

  if (!inputFileId) {
    try {
      const requests = await input.loadRequests();
      const prepared = await input.provider.prepareBatchInput(requests);
      inputFileId = prepared.inputFileId;
      await input.persistInputFileId(prepared.inputFileId);
    } catch (error) {
      return {
        kind: "failed",
        phase: "prepare",
        classification: classifyTranslationSubmissionFailure(
          error,
          "DEFINITE_RETRYABLE_NOT_CREATED",
        ),
        error,
      };
    }
  }

  try {
    input.validateInputFileId?.(inputFileId);
    const providerBatch = await input.provider.createBatch(
      input.logicalBatchId,
      inputFileId,
    );
    await input.persistSubmitted({
      providerBatchId: providerBatch.providerBatchId,
      inputFileId,
    });
    return {
      kind: "submitted",
      inputFileId,
      providerBatchId: providerBatch.providerBatchId,
    };
  } catch (error) {
    return {
      kind: "failed",
      phase: "create",
      classification: classifyTranslationSubmissionFailure(
        error,
        "AMBIGUOUS_CREATE",
      ),
      error,
    };
  }
}
