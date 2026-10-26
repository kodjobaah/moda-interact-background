import {
  TemplateTranslationSubmitJobSchema, TemplateTranslationPollJobSchema,
  TemplateTranslationResultsJobSchema,
} from "../services/template-translation/jobs.js";
import { TemplateTranslationBatchLifecycle } from "../services/template-translation/lifecycle.js";

const lifecycle = new TemplateTranslationBatchLifecycle();

export async function handleTemplateTranslationSubmit(raw: unknown): Promise<void> {
  const job = TemplateTranslationSubmitJobSchema.parse(raw);
  await lifecycle.submit(job.translationBatchId);
}
export async function handleTemplateTranslationPoll(raw: unknown): Promise<void> {
  const job = TemplateTranslationPollJobSchema.parse(raw);
  await lifecycle.poll(job.translationBatchId, job.pollSequence);
}
export async function handleTemplateTranslationResults(raw: unknown): Promise<void> {
  const job = TemplateTranslationResultsJobSchema.parse(raw);
  await lifecycle.ingest(job.translationBatchId);
}

export async function closeTemplateTranslationWorkerResources(): Promise<void> {
  await lifecycle.close();
}
