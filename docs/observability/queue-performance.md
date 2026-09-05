# Queue performance metrics

Background emits bounded OpenTelemetry signals for the four BullMQ queues:

- `checkout-events`
- `order-events`
- `pending-recovery-candidates`
- `whatsapp-events`

## Metrics

`moda.background.queue.jobs` is an observable gauge with
`bullmq.queue.name` and `bullmq.job.state` attributes for `waiting`, `active`,
`delayed`, and `failed`.

`moda.background.queue.oldest_waiting_age_ms` reports the age of the oldest
eligible waiting job. Delayed jobs are excluded from this value.

`moda.background.worker.job.queue_wait_ms` is a histogram measured from the
observed BullMQ transition into `waiting` to processor start. It is separate
from `moda.background.worker.job.duration_ms`, which measures processor time.
If the transition was not observed, queue wait is omitted rather than inferred
from `timestamp + delay`; this avoids incorrect values after observer restart,
rescheduling, or delayed retry/backoff.

The oldest-waiting-age gauge uses the same observed transition timestamp. It is
omitted when the oldest waiting job's eligibility transition was not observed,
so a stale value is never exported as current backlog health.

`moda.background.queue.transition.operations` is a counter with the bounded
`bullmq.job.transition` values `added`, `waiting`, `active`, `delayed`,
`completed`, `failed`, and `stalled`.

The existing worker operations metric remains the source for success, failure,
and retry rates. No job, tenant, customer, token, or message identifiers are
metric attributes.

## Grafana panels

For each queue, graph:

- processing attempts per minute from the existing worker operations counter;
- success/failure and retry rates from `moda.worker.outcome` and
  `moda.worker.attempt`;
- waiting, active, delayed, and failed depth from `moda.background.queue.jobs`;
- `moda.background.queue.oldest_waiting_age_ms`;
- processor duration p50/p95/p99 from
  `moda.background.worker.job.duration_ms`;
- queue wait p50/p95/p99 from
  `moda.background.worker.job.queue_wait_ms`;
- stalled jobs per minute from the transition counter.

A large delayed count is not, by itself, unhealthy backlog. This is especially
important for `pending-recovery-candidates`, where the configured recovery
delay is intentional. Prefer oldest waiting age and queue-wait p95 for backlog
health.
