import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

type Fields = Readonly<Record<string, unknown>>;
const REPEATED_DEBUG = new Set([
  "recovery.delivery_retry.evaluation_started", "recovery.delivery_retry.eligible",
  "recovery.delivery_retry.eligibility_held", "recovery.delivery_retry.claim_held",
  "recovery.delivery_retry.claim_replayed", "recovery.delivery_retry.permit_held",
  "recovery.delivery_retry.execution_held", "recovery.delivery_retry.offer_revalidated",
  "recovery.delivery_retry.dispatch_held",
]);

/** Coalesce unchanged per-intent diagnostics from polling, not exceptions or
 * new committed actions. Local, bounded and non-authoritative: no business
 * decision depends on the cache. A different reason logs immediately. */
export function retrySweepLogger(base: StructuredLogger, now = Date.now, ttlMs = 15 * 60_000,
  maxEntries = 2_000): StructuredLogger {
  const entries = new Map<string, { signature: string; loggedAt: number }>();
  const wrap = (target: StructuredLogger, inherited: Fields = {}): StructuredLogger => {
    function shouldLog(event: string, fields: Fields | undefined) {
      const context = { ...inherited, ...fields };
      const id = context.retryIntentId ?? context.outreachAttemptId;
      if (typeof id !== "string") return true;
      // Only bounded, non-content decision metadata determines suppression.
      const key = `${event}:${id}`;
      const signature = JSON.stringify([context.reason, context.outcome, context.stage,
        context.operation, context.outboundMessageId]);
      const at = now();
      const old = entries.get(key);
      if (old?.signature === signature && at >= old.loggedAt && at - old.loggedAt < ttlMs) return false;
      entries.delete(key);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(key, { signature, loggedAt: at });
      return true;
    }
    return {
      debug(event, fields) {
        // An exception attached to an otherwise normal hold is evidence.
        if (!REPEATED_DEBUG.has(event) || fields?.sourceError || shouldLog(event, fields)) target.debug(event, fields);
      },
      info(event, fields) {
        if (event !== "recovery.delivery_retry.execution_reconciled" || shouldLog(event, fields)) target.info(event, fields);
      },
      warn(event, fields) { target.warn(event, fields); },
      error(event, fields) { target.error(event, fields); },
      child(fields) { return wrap(target.child(fields), { ...inherited, ...fields }); },
    };
  };
  return wrap(base);
}
