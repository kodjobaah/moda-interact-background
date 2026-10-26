import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import { backgroundRuntimeConfig } from "./background-runtime-config.js";
import { type TranslationProvider, type TranslationRequest, type TranslationProviderResult } from "../../src/providers/translation.provider.js";

const HASH = "a".repeat(64);
export const config = { current: () => backgroundRuntimeConfig({
  translationBatchMaxRequests: 20, translationInitialPollSeconds: 30,
  translationPollIntervalSeconds: 30, translationMaxAutoRetries: 1,
  translationResultRetrySeconds: 30,
}) };

export type Fixture = Awaited<ReturnType<typeof seed>>;

export async function seed(db: PrismaClient) {
  const admin = await db.platformAdmin.create({ data: { email: `${randomUUID()}@arch047-integration.test` } });
  const credential = await db.commerceTranslationProviderCredential.create({ data: {
    environment: "TEST", provider: "openai", ciphertext: Buffer.from([1]),
    nonce: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 1), keyId: "test",
    updatedByAdminId: admin.id,
  } });
  const model = await db.commerceTranslationModelConfiguration.create({ data: {
    environment: "TEST", provider: "openai", providerModelId: `test-${randomUUID()}`,
    displayName: `WhatsApp template ${randomUUID()}`, enabled: true,
    createdByAdminId: admin.id, updatedByAdminId: admin.id,
  } });
  const definition = await db.whatsAppTemplateDefinition.create({ data: {
    kind: "META_TEMPLATE", purpose: "RECOVERY_INITIAL", sourceLanguageTag: "en-GB",
    astSchemaVersion: 1, sourceHash: HASH, status: "DRAFT", createdByAdminId: admin.id,
  } });
  const locale = await db.whatsAppTemplateLocale.create({ data: {
    definitionId: definition.id, languageTag: "fr-FR", status: "PENDING",
    localeAst: { source: "never touch me" },
  } });
  const sourceSnapshot = {
    schemaVersion: 1, definitionId: definition.id, sourceHash: HASH,
    sourceLanguageTag: "en-GB", segments: [
      { key: "header.text", text: "Hello", protectedTokens: [] },
      { key: "body.text", text: "Hi <PERSON>, see <URL>", protectedTokens: [
        { marker: "<PERSON>", variable: "customer.firstName" },
        { marker: "<URL>", variable: "checkout.recoveryUrl" },
      ] },
      { key: "buttons.0.text", text: "Open basket", protectedTokens: [] },
    ],
  };
  const run = await db.whatsAppTemplateTranslationRun.create({ data: {
    definitionId: definition.id, translationModelConfigurationId: model.id,
    provider: "openai", providerModelId: model.providerModelId, modelConfigurationVersion: model.editVersion,
    sourceSchemaVersion: 1, sourceHash: HASH, sourceSnapshot,
    status: "PENDING", requestedByAdminId: admin.id,
  } });
  const languageTags = ["fr-FR", "de-DE"];
  const items = await Promise.all(languageTags.map((targetLanguageTag) =>
    db.whatsAppTemplateTranslationItem.create({ data: {
      runId: run.id, targetLanguageTag, status: "PENDING",
      ...(targetLanguageTag === "fr-FR" ? { resultLocaleId: locale.id } : {}),
    } }),
  ));
  return { admin, credential, model, definition, locale, run, items };
}

export async function cleanup(db: PrismaClient, fixture: Fixture, queue: Queue) {
  const batches = await db.whatsAppTemplateTranslationBatch.findMany({ where: { runId: fixture.run.id } });
  for (const batch of batches) {
    for (const id of [
      `whatsapp-template-translate-submit-${batch.id}`,
      `whatsapp-template-translate-results-${batch.id}`,
      ...Array.from({ length: 4 }, (_, index) => `whatsapp-template-translate-poll-${batch.id}-${index + 1}`),
    ]) {
      const job = await queue.getJob(id);
      if (job) await job.remove();
    }
  }
  await db.whatsAppTemplateTranslationBatchItem.deleteMany({ where: { batchId: { in: batches.map((batch) => batch.id) } } });
  await db.whatsAppTemplateTranslationItem.deleteMany({ where: { runId: fixture.run.id } });
  await db.whatsAppTemplateTranslationBatch.deleteMany({ where: { runId: fixture.run.id } });
  await db.whatsAppTemplateTranslationRun.delete({ where: { id: fixture.run.id } });
  await db.whatsAppTemplateLocale.delete({ where: { id: fixture.locale.id } });
  await db.whatsAppTemplateDefinition.delete({ where: { id: fixture.definition.id } });
  await db.commerceTranslationModelConfiguration.delete({ where: { id: fixture.model.id } });
  await db.commerceTranslationProviderCredential.delete({ where: { id: fixture.credential.id } });
  await db.platformAdmin.delete({ where: { id: fixture.admin.id } });
}

export function fakeProvider(options: { failures?: Set<string>; captured: TranslationRequest[] }): TranslationProvider {
  const responses: TranslationProviderResult[] = [];
  return {
    async prepareBatchInput(requests) {
      options.captured.splice(0, options.captured.length, ...requests);
      responses.splice(0, responses.length, ...requests.map((request) => {
        const encoded = JSON.parse(request.sourceText) as { schemaVersion: number; segments: Array<{ key: string; text: string }> };
        const translated = { schemaVersion: 1, segments: encoded.segments.map(({ key, text }) => ({ key, text: `Traduit: ${text}` })) };
        return options.failures?.has(request.targetLanguageTag) ? {
          providerCustomId: request.providerCustomId!, status: "failed" as const,
          translatedText: null, failureCode: "http-503",
        } : {
          providerCustomId: request.providerCustomId!, status: "completed" as const,
          translatedText: JSON.stringify(translated), failureCode: null,
        };
      }));
      return { inputFileId: `file-${randomUUID()}` };
    },
    async createBatch(logicalBatchId, inputFileId) {
      return {
        provider: "openai", providerStatus: "in_progress", logicalBatchId,
        providerBatchId: `batch-${logicalBatchId}`, status: "nonterminal",
        inputFileId, outputFileId: null, errorFileId: null, failureCode: null,
        createdAt: null, completedAt: null,
      };
    },
    async retrieveBatch(providerBatchId) {
      return {
        provider: "openai", providerStatus: "completed", providerBatchId,
        logicalBatchId: providerBatchId.replace(/^batch-/, ""),
        status: "completed", inputFileId: "input", outputFileId: "output", errorFileId: null,
        failureCode: null, createdAt: null, completedAt: null,
      };
    },
    async findBatchByCorrelation() { return { kind: "none" }; },
    async readOutputFile() { return responses; },
  };
}
