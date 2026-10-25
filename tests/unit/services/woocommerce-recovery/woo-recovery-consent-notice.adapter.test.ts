import { describe, expect, it, vi } from "vitest";
import type {
  RecoveryConsentNoticeInput,
  RecoveryConsentNoticeReason,
} from "../../../../src/services/checkout-recovery/recovery-consent-merchant-notice.contracts.js";
import { formatRecoveryConsentMerchantNotice } from
  "../../../../src/services/checkout-recovery/recovery-consent-merchant-notice.formatter.js";
import type { WooPendingCandidate } from
  "../../../../src/services/woocommerce-recovery/contracts.js";
import type { WooAdmissionDenialReason, WooDeniedAdmission } from
  "../../../../src/services/woocommerce-recovery/woo-recovery-admission.service.js";
import { createWooRecoveryConsentDeniedAdmissionNotifier } from
  "../../../../src/services/woocommerce-recovery/woo-recovery-consent-notice.adapter.js";

const SHOP = "woo-shop-1";
const TOKEN = "private-checkout-token-42";
const PHONE = "+447400123456";
const ACTIVITY = "2026-10-24T10:00:00.000Z";

function candidate(overrides: Partial<WooPendingCandidate> = {}): WooPendingCandidate {
  return {
    source: "woocommerce", shopId: SHOP, checkoutToken: TOKEN,
    lastEventId: "accepted-event-1", lastActivityAt: ACTIVITY,
    basket: { kind: "nonempty", checkout: {
      currency: "GBP", total: "44.20",
      items: [
        { quantity: 2, productId: "product-1", total: "29.20" },
        { quantity: 1, productId: "product-2", total: "15.00" },
      ],
      contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: PHONE },
    } },
    ...overrides,
  };
}

function harness(initialCandidate: WooPendingCandidate | null = candidate()) {
  const candidates = { getPending: vi.fn(async () => initialCandidate) };
  const notifier = { notify: vi.fn(async (_input: RecoveryConsentNoticeInput) => "created" as const) };
  const logger = { info: vi.fn(), error: vi.fn() };
  const callback = createWooRecoveryConsentDeniedAdmissionNotifier({ candidates, notifier, logger });
  return { callback, candidates, notifier, logger };
}

function denial(reason: WooAdmissionDenialReason, shopId = SHOP, checkoutToken = TOKEN): WooDeniedAdmission {
  return { reason, shopId, checkoutToken };
}

const matrix: readonly [WooAdmissionDenialReason, RecoveryConsentNoticeReason | null][] = [
  ["CONSENT_NOT_GRANTED", "NO_VERIFIED_OPT_IN"],
  ["CONSENT_AMBIGUOUS", "RECIPIENT_AMBIGUOUS"],
  ["RECIPIENT_MISSING", "RECIPIENT_UNVERIFIED"],
  ["RECIPIENT_INVALID", "RECIPIENT_UNVERIFIED"],
  ["RECIPIENT_IDENTITY_MISMATCH", "RECIPIENT_UNVERIFIED"],
  ["CONSENT_RECIPIENT_UNVERIFIED", "RECIPIENT_UNVERIFIED"],
  ["CONSENT_NO_CONTACT", null],
  ["CONSENT_CHANGED", null],
  ["INVALID_CANDIDATE", null],
  ["SHOP_NOT_ELIGIBLE", null],
  ["INSTALLATION_INACTIVE", null],
  ["BASKET_EMPTY", null],
  ["BASKET_INVALID", null],
];

