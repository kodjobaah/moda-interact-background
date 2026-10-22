import { describe, expect, it } from "vitest";
import type { RecoveryCreditPurchase, RecoveryCreditRefund } from "@prisma/client";
import { classifyPurchasedCreditState } from
  "../../../../src/services/recovery-delivery-compensation/purchased-credit-state.js";

function lot(status: RecoveryCreditPurchase["status"]): RecoveryCreditPurchase {
  return { id: "lot", shopId: "shop", provider: "WOOCOMMERCE", status,
    creditsGranted: 2, currentAmount: status === "REFUNDED" || status === "COMPLETED" ? 0 : 1,
    reservedAmount: 0 } as RecoveryCreditPurchase;
}
function refund(status: RecoveryCreditRefund["status"]): RecoveryCreditRefund {
  return { id: "refund", shopId: "shop", purchaseId: "lot", provider: "WOOCOMMERCE",
    status, completedAt: status === "COMPLETED" ? new Date() : null,
    providerConfirmedAt: status === "COMPLETED" ? new Date() : null,
    finalCreditQuantity: status === "COMPLETED" ? 1 : null } as RecoveryCreditRefund;
}

describe("ARCH-028 purchased correction refund-state classifier", () => {
  it.each(["ACTIVE", "COMPLETED"] as const)("restores %s with no live refund", (status) => {
    expect(classifyPurchasedCreditState(lot(status), [])).toBe("restored-spendable");
    expect(classifyPurchasedCreditState(lot(status), [refund("CANCELLED")])).toBe("restored-spendable");
  });
  it.each(["REQUESTED", "PROVIDER_ACTION_REQUIRED", "NEEDS_ATTENTION"] as const)(
    "keeps WITHDRAWN capacity held for %s", (status) => {
      expect(classifyPurchasedCreditState(lot("WITHDRAWN"), [refund(status)])).toBe("held-for-refund");
    },
  );
  it("recognizes only a coherently completed provider refund as historical", () => {
    expect(classifyPurchasedCreditState(lot("REFUNDED"), [refund("COMPLETED")])).toBe("historical-only");
  });
  it("fails closed for unowned, multiple, incomplete, and contradictory refund state", () => {
    expect(() => classifyPurchasedCreditState(lot("WITHDRAWN"), [])).toThrow(/live refund/);
    expect(() => classifyPurchasedCreditState(lot("REFUNDED"), [refund("REQUESTED")])).toThrow(/terminal/);
    expect(() => classifyPurchasedCreditState(lot("ACTIVE"), [refund("REQUESTED")])).toThrow(/incompatible/);
    expect(() => classifyPurchasedCreditState(lot("WITHDRAWN"), [refund("COMPLETED")])).toThrow(/live refund/);
    expect(() => classifyPurchasedCreditState(lot("WITHDRAWN"), [refund("REQUESTED"), refund("REQUESTED")]))
      .toThrow(/ambiguous/);
    expect(() => classifyPurchasedCreditState(lot("WITHDRAWN"), [{ ...refund("REQUESTED"), shopId: "other" }]))
      .toThrow(/owner/);
    expect(() => classifyPurchasedCreditState({ ...lot("COMPLETED"), currentAmount: 1 }, []))
      .toThrow(/incompatible/);
    expect(() => classifyPurchasedCreditState({ ...lot("ACTIVE"), reservedAmount: 2 }, []))
      .toThrow(/quantities/);
  });
});
