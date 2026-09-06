import {
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  TranslationDispatchJobSchema,
  TranslationBatchSubmitJobSchema,
  type TranslationBatchSubmitJob,
  type TranslationDispatchJob,
} from "@modainteract/moda-interact-shared/merchant-communications";

export {
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,
  TranslationDispatchJobSchema,
  TranslationBatchSubmitJobSchema,
};

export type { TranslationBatchSubmitJob, TranslationDispatchJob };
