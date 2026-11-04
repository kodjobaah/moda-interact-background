import { randomUUID } from "node:crypto";

import prisma from "../../../src/lib/db.js";

export type Arch056InboundFixture = {
  conversationId: string;
  recoveryId: string;
  shopId: string;
  suffix: string;
};

export async function createArch056RecoveryFixture(
  delayMinutes = 1,
  controlRevision = 3,
): Promise<Arch056InboundFixture> {
  const suffix = randomUUID();
  const shopId = `arch056-shop-${suffix}`;
  const recoveryId = `arch056-recovery-${suffix}`;
  const conversationId = `arch056-conversation-${suffix}`;

  await prisma.shop.create({
    data: {
      id: shopId,
      domain: `arch056-${suffix}.myshopify.com`,
      status: "ACTIVE",
      onboardingCompleted: true,
    },
  });
  try {
    await prisma.checkoutRecovery.create({
      data: {
        id: recoveryId,
        shopId,
        checkoutToken: `arch056-checkout-${suffix}`,
        status: "MESSAGE_SENT",
        lastExternalActivityAt: new Date(),
      },
    });
    await prisma.shopSettings.create({
      data: { shopId, aiResponseDelayMinutes: delayMinutes },
    });
    await prisma.conversation.create({
      data: {
        id: conversationId,
        type: "RECOVERY",
        checkoutRecoveryId: recoveryId,
        controlRevision,
        controlChangedAt: controlRevision === 0
          ? null
          : new Date("2026-10-31T00:00:00.000Z"),
      },
    });
  } catch (error) {
    await cleanupArch056RecoveryFixture({
      conversationId,
      recoveryId,
      shopId,
      suffix,
    });
    throw error;
  }

  return { conversationId, recoveryId, shopId, suffix };
}

export async function cleanupArch056RecoveryFixture(
  fixture: Arch056InboundFixture,
): Promise<void> {
  await prisma.conversationMessage.deleteMany({
    where: { conversationId: fixture.conversationId },
  });
  await prisma.conversation.deleteMany({
    where: { id: fixture.conversationId },
  });
  await prisma.shopSettings.deleteMany({
    where: { shopId: fixture.shopId },
  });
  await prisma.checkoutRecovery.deleteMany({
    where: { id: fixture.recoveryId },
  });
  await prisma.shop.deleteMany({ where: { id: fixture.shopId } });
}
