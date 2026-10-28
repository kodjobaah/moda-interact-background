import { createHash } from "node:crypto";
import type {
  BrandClaim, BrandDocument, BrandOutcome, BrandReady, BrandRefresh, BrandRole, BrandSlot,
  BrandSource, BrandWork, SourceObservation,
} from "./contracts.js";
import {
  BrandStateError, BRAND_ROLES, MEDIA_LEASE_MS, MEDIA_MAX_ATTEMPTS,
  MEDIA_RECHECK_MS, MEDIA_RETRY_DELAYS_MS,
} from "./contracts.js";
import { decodeShopBrandDomain, encodeShopBrandDomain } from "../shop-brand-media/contracts.js";

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OWNERS = /^[0-9a-f-]{36}$/;
const MAX_SOURCE_LENGTH = 16_384;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function iso(value: string): number {
  const date = Date.parse(value);
  if (!Number.isFinite(date) || !/\d{4}-\d{2}-\d{2}T/.test(value)) throw new BrandStateError("INVALID_OBSERVATION");
  return date;
}

function checkedDocument(input: unknown): BrandDocument {
  const raw = record(input);
  if (!raw || Object.keys(raw).length === 0) return { schemaVersion: 1, roles: {} };
  if (raw.schemaVersion !== 1 || !record(raw.roles)) throw new BrandStateError("UNSUPPORTED_SCHEMA");
  for (const [key, value] of Object.entries(raw.roles as Record<string, unknown>)) {
    const slot = record(value);
    const source = record(slot?.source);
    const work = record(slot?.work);
    if (!BRAND_ROLES.includes(key as BrandRole) || !slot || !source || !work ||
        !(source.url === null || typeof source.url === "string") ||
        !(source.reference === null || typeof source.reference === "string") ||
        !(source.fingerprint === null || typeof source.fingerprint === "string" && FINGERPRINT.test(source.fingerprint)) ||
        !Number.isSafeInteger(source.generation) || (source.generation as number) < 1 ||
        typeof source.observedAt !== "string" || Number.isNaN(Date.parse(source.observedAt)) ||
        !["MISSING", "PENDING", "PROCESSING", "READY", "FAILED"].includes(String(work.status)) ||
        !Number.isSafeInteger(work.attempts) || (work.attempts as number) < 0 ||
        (work.retryAfter !== null && typeof work.retryAfter !== "string") ||
        (work.leaseOwner !== null && typeof work.leaseOwner !== "string") ||
        (work.leaseUntil !== null && typeof work.leaseUntil !== "string") ||
        (work.failureCode !== null && typeof work.failureCode !== "string") ||
        (work.lastCheckedAt !== null && typeof work.lastCheckedAt !== "string")) {
      throw new BrandStateError("INVALID_STORED_STATE");
    }
  }
  return raw as unknown as BrandDocument;
}

/** Never silently rewrite an unknown JSON schema or corrupt slot. */
export function parseBrandDocument(value: unknown): BrandDocument {
  return checkedDocument(value);
}

/** A null producer fingerprint means the canonical URL/reference digest; identical in API and Background. */
export function effectiveFingerprint(url: string, reference: string | null, provided: string | null): string {
  if (provided !== null) {
    if (!FINGERPRINT.test(provided)) throw new BrandStateError("INVALID_OBSERVATION");
    return provided;
  }
  return `sha256:${createHash("sha256").update(JSON.stringify([url, reference])).digest("hex")}`;
}

export function validateObservation(observation: SourceObservation): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(observation.shopId) ||
      !BRAND_ROLES.includes(observation.role) ||
      (observation.sourceUrl !== null && (typeof observation.sourceUrl !== "string" ||
        observation.sourceUrl.length === 0 || observation.sourceUrl.length > MAX_SOURCE_LENGTH)) ||
      (observation.sourceReference !== null && (typeof observation.sourceReference !== "string" ||
        observation.sourceReference.length > 1024)) ||
      (observation.sourceFingerprint !== null && !FINGERPRINT.test(observation.sourceFingerprint))) {
    throw new BrandStateError("INVALID_OBSERVATION");
  }
  iso(observation.observedAt);
}

