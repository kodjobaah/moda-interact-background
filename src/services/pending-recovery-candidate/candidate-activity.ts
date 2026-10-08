import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";

export function canonicalCandidateActivityAt(
  value: string | null | undefined,
  fallbackNow = Date.now(),
): string {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date(fallbackNow).toISOString();
}

export function candidateActivityDueAtMs(
  lastActivityAt: string | undefined,
  delayMinutes: number,
  fallbackNow = Date.now(),
): number {
  const activityMs = lastActivityAt ? Date.parse(lastActivityAt) : fallbackNow;
  return activityMs + delayMinutes * 60_000;
}

export function maxCandidateActivityAt(
  existing: string | null | undefined,
  incoming: string | undefined,
  fallbackNow = Date.now(),
): string {
  const incomingValue = incoming ?? new Date(fallbackNow).toISOString();
  const existingMs = existing ? Date.parse(existing) : Number.NaN;
  const incomingMs = Date.parse(incomingValue);
  if (Number.isFinite(existingMs) && existingMs >= incomingMs) {
    return new Date(existingMs).toISOString();
  }
  return incomingValue;
}

export function mergeCandidateInternationalContext(
  existing: InternationalContext | undefined,
  incoming: InternationalContext | undefined,
): InternationalContext | undefined {
  if (!existing && !incoming) return undefined;

  return {
    languageTag: incoming?.languageTag ?? existing?.languageTag ?? null,
    languageSource: incoming?.languageSource ?? existing?.languageSource ?? null,
    countryCode: incoming?.countryCode ?? existing?.countryCode ?? null,
    currencyCode: incoming?.currencyCode ?? existing?.currencyCode ?? null,
    timeZone: incoming?.timeZone ?? existing?.timeZone ?? null,
  };
}

export function optionalCandidateInternationalContext(
  context: InternationalContext | undefined,
): { internationalContext: InternationalContext } | Record<string, never> {
  return context ? { internationalContext: context } : {};
}
