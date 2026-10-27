# ARCH-049-BACKGROUND-001 — isolated ShopBrand image processor

This processor is a reusable internal Background service, **not** an HTTP route or
BullMQ worker. `createProductionShopBrandMediaProcessor().process(...)` accepts a
trusted BG002 source observation `(shopId, role, sourceUrl, sourceFingerprint,
sourceGeneration)`; it does not read or mutate `ShopBrand`, source generations,
leases, or the private Merchant Knowledge bucket. BG002 will own those operations.

## Invariants

- Only pinned, publicly routable HTTPS destinations; three redirects maximum,
  one 10-second deadline; rejects credentials, private/metadata destinations,
  rebinding, non-443 ports, content-encoding and more than 10 MiB of source bytes.
- libvips/Sharp decodes **actual bytes** (not URL suffix or source MIME), with a
  40-million-pixel input limit. Output is a 1125×600 JPEG or transparent PNG,
  with logo fit/pad and cover centre-crop, stripped of source metadata, re-decoded
  and independently SHA-256 checked. Encoded output must be **below** 5 MiB.
- Each object key is `shop-brands/<shopId>/<role-lowercase>/sha256-<digest>.jpg|png`.
  Conditional writes prevent mutation; existing objects can be reused only after
  a matching R2 HEAD. `Cache-Control: public, max-age=31536000, immutable`.
- No READY metadata is returned until a pinned **public HTTPS GET** from the
  configured custom domain delivers the same media MIME, byte length and digest.
  R2 HEAD is not a substitute for live delivery verification.
- The Admin-owned **non-secret** `shopBrand.publicMedia` policy supplies public
  origin and bucket name; missing rows produce the approved default at revision
  zero **without database writes**. This is independent of `merchant.knowledge.r2`.
- Worker credentials are provided **only** through
  `SHOPBRAND_R2_ENDPOINT`, `SHOPBRAND_R2_ACCESS_KEY_ID`, and
  `SHOPBRAND_R2_SECRET_ACCESS_KEY`. Invalid values fail the protected operation
  and generate a safe shared-logger reason code. Never include these values,
  untrusted source URLs or original image bytes in diagnostics.

## Operational prerequisite — external preflight not established in snapshot

Before enabling BG002 or claiming live media delivery readiness:

1. Confirm in Cloudflare that the existing R2 custom domain is **Active**, not
   Initializing, and that the zone's minimum TLS version is **at least 1.2**.
   Enforcing TLS ≥1.2 on the fetch client does not prove the Cloudflare zone has
   disabled TLS 1.0/1.1.
2. Configure the three dedicated worker-only R2 environment variables in the
   worker secret store, never source control. Confirm the credentials have
   bucket-scoped `PutObject` and `HeadObject` permissions.
3. Run an isolated image processor invocation with a permitted brand source.
   The processor must verify the current public HTTPS domain returns HTTP 200,
   correct JPEG/PNG Content-Type, and the exact uploaded bytes/hash. A previous
   screenshot or a successful R2 upload alone is insufficient.
4. Disable the public `r2.dev` endpoint when no longer required for development,
   and retain immutable derivatives as specified by ARCH-049.

## Validation and ownership

Focused tests: `npx vitest run tests/unit/services/shop-brand-media
 tests/unit/services/platform-configuration/service.test.ts`
from `moda-interact-background`, followed by its declared `lint`/`build` scripts.
No cross-repository deployment, schema migration, provider source acquisition,
message sending, or R2 infrastructure provisioning is part of BACKGROUND-001.
