import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claimRole, claimable, completeClaim, currentReady, effectiveFingerprint,
  failClaim, parseBrandDocument, updateObservedSource,
} from "../../../../src/services/shop-brand-media-orchestration/state.js";
import { MEDIA_RECHECK_MS, MEDIA_LEASE_MS, type BrandDocument, type BrandClaim,
} from "../../../../src/services/shop-brand-media-orchestration/contracts.js";

const SHOP = "shop_123";
const DOMAIN = "merchant.myshopify.com";
const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);
const FINGERPRINT = `sha256:${DIGEST}`;
const FIRST = new Date("2026-10-01T00:00:00.000Z");
const after = (ms: number) => new Date(FIRST.getTime() + ms);
const observation = (role: "LOGO" | "COVER_IMAGE" = "LOGO", url: string | null = "https://merchant.test/logo.jpg", at = FIRST) => ({
  shopId: SHOP, role, sourceUrl: url, sourceReference: "shopify:brand", sourceFingerprint: url ? FINGERPRINT : null,
  observedAt: at.toISOString(),
});
function initial(doc: BrandDocument = parseBrandDocument({})): BrandDocument {
  return updateObservedSource(doc, observation()).document;
}
function claim(doc: BrandDocument, at = after(10), owner = randomUUID()) {
  return claimRole(doc, SHOP, DOMAIN, "LOGO", owner, at);
}
function output(c: BrandClaim, digest = DIGEST) {
  return { verifiedAt: after(20).toISOString(), result: {
    sourceGeneration: c.generation, sourceFingerprint: c.fingerprint,
    contentSha256: digest, objectKey: `shop-brands/${SHOP}/logo/sha256-${digest}.jpg`,
    contentType: "image/jpeg" as const, width: 1125, height: 600, sizeBytes: 1024,
  } };
}
function ready(): BrandDocument {
  const { document: processing, claim: token } = claim(initial());
  return completeClaim(processing, token!, output(token!), after(20)).document;
}