export function newWork(status: BrandWork["status"]): BrandWork {
  return { status, attempts: 0, retryAfter: null, leaseOwner: null, leaseUntil: null,
    failureCode: null, lastCheckedAt: null };
}

export function updateObservedSource(document: BrandDocument, observed: SourceObservation): { document: BrandDocument; changed: boolean } {
  validateObservation(observed);
  const previous = document.roles[observed.role];
  const oldSource = previous?.source;
  // Equal timestamps from independent producers have no deterministic ordering. First accepted wins.
  if (oldSource && iso(observed.observedAt) <= iso(oldSource.observedAt)) {
    return { document, changed: false };
  }
  const fingerprint = observed.sourceUrl === null ? null :
    effectiveFingerprint(observed.sourceUrl, observed.sourceReference, observed.sourceFingerprint);
  const changed = !oldSource || oldSource.url !== observed.sourceUrl ||
    oldSource.reference !== observed.sourceReference || oldSource.fingerprint !== fingerprint;
  const source: BrandSource = {
    url: observed.sourceUrl, reference: observed.sourceReference, fingerprint,
    generation: (oldSource?.generation ?? 0) + (changed ? 1 : 0),
    observedAt: new Date(iso(observed.observedAt)).toISOString(),
  };
  const slot: BrandSlot = changed ? {
    source, work: newWork(source.url ? "PENDING" : "MISSING"), ready: previous?.ready ?? null,
  } : { ...previous!, source };
  return { document: { schemaVersion: 1, roles: { ...document.roles, [observed.role]: slot } }, changed };
}

function due(value: string | null, now: number): boolean {
  return !value || Number.isNaN(Date.parse(value)) || Date.parse(value) <= now;
}

function expired(value: string | null, now: number): boolean {
  return !value || Number.isNaN(Date.parse(value)) || Date.parse(value) <= now;
}

/** Role eligibility: no source or stale ready metadata can masquerade as deliverable READY. */
export function currentReady(slot: BrandSlot, expectedDomain?: string, expectedRole?: BrandRole): BrandReady | null {
  const { source, work, ready } = slot;
  const [prefix, domainSegment, role, filename] = ready?.objectKey.split("/") ?? [];
  const domain = decodeShopBrandDomain(domainSegment);
  if (work.status !== "READY" || !source.url || !source.fingerprint ||
      !ready || ready.sourceGeneration !== source.generation ||
      ready.sourceFingerprint !== source.fingerprint ||
      !(ready.contentType === "image/jpeg" || ready.contentType === "image/png") ||
      ready.width !== 1125 || ready.height !== 600 ||
      !Number.isSafeInteger(ready.sizeBytes) || ready.sizeBytes <= 0 || ready.sizeBytes >= 5 * 1024 * 1024 ||
      !DIGEST.test(ready.contentSha256) ||
        prefix !== "shop-brands" || domain === null ||
        !["logo", "square_logo", "cover_image"].includes(role ?? "") ||
        (expectedDomain !== undefined && domain !== expectedDomain) ||
        (expectedRole !== undefined && role !== expectedRole.toLowerCase()) ||
        !/^sha256-[a-f0-9]{64}\.(?:jpg|png)$/.test(filename ?? "") ||
        ready.objectKey.split("/").length !== 4) return null;
      if (filename !== `sha256-${ready.contentSha256}.${ready.contentType === "image/png" ? "png" : "jpg"}`) return null;
  return ready;
}

function refreshDue(slot: BrandSlot, now: number): boolean {
  const checked = Date.parse(slot.work.lastCheckedAt ?? slot.ready?.verifiedAt ?? "");
  const intervalElapsed = !Number.isFinite(checked) || checked + MEDIA_RECHECK_MS <= now;
  const state = slot.work.refresh;
  if (state?.leaseOwner && !expired(state.leaseUntil, now)) return false;
  if (state?.retryAfter) return due(state.retryAfter, now);
  return intervalElapsed;
}

