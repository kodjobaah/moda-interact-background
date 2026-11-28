type InitialOutreachErrorDiagnostic = {
  name: string;
  message: string;
  redactionApplied: boolean;
  truncated: boolean;
  code?: string;
  clientVersion?: string;
  meta?: Record<string, string>;
  cause?: InitialOutreachErrorDiagnostic;
};

/** Safe projection of initial-outreach failure evidence for the Shared sink. */
export function initialOutreachDiagnostic(error: unknown) {
  const project = (
    source: unknown,
    includeCause: boolean,
  ): InitialOutreachErrorDiagnostic => {
    const original =
      source instanceof Error
        ? source.message
        : typeof source === "string"
          ? source
          : "Non-Error failure";
    const redacted = original
      .replace(
        /\b(?:https?|postgres(?:ql)?|redis):\/\/[^\s<>]+/gi,
        "[REDACTED_URL]",
      )
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(
        /\b(?:[a-z_-]*token|[a-z_-]*secret|password|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "[REDACTED_CREDENTIAL]",
      )
      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        "[REDACTED_EMAIL]",
      )
      .replace(
        /(?<![A-Za-z0-9])\+?\d(?:[ ().-]*\d){6,14}(?![A-Za-z0-9])/g,
        "[REDACTED_PHONE]",
      )
      .replace(/[\r\n\t]+/g, " ");
    const boundedIdentifier = (value: unknown) =>
      typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
        ? value
        : undefined;
    const properties =
      typeof source === "object" && source !== null
        ? (source as Record<string, unknown>)
        : {};
    const meta =
      typeof properties.meta === "object" && properties.meta !== null
        ? (properties.meta as Record<string, unknown>)
        : {};
    const code = boundedIdentifier(properties.code);
    const clientVersion = boundedIdentifier(properties.clientVersion);
    const safeMeta = Object.fromEntries(
      ["modelName", "constraint", "field_name"].flatMap((key) => {
        const value = boundedIdentifier(meta[key]);
        return value ? [[key, value]] : [];
      }),
    );
    return {
      name:
        boundedIdentifier(source instanceof Error ? source.name : undefined) ??
        "UnknownError",
      message: redacted.slice(0, 384),
      redactionApplied: redacted !== original,
      truncated: redacted.length > 384,
      ...(code ? { code } : {}),
      ...(clientVersion ? { clientVersion, meta: safeMeta } : {}),
      ...(includeCause && properties.cause !== undefined
        ? { cause: project(properties.cause, false) }
        : {}),
    };
  };
  return project(error, true);
}
