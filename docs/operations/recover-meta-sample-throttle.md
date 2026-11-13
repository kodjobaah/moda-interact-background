# Proven historical sample code-4 blocks

Root operator only, after accepted deployment/migration and worker drain. This separate capability never blanket-retries `META_SAMPLE_SESSION_REJECTED` or `META_SAMPLE_UPLOAD_REJECTED`. Legacy database events omit the provider code: eligibility depends on the operator truthfully attesting protected external HTTP403/numeric-code4 evidence for every exact ID in the manifest. The command hashes that protected file but does not interpret its private contents or claim database-derived proof. Retain the protected file/reference for review; never commit it or echo credentials/source bodies.

Build accepted code first. Use the actual messaging worker's trusted environment, META_APP_ID and messaging.sender WABA/configuration. At most20 unique exact IDs, no wildcards or discovery:

`node scripts/recover-meta-sample-throttle.mjs --ids ID1,ID2 --operator change:REFERENCE --messaging-worker-proof deployment:REFERENCE --external-evidence PROTECTED_FILE --evidence-reference evidence:REFERENCE --evidence-operation sample_session --attest-exact-code4`

Default plan changes nothing. Review and save only the returned manifest object and its digest. It pins exact registration updatedAt/frozen/source/reviewer identity, app/WABA/environment and protected-file SHA256/reference/exact-ID attestation. For sample_upload evidence use that exact operation; no English message matching occurs.

Revalidate without writes:

`node scripts/recover-meta-sample-throttle.mjs --manifest reviewed-throttle-manifest.json`

After explicit operator authorization, apply the exact reviewed artifact:

`node scripts/recover-meta-sample-throttle.mjs --manifest reviewed-throttle-manifest.json --apply --digest REVIEWED_DIGEST`

One serializable transaction rechecks all rows and evidence, seeds/retains a single app cooldown, atomically makes existing rows READY_TO_SUBMIT no earlier than cooldown, and appends truthful external-attestation recovery audits. It never resets existing attempts/history or shortens a cooldown, and does not increment backoff per locale. Missing-app block plus the accepted exact BG005 recovery audit is valid provenance; unknown events, claim/post/result/provider/reconciliation/drift evidence, stale/foreign/unreviewed source, active app lease, mismatched manifest/config or audit failure refuse/roll back. Same-manifest replay adds no transition/audit/cooldown extension while unchanged/unclaimed; advanced rows refuse. Existing missing-app recovery remains a separate unchanged policy.

Production sample operations use a dedicated SQL app/environment gate with fenced120second leases and a90second whole-operation deadline, checked before each HTTP phase. Numeric403/code4 starts15minute cooldown, doubling on consecutive throttles to6hours with counter saturation31. These are conservative internal settings, not a Meta reset guarantee. Genuine successful sample work resets consecutive count only under valid ownership. Other403 errors stay blocked. No sample/session/handle cache exists. Newly created registrations and other replicas respect the same persisted cooldown. Making rows due later intentionally allows ordinary guarded submission after cooldown; root owns rollout/drain/live verification.
