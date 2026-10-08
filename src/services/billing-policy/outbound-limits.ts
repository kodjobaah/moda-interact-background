/** Preserves the resolver-owned error class and message prefix at the call site. */
type InvalidConfigurationFactory = (shopId: string, detail: string) => Error;

/** Shared validation and platform-cap calculation for both billing policy resolvers. */
export function resolveOutboundLimits(
  shopId: string,
  platformSoft: number,
  platformDefaultHard: number,
  absoluteHard: number,
  override: { outboundSoftLimit: number | null; outboundHardLimit: number | null } | null,
  invalidConfiguration: InvalidConfigurationFactory,
): { soft: number; hard: number } {
  const validatedPlatformSoft = validateMinimumInteger(
    shopId,
    "platform soft limit",
    platformSoft,
    1,
    invalidConfiguration,
  );
  const validatedPlatformHard = validateMinimumInteger(
    shopId,
    "platform default hard limit",
    platformDefaultHard,
    2,
    invalidConfiguration,
  );
  const validatedAbsoluteHard = validateMinimumInteger(
    shopId,
    "platform absolute hard limit",
    absoluteHard,
    2,
    invalidConfiguration,
  );
  if (validatedPlatformSoft > validatedPlatformHard) {
    throw invalidConfiguration(shopId, "platform soft limit exceeds platform hard limit");
  }

  const overrideHard = override?.outboundHardLimit;
  const overrideSoft = override?.outboundSoftLimit;
  if (overrideHard !== null && overrideHard !== undefined) {
    validateMinimumInteger(shopId, "shop hard limit", overrideHard, 2, invalidConfiguration);
  }
  if (overrideSoft !== null && overrideSoft !== undefined) {
    validateMinimumInteger(shopId, "shop soft limit", overrideSoft, 1, invalidConfiguration);
  }
  if (
    overrideSoft !== null &&
    overrideSoft !== undefined &&
    overrideHard !== null &&
    overrideHard !== undefined &&
    overrideSoft > overrideHard
  ) {
    throw invalidConfiguration(shopId, "shop soft limit exceeds shop hard limit");
  }

  const requestedHardLimit = overrideHard ?? validatedPlatformHard;
  const hard = Math.min(requestedHardLimit, validatedAbsoluteHard);
  const requestedSoftLimit = overrideSoft ?? validatedPlatformSoft;
  const soft = Math.min(requestedSoftLimit, hard);
  if (soft < 1 || hard < 2 || soft > hard) {
    throw invalidConfiguration(shopId, "effective outbound limits are invalid");
  }
  return { soft, hard };
}

function validateMinimumInteger(
  shopId: string,
  label: string,
  value: number,
  minimum: number,
  invalidConfiguration: InvalidConfigurationFactory,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalidConfiguration(shopId, `${label} must be a finite integer of at least ${minimum}`);
  }
  return value;
}

export function validateTerminalMessageReservedSlots(
  shopId: string,
  value: number,
  effectiveHardLimit: number,
  invalidConfiguration: InvalidConfigurationFactory,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= effectiveHardLimit) {
    throw invalidConfiguration(
      shopId,
      "terminalMessageReservedSlots must be at least 1 and less than the effective hard limit",
    );
  }
  return value;
}
