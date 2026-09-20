import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(resolve(root, "src/entrypoints/billing.ts"), "utf8");

describe("billing entrypoint runtime controls", () => {
  it("uses the shared dynamic leased scheduler and configured interval", () => {
    expect(source).toContain("startDynamicLeasedScheduler");
    expect(source).toContain("PromotionSelectionExpiryReconciliationService");
    expect(source).toContain("promotionSelectionExpiryReconciliationService.reconcileOnce(runtimeConfig)");
    expect(source).toContain("billing.reconciliation.promotion_selection_expiry_completed");
    expect(source).toContain("billing.reconciliation.promotion_selection_expiry_failed");
    expect(source).toContain('leaseName: "BILLING_RECONCILIATION"');
    expect(source).toContain("billingReconciliationIntervalSeconds * 1000");
    expect(source.match(/startDynamicLeasedScheduler\(\{/g)).toHaveLength(1);
    expect(source).not.toContain("startBillingReconciliationScheduler(");
    expect(source).not.toContain("60_000");
  });
});
