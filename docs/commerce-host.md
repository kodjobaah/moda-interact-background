# CommerceAgent host (ARCH-020-BACKGROUND-001)

The WhatsApp worker calls the Shared runner after existing turn, abuse and outbound admission. No local product tool or standalone agent fallback is used. Initial/follow-up outreach still uses its existing recovery conversation and does not resolve a grant.

## Configuration

Configure these only on the messaging worker:

- `COMMERCE_MCP_URL`: fixed private Commerce URL ending in `/api/mcp`. No credentials, query or fragment. HTTP is supported for the private service network; redirects are rejected.
- `COMMERCE_ASSERTION_KEY_ID`: the configured Commerce verification-key identifier.
- `COMMERCE_ASSERTION_PRIVATE_KEY`: PEM RSA private key, at least 2048 bits. Keep this in service secrets, never in Studio, model context or logs.
- `DEPLOYMENT_ENVIRONMENT_NAME`: existing shared environment identity; match Commerce.
- Existing `GROQ_COMMERCE_MODEL`/provider credentials and single Moda WhatsApp sender configuration remain required.

Assertions use RS256, `iss=moda-background`, `sub=moda-messaging-worker`, `aud=moda-commerce`, a 120-second expiry and trusted turn identity. Resolve assertions have no grant selector. Execute assertions carry the persisted grant and release IDs. The original grant survives retries and worker restarts; current revocation may only reduce its usable tools. A new release cannot expand it.

Shared is pinned to 0.13.1, runner 1.0.0, MCP SDK client/server to 1.30.0. The local interoperability test uses the Commerce foundation's WebStandard stateless JSON transport profile and verifies protocol 2025-11-25. This proves client/server SDK compatibility, not a deployed Commerce service or live provider.

## Bounds and delivery

Each request is bounded to 10 seconds, 128 KiB input and 256 KiB decoded output. The complete host turn has a 90-second deadline including discovery. Shared enforces 12 model steps, 10 remote tool calls and 800 output tokens per model invocation; the provider adapter disables automatic retries. Tool authority is rechecked using execute-purpose `tools/list` and again by Commerce on calls.

Prior same-conversation history contains at most 20 eligible messages. Current fragments remain separate in trusted context so Shared's 20-history-entry bound does not drop them. Combined serialized history/current input is bounded to 32,000 Unicode code points, dropping oldest prior entries. Oversized current input takes the admitted fixed shorter-question path without grant/model work. Template records are explicitly labelled as recorded automation context, not verbatim delivered copy. Pending/rejected/failed transcription, unsupported content and outbound records without `sentAt` are excluded.

Only the stable response envelope leaves the host; custom `details` never enter WhatsApp delivery. Referrals ignore model contact text and use the owner Shop.domain. Fixed referral copy supports English, French, German, Spanish, Italian, Portuguese and Dutch; other locales currently fall back to English. This translation coverage is an explicit review limitation, not a claim of universal localization.

Discount evidence extraction and pre-send re-evaluation belong to BACKGROUND-002. This host does not register evidence for delivery: a final naming evidence absent from Shared's actual turn map is rejected. Do not interpret this task as authorization to launch discount delivery before that task is accepted.

## Local evidence

`npm run build` generates Prisma from the pinned database submodule and compiles the implementation. Focused Vitest fixtures under `tests/integration/commerce/` use synthetic manifests, scripted model steps, a local HTTP server and mocked persistence. No model, Shopify, WhatsApp or shared database is contacted. These fixtures verify host enforcement and instruction/context composition; they do not prove semantic compliance of an arbitrary live model.

The completion report records the exact fixture matrix and results. Deployment topology, key provisioning, live providers and architecture system tests remain separate tasks; this implementation must not silently redirect to a local product tool if configuration or MCP is unavailable.
