import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { parseWooRefundEvidence } from "../../../../src/services/woocommerce-billing/charge-refund-evidence.js";

describe("parseWooRefundEvidence", () => {
  it("accepts exact refunded charge evidence without monetary fields", () => {
    expect(parseWooRefundEvidence({ charge: { id: "charge-1", status: "canceled" } }, "charge-1"))
      .toEqual({ charge: { id: "charge-1", status: "canceled" }, money: null });
  });

  it("reads bounded amount_refunded from the latest transaction as audit-only evidence", () => {
    const evidence = parseWooRefundEvidence({
      charge: {
        id: "charge-1",
        status: "refunded",
        transactions: [
          { id: 1, completed_at: "2026-10-01T00:00:00Z", amount_refunded: "2.00" },
          { id: 2, completed_at: "2026-10-02T00:00:00Z", amount_refunded: "7.25" },
        ],
      },
    }, "charge-1");

    expect(evidence).toMatchObject({ money: { amount: new Prisma.Decimal("7.25"), currency: "USD" } });
  });

  it("rejects mismatched contract IDs and malformed supplied money", () => {
    expect(parseWooRefundEvidence({ charge: { id: "other", status: "refunded" } }, "charge-1"))
      .toEqual({ errorCode: "WOO_REFUND_CHARGE_EVIDENCE_INVALID" });
    expect(parseWooRefundEvidence({
      charge: {
        id: "charge-1",
        status: "refunded",
        transactions: [{ completed_at: "2026-10-02T00:00:00Z", amount_refunded: "1.001" }],
      },
    }, "charge-1")).toEqual({ errorCode: "WOO_REFUND_AMOUNT_EVIDENCE_INVALID" });
  });
});