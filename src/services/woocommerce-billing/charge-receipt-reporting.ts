import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";

const logger = createLogger({ serviceName: "moda-billing-worker", environment: resolveDeploymentEnvironmentName() });

type ReceiptLogFields = {
  receiptId: string;
  topic: string;
  providerContractId: string | null;
  shopId?: string;
  operationId?: string;
  purchaseId?: string;
};

export function reportRetryableChargeReceipt(fields: ReceiptLogFields & { processingError: string }): void {
  logger.info("billing.woocommerce.charge_receipt.retryable", {
    ...fields,
    outcome: "retryable",
  });
}

export function reportProcessedChargeReceipt(fields: ReceiptLogFields & { outcome: string }): void {
  logger.info("billing.woocommerce.charge_receipt.processed", fields);
}

export function reportChargeResumeScheduleFailure(fields: ReceiptLogFields & { outcome: "activated" }): void {
  logger.error("billing.woocommerce.charge_receipt.resume_schedule_failed", fields);
}