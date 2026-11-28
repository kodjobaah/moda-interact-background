# Definitive WhatsApp non-delivery: credit protection (phase 1)

## Policy

For an authenticated provider-status FAILED receipt, use the persisted outbound
message identity, failure timestamp and absence of stronger delivery/read
receipts to establish definitive non-delivery. The provider error code is not
an accounting eligibility gate. The old synchronous 131026 compensation
entrypoint and ordinary definitive pre-provider/HTTP rejection release paths
remain in place. Pending or unknown provider acceptance is not failure.

The provider status service converges the exact waiting outreach, clears its
follow-up due date, and runs the existing source compensation after commit.
The compensation transaction locks and re-reads the message, establishes the
exact funding source and preserves the attempt/message association before
removing its automated-message usage. If failure precedes finalisation, the
exact admission lineage can also close the pending attempt. Existing terminal
response history is not overwritten. Replay uses the original correction
identity; no new ledger or provider refund API is introduced.

Committed reservations remain COMMITTED for audit and get a linked negative
usage event and a compensation disposition. A still-spendable source is
restored; expired/closed sources retain their existing historical-only
accounting, and purchase refund holds remain held. Reserved capacity is
released through its original owner. A previously AMBIGUOUS reservation can
be released only after a definitive provider FAILED receipt, in the same
transaction. Missing/conflicting lineage or a funded allowance with later
provider-admitted consumption remains an operator-visible error, not an
invented credit correction. No consent or reachability write is introduced
for 131049. Existing 131026 recipient suppression remains unchanged.

The new additive enum value WHATSAPP_DELIVERY_FAILED requires the database
migration and generated Prisma client before deployment. Legacy correction
replays must accept both compensation reasons. Internal attempt failure codes
preserve the bounded original provider code where present. Actual Meta error
text is not available from the persisted status contract; do not invent it.

## Validation / rollout

1. Apply and validate the database migration on a disposable database.
2. Pin the new database submodule, regenerate Prisma and build Background.
3. Run the focused unit suites and the disposable PostgreSQL compensation,
   reachability and notification suites. Do not deploy on a failing gate.
4. Re-deliver the original authenticated provider-status FAILED event through
   the existing status consumer for historical failed test messages. This
   patch does not scan or mutate historical production records automatically.
5. Verify exactly one correction for the original committed event, correct
   source counter, failed outreach, no actionable follow-up, no fabricated
   recipient suppression, and one merchant support notification.

## Phase 2: safe recycling

The additive retry-decision foundation is described in
[`whatsapp-recovery-retry-intent.md`](whatsapp-recovery-retry-intent.md).
Automatic resend execution remains disabled pending the coordinated physical
attempt/slot migration.

The current `RecoveryOutreachAttempt` has a unique (checkoutRecoveryId,
sequence) constraint; sequence 1 is initial and sequence 2 is follow-up.
The immutable `recovery-outreach:<attemptId>` key is used for provider
admission, allowance funding, credit settlement, support notification and
compensation. Recycling must not reset that attempt, delete its failed message
or reactivate its compensated reservation. A retry requires a new immutable
physical send/funding identity while keeping the same logical initial or
follow-up slot and the same recovery/conversation. This is a separate schema
and cross-consumer change, not a BullMQ retry of the old provider permit.

Implementation acceptance boundary for phase 2:

- Persist retry send identity, ordinal, cause, next eligible time, bounded
  retry budget and durable lease; guarantee one eligible retry per logical
  outreach slot and deduplicate webhook and scheduler replay.
- Schedule only after source correction is durably complete; keep durable
  scheduling authority in PostgreSQL and reconstruct delayed BullMQ jobs.
- Classify recoverability independently of compensation. Do not retry
  invalid/unreachable recipient, revoked consent, STOP, completed order,
  expired checkout or unknown provider acceptance. For policy/marketing
  restrictions (including 131049), defer until permitted by provider policy;
  never rotate sender numbers or retry rapidly to evade a recipient limit.
  Configuration/template errors require verified repair. Unknown failures
  require an explicit retry decision, not an unbounded resend loop.
- Preserve current attempt history and never consume the follow-up slot on
  an initial retry. Revalidate authoritative Shopify abandoned checkout or
  persisted Woo state, generation, consent, order, configured lifetime, shop
  eligibility, sender assignment, prices/offers, template and credit.
- Fence send and revalidation against order/checkout update, inbound customer
  response, late positive receipt, duplicate worker and expired work lease.
  Reserve a fresh credit using only the new physical identity, then use
  normal dispatch/settlement. If this attempt also definitively fails,
  compensate exactly once. No retry is charged unless accepted and retained
  under existing accounting rules.
- Test both platforms, four funding sources, pre/post-commit failure, crash
  recovery, late positive delivery, retry exhaustion, provider restrictions,
  and unchanged sequence-two policy. Include Admin/API/Shopify queries that
  assume a unique sequence when changing the data model.
