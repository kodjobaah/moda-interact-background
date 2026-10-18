# ARCH-043-BACKGROUND-002 — Consumer Migration Review Matrix

This file records code paths introduced in the implementation candidate; it is **not** a Completion Report or architect acceptance. Configuration source is BACKGROUND-001's typed service, backed by the trusted deployment environment and fresh PostgreSQL reads. There is no application configuration cache.

| Existing consumer | Canonical PostgreSQL key | Operation boundary | Test/proof |
|---|---|---|---|
| Recovery Woo dispatcher | `woo.couponSync` | Each leased dispatch cycle | Platform consumer snapshot unit test; local leased scheduler regression required |
| Woo catalogue worker + transport | `woo.couponSync` | Each claimed Woo sync job | Platform consumer snapshot unit test; existing Woo catalogue/worker regressions required |
| Woo read grant decryption | `commerce.connectionKeys` | After grant validity checks, before AEAD decryption | Existing Woo grant integrity regressions require rerun |
| Merchant Knowledge uploaded assets | `merchant.knowledge.r2` | Each asset acquisition | Platform consumer snapshot unit test; actual R2/acquisition integration required |
| Merchant Knowledge orphan cleanup | `merchant.knowledge.r2` | Each cleanup scheduler iteration | Existing cleanup integration required |
| Merchant Knowledge embeddings | `commerce.connectionKeys` | Each source-processing job | Existing embedding runtime tests require rerun |
| WhatsApp speech | `speech.transcription`, `ai.providers` | One bundled read for each transcription | Platform consumer bundle unit test; speech provider unit regressions required |
| Shopify OAuth refresh | `shopify.oauth` | Each expired session refresh | Existing session refresh regressions required |
| Shopify Partner billing | `shopify.partner` | Each Partner GraphQL operation | Existing Partner unit tests require rerun |
| Shopify App Events | `shopify.appEvents` | Each claimed billing event, new client per event | Existing token refresh + publisher tests require rerun |
| WhatsApp outbound text and template | `messaging.sender` | One full sender tuple for each send | Existing sender/send integration regressions required |
| WhatsApp media download | `messaging.sender` | One token read per media download | Existing media unit tests require rerun |
| Commerce agent/OpenRouter | `commerce.connectionKeys` | Each Commerce model invocation | Existing Commerce agent tests require rerun |
| Store-category/merchant-pricing translation credential resolvers | `commerce.connectionKeys` | Each provider operation | Existing translation tests require rerun |
| Support translation model selection | Existing `CommerceTranslationModelConfiguration` automatic default | Each newly assembled batch, persists provider/model | Existing batch assembly concurrent tests require rerun |
| Support translation provider credential | Existing `CommerceTranslationProviderCredential` | Each submit/poll/results operation | Existing support translation lifecycle tests require rerun |

## Deployment/cutover caveats

- Woo worker concurrency is fixed at BullMQ worker construction; a policy edit requires a worker restart/recreation. No claim of live mutation is made.
- No `merchantKnowledge.upload`, `support.translation`, or speech-only provider key aliases are introduced.
- Shopify App Events bearer reuse is bounded to a single claimed event; next event constructs a new client to honour revocation, even when the previous token has no expiry timestamp.
- No environment variable cleanup in Render is authorised in this task.
- Existing opaque ciphertext and AAD formats are unchanged.
- This candidate must not be marked Complete until the local full test suite, disposable PostgreSQL integration and any reviewed test updates pass. In particular, tests relying on synchronous `resolveSender` / `getProviderAccountId` or old environment-backed provider fixtures must be reconciled before acceptance.

## Audit correction — support reconciliation and legacy runtime configuration

- `SUBMISSION_UNKNOWN` support-translation reconciliation now resolves its credential
  from `CommerceTranslationProviderCredential` through the existing sealed Commerce
  credential resolver on each attempt. Persisted batch provider/model are not changed.
  A missing or revoked row fails before constructing an OpenAI client; even a valid
  legacy `OPENAI_API_KEY` cannot override revocation. Failures emit only a bounded
  code and batch identity through the Shared logger.
- An explicit empty `apiKey` supplied to the translation provider no longer invokes
  environment fallback. Legacy provider helper calls without an explicit key remain
  compatibility-only; deployed consumer calls must provide their DB-resolved key.
- Production Woo worker entrypoint must supply DB-derived concurrency. The worker
  constructor no longer obtains implicit concurrency from environment. Explicit
  injected catalogues used by unit/integration fixtures remain self-contained.
- The Background `commerce.connectionKeys` consumer uses the credential keyring for
  encryption/decryption; the `commandHmacKey` field is not currently required by an
  identified Background operation. Do not fabricate a command-signing consumer.
- `omini.moderation` is registered but is not invoked by this task; its consumer
  remains `ARCH-040-BACKGROUND-006`.
- Legacy R2, App Events, Woo, and Woo grant parse helpers now require a caller-
  supplied environment object. No deployed caller invokes these compatibility
  utilities, and none implicitly reads `process.env`. Unit tests pass synthetic
  objects explicitly; the default deployed adapters exclusively read PostgreSQL.