export function claimable(slot: BrandSlot | undefined, now: number, domain?: string, role?: BrandRole): boolean {
  if (!slot?.source.url || !slot.source.fingerprint) return false;
  const work = slot.work;
  if (work.status === "PENDING") return true;
  if (work.status === "FAILED") return work.attempts < MEDIA_MAX_ATTEMPTS &&
    Boolean(work.retryAfter) && due(work.retryAfter, now);
  if (work.status === "PROCESSING") return expired(work.leaseUntil, now);
  if (work.status === "READY") return !currentReady(slot, domain, role) || refreshDue(slot, now);
  return false;
}

/** Deterministic transition done only while holding a PostgreSQL ShopBrand row lock. */
export function claimRole(document: BrandDocument, shopId: string, domain: string, role: BrandRole, owner: string, at: Date): {
  document: BrandDocument; claim: BrandClaim | null;
} {
  if (!OWNERS.test(owner) || typeof domain !== "string") throw new BrandStateError("INVALID_OBSERVATION");
  const slot = document.roles[role];
  if (!slot || !claimable(slot, at.getTime(), domain, role) || !slot.source.url || !slot.source.fingerprint) {
    return { document, claim: null };
  }
  const now = at.getTime();
  const validReady = currentReady(slot, domain, role);
  const refresh = Boolean(validReady);
  const leaseUntil = new Date(now + MEDIA_LEASE_MS).toISOString();
  // An abandoned refresh must consume its attempt budget just like a failed initial
  // processing lease. After five crashes, allow the next seven-day recheck cycle.
  if (refresh && slot.work.refresh?.leaseOwner &&
      expired(slot.work.refresh.leaseUntil, now) &&
      slot.work.refresh.attempts >= MEDIA_MAX_ATTEMPTS) {
    const work: BrandWork = { ...slot.work, lastCheckedAt: at.toISOString(),
      refresh: { ...slot.work.refresh, leaseOwner: null, leaseUntil: null,
        retryAfter: null, failureCode: "LEASE_EXHAUSTED" } };
    return { document: putRole(document, role, { ...slot, work }), claim: null };
  }
  if (!refresh && slot.work.status === "PROCESSING" && slot.work.attempts >= MEDIA_MAX_ATTEMPTS) {
    const work: BrandWork = { ...slot.work, status: "FAILED", retryAfter: null, leaseOwner: null,
      leaseUntil: null, failureCode: "LEASE_EXHAUSTED" };
    return { document: putRole(document, role, { ...slot, work }), claim: null };
  }
  let work: BrandWork;
  if (refresh) {
    const current = slot.work.refresh;
    const continuing = Boolean(current && current.attempts < MEDIA_MAX_ATTEMPTS && (
      (current.retryAfter && due(current.retryAfter, now)) ||
      (current.leaseOwner && expired(current.leaseUntil, now))));
    const attempts = (continuing ? current!.attempts : 0) + 1;
    const nextRefresh: BrandRefresh = { attempts, retryAfter: null, leaseOwner: owner,
      leaseUntil, failureCode: null };
    work = { ...slot.work, refresh: nextRefresh };
  } else {
    work = { ...slot.work, status: "PROCESSING", attempts: slot.work.attempts + 1,
      retryAfter: null, leaseOwner: owner, leaseUntil, failureCode: null };
  }
  const claimed = putRole(document, role, { ...slot, work });
  return { document: claimed, claim: { shopId, role, generation: slot.source.generation,
    fingerprint: slot.source.fingerprint, sourceUrl: slot.source.url, domain, kind: refresh ? "refresh" : "initial",
    leaseOwner: owner, leaseUntil } };
}

function putRole(doc: BrandDocument, role: BrandRole, slot: BrandSlot): BrandDocument {
  return { schemaVersion: 1, roles: { ...doc.roles, [role]: slot } };
}

