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

## Shop language and spoken-language transcription (Attempt 2)

New recovery conversations read `ShopSettings.defaultLanguageTag`, canonicalize it,
then persist `MERCHANT_DEFAULT`. Checkout locale, phone and country do not determine
language. An existing conversation is never reset by the upsert. Missing/invalid
shop configuration leaves the existing null fallback; no platform template locale
is enabled implicitly. Fixed platform replies use their existing English fallback.
There is no new preference setting, enum or database migration. Legacy explicit
source rows remain stored unchanged: the recovery runner receives their retained
language through trusted `resolvedConversationLanguage` context, without asserting
a customer preference; accepted substantive detection can replace it.

Substantive text or a completed transcript can switch language at confidence >=0.85,
with canonicalization and current-turn/lease checks. Ambiguous input emits null
detection. Initial templates request the approved shop-language variant; follow-ups
request the established conversation language then approved shop fallback. Template
descriptors record the language actually selected; they do not update conversation
language. No approved variant retains the existing no-template result. Country,
currency, amount, URLs and recovery policy are independent of language resolution.

Fixed store referrals cover en/fr/de/es/it/pt/nl. Other referral languages fall back
to English. Voice retry/too-long, shorter-question and routing fallback messages
remain English. These are explicit coverage limits, not universally localized
responses, and English is never recorded as a new detected conversation language.

### Gateway handoff — messaging worker only

| Variable | Allowed values / default | Credential scope |
| --- | --- | --- |
| `WHATSAPP_TRANSCRIPTION_PROVIDER` | `groq` or `openai`; omitted/blank means `groq` | Explicit selection; invalid values fail closed |
| `GROQ_TRANSCRIPTION_MODEL` | Provider model ID, default `whisper-large-v3-turbo` | Existing Groq deployment preserved |
| `GROQ_API_KEY` | Required when Groq selected | Existing messaging-worker secret |
| `OPENAI_TRANSCRIPTION_MODEL` | Provider model ID, default `gpt-4o-mini-transcribe` **only when OpenAI selected** | No automatic provider/model fallback |
| `WHATSAPP_OPENAI_API_KEY` | Required when OpenAI selected | Separate messaging-worker secret; translation-worker `OPENAI_API_KEY` is not consulted |

Model IDs must be 1–128 letters/digits/dots/underscores/hyphens, starting with a
letter/digit. Availability is provider-validated; an invalid/unsupported model
returns a bounded terminal error. Gateway should provision independent test and
production secrets/settings. Roll out to test by explicitly selecting OpenAI and
its model, perform consented provider/WhatsApp checks, then separately approve the
production change. Rollback explicitly selects `groq` with its retained credential
and model. No deployment is performed by this task and no reverse dependency on
Gateway or SYSTEM-TEST is introduced.

The adapter calls `/audio/transcriptions` with no language hint and no translation
request. It submits only the supplied byte view, matching MIME and extension-bearing
filename. Container signatures and music-metadata duration parsing run before STT.
Existing 15 MiB / 120-second limits remain; the provider request is bounded to 60
seconds and Meta requests to 30 seconds each. BullMQ's configured attempt budget is
the sole retry mechanism: only retryable failures with attempts remaining retry;
exhaustion produces the existing request-to-type response. No cross-provider retry.
Provider/model metadata is saved with the successful transcript. Raw provider
errors, credentials, audio and transcript contents are not logged.

Transcript completion and inbound-version advancement share a transaction guarded
by the pre-transcription inbound/processed versions. A newer turn makes completion
stale; a losing duplicate cannot increment another turn. The original event time is
preserved. History/current-fragment selection uses `transcriptionCompletedAt` for
audio, so delayed transcription remains current input. Pending, rejected and failed
audio stays excluded. A replay may recover an interrupted enqueue only while that
exact transcript remains the unprocessed latest turn; normal processor idempotency
and lease checks still guard admission/delivery.

### Separate audio-format and acoustic-quality evidence

On 2026-09-20, the local fixture `tests/fixtures/audio/synthetic-tone.ogg` was generated
with the already installed ffmpeg (`sine=frequency=440:duration=0.5`, libopus, 16k).
`audio-format.test.ts` parses actual Ogg/Opus bytes as `audio/ogg; codecs=opus` and
checks duration and `.ogg` filename. It is a synthetic tone, **not speech**, has no
personal data and was not sent to a provider. No conversion dependency is added.

| Quality fixture | Speech / container / MIME / duration | Provider/model | Outcome |
| --- | --- | --- | --- |
| Planned FR-VOICE-01 | Consented French WhatsApp voice note; Ogg/Opus; audio/ogg; duration to record, <=120s | OpenAI / gpt-4o-mini-transcribe | Not run: no paid/provider rehearsal authorized; language retention and material errors unmeasured |
| Planned EN-VOICE-01 | Consented English WhatsApp voice note; Ogg/Opus; audio/ogg; duration to record, <=120s | OpenAI / gpt-4o-mini-transcribe | Not run: same limitation |
| Planned GROQ-VOICE-01/02 | Same consented French/English notes | Groq / configured model | Not run: production-provider codec/quality compatibility unmeasured |

For an explicitly authorized rehearsal, record fixture ID/consent, actual container,
codec/MIME/duration, provider/model/date, conversion (none unless incompatibility is
demonstrated), detected spoken language and material errors in a protected evidence
record. Use the configured adapter, verify the persisted transcript precedes normal
agent admission and text delivery, and do not copy transcripts/secrets into runtime
logs. Do not make this a default test-suite network call.

The [OpenAI transcription reference](https://developers.openai.com/api/reference/cli/resources/audio/subresources/transcriptions/methods/create)
lists Ogg among supported inputs and recommends an identifying filename/content
type. That documentation and local parsing are not proof of live acceptance of a
particular WhatsApp recording. There is no demonstrated incompatibility requiring
conversion; deterministic provider mocks prove workflow only.
