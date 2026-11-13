# Meta sample upload session identity

The resumable upload response's `id` is an opaque Upload-ID. Meta's own
[session creation documentation](https://www.postman.com/meta/whatsapp-business-platform/request/vkmioqf/resumable-upload-create-an-upload-session)
instructs callers to reuse the server-generated value in the
[file data request](https://www.postman.com/meta/whatsapp-business-platform/request/jruartu/resumable-upload-upload-file-data).
Do not strip its signed query or rebuild it with a query encoder.

A protected production diagnostic on 2026-11-13 returned HTTP 200 with an
object containing one `id` string: `upload:`, 180 alphanumeric characters,
`?sig=`, then 19 alphanumeric characters (211 total). Only that structure is
reproduced in tests; no real identifier or signature is retained in this repo.
The previous identifier-only validator refused this response before byte upload.

The uploader accepts its existing unsigned form and an optional single `sig`
suffix. The opaque path remains 8–256 URL-safe alphanumeric/underscore/hyphen
characters; the signature is bounded to 1–256 of those characters. Other query
keys, repeated queries, percent escapes, fragments, controls, slashes, dots and
backslashes are refused. This is deliberately narrower than accepting arbitrary
URLs or assuming every Base64 representation is supported.

The resulting URL must preserve the exact returned identity and remain on the
configured Graph origin and `/vN.N` namespace, without credentials, fragments or
URL-parser normalization. Both source and byte upload retain the existing
configuration checks, fenced app lease, deadlines and `beforeHttp` checks. Upload
errors redact the identifier, opaque path and signature before diagnostics are
projected through the existing logger. No raw successful provider response is
logged.

An invalid session is still an uncertain **preclaim** failure. It cannot create a
template or bypass CREATE/POST intent fencing. Existing retry scheduling handles
that state after compatible runtime deployment. Historical HTTP 403/code-4
blocks require the separate exact-evidence procedure in
[recover-meta-sample-throttle.md](recover-meta-sample-throttle.md); this change
does not reset those records or add another recovery capability.
