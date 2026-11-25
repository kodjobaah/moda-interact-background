import type { PrismaClient } from "@prisma/client";
import { RecoverySenderPoolService, type RecoverySenderIdentity } from "../../../src/services/recovery-sender-pool/sender-pool.service.js";
import { startArch040BackgroundMocks } from "./arch040-background-mocks.fixture.js";

/** ARCH-076 sender evidence for the real SQL human dispatch fence. Only the
 * credential reader is fixture-backed; all persisted ownership checks remain
 * production code. The singleton and pooled phone IDs must be distinct. */
export async function startPooledHumanDispatchMocks(db: PrismaClient, owner: {
  shopId: string; conversationId: string; recipient: string;
}) {
  if (process.env.MODA_DISPOSABLE_INTEGRATION !== "1") {
    throw new Error("Pooled sender fixture requires disposable integration infrastructure");
  }
  const providerAccountId = "918273645546372819";
  const standalonePhoneNumberId = "15550123457";
  let mocks: Awaited<ReturnType<typeof startArch040BackgroundMocks>> | undefined;
  let allocatedSender: RecoverySenderIdentity | undefined;
  let ownedPoolPhoneId: string | undefined;
  async function cleanupAfterOwnerDeletion() {
    // Shop deletion cascades the route/assignment. Delete only our fixture's
    // thread and sender, after the deferred owner FK has committed.
    if (allocatedSender) await db.recoverySenderThread.delete({ where: { id: allocatedSender.threadId } });
    if (ownedPoolPhoneId) await db.whatsAppPoolSender.delete({ where: { providerPhoneNumberId: ownedPoolPhoneId } });
  }
  try {
    const configuration = await db.platformConfiguration.upsert({
      where: { environment_key: { environment: "test", key: "messaging.sender" } },
      create: { environment: "test", key: "messaging.sender", value: { fixture: true } },
      update: {},
    });
    mocks = await startArch040BackgroundMocks({ rowId: configuration.id,
      version: configuration.version, providerAccountId, standalonePhoneNumberId });
    await db.backgroundRuntimeConfig.upsert({ where: { id: "default" },
      create: { id: "default", checkoutRecoveryLifetimeDays: 21 }, update: {} });
    await db.whatsAppPoolSender.create({ data: {
      providerPhoneNumberId: mocks.whatsapp.phoneNumberId, providerAccountId,
      allocationEnabled: true, verifiedAt: new Date(Date.now() - 60_000),
    } });
    ownedPoolPhoneId = mocks.whatsapp.phoneNumberId;
    const allocation = await new RecoverySenderPoolService(db).allocate({
      conversationId: owner.conversationId, canonicalRecipient: owner.recipient,
    });
    if (allocation.kind !== "assigned") throw new Error(`Fixture sender allocation failed: ${allocation.kind}`);
    allocatedSender = allocation.sender;
    if (allocatedSender.providerPhoneNumberId !== ownedPoolPhoneId ||
        allocatedSender.providerAccountId !== providerAccountId) throw new Error("Fixture sender identity mismatch");
    return { mocks, cleanupAfterOwnerDeletion };
  } catch (error) {
    try {
      await db.shop.delete({ where: { id: owner.shopId } });
      await cleanupAfterOwnerDeletion();
    } finally { await mocks?.close(); }
    throw error;
  }
}
