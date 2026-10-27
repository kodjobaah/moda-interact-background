import "dotenv/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboundWhatsAppAdmissionService } from
  "../../src/services/outbound-whatsapp-admission.service.js";
import { automatedRecoveryTemplateService } from
  "../../src/services/recovery-template-integration/automated-recovery-template.service.js";
import { createWooOutreachFixture, type WooOutreachIntegrationFixture } from
  "./fixtures/arch048-woo-outreach.fixture.js";

const integration = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL &&
  process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

/** Postgres, credit attribution, queue and Redis are real. The BG004 fixture
 * uses a test-only sender; the separate Woo SQL-fence suite proves its final
 * dispatch safety. This case proves a late Redis failure isn't acknowledged as
 * a customer denial or converted into an earned credit/provider request.
 */
integration("ARCH-046 Woo initial outreach: late Redis fault compensation", () => {
  let fixture: WooOutreachIntegrationFixture | undefined;

  beforeEach(async () => {
    vi.spyOn(outboundWhatsAppAdmissionService, "getProviderAccountId")
      .mockResolvedValue("test-meta-account");
    vi.spyOn(automatedRecoveryTemplateService, "prepare").mockResolvedValue({
      kind: "prepared", prepared: {
        purpose: "INITIAL_NO_OFFER", providerTemplateName: "woo_checkout_recovery",
        providerLanguageCode: "en_GB", canonicalLanguageTag: "en-GB",
      }, send: { templateName: "woo_checkout_recovery", languageCode: "en_GB" },
    } as never);
    fixture = await createWooOutreachFixture();
  });

  afterEach(async () => {
    try { if (fixture) await fixture.cleanup(); }
    finally { fixture = undefined; vi.restoreAllMocks(); }
  });

  it("propagates a late Redis read failure without provider send or committed recovery charge", async () => {
    const f = fixture!;
    await f.service.enqueueInitial(f.recoveryId);
    // Fail only the final order observation, after billing has admitted one
    // reversible credit and before the test sender's provider permit.
    f.setBeforePermit(async () => {
      vi.spyOn(f.redis, "get").mockRejectedValueOnce(new Error("ARCH046_REDIS_ORDER_READ_FAILED"));
    });
    await expect(f.service.processInitial(f.recoveryId))
      .rejects.toThrow("ARCH046_REDIS_ORDER_READ_FAILED");
    expect(f.providerRequests).toBe(0);
    const counter = await f.db.shopEntitlementCounter.findUniqueOrThrow({
      where: { shopId_counter: { shopId: f.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } },
    });
    expect(counter.committedQuantity).toBe(0);
    expect(await f.db.usageEvent.count({ where: {
      shopId: f.shopId, metric: "RECOVERY_CONVERSATION",
    } })).toBe(0);
    const reservations = await f.db.usageReservation.findMany({ where: { shopId: f.shopId } });
    expect(reservations.every((row) => row.status !== "COMMITTED")).toBe(true);
  }, 90_000);
});