export function claimStillCurrent(slot: BrandSlot | undefined, claim: BrandClaim, at: Date,
  currentDomain: string = claim.domain): slot is BrandSlot {
  if (!slot || slot.source.generation !== claim.generation ||
      slot.source.fingerprint !== claim.fingerprint || slot.source.url !== claim.sourceUrl ||
      currentDomain !== claim.domain ||
      Date.parse(claim.leaseUntil) <= at.getTime()) return false;
  const holder = claim.kind === "refresh" ? slot.work.refresh : slot.work;
  return holder?.leaseOwner === claim.leaseOwner &&
    Boolean(holder.leaseUntil) && holder.leaseUntil === claim.leaseUntil &&
    Date.parse(holder.leaseUntil) > at.getTime() &&
    (claim.kind === "refresh" ? Boolean(currentReady(slot, claim.domain, claim.role)) : slot.work.status === "PROCESSING");
}

export function completeClaim(doc: BrandDocument, claim: BrandClaim, result: BrandOutcome, at: Date,
  currentDomain: string = claim.domain): {
  document: BrandDocument; applied: boolean;
} {
  const slot = doc.roles[claim.role];
  if (!claimStillCurrent(slot, claim, at, currentDomain) ||
      result.result.sourceGeneration !== claim.generation ||
      result.result.sourceFingerprint !== claim.fingerprint ||
      !DIGEST.test(result.result.contentSha256) ||
      !["image/jpeg", "image/png"].includes(result.result.contentType) ||
      result.result.width !== 1125 || result.result.height !== 600 ||
      result.result.sizeBytes <= 0 || result.result.sizeBytes >= 5 * 1024 * 1024 ||
      result.result.objectKey !== `shop-brands/${encodeShopBrandDomain(claim.domain)}/${claim.role.toLowerCase()}/sha256-${result.result.contentSha256}.${result.result.contentType === "image/png" ? "png" : "jpg"}`) {
    return { document: doc, applied: false };
  }
  const ready: BrandReady = {
    sourceGeneration: claim.generation, sourceFingerprint: claim.fingerprint,
    objectKey: result.result.objectKey, contentType: result.result.contentType,
    width: result.result.width, height: result.result.height,
    sizeBytes: result.result.sizeBytes, contentSha256: result.result.contentSha256,
    verifiedAt: result.verifiedAt,
  };
  const work: BrandWork = { ...slot.work, status: "READY", retryAfter: null,
    leaseOwner: null, leaseUntil: null, failureCode: null, lastCheckedAt: result.verifiedAt,
    refresh: { attempts: 0, retryAfter: null, leaseOwner: null, leaseUntil: null, failureCode: null } };
  return { document: putRole(doc, claim.role, { ...slot, work, ready }), applied: true };
}

export function failClaim(doc: BrandDocument, claim: BrandClaim, code: string, retryable: boolean, at: Date,
  currentDomain: string = claim.domain): {
  document: BrandDocument; applied: boolean;
} {
  const slot = doc.roles[claim.role];
  if (!claimStillCurrent(slot, claim, at, currentDomain)) return { document: doc, applied: false };
  // Whitelist the category so provider exceptions/URLs cannot leak into JSONB.
  const failureCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNEXPECTED_FAILURE";
  if (claim.kind === "refresh") {
    const refresh = slot.work.refresh!;
    const retry = retryable && refresh.attempts < MEDIA_MAX_ATTEMPTS;
    const work: BrandWork = { ...slot.work,
      lastCheckedAt: retry ? slot.work.lastCheckedAt : at.toISOString(),
      refresh: { ...refresh, leaseOwner: null, leaseUntil: null, failureCode,
        retryAfter: retry ? new Date(at.getTime() + MEDIA_RETRY_DELAYS_MS[refresh.attempts - 1]!).toISOString() : null },
    };
    return { document: putRole(doc, claim.role, { ...slot, work }), applied: true };
  }
  const retry = retryable && slot.work.attempts < MEDIA_MAX_ATTEMPTS;
  const work: BrandWork = { ...slot.work, status: "FAILED", leaseOwner: null, leaseUntil: null, failureCode,
    retryAfter: retry ? new Date(at.getTime() + MEDIA_RETRY_DELAYS_MS[slot.work.attempts - 1]!).toISOString() : null };
  return { document: putRole(doc, claim.role, { ...slot, work }), applied: true };
}