describe("ARCH-046-BACKGROUND-002 Woo first-recovery merchant notices", () => {
  it.each(matrix)("maps %s to %s (or excludes it)", async (reason, expected) => {
    const h = harness();
    await h.callback(denial(reason));
    if (expected === null) {
      expect(h.candidates.getPending).not.toHaveBeenCalled();
      expect(h.notifier.notify).not.toHaveBeenCalled();
    } else {
      expect(h.candidates.getPending).toHaveBeenCalledExactlyOnceWith({ shopId: SHOP, checkoutToken: TOKEN });
      expect(h.notifier.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        shopId: SHOP, checkoutToken: TOKEN, platform: "WOOCOMMERCE",
        blockedOperation: "CREATE_FIRST_RECOVERY", reason: expected,
      }));
    }
  });

  it("shows only verified-source checkout details; never leaks a raw key, phone or guessed reference", async () => {
    const h = harness();
    await h.callback(denial("CONSENT_NOT_GRANTED"));
    const input = h.notifier.notify.mock.calls[0]![0];
    expect(input.context).toEqual({
      customerName: "Ada Lovelace", customerEmail: "ada@example.test",
      checkoutTotal: { amountDecimal: "44.20", currency: "GBP" },
      itemCount: 3, lastActivityAt: ACTIVITY,
    });
    expect(input.context).not.toHaveProperty("merchantVisibleReference");
    const body = formatRecoveryConsentMerchantNotice(input);
    expect(body).toContain("Customer: Ada Lovelace");
    expect(body).toContain("Email: ada@example.test");
    expect(body).toContain("Checkout total: GBP 44.20");
    expect(body).toContain("Items: 3");
    expect(body).toContain("Last recorded activity: 2026-10-24 10:00 UTC");
    expect(body).toContain("No checkout recovery was created");
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(PHONE);
    expect(body).not.toContain("Checkout reference:");
    const logs = JSON.stringify([...h.logger.info.mock.calls, ...h.logger.error.mock.calls]);
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(PHONE);
    expect(logs).not.toContain("ada@example.test");
    expect(logs).not.toContain("accepted-event-1");
  });

  it.each([
    "CONSENT_AMBIGUOUS", "RECIPIENT_MISSING", "RECIPIENT_INVALID",
    "RECIPIENT_IDENTITY_MISMATCH", "CONSENT_RECIPIENT_UNVERIFIED",
  ] as const)("never represents unverified contact as an identified customer (%s)", async (reason) => {
    const h = harness();
    await h.callback(denial(reason));
    expect(h.notifier.notify.mock.calls[0]![0].context).toEqual({
      checkoutTotal: { amountDecimal: "44.20", currency: "GBP" },
      itemCount: 3, lastActivityAt: ACTIVITY,
    });
    const body = formatRecoveryConsentMerchantNotice(h.notifier.notify.mock.calls[0]![0]);
    expect(body).not.toContain("Customer: ");
    expect(body).not.toContain("Email: ");
  });

  it("emits a truthful context-free notice for missing or wrong-source/tenant/checkout snapshots", async () => {
    for (const value of [
      null,
      candidate({ shopId: "different-shop" }),
      candidate({ checkoutToken: "different-checkout" }),
      { ...candidate(), source: "shopify" } as unknown as WooPendingCandidate,
      candidate({ lastEventId: "unsafe event key" }),
      candidate({ lastActivityAt: "not-a-timestamp" }),
    ]) {
      const h = harness(value);
      await h.callback(denial("CONSENT_NOT_GRANTED"));
      const input = h.notifier.notify.mock.calls[0]![0];
      expect(input).not.toHaveProperty("context");
      expect(formatRecoveryConsentMerchantNotice(input)).toContain(
        "Customer / checkout details: Not available from the recorded checkout.",
      );
    }
  });

  it("never turns absent, oversized, malformed or over-totalled items into an item count of zero", async () => {
    for (const items of [
      undefined,
      [],
      Array.from({ length: 51 }, () => ({ quantity: 1, productId: "product" })),
      [{ quantity: 0, productId: "product" }],
      [{ quantity: -1, productId: "product" }],
      [{ quantity: 1.5, productId: "product" }],
      [{ quantity: 100_000, productId: "product" }, { quantity: 100_000, productId: "other" }],
    ]) {
      const corrupted = candidate({ basket: {
        kind: "nonempty", checkout: {
          currency: "GBP", total: "44.20",
          items: items as never,
          contact: { phone: PHONE },
        },
      } });
      const h = harness(corrupted);
      await h.callback(denial("CONSENT_NOT_GRANTED"));
      const context = h.notifier.notify.mock.calls[0]![0].context;
      expect(context).toMatchObject({ checkoutTotal: { amountDecimal: "44.20", currency: "GBP" } });
      expect(context).not.toHaveProperty("itemCount");
    }
    const h = harness(candidate({ basket: { kind: "unknown", reason: "items-omitted" } }));
    await h.callback(denial("CONSENT_NOT_GRANTED"));
    expect(h.notifier.notify.mock.calls[0]![0].context).toEqual({ lastActivityAt: ACTIVITY });
  });

  it("omits individually invalid checkout total and unverified/absent contact", async () => {
    const h = harness(candidate({ basket: { kind: "nonempty", checkout: {
      currency: "gBp" as never, total: "01.00", items: [{ quantity: 1, productId: "product" }],
      contact: { firstName: "Unverified", email: "unverified@example.test" },
    } } }));
    await h.callback(denial("CONSENT_NOT_GRANTED"));
    expect(h.notifier.notify.mock.calls[0]![0].context).toEqual({
      itemCount: 1, lastActivityAt: ACTIVITY,
    });
  });

  it("rethrows candidate-store errors and notifier failures, with only bounded diagnostic fields", async () => {
    const redisError = new Error(`Redis refused ${PHONE} / ${TOKEN}`);
    const h = harness();
    h.candidates.getPending.mockRejectedValueOnce(redisError);
    await expect(h.callback(denial("CONSENT_NOT_GRANTED"))).rejects.toBe(redisError);
    expect(h.notifier.notify).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenLastCalledWith(
      "woocommerce.recovery.consent_notice.failed",
      expect.objectContaining({ shopId: SHOP, stage: "candidate_read", outcome: "failed" }),
    );
    const dbError = new Error(`DB write failed for ${TOKEN}`);
    h.notifier.notify.mockRejectedValueOnce(dbError);
    await expect(h.callback(denial("CONSENT_NOT_GRANTED"))).rejects.toBe(dbError);
    expect(h.logger.error).toHaveBeenLastCalledWith(
      "woocommerce.recovery.consent_notice.failed",
      expect.objectContaining({ shopId: SHOP, stage: "notice_write", outcome: "failed" }),
    );
    const logs = JSON.stringify(h.logger.error.mock.calls);
    expect(logs).not.toContain(PHONE);
    expect(logs).not.toContain(TOKEN);
  });

  it("rejects new reason variants visibly, without looking up other candidate data or sending a notice", async () => {
    const h = harness();
    await expect(h.callback(denial("FUTURE_REASON" as WooAdmissionDenialReason)))
      .rejects.toThrow("Unknown Woo admission denial reason");
    expect(h.candidates.getPending).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      "woocommerce.recovery.consent_notice.failed",
      expect.objectContaining({ reasonCode: "UNKNOWN_DENIAL_REASON", stage: "validate" }),
    );
  });

  it("rejects malformed tenant/checkout keys without logging their raw values", async () => {
    const h = harness();
    await expect(h.callback(denial("CONSENT_NOT_GRANTED", "shop / other", TOKEN)))
      .rejects.toThrow("Invalid Woo denial");
    await expect(h.callback(denial("CONSENT_NOT_GRANTED", SHOP, "https://private.example/token")))
      .rejects.toThrow("Invalid Woo denial");
    expect(h.candidates.getPending).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain("private.example");
  });

  it("isolates logger sink errors from both commits and logged failure propagation", async () => {
    const h = harness();
    h.logger.info.mockImplementation(() => { throw new Error("sink offline"); });
    h.logger.error.mockImplementation(() => { throw new Error("sink offline"); });
    await expect(h.callback(denial("CONSENT_NOT_GRANTED"))).resolves.toBeUndefined();
    h.notifier.notify.mockRejectedValueOnce(new Error("notifier offline"));
    await expect(h.callback(denial("CONSENT_NOT_GRANTED"))).rejects.toThrow("notifier offline");
    expect(h.notifier.notify).toHaveBeenCalledTimes(2);
    await expect(h.callback(denial("CONSENT_NO_CONTACT"))).resolves.toBeUndefined();
    expect(h.notifier.notify).toHaveBeenCalledTimes(2);
  });

  it("does not turn an invalid notifier outcome into successful delivery", async () => {
    const h = harness();
    h.notifier.notify.mockResolvedValueOnce("invalid" as never);
    await expect(h.callback(denial("CONSENT_NOT_GRANTED"))).rejects.toThrow("Invalid recovery consent notifier outcome");
  });
});
