import prisma from "../lib/db.js";
import { Queue } from "bullmq";
import { BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME } from "@modainteract/moda-interact-shared/billing";
import { connectionRedis } from "../lib/redis.js";

export const billingSubscriptionQueue = new Queue(BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME, { connection: connectionRedis });

export const closeBillingResources = [
  () => billingSubscriptionQueue.close(),
  () => prisma.$disconnect(),
] as const;