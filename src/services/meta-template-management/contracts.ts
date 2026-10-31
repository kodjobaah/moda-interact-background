import { createHash } from "node:crypto";

/** BG003-local service contracts, not a new Messaging or authoring wire schema. */
export type ProviderStatus = "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED" | "UNKNOWN";
export type MetaCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";
export type MetaComponent = Readonly<Record<string, unknown>>;
export type TemplateIdentity = Readonly<{ wabaId: string; name: string; language: string; id?: string | null }>;
export type ProviderTemplate = TemplateIdentity & Readonly<{
  id: string;
  category: string;
  status: string;
  components: MetaComponent[];
}>;
export type PreparedRegistration = TemplateIdentity & Readonly<{
  registrationId: string;
  localeId: string;
  category: MetaCategory;
  components: MetaComponent[];
  contentHash: string;
  updatedAt: Date;
  submittedAt: Date | null;
  submissionState: string;
  providerId: string | null;
}>;
export type SubmissionOutcome =
  | { kind: "submitted" | "already-submitted"; providerId: string }
  | { kind: "busy" | "unknown" | "blocked" | "failed"; code: string };
export type ReconcileOutcome = { kind: "current" | "unconfirmed" | "drift" | "stale"; status?: ProviderStatus };

/** A verified Messaging observation, not the unagreed queue payload. Only the owning
 * Messaging task can define and emit the cross-service job. */
export type AuthenticatedTemplateObservation = Readonly<{
  eventIdentity: string;
  wabaId: string;
  providerTemplateId?: string;
  providerTemplateName: string;
  providerLanguageCode: string;
  providerStatus: string;
  occurredAt: string;
  reasonCode?: string;
}>;

export class MetaManagementError extends Error {
  constructor(
    readonly code: string,
    readonly disposition: "blocked" | "definitive" | "uncertain",
    options?: ErrorOptions,
    readonly diagnostics?: Readonly<Record<string, unknown>>,
  ) {
    super(code, options);
    this.name = "MetaManagementError";
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Examples are Meta submission evidence, not the approved rendered content. */
function contentProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contentProjection);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "example") result[key] = contentProjection(entry);
    }
    return result;
  }
  return value;
}

export function observedContentHash(components: MetaComponent[]): string {
  return fingerprint(contentProjection(components));
}

/** Validates only the frozen Meta transport shape, NEVER reparses an Admin AST. */
export function validatedComponents(value: unknown): MetaComponent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20 ||
      value.some((c) => !c || Array.isArray(c) || typeof c !== "object")) {
    throw new MetaManagementError("INVALID_COMPILED_COMPONENTS", "blocked");
  }
  const components = value as MetaComponent[];
  for (const component of components) {
    if (component.type !== "HEADER") continue;
    const example = component.example;
    const imageExample = example && typeof example === "object" && !Array.isArray(example)
      ? example as Record<string, unknown> : undefined;
    if (component.format === "IMAGE" && example !== undefined && example !== null &&
        (typeof example !== "object" || Array.isArray(example))) {
      throw new MetaManagementError("INVALID_COMPILED_COMPONENTS", "blocked");
    }
    if (component.format === "IMAGE" && imageExample && Object.keys(imageExample).length > 0) {
      throw new MetaManagementError(Object.hasOwn(imageExample, "header_handle")
        ? "UNTRUSTED_IMAGE_SAMPLE_HANDLE" : "INVALID_COMPILED_COMPONENTS", "blocked");
    }
    const hasHandle = !!imageExample && Object.hasOwn(imageExample, "header_handle");
    if (component.format !== "IMAGE" && hasHandle) {
      throw new MetaManagementError("INVALID_COMPILED_COMPONENTS", "blocked");
    }
  }
  return components;
}

/** Final provider boundary. IMAGE examples are accepted only after the trusted
 * uploader has produced a handle and the service has copied it into the payload. */
export function validatedProviderComponents(value: unknown): MetaComponent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20 ||
      value.some((c) => !c || Array.isArray(c) || typeof c !== "object")) {
    throw new MetaManagementError("INVALID_COMPILED_COMPONENTS", "blocked");
  }
  for (const component of value as MetaComponent[]) {
    if (component.type !== "HEADER") continue;
    const example = component.example;
    const handles = example && typeof example === "object" && !Array.isArray(example)
      ? (example as Record<string, unknown>).header_handle : undefined;
    if (component.format === "IMAGE" && (!Array.isArray(handles) || handles.length !== 1 ||
        typeof handles[0] !== "string" || handles[0].length < 5 || handles[0].length > 4096 ||
        /^(?:https?:\/\/|data:|file:)/i.test(handles[0]) ||
        !/^[A-Za-z0-9+/_:.=-]+$/.test(handles[0]))) {
      throw new MetaManagementError("IMAGE_SAMPLE_HANDLE_REQUIRED", "blocked");
    }
    if (component.format !== "IMAGE" && handles !== undefined) {
      throw new MetaManagementError("INVALID_COMPILED_COMPONENTS", "blocked");
    }
  }
  return value as MetaComponent[];
}

export function parseProviderStatus(value: string): ProviderStatus {
  return (["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"] as const).find((v) => v === value) ?? "UNKNOWN";
}

export function safeMetaError(error: unknown): { code: string; name: string } {
  // Provider responses, URLs, credentials, payloads and customer content never enter logs.
  if (error instanceof MetaManagementError) return {
    code: error.code,
    name: error.name.slice(0, 64),
    ...(error.diagnostics ?? {}),
  };
  return { code: "UNEXPECTED_ERROR", name: error instanceof Error ? error.name.slice(0, 64) : "UnknownError",
    ...(error instanceof Error ? { origin: "sdk_exception" } : {}) };
}
