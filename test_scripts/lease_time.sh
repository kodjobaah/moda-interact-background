node <<'NODE'
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  const [config, leases, runs] = await Promise.all([
    prisma.backgroundRuntimeConfig.findUnique({
      where: { id: "default" },
      select: {
        version: true,
        translationReconciliationIntervalSeconds: true,
        translationReconciliationPageSize: true,
        translationBatchMaxRequests: true,
      },
    }),

    prisma.backgroundRuntimeLease.findMany({
      where: { name: "TRANSLATION_RECONCILIATION" },
      select: {
        name: true,
        ownerToken: true,
        generation: true,
        acquiredAt: true,
        lastFinishedAt: true,
        leaseUntil: true,
        updatedAt: true,
      },
    }),

    prisma.commerceStoreCategoryTranslationRun.findMany({
      orderBy: { requestedAt: "desc" },
      take: 5,
      select: {
        id: true,
        categoryId: true,
        status: true,
        requestedAt: true,
        startedAt: true,
        readyToPublishAt: true,
        completedAt: true,
        failureCode: true,
      },
    }),
  ]);

  console.dir({ config, leases, runs }, { depth: null });
})()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
NODE
