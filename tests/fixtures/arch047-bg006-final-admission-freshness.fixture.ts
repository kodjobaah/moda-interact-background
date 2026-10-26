/**
 * ARCH-047 BG003 -> BG006 final admission handoff fixture.
 *
 * BG006 MUST run these vectors against its real late SQL admission adapter
 * (after re-reading the assignment/registration). They are data-only: BG003
 * does not own, duplicate or certify the production send fence.
 *
 * Age is measured against the final permit time, not preparation time.
 */
export type Bg006RegistrationFreshness = Readonly<{
  registrationId: string;
  wabaId: string;
  providerStatus: "APPROVED" | "UNKNOWN" | "PAUSED";
  failureCode: string | null;
  driftDetectedAt: Date | null;
  lastReconciledAt: Date | null;
}>;

export type Bg006FinalAdmissionFreshnessFixture = Readonly<{
  name: string;
  permitAt: Date;
  registration: Bg006RegistrationFreshness;
  expected: Readonly<{
    kind: "eligible" | "suppressed";
    reason?: "TEMPLATE_PROVIDER_STATUS_STALE" | "TEMPLATE_PROVIDER_STATUS_UNRESOLVED";
  }>;
}>;

const permitAt = new Date("2026-10-26T12:00:00.000Z");
const base: Bg006RegistrationFreshness = {
  registrationId: "bg006-shared-registration",
  wabaId: "123456789",
  providerStatus: "APPROVED",
  failureCode: null,
  driftDetectedAt: null,
  lastReconciledAt: new Date("2026-10-26T11:30:00.000Z"),
};

export const bg006FinalAdmissionFreshnessFixtures: readonly Bg006FinalAdmissionFreshnessFixture[] = [
  {
    name: "approved and reconciled 30 minutes before final admission",
    permitAt, registration: { ...base }, expected: { kind: "eligible" },
  },
  {
    name: "approved exactly 60 minutes before final admission is still fresh",
    permitAt, registration: { ...base, lastReconciledAt: new Date("2026-10-26T11:00:00.000Z") },
    expected: { kind: "eligible" },
  },
  {
    name: "previously approved but reconciled more than 60 minutes ago is stale",
    permitAt, registration: { ...base, lastReconciledAt: new Date("2026-10-26T10:59:59.999Z") },
    expected: { kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_STALE" },
  },
  {
    name: "approved without a successful reconciliation is stale",
    permitAt, registration: { ...base, lastReconciledAt: null },
    expected: { kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_STALE" },
  },
  {
    name: "webhook has fenced a prior approval while provider GET fails",
    permitAt, registration: { ...base, providerStatus: "UNKNOWN",
      failureCode: "STATUS_RECONCILIATION_PENDING" },
    expected: { kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" },
  },
  {
    name: "provider has paused a previously approved registration",
    permitAt, registration: { ...base, providerStatus: "PAUSED" },
    expected: { kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" },
  },
  {
    name: "provider content drift blocks even a fresh approved registration",
    permitAt, registration: { ...base, driftDetectedAt: new Date("2026-10-26T11:45:00.000Z") },
    expected: { kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" },
  },
];
