import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { InitialOutreachCreditService } from "../../src/services/recovery-billing/initial-outreach-credit.service.js";
import { addSharedCounterInitialOutreach, createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

suite("ARCH-056 initial outreach credit races (PostgreSQL)", () => {
  it("commits two distinct confirmed messages sharing one counter through independent clients", async () => {
    const f = await createInitialOutreachCreditFixture();
    const second = await addSharedCounterInitialOutreach(f);
    const secondClient = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    try {
      const secondService = new InitialOutreachCreditService(secondClient);
      const firstInput = {
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      };
      const secondInput = {
        shopId: f.shopId,
        recoveryId: second.recoveryId,
        outreachAttemptId: second.attemptId,
        outboundMessageId: second.messageId,
      };
      const results = await Promise.all([
        f.service.settleConfirmedInitialOutreach(firstInput),
        secondService.settleConfirmedInitialOutreach(secondInput),
      ]);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "settled", reservationId: f.reservationId }),
        expect.objectContaining({ kind: "settled", reservationId: second.reservationId }),
      ]));
      const counter = await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } });
      expect(counter).toMatchObject({ committedQuantity: 2, reservedQuantity: 0 });
      const reservations = await f.db.usageReservation.findMany({ where: { id: { in: [f.reservationId!, second.reservationId] } } });
      expect(reservations).toHaveLength(2);
      expect(reservations.every((reservation) => reservation.status === "COMMITTED")).toBe(true);
      expect(await f.db.usageEvent.count({ where: {
        shopId: f.shopId,
        metric: "RECOVERY_CONVERSATION",
        correctionOfUsageEventId: null,
      } })).toBe(2);
    } finally {
      await secondClient.$disconnect();
      await f.close();
    }
  });
});
