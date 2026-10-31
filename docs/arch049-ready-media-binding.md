# ARCH-049-BACKGROUND-004 — frozen recovery IMAGE headers

## Production path

`RecoveryTemplatePreparer` continues to select only the current Moda-authored,
APPROVED, enabled, shop-assigned ARCH-047 Meta registration. For an approved IMAGE
HEADER, its frozen `parameterBindingsSnapshot` must carry exactly the Admin v1
semantic `headerMediaRole` (`LOGO`, `SQUARE_LOGO`, `COVER_IMAGE`), with `header: []`.
This role is included in the existing Admin-compatible SHA-256 prepared-content
projection, not inferred from original ShopBrand URLs or from the body text.

`ShopBrandReadyMediaAdapter` reads one `commerce.ShopBrand` record by `shopId`
using Prisma `findUnique`, selecting only `shopId` and `whatsAppMedia`. It reads
`shopBrand.publicMedia` through the existing validated Background platform
configuration reader; an absent configuration *row* uses Admin's default-on-read
policy, not an unchecked environment variable. No policy is cached across
preparation operations.

The resolver returns a constructed HTTPS URL only when the named role is
`work.status=READY`, has a non-null current source and matching source generation
and SHA-256 fingerprint, and its verified 1125×600 JPEG/PNG derivative is below
5 MiB. `objectKey` must match the full content digest, exact shop ID and role:

`shop-brands/<shopId>/<role-lowercase>/sha256-<64-hex>.<jpg|png>`

Any stale, untrusted or absent asset is a typed `MEDIA_NOT_READY` outcome. A
malformed/missing IMAGE binding is `BINDINGS_INVALID`; a changed immutable
compiled hash is `BINDING_FINGERPRINT_MISMATCH`. Operational database/configuration
exceptions are logged by the existing shared-logger preparer at a bounded
exception type and rethrown. No customer/source URLs or tokens appear in logs.

Original `shopBrand.logoUrl`, `squareLogoUrl`, and `coverImageUrl` fields remain
source metadata. When an *existing text variable* requests one of those URLs,
the runtime returns the respective validated derivative and never a raw source.
The `headerMediaRole` is a separate IMAGE-header parameter and never a TEXT
placeholder.

## Admission boundary

The result is still an ordinary ARCH-047 `PreparedRecoveryTemplate`. Its single
IMAGE header passes through `templateSendFields`, automated moderation input,
conversation/admission and provider delivery exactly as before. This adapter
does not send a WhatsApp message, inspect media over the network, create an R2
object, reserve credits or bypass consent/STOP checks or the final locked send
permit. It does not acquire an IMAGE sample handle for Meta template creation.

## Local validation

From the **dedicated Background task implementation worktree** after preparing
the pinned dependencies and recursive database submodule:

```bash
npm ci
npm run prisma:generate
npm test -- tests/unit/services/shop-brand-media-runtime \
  tests/unit/services/recovery-template-preparation \
  tests/unit/services/recovery-template-integration
node scripts/test-integration.mjs tests/integration/arch049-ready-media.integration.test.ts
npm run lint
npm run build
git diff --check
```

The integration test uses a disposable PostgreSQL instance and requires
`TEST_DATABASE_URL` and `MODA_DISPOSABLE_INTEGRATION=1` as handled by the
repository's integration runner. All three roles are covered by fixed,
Admin-fingerprint-compatible test vectors. No HTTP network call is needed for
media resolution.
