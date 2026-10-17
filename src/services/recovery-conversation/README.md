# ARCH-040 BACKGROUND-001 service contract

This directory is **service layer only**. BACKGROUND-002 will wire these exported
services into the existing conversation-turn, follow-up, and WhatsApp delivery
paths; there is deliberately no worker, timer, producer, provider adapter, or
second transcript here. All inputs are platform-neutral durable IDs. The
Background `database/` submodule must be updated to the accepted
`ARCH-040-DATABASE-001` migration and Prisma client regenerated before use.

- `AiTurnOwnershipService.readTurnOwnership` and `checkAutomatedTurn` capture and
  compare the **original** revision before the AI job, after awaits and before
  provider admission. `projectRecoveryHistory` labels HUMAN content as untrusted
  merchant-authored history; BG002 must connect it to the actual context composer.
  `latestVerifiedCustomerInbound` provides the monotonic verified timestamp
  rule; BG002 will apply the max update during customer ingress persistence.
- `MerchantSendCommandService.claimDueHumanCommands` claims indexed, due
  commands using PostgreSQL `FOR UPDATE SKIP LOCKED` with per-command lease
  tokens. `loadClaimedCommand`, `rejectCommand`, `deferCommand` fence lost leases.
  `completeCommand` cannot be used to infer SENT from a lease; provider
  reconciliation is the sole finalisation route.
- `RecoveryFollowUpPolicyService.checkServiceWindow`,
  `validateHumanFollowUp`, `claimSequenceTwo` accept a canonical recovery; one
  `(recoveryId, sequence=2)` row and `recovery-outreach:<attemptId>` credit key
  are shared by human and automatic follow-up. BG002 must inject the existing
  checkout lock and template choice; `RecoveryFollowUpBillingService` delegates
  admit/revalidate/commit/failure/release to `RecoveryBillingService`. Do not call a new billing ledger.
- `HumanSendPolicyService.checkRestriction`, `validateContent`,
  `screenHumanCommand` apply HUMAN-only fixed limits (defaults: 4000 Unicode
  characters, 30/shop/minute, 12/recipient/hour, 3 identical contents per
  recipient/10 minutes). Redis evaluation is atomic and repeat command IDs do
  not consume capacity. Redis errors are `human_screening_unavailable` and
  must be retried without sending. Text is never logged. Restrictions are
  admin-owned; service checks them, never changes them.
- `OutboundSendFenceService.admitFinalSend` / `admitProviderDispatch` use a
  short PostgreSQL transaction, ordering **Shop row -> Conversation row ->
  command/follow-up/message**. Locking the Shop row protects against the first
  restriction INSERT. The commit of the provider key and timestamp is the
  linearisation point; provider admission first may result in a later Meta send
  after a subsequent takeover. No database transaction may span provider HTTP.
  A `durableEligibility(tx, input, context)` checker is **required** and must
  inspect in-database entitlement/recovery credit/capacity before granting the
  permit. The service fails closed without it. BG002 must also run its existing
  external recipient/provider and RecoveryBillingService checks *before* this
  fence, and must never call provider HTTP more than once for each permit.
- `HumanSendReconciliationService.recordProviderAccepted`,
  `recordDefinitiveFailure`, `recordProviderUnknown`, `reconcileUnknown` attach
  outcomes to the single canonical HUMAN `ConversationMessage`. UNKNOWN is
  reconciliation-only. A lease never justifies treating an ambiguous provider
  request as definitively failed. BG002 must connect verified receipts and
  recovery-credit compensation via its existing provider/billing services.

A crash after admission cannot be safely retried as a second Meta call; the
one-way provider permit is deliberately stronger than a command lease. The
client cannot supply `shopId` as authority: the recovery-linked conversation
and `CheckoutRecovery.shopId` determine tenant context.
