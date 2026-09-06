import {
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  TranslationDispatchJobSchema,
  TranslationBatchSubmitJobSchema,
  TranslationBatchPollJobSchema,
  TranslationBatchResultsJobSchema,
  type TranslationBatchSubmitJob,
  type TranslationDispatchJob,
  type TranslationBatchPollJob,
  type TranslationBatchResultsJob,
} from "@modainteract/moda-interact-shared/merchant-communications";

export {
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,
  TranslationDispatchJobSchema,
  TranslationBatchSubmitJobSchema,
  TranslationBatchPollJobSchema,
  TranslationBatchResultsJobSchema,
};

export type {
  TranslationBatchSubmitJob,
  TranslationDispatchJob,
  TranslationBatchPollJob,
  TranslationBatchResultsJob,
};
