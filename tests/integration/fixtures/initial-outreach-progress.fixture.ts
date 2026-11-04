import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { createLogger, type LogRecord, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { InitialOutreachCreditService } from "../../../src/services/recovery-billing/initial-outreach-credit.service.js";
import { RecoveryInitialOutreachSupportNoticeService } from
  "../../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js";
import { RecoveryOutreachFinalizationService } from
  "../../../src/services/checkout-recovery/recovery-outreach-finalization.service.js";
import { createInitialOutreachCreditFixture } from "./arch056-initial-outreach-credit.fixture.js";

export async function createInitialOutreachProgressFixture() {
  const credit = await createInitialOutreachCreditFixture({ withCredit: false });
  await credit.db.checkoutRecovery.update({ where: { id: credit.recoveryId }, data: { status: "DETECTED" } });
  const conversation = await credit.db.conversation.findUniqueOrThrow({
    where: { checkoutRecoveryId: credit.recoveryId }, select: { id: true },
  });
  await credit.db.conversationMessage.create({ data: {
    id: credit.messageId,
    conversationId: conversation.id,
    direction: "OUTBOUND",
    senderType: "AUTOMATION",
    status: "SENT",
    content: "Initial recovery outreach",
    providerMessageId: credit.providerMessageId,
    sentAt: credit.sentAt,
  } });
  const counter = await credit.db.shopEntitlementCounter.create({ data: {
    shopId: credit.shopId,
    counter: "LIFETIME_FREE_RECOVERY_CREDITS",
    grantedQuantity: 1,
    reservedQuantity: 1,
  } });
  const sourceKey = createRecoveryIdempotencyKey(credit.shopId,
    `recovery-outreach:${credit.attemptId}`);
  const reservation = await credit.db.usageReservation.create({ data: {
    shopId: credit.shopId,
    counterId: counter.id,
    sourceKey,
    quantity: 1,
    status: "RESERVED",
  } });
  await credit.db.usageEvent.create({ data: {
    shopId: credit.shopId,
    metric: "OUTBOUND_AUTOMATED_MESSAGE",
    quantity: 1,
    idempotencyKey: `recovery-outreach:${credit.attemptId}`,
    sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
    sourceId: credit.messageId,
    provider: credit.provider,
  } });
  await credit.db.shopSettings.create({ data: {
    shopId: credit.shopId,
    notifyOnInitialRecoveryOutreach: true,
  } });
  const records: LogRecord[] = [];
  const logger = createLogger({ serviceName: "initial-outreach-progress-integration-test", environment: "test",
    sink: (record) => records.push(JSON.parse(JSON.stringify(record)) as LogRecord) });
  const support = new RecoveryInitialOutreachSupportNoticeService(
    credit.db,
    () => new Date("2026-10-27T10:01:00.000Z"),
    logger as Pick<StructuredLogger, "info" | "error">,
  );
  const finalizer = new RecoveryOutreachFinalizationService(
    new InitialOutreachCreditService(credit.db), support,
    logger as Pick<StructuredLogger, "error">,
    credit.db,
  );
  return {
    ...credit,
    counterId: counter.id,
    reservationId: reservation.id,
    sourceKey,
    records,
    finalizer,
    recovery: async () => credit.db.checkoutRecovery.findUniqueOrThrow({ where: { id: credit.recoveryId } }),
    attempt: async () => credit.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: credit.attemptId } }),
    message: async () => credit.db.conversationMessage.findUniqueOrThrow({ where: { id: credit.messageId } }),
  };
}
