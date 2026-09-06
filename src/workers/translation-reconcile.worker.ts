import { TranslationReconcileJobSchema } from "@modainteract/moda-interact-shared/merchant-communications";

import { translationReconciliationService } from "../services/translation-reconciliation.service.js";

export async function handleTranslationReconcile(input: unknown): Promise<void> {
  const job = TranslationReconcileJobSchema.parse(input);
  await translationReconciliationService.reconcile(job.reconciliationRequestId);
}