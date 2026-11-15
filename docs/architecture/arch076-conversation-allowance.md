# Funded allowance inside one checkout conversation

`ConversationAllowanceBlock` is a funding boundary, not another conversation. A checkout keeps the same Conversation, transcript, inbound ordering and lifetime UsageEvents.

The ordinary budget is the saved `hardMessageLimit - terminalReservedSlots`. A full budget leaves the current block ACTIVE and emits one merchant SYSTEM notice using its conversation/ordinal source key. The notice itself does not buy a credit or consume an automated slot.

## One opening action

A genuine, still-unprocessed AI customer turn may create one PENDING successor. Its immutable block ID supplies the continuation billing identity `recovery-continuation:<blockId>`. The existing billing owners select and reserve Free, promotional, paid included or purchased credit. A genuine sequence-two recovery template instead binds its existing `recovery-outreach:<attemptId>` reservation; it never buys a second continuation credit.

The PENDING row exists before reservation I/O. A token and lease fence the later reservation bind. Repair recovers a reservation created before a crash from that exact action identity. It does not reconstruct a credit from the current plan. No-credit work retains the pending customer turn and uses the existing repair cadence. Human text, clarification and opt-out do not create continuation funding.

Each new automated message is pinned to its block at INSERT. Usage remains the existing exact message UsageEvent. A genuine human sequence-two template has one such opening event while retaining its HUMAN transcript actor; ordinary human text has none. Original historical messages retain NULL pins and belong only to the adopted initial block's accounting.

## Final decision and settlement

Immediately before the irreversible provider permit, the owner lock protects a fresh read of the predecessor's surviving charged/reserved UsageEvents. If an old failure freed a normal slot, the pending credit is released, the unsent prepared row remains in cancelled lineage, and the same inbound version retries with a fresh row using the old ACTIVE capacity. Message pins are never rewritten.

After an opening permit, its funding choice is frozen. Provider-unknown work stays PENDING and is never resent or refunded merely because a lease or deadline expired. A confirmed exact opening receipt and committed credit activate the successor atomically. The predecessor becomes EXHAUSTED for a continuation or CLOSED for a genuine follow-up.

A definitive failed opening can cancel/release before activation. A late opening failure can compensate only if no other message in that block has provider-admitted evidence. Otherwise the existing compensation owner preserves the credit and reports the lineage incident. Eligible cancellation retains the block/reservation/message evidence; a retry gets a new monotonic ordinal and verifies the cancelled successor plus its explicit predecessor. Exhausted or closed predecessors are never reopened.

## Ownership and checks

`recovery-allowance/storage.ts` owns database-only accounting and final reopened-capacity checks. `renewal.service.ts` orchestrates durable intent, the existing billing services and bounded repair. Outbound admission reserves a message before model work; the final send fence owns provider admission. Existing credit owners alone commit, release or compensate their source counters.

No model, prompt, routing decision, sender allocation, auto-purchase or new conversation is introduced. Limits come from existing application billing policy and are snapshotted on each funded block. An ordinary budget of zero fails before a new funding intent or reservation.

Run `npm run test:arch076-allowance:postgres` for disposable PostgreSQL races and provider-proof fixtures. These are repository checks, separate from the deferred system-test task.
