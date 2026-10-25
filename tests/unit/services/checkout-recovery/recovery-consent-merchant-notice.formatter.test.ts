import { describe, expect, it } from "vitest";
import type { RecoveryConsentNoticeInput } from "../../../../src/services/checkout-recovery/recovery-consent-merchant-notice.contracts.js";
import {
  createRecoveryConsentNoticeSourceKey,
  formatRecoveryConsentMerchantNotice,
} from "../../../../src/services/checkout-recovery/recovery-consent-merchant-notice.formatter.js";

const first: RecoveryConsentNoticeInput = {
  shopId: "shop-test-1", platform: "SHOPIFY", checkoutToken: "checkout-secret-123",
  reason: "NO_VERIFIED_OPT_IN", blockedOperation: "CREATE_FIRST_RECOVERY",
};

const reasons = {
  NO_VERIFIED_OPT_IN: "Verified WhatsApp marketing permission is not available for this customer.",
  RECIPIENT_UNVERIFIED: "Moda could not verify the exact customer and WhatsApp recipient for this checkout.",
  RECIPIENT_AMBIGUOUS: "Moda could not identify one unambiguous WhatsApp recipient for this checkout.",
  VERIFICATION_UNAVAILABLE:
    "WhatsApp consent verification was temporarily unavailable. The customer's preference is unknown, not refused.",
} as const;

