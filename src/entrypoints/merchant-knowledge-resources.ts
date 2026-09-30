import { Queue } from "bullmq";
import {
  MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME,
  MERCHANT_KNOWLEDGE_QUEUE_NAME,
  type MerchantKnowledgeProcessSourceRevisionJob,
} from "@modainteract/moda-interact-shared/merchant-knowledge";

import { connectionRedis } from "../lib/redis.js";

export const merchantKnowledgeQueue = new Queue<
  MerchantKnowledgeProcessSourceRevisionJob,
  void,
  typeof MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME
>(MERCHANT_KNOWLEDGE_QUEUE_NAME, { connection: connectionRedis });

export const closeMerchantKnowledgeResources: readonly (() => Promise<unknown>)[] = [
  () => merchantKnowledgeQueue.close(),
];