# Recovery sender allocation

`RecoverySenderPoolService.allocate` links the existing recovery Conversation to
one immutable sender assignment. Call it after resolving a trusted canonical
recipient and before new recovery credit or provider admission. Shopify and Woo
initial flows pass the exact persisted sequence-one attempt; no inventory uses
its existing CAPACITY_BLOCKED state and the recovery's existing capacity-resume
marker. `SENDER_INVENTORY_UNAVAILABLE` distinguishes that operational hold from
funding exhaustion. Retry reuses the same attempt and Conversation.

Allocation and release take the same transaction advisory lock for the canonical
recipient. Owner rows are locked in stable Conversation order, then their
CheckoutRecovery rows. A live same-shop route survives inventory drain. Otherwise
selection ranks current-WABA enabled verified inventory by this recipient's
number of distinct live shops, priority and phone ID in C order. The validated
current messaging configuration is captured outside locks; a new route requires
the identical environment/row/version under a row-share lock. This prevents a
concurrent credential-account switch from admitting an old-account sender.
Existing assignments never switch even when configuration changes.

Terminal and inclusive-lifetime-expired assignments release monotonically. The
last assignment closes its route and the last route closes its physical thread.
The existing expiry tick also reconciles terminal assignments after crashes.
Allocation reconciles terminal owners for its recipient before selecting, so a
concurrent last-member release/allocation cannot revive an old generation.
Pending routing originals remain on their historical thread; this service does
not reattribute or resolve them. Message allowance, credits, model and plan are
not ownership predicates.

The service performs database work only while locked. Provider dispatch sender
pinning, credential membership at send time, failed/unknown initial delivery
proof and exact sender-qualified status/reply routing are the subsequent
ARCH-076-BACKGROUND-002/003 tasks. Allocation success is not permission to send
or evidence of customer contact. Existing consent, STOP, service window,
moderation, recovery status and final send fences remain authoritative.

Validation uses the actual service against disposable PostgreSQL, including
same-shop races, last-member closure racing same/new-shop allocation, separate
recipients, drain/restart replay, WABA isolation/configuration CAS, no-inventory
original identity, terminal restart cleanup and the inclusive expiry boundary.
These are repository-local tests; the deferred architecture system test is not
executed.
