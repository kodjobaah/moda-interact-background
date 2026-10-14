# ARCH-036 Woo coupon synchronisation operations

The recovery deployment starts **one global PostgreSQL-leased dispatcher** shared across replicas (`WOO_COUPON_SYNC_DISPATCH`, fixed 60-second lease cadence). Each successful dispatch reserves no more than one configured batch of due Woo shops and emits one-off BullMQ jobs. A pool of shop-scoped workers handles independent full-catalogue reads. No per-shop recurring timers or schedules are created.

## Configuration

All numeric overrides are strictly validated at process/service construction. Missing values take the defaults. Invalid values fail fast; they do not silently fall back. The 60-second global lease cadence remains fixed in the existing PostgreSQL lease service.

| Environment variable | Default | Allowed | Meaning |
|---|---:|---:|---|
| `WOO_COUPON_SYNC_DISPATCH_BATCH_SIZE` | 500 | 1–500 | Maximum reserved/enqueued shop jobs per tick; bounds discovery pages |
| `WOO_COUPON_SYNC_REFRESH_MINUTES` | 30 | 1–1440 | Minimum age since last successful full scan before another refresh |
| `WOO_COUPON_SYNC_DISPATCH_COOLDOWN_MINUTES` | 5 | 1–120 | Minimum time before a shop can be redispatched, including lost Redis publication |
| `WOO_COUPON_SYNC_UNAVAILABLE_RECHECK_MINUTES` | 30 | 1–1440 | Minimum time before a grant/permission-unavailable shop is eligible again |
| `WOO_COUPON_SYNC_STALE_SCAN_MINUTES` | 15 | 1–120 | Maximum age of a shop `SYNCING` claim before its generation may be replaced |
| `WOO_COUPON_SYNC_MAX_PAGES` | 50 | 1–200 | Maximum complete pages, each with up to 100 coupons; exceeding limit fails the scan |
| `WOO_COUPON_SYNC_REQUEST_TIMEOUT_MS` | 8000 | 1000–30000 | Per Woo HTTP request deadline |
| `WOO_COUPON_SYNC_MAX_RESPONSE_BYTES` | 1048576 | 16384–4194304 | Maximum bytes per Woo response |
| `WOO_COUPON_SYNC_MAX_SCAN_DURATION_MS` | 120000 | 30000–600000 | Maximum overall elapsed time for successful pagination; abort before committing any partial scan |
| `WOO_COUPON_SYNC_WORKER_CONCURRENCY` | 4 | 1–32 | BullMQ concurrency per recovery worker process (existing validation) |

The provider HTTP client pins DNS and rejects redirects, uses Basic credentials **only over verified HTTPS**, and allows signed local-development HTTP only outside production. No provider URL or key is accepted from a queue job.

## Credential wiring

Background reads Woo grant decryption keys from the shared `COMMERCE_CONNECTION_KEYS_JSON` JSON object mapping safe key IDs (1-128 characters) to canonical standard-base64 encodings of 32-byte AES keys. API-007 still seals grants using its `MODA_WOO_REST_READ_KEYRING` base64url format. For every Woo grant key ID, configure the identical 32-byte key material and ID in both settings, encoded according to each variable's format; retain old keys in both keyrings while grants reference them. Do not store key material in source control. The shared keyring and `MODA_WOOCOMMERCE_CONNECTION_MODE` are validated at the Background worker boundary. Only the existing API authorisation service can create/rotate the sealed grant. The worker validates installation, tenant, `authorizedScope=read`, authorization attempt, credential version and rotation before/after reads.

## Observability and failure recovery

The shared structured logger emits `woo.coupon_sync.dispatch_cycle` with **observed** counts `cataloguesCreated` (rows created), `discovered` (missing-installation rows returned), `reserved` (rows returned by the atomic reservation statement), and `published` (jobs acknowledged by the publication call). It separately reports `backlog` (due rows counted by a **post-reservation**, point-in-time SQL query), `oldestDueSeconds` (an approximate age derived from the catalogue's last success or creation timestamp), and `dueEstimate` (`reserved + backlog` **only when backlog is available**; otherwise `null`). Because reservation and backlog use different database snapshots, `dueEstimate` must not be interpreted as an exact scan count or a consistent count of due shops. In particular, the dispatcher does **not** measure how many SQL rows were scanned/considered or how many shops were skipped, so it must not emit `scanned` or `skipped` fields. The figures are not a production freshness guarantee. If telemetry SQL or the logger fails, dispatch behavior must remain unchanged. The entrypoint emits `woo.coupon_sync.dispatch_failed` without provider response bodies, credentials, or full URLs.

`CURRENT` means a complete scan was successfully reconciled; `UNAVAILABLE` indicates a missing or unusable grant; `ERROR` indicates provider/transport/normalisation failure; a stale `SYNCING` claim is eligible for takeover only after its timeout. Merchant selections are preserved even when a coupon becomes unavailable. Coupons are confirmed `REMOVED` only after two **successful** complete scans omit them. Errors, skips and partial scans do not confirm removal.

The 30-minute shop interval is a **target**; actual freshness is bounded by queue lag, provider latency, retry cooldown and worker capacity. No 10,000-shop benchmark is required by ARCH-036.
