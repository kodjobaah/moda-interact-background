# Single-bubble recovery replies

`RECOVERY_COMPOSITE_REPLY_ENABLED` enables new composition only when its value is exactly `true`. Absent, false and unrecognised values retain the existing writer. `RECOVERY_BRANDED_MAIN_REPLY_ENABLED` keeps its existing meaning. Both legacy and composite frozen plans remain readable regardless of either writer flag.

A composite has one existing logical message root and one `HEADER` delivery part. The bitmap contains the trusted shop logo, canonical shop header and optional first-presented verified product. The physical caption is the exact canonical answer followed by the canonical checkout footer. The full canonical header, answer and footer remain the root content and moderation/history identity. Above 1024 caption codepoints, missing/invalid media, unavailable fonts, or exhausted optional budget produce one complete canonical TEXT reply. Authored URLs and whitespace are preserved.

Preparation uses the accepted Shared Node renderer, immutable R2 writer and public byte probe. Background records an independent host receipt for the logo, verified product facts/first pair, font/render identity and output digest. AI and HUMAN application identities bind that receipt and plan; the final existing dispatch fence checks canonical source/control/moderation, current logo generation and public-media policy plus frozen product proof. Product context is still committed once at ordinal zero. No live commerce/network request runs inside the final database transaction.

All optional media stages share one bounded child signal/deadline (at most five seconds, within the original authority deadline). AI passes the original processing claim deadline bounded by the Commerce host deadline. Fresh HUMAN preparation reads its actual claimed-command lease expiration. Prepared HUMAN replay and frozen root repair use the original immutable receipt; they do not regenerate media or replace the original runtime/font identity.

## Reader-first rollout

1. Keep the composite writer OFF while deploying the new reader to all processes that consume `whatsapp-events`, HUMAN commands, or multipart repair/status jobs.
2. Observe `whatsapp.worker.started.data.recoveryCompositeReplyEnabled=false` on each replacement and confirm predecessor instances have drained before enabling the writer. Do not delete pending/unknown jobs or rewrite frozen plans.
3. The production entrypoint is `src/entrypoints/messaging.ts`: it starts the WhatsApp worker, HUMAN dispatcher and multipart repair. The legacy `src/index.ts` also starts the WhatsApp worker/HUMAN dispatcher and must be included if deployed. Other dedicated entrypoints do not start those consumers. The boolean is emitted by the existing WhatsApp worker-start event, so it covers either entrypoint.
4. Root/operator owns eventual test/production activation and live verification. Verify exact `true` startup proof and real delivered image/caption before claiming live success. Gateway owns deployment declarations and activation procedure.
5. Rollback disables only new composite writes; retain compatible readers until all newer frozen roots, including UNKNOWN outcomes, are resolved under their existing lifecycle. Never resend an uncertain provider request.

This source checkpoint is prepared against the exact accepted 5.13.11 package archive. The public-registry dependency/lock and clean npm-ci gate must be reconciled after the separately authorised release; an unpublished draft is not deployment-ready. Native Meta template definitions and registrations are unchanged.