describe("canonical recovery consent merchant notice formatter", () => {
  it("matches the canonical six-field key vector, independent of blocked operation", () => {
    const canonicalKey =
      "recovery-consent:v1:f3725880d130d1a6c566743b009125f0e187cc4a9e50ac5391484a99b31a0a15";
    expect(createRecoveryConsentNoticeSourceKey(first)).toBe(canonicalKey);
    expect(createRecoveryConsentNoticeSourceKey({
      ...first, blockedOperation: "SEND_INITIAL_RECOVERY",
    })).toBe(canonicalKey);
    for (const change of [
      { platform: "WOOCOMMERCE" as const }, { shopId: "shop-2" },
      { checkoutToken: "another-secret" }, { reason: "RECIPIENT_AMBIGUOUS" as const },
    ]) {
      expect(createRecoveryConsentNoticeSourceKey({ ...first, ...change }))
        .not.toBe(createRecoveryConsentNoticeSourceKey(first));
    }
    expect(createRecoveryConsentNoticeSourceKey({ ...first, context: { customerName: "Different" } }))
      .toBe(createRecoveryConsentNoticeSourceKey(first));
    expect(createRecoveryConsentNoticeSourceKey(first)).not.toContain(first.checkoutToken);
  });

  it("formats the fixed heading, optional context, reason and operation in exact order", () => {
    const input: RecoveryConsentNoticeInput = {
      ...first, context: {
        customerName: "  Ada   Lovelace  ", customerEmail: "  Ada@Example.test  ",
        checkoutTotal: { currency: "GBP", amountDecimal: "123.450" }, itemCount: 5,
        lastActivityAt: "2026-10-24T18:10:00+02:00", merchantVisibleReference: "#10028",
      },
    };
    expect(formatRecoveryConsentMerchantNotice(input)).toBe([
      "Checkout recovery could not proceed",
      "Platform: Shopify",
      "Customer: Ada Lovelace",
      "Email: Ada@Example.test",
      "Checkout total: GBP 123.450",
      "Items: 5",
      "Last recorded activity: 2026-10-24 16:10 UTC",
      "Checkout reference: #10028",
      `Reason: ${reasons.NO_VERIFIED_OPT_IN}`,
      "Outcome: No checkout recovery was created, and no WhatsApp recovery message was sent.",
    ].join("\n"));
    expect(formatRecoveryConsentMerchantNotice({
      ...input, platform: "WOOCOMMERCE", blockedOperation: "SEND_INITIAL_RECOVERY",
    })).toBe(formatRecoveryConsentMerchantNotice(input)
      .replace("Platform: Shopify", "Platform: WooCommerce")
      .replace("Outcome: No checkout recovery was created, and no WhatsApp recovery message was sent.",
        "Outcome: The initial WhatsApp recovery message was not sent at this check. An existing recovery may remain."));
  });

  it("renders the exact fallback and all four reasons with both operation endings", () => {
    for (const [reason, copy] of Object.entries(reasons)) {
      for (const blockedOperation of ["CREATE_FIRST_RECOVERY", "SEND_INITIAL_RECOVERY"] as const) {
        const body = formatRecoveryConsentMerchantNotice({
          ...first, reason: reason as keyof typeof reasons, blockedOperation,
        });
        expect(body.split("\n")).toEqual([
          "Checkout recovery could not proceed", "Platform: Shopify",
          "Customer / checkout details: Not available from the recorded checkout.",
          `Reason: ${copy}`,
          `Outcome: ${blockedOperation === "CREATE_FIRST_RECOVERY"
            ? "No checkout recovery was created, and no WhatsApp recovery message was sent."
            : "The initial WhatsApp recovery message was not sent at this check. An existing recovery may remain."}`,
        ]);
      }
    }
  });

  it("omits malformed optional fields without misrepresenting consent or leaking tokens", () => {
    const body = formatRecoveryConsentMerchantNotice({
      ...first, context: {
        customerName: "\u202e Alice\r\nInjected\t<admin>\u2069",
        customerEmail: "a@b.test\r\nUnwanted", checkoutTotal: { currency: "gbp", amountDecimal: "0.00" },
        itemCount: Number.MAX_SAFE_INTEGER,
        lastActivityAt: "2026-02-30T10:00:00Z",
        merchantVisibleReference: first.checkoutToken,
      },
    });
    expect(body).toContain("Customer: Alice Injected admin");
    expect(body).not.toContain("Email:");
    expect(body).not.toContain("Checkout total:");
    expect(body).not.toContain("Items:");
    expect(body).not.toContain("Last recorded activity:");
    expect(body).not.toContain("Checkout reference:");
    expect(body).not.toContain("\r");
    expect(body).not.toMatch(/[\u202e\u2069<>]/u);
    expect(body).not.toContain(first.checkoutToken);
    expect(body).not.toContain("refund");
    expect(body).not.toContain("credit");
    expect(body).not.toContain("retry");
  });

  it("enforces precise bounds and omits invalid optional amounts, time, references and item counts", () => {
    const safe = formatRecoveryConsentMerchantNotice({
      ...first, context: {
        checkoutTotal: { amountDecimal: "0.001", currency: "USD" }, itemCount: 0,
        lastActivityAt: "2024-02-29T23:30:00-00:30", merchantVisibleReference: "Order #567",
        customerName: "💫".repeat(145),
      },
    });
    expect(safe).toContain("Checkout total: USD 0.001");
    expect(safe).toContain("Items: 0");
    expect(safe).toContain("Last recorded activity: 2024-03-01 00:00 UTC");
    expect(safe).toContain("Checkout reference: Order #567");
    expect(Array.from(safe.split("\n").find((line) => line.startsWith("Customer: "))!.slice(10)).length).toBe(120);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(2048);

    const bad = formatRecoveryConsentMerchantNotice({
      ...first, context: {
        checkoutTotal: { amountDecimal: "01.00", currency: "USD" }, itemCount: -2,
        lastActivityAt: "2024-02-29T23:30:00", merchantVisibleReference: "https://example.test/admin?token=1",
      },
    });
    expect(bad).toContain("Customer / checkout details: Not available");
    expect(bad).not.toContain("01.00");
    expect(bad).not.toContain("example.test");
  });

  it("keeps worst-case Unicode presentation below the UTF-8 budget and single-line safe", () => {
    const body = formatRecoveryConsentMerchantNotice({
      ...first, context: {
        customerName: "🐱".repeat(120),
        customerEmail: `${"💎".repeat(120)}@${"💎".repeat(120)}.test`,
        merchantVisibleReference: "#" + "A".repeat(79),
        itemCount: 100000, checkoutTotal: { amountDecimal: "999999999999.999", currency: "GBP" },
        lastActivityAt: "2026-10-24T10:00:00.123Z",
      },
    });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(2048);
    expect(body.split("\n").every((line) => !line.includes("\r"))).toBe(true);
  });

  it("rejects invalid required identifiers, enums and operations with safe errors", () => {
    for (const [input, message] of [
      [{ ...first, shopId: " " }, "shopId"],
      [{ ...first, shopId: "s".repeat(129) }, "shopId"],
      [{ ...first, checkoutToken: " " }, "checkoutToken"],
      [{ ...first, checkoutToken: "t".repeat(1025) }, "checkoutToken"],
      [{ ...first, platform: "SOMETHING_ELSE" }, "platform"],
      [{ ...first, reason: "OTHER" }, "reason"],
      [{ ...first, blockedOperation: "INVALID" }, "blockedOperation"],
    ] as const) {
      expect(() => formatRecoveryConsentMerchantNotice(input as RecoveryConsentNoticeInput)).toThrow(message);
      expect(() => createRecoveryConsentNoticeSourceKey(input as RecoveryConsentNoticeInput)).toThrow(message);
    }
  });
});