describe("ARCH-049 ShopBrand source/update/claim state machine", () => {
  it("produces canonical fingerprints across services when upstream digest is absent", () => {
    expect(effectiveFingerprint("https://example.test/a.png", null, null)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(effectiveFingerprint("https://example.test/a.png", null, null)).toBe(
      effectiveFingerprint("https://example.test/a.png", null, null));
    expect(() => effectiveFingerprint("https://example.test/a.png", null, "sha256:bad")).toThrow();
  });

  it("initialises JSONB v1, preserves other roles and ignores older/equal observations", () => {
    const a = initial();
    const b = updateObservedSource(a, observation("COVER_IMAGE", "https://merchant.test/cover.jpg", after(100))).document;
    expect(b.roles.LOGO!.source.generation).toBe(1);
    expect(b.roles.COVER_IMAGE!.source.generation).toBe(1);
    const noChange = updateObservedSource(b, observation("LOGO", "https://merchant.test/logo.jpg", after(1)));
    expect(noChange.changed).toBe(false);
    expect(noChange.document.roles.LOGO!.source.generation).toBe(1);
    const old = updateObservedSource(b, observation("LOGO", "https://merchant.test/changed.jpg", FIRST));
    expect(old.document).toBe(b);
    const changed = updateObservedSource(b, observation("LOGO", "https://merchant.test/new.jpg", after(500)));
    expect(changed.changed).toBe(true);
    expect(changed.document.roles.LOGO!.source.generation).toBe(2);
    expect(changed.document.roles.COVER_IMAGE).toEqual(b.roles.COVER_IMAGE);
    const changedDigest = updateObservedSource(b, {
      ...observation("LOGO", "https://merchant.test/logo.jpg", after(600)),
      sourceFingerprint: `sha256:${OTHER}`,
    });
    expect(changedDigest.document.roles.LOGO!.source.generation).toBe(2);
  });

  it("source removal revokes READY and increments generation without deleting historical ready", () => {
    const old = ready();
    const missing = updateObservedSource(old, observation("LOGO", null, after(50))).document;
    expect(missing.roles.LOGO!.source.generation).toBe(2);
    expect(missing.roles.LOGO!.work.status).toBe("MISSING");
    expect(missing.roles.LOGO!.ready).toEqual(old.roles.LOGO!.ready);
    expect(currentReady(missing.roles.LOGO!)).toBeNull();
    const restored = updateObservedSource(missing, observation("LOGO", "https://merchant.test/logo.jpg", after(100))).document;
    expect(restored.roles.LOGO!.source.generation).toBe(3);
    expect(restored.roles.LOGO!.work.status).toBe("PENDING");
    expect(currentReady(restored.roles.LOGO!)).toBeNull();
  });

  it("rejects unknown document schema to avoid destructive downgrade", () => {
    expect(() => parseBrandDocument({ schemaVersion: 2, roles: {} })).toThrow("UNSUPPORTED_SCHEMA");
  });

  it("enforces one lease, stale owner, expired lease and later source generation", () => {
    const first = claim(initial());
    expect(first.claim?.kind).toBe("initial");
    expect(first.claim?.domain).toBe(DOMAIN);
    expect(claim(first.document).claim).toBeNull();
    const staleOwner = { ...first.claim!, leaseOwner: randomUUID() };
    expect(completeClaim(first.document, staleOwner, output(staleOwner), after(20)).applied).toBe(false);
    const crossTenant = output(first.claim!);
    crossTenant.result.objectKey = `shop-brands/another_shop/logo/sha256-${DIGEST}.jpg`;
    expect(completeClaim(first.document, first.claim!, crossTenant, after(20)).applied).toBe(false);
    const expired = completeClaim(first.document, first.claim!, output(first.claim!), after(MEDIA_LEASE_MS + 15));
    expect(expired.applied).toBe(false);
    const newest = updateObservedSource(first.document, observation("LOGO", "https://merchant.test/new.png", after(30)));
    expect(completeClaim(newest.document, first.claim!, output(first.claim!), after(40)).applied).toBe(false);
    expect(newest.document.roles.LOGO!.source.generation).toBe(2);
  });

  it("recovers crashed leases and stops claiming after five attempts", () => {
    let doc = initial();
    for (let i = 0; i < 5; i++) {
      const next = claim(doc, after(i * (MEDIA_LEASE_MS + 1)));
      expect(next.claim?.kind).toBe("initial");
      expect(next.document.roles.LOGO!.work.attempts).toBe(i + 1);
      doc = next.document;
    }
    const exhausted = claim(doc, after(5 * (MEDIA_LEASE_MS + 1)));
    expect(exhausted.claim).toBeNull();
    expect(exhausted.document.roles.LOGO!.work.status).toBe("FAILED");
    expect(exhausted.document.roles.LOGO!.work.retryAfter).toBeNull();
    expect(exhausted.document.roles.LOGO!.work.failureCode).toBe("LEASE_EXHAUSTED");
  });

  it("retries transient failures on 1m/5m/30m/2h without an infinite sixth attempt", () => {
    let doc = initial();
    const expected = [60_000, 300_000, 1_800_000, 7_200_000];
    let time = after(10);
    for (let i = 0; i < 5; i++) {
      const next = claim(doc, time);
      expect(next.claim).not.toBeNull();
      const failedAt = new Date(time.getTime() + 10);
      const failure = failClaim(next.document, next.claim!, "SOURCE_TIMEOUT", true, failedAt);
      expect(failure.applied).toBe(true);
      expect(failure.document.roles.LOGO!.work.failureCode).toBe("SOURCE_TIMEOUT");
      expect(failure.document.roles.LOGO!.work.retryAfter).toBe(i === 4 ? null : new Date(failedAt.getTime() + expected[i]!).toISOString());
      doc = failure.document;
      time = new Date(failedAt.getTime() + (expected[i] ?? 300_000));
    }
    expect(claim(doc, time).claim).toBeNull();
  });

  it("treats permanent errors as terminal immediately and sanitises failure codes", () => {
    const next = claim(initial());
    const failed = failClaim(next.document, next.claim!, "https://source.example/?token=private", false, after(20));
    expect(failed.document.roles.LOGO!.work).toMatchObject({ status: "FAILED", retryAfter: null,
      failureCode: "UNEXPECTED_FAILURE" });
  });

  it("holds verified READY during refresh, replaces changed content and retains identical keys", () => {
    const document = ready();
    const before = document.roles.LOGO!.ready;
    expect(claimable(document.roles.LOGO!, after(MEDIA_RECHECK_MS - 1).getTime())).toBe(false);
    const refresh = claim(document, after(MEDIA_RECHECK_MS + 30));
    expect(refresh.claim?.kind).toBe("refresh");
    expect(currentReady(refresh.document.roles.LOGO!)).toEqual(before);
    const same = completeClaim(refresh.document, refresh.claim!, output(refresh.claim!), after(MEDIA_RECHECK_MS + 40));
    expect(same.applied).toBe(true);
    expect(same.document.roles.LOGO!.ready!.objectKey).toBe(before!.objectKey);
    const refresh2 = claim(same.document, after(2 * MEDIA_RECHECK_MS + 70));
    const changed = completeClaim(refresh2.document, refresh2.claim!, output(refresh2.claim!, OTHER), after(2 * MEDIA_RECHECK_MS + 80));
    expect(changed.document.roles.LOGO!.ready!.contentSha256).toBe(OTHER);
    expect(changed.document.roles.LOGO!.ready!.objectKey).not.toBe(before!.objectKey);
  });

  it("refresh transient failures preserve READY and reattempt while restricting new leases", () => {
    const document = ready();
    const refresh = claim(document, after(MEDIA_RECHECK_MS + 30));
    const failed = failClaim(refresh.document, refresh.claim!, "SOURCE_TIMEOUT", true, after(MEDIA_RECHECK_MS + 40));
    expect(currentReady(failed.document.roles.LOGO!)).not.toBeNull();
    expect(failed.document.roles.LOGO!.work.refresh?.retryAfter).not.toBeNull();
    expect(claim(failed.document, after(MEDIA_RECHECK_MS + 41)).claim).toBeNull();
    expect(claim(failed.document, after(MEDIA_RECHECK_MS + 60_040)).claim?.kind).toBe("refresh");
  });

  it("expired refresh leases count towards maximum and keep current READY eligible", () => {
    let doc = ready();
    for (let i = 0; i < 5; i++) {
      const at = after(MEDIA_RECHECK_MS + 100 + i * (MEDIA_LEASE_MS + 1));
      const next = claim(doc, at);
      expect(next.claim?.kind).toBe("refresh");
      expect(next.document.roles.LOGO!.work.refresh!.attempts).toBe(i + 1);
      doc = next.document;
    }
    const exhausted = claim(doc, after(MEDIA_RECHECK_MS + 100 + 5 * (MEDIA_LEASE_MS + 1)));
    expect(exhausted.claim).toBeNull();
    expect(exhausted.document.roles.LOGO!.work.refresh!.failureCode).toBe("LEASE_EXHAUSTED");
    expect(currentReady(exhausted.document.roles.LOGO!)).not.toBeNull();
    expect(claim(exhausted.document, after(MEDIA_RECHECK_MS + 100 + 5 * (MEDIA_LEASE_MS + 1) + 10)).claim).toBeNull();
  });
});
