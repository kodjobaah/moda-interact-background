import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import prisma from "../lib/db.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "../runtime/background-runtime-lease.js";
import { startDynamicLeasedScheduler } from "../runtime/dynamic-leased-scheduler.js";
import { createMerchantKnowledgeWorker } from "../workers/merchant-knowledge.worker.js";
import { closeMerchantKnowledgeResources } from "./merchant-knowledge-resources.js";
import { MerchantKnowledgeUploadedAssetAcquirerService } from "../services/merchant-knowledge-uploaded-asset-acquirer.js";
import { MerchantKnowledgeWebPageAcquirer } from "../services/merchant-knowledge-web-page-acquirer.js";
import { MerchantKnowledgeUploadCleanupService } from "../services/merchant-knowledge-upload-cleanup.service.js";
import { createMerchantKnowledgeR2Client } from "../services/merchant-knowledge-r2-client.js";
import { readR2Configuration } from "../services/platform-configuration/consumers.js";
import { readCanonicalCredentialKeyring as readCommerceCredentialKeyring } from "../commerce/credential-keyring.js";
import { resolveCommerceEnvironment } from "../commerce/model-environment.js";
import { createMerchantKnowledgeEmbeddingResolver } from "../services/merchant-knowledge-embedding-runtime.js";
import { MerchantKnowledgeProcessingService } from "../services/merchant-knowledge-processing.service.js";
import { merchantKnowledgeReconciliationService } from "../services/merchant-knowledge-reconciliation.service.js";
import { merchantKnowledgeEntitlementReconciliationService } from "../services/merchant-knowledge-entitlement-reconciliation.service.js";

void startReadyWorkerProcess({
  serviceName: "moda-merchant-knowledge-worker",
  loadWorkerProcess: async () => {
    const uploadedAssetAcquirer = {
      async acquire(input: Parameters<MerchantKnowledgeUploadedAssetAcquirerService["acquire"]>[0]) {
        const config = await readR2Configuration();
        return new MerchantKnowledgeUploadedAssetAcquirerService({
          database: prisma, r2: createMerchantKnowledgeR2Client(config),
          bucket: config.bucket, maxUploadBytes: config.maxUploadBytes,
          maxXlsxUncompressedBytes: config.maxXlsxUncompressedBytes,
        }).acquire(input);
      },
    };
    const newProcessingService = async () => new MerchantKnowledgeProcessingService({
      webPageAcquirer: new MerchantKnowledgeWebPageAcquirer(),
      uploadedAssetAcquirer,
      embeddingResolver: createMerchantKnowledgeEmbeddingResolver({
        db: prisma, environment: resolveCommerceEnvironment(),
        keyring: await readCommerceCredentialKeyring(),
      }),
    });
    // Cleanup config is obtained per scheduler tick, never from worker startup.
    const cleanup = async () => {
      const config = await readR2Configuration();
      return new MerchantKnowledgeUploadCleanupService({
        database: prisma, r2: createMerchantKnowledgeR2Client(config), bucket: config.bucket,
      }).cleanupOnce();
    };

    await backgroundRuntimeConfigService.start();
    const worker = createMerchantKnowledgeWorker({
      processJob: async (job) => (await newProcessingService()).processJob(job),
      markTerminalFailure: async (input) => (await newProcessingService()).markTerminalFailure(input),
    });
    const stopPendingReconciliation = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "MERCHANT_KNOWLEDGE_PENDING_RECONCILIATION",
      intervalMs: 60_000,
      runImmediately: true,
      run: async () => {
        await merchantKnowledgeReconciliationService.reconcilePendingOnce({
          pageSize: 100,
        });
      },
      onError: () => console.error("Merchant Knowledge reconciliation failed"),
    });
    const stopEntitlementReconciliation = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "MERCHANT_KNOWLEDGE_ENTITLEMENT_RECONCILIATION",
      intervalMs: 300_000,
      runImmediately: true,
      run: async () => {
        await merchantKnowledgeEntitlementReconciliationService.reconcileOnce({
          shopPageSize: 100,
        });
      },
      onError: () => console.error("Merchant Knowledge entitlement reconciliation failed"),
    });
    const stopUploadCleanup = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "MERCHANT_KNOWLEDGE_UPLOAD_CLEANUP",
      intervalMs: 3_600_000,
      runImmediately: true,
      run: async () => {
        await cleanup();
      },
      onError: () => console.error("Merchant Knowledge upload cleanup failed"),
    });
    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["merchant-knowledge"],
    });

    return {
      workers: [worker],
      closeResources: [
        ...closeMerchantKnowledgeResources,
        stopPendingReconciliation,
        stopEntitlementReconciliation,
        stopUploadCleanup,
        () => backgroundRuntimeConfigService.close(),
        closeWorkerObservability,
        closeQueuePerformanceTelemetry,
        async () => {
          await connectionRedis.quit();
          await prisma.$disconnect();
        },
      ],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}