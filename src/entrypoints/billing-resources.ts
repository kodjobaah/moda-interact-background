import prisma from "../lib/db.js";
import { Queue } from "bullmq";
import { BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME } from "@modainteract/moda-interact-shared/billing";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import { connectionRedis } from "../lib/redis.js";

export const billingSubscriptionQueue = new Queue(BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME, { connection: connectionRedis });
export const shopifyDiscountSyncQueue = new Queue(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.SHOPIFY_DISCOUNT_SYNC.queueName, { connection: connectionRedis });

export const closeBillingResources = [
  () => billingSubscriptionQueue.close(),
  () => shopifyDiscountSyncQueue.close(),
  () => prisma.$disconnect(),
] as const;