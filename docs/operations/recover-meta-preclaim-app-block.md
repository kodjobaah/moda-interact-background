# Recover a proven preclaim missing-app block

This explicit operator command repairs at most 20 exact registration IDs. It makes no Meta requests and never creates registrations, alters source/review state, resets attempts/history or activates templates. Normal worker discovery and submission guards are unchanged. The operator must first verify META_APP_ID on the actual `moda-messaging-worker` process (`src/entrypoints/messaging.ts`, which starts `startProductionMetaTemplateDuePoller`), not the merchant-communications translation worker. The manifest requires a reference to that deployment/configuration evidence; this is an operator attestation, not an automated remote-process inspection. Only the root operator may execute historical live recovery after source acceptance, trusted runtime configuration repair and confirmed English/source review. Task agents must not execute live recovery.

Build the accepted code using `npm run build`. Use the same trusted server configuration and database as the owning worker; META_APP_ID must be valid and messaging.sender must resolve the intended WABA and credential. Do not pass credentials through CLI arguments. Apply makes rows due: the normal worker may subsequently submit them, so coordinate the reviewed cohort with the worker operator.

1. Plan with exact reviewed IDs and a bounded operator/change reference:

   `node scripts/recover-meta-preclaim-app-block.mjs --ids ID1,ID2 --operator change:REFERENCE --messaging-worker-proof deployment:REFERENCE`

   Default is read-only. The JSON response contains a manifest and SHA-256 digest; save only its `manifest` object to a restricted immutable review artifact. It includes exact IDs, WABA/app IDs, expected updatedAt and hashes of frozen transport/current reviewed source identities, with no template bodies or secrets. Review all IDs and the trusted configuration before apply. No wildcard or discovery mode exists.

2. Revalidate the saved artifact without mutation:

   `node scripts/recover-meta-preclaim-app-block.mjs --manifest reviewed-manifest.json`

3. Only after operator authorization, apply that exact artifact and digest:

   `node scripts/recover-meta-preclaim-app-block.mjs --manifest reviewed-manifest.json --apply --digest REVIEWED_DIGEST`

The transaction locks exact rows/current source, checks historical matching SUBMISSION_BLOCKED evidence and refuses all other event types, provider IDs/submission timestamps, stale snapshots, wrong WABA/configuration, unreviewed/retired source or other failure reasons. It preserves history and atomically appends PRECLAIM_APP_RECOVERY with the full reviewed manifest/digest while making rows READY_TO_SUBMIT/due. The batch rolls back on any refusal/audit failure/CAS or serialization conflict. Review changed facts and create a fresh plan after a conflict; there is no automatic retry. Replaying the identical applied manifest reports already-applied and adds no audit or transition while the recovered row is still unchanged and unclaimed. If normal processing has advanced the row, replay refuses without mutation. Do not use this command for uncertain or submitted creations.
