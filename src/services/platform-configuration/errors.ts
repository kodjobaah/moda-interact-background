/** Stable, redacted outcomes. No underlying Prisma/crypto error is propagated. */
export type PlatformConfigurationFailureCode =
  | "DENIED" | "MISSING" | "DISABLED" | "INVALID" | "UNSEAL_FAILED" | "DB_UNAVAILABLE";

export class PlatformConfigurationFailure extends Error {
  constructor(readonly code: PlatformConfigurationFailureCode, readonly key: string) {
    super(`Platform configuration ${code.toLowerCase()}`);
    this.name = "PlatformConfigurationFailure";
  }
}
