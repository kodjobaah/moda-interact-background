import { describe, expect, it } from "vitest";
import {
  bg006FinalAdmissionFreshnessFixtures,
} from "../../../fixtures/arch047-bg006-final-admission-freshness.fixture.js";

/** Fixture-validation only. The BG006 owning task must import these same
 * vectors and assert them against the real DB-backed late-send adapter.
 */
describe("ARCH-047 BG006 60-minute final-admission fixture contract", () => {
  it("provides both positive and fail-closed cases at the exact 60-minute boundary", () => {
    const fixtures = bg006FinalAdmissionFreshnessFixtures;
    expect(fixtures).toHaveLength(7);
    const approved = fixtures.filter((fixture) => fixture.expected.kind === "eligible");
    expect(approved).toHaveLength(2);
    for (const fixture of approved) {
      const age = fixture.permitAt.getTime() - fixture.registration.lastReconciledAt!.getTime();
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(60 * 60_000);
      expect(fixture.registration.providerStatus).toBe("APPROVED");
      expect(fixture.registration.failureCode).toBeNull();
      expect(fixture.registration.driftDetectedAt).toBeNull();
    }
    const stale = fixtures.find((fixture) => fixture.name.startsWith("previously approved but reconciled more"));
    expect(stale).toBeDefined();
    expect(stale!.permitAt.getTime() - stale!.registration.lastReconciledAt!.getTime())
      .toBeGreaterThan(60 * 60_000);
    expect(stale!.expected).toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_STALE" });
    const pending = fixtures.find((fixture) => fixture.registration.failureCode === "STATUS_RECONCILIATION_PENDING");
    expect(pending!.expected).toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" });
  });
});
