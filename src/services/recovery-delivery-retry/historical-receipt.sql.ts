/** Fixed SQL fragments only: callers provide these internal aliases, never
 * request data. Historical contact is independent of current retry policy or
 * a late cancellation. Every physical successor must trace to sequence one.
 * Positive contact must still have the exact platform provider permit. */
export function historicalInitialRetryReceiptSql(alias: "sender" | "window"): string {
  const a = alias === "sender" ? "i" : "initial";
  const r = alias === "sender" ? "r" : "recovery";
  const c = alias === "sender" ? "c.id" : "$2";
  const m = alias === "sender" ? "m" : "retry_message";
  return `(${a}.sequence>=3 AND ${a}.trigger='INITIAL'
    AND ${a}.id ~ '^retry_[A-Za-z0-9_-]{1,100}$'
    AND ${a}."initiatedBy" IS DISTINCT FROM 'HUMAN'
    AND ${m}."conversationId"=${c} AND ${m}.direction='OUTBOUND' AND ${m}."senderType"='AUTOMATION'
    AND ${m}."providerDispatchAdmittedAt" IS NOT NULL AND ${m}."providerDispatchControlRevision" IS NOT NULL
    AND ${m}."providerMessageId" IS NOT NULL AND ${m}."sentAt"=${a}."sentAt"
    AND ${m}."providerDispatchKey"=CASE shop.platform
      WHEN 'SHOPIFY' THEN 'recovery-retry-'||encode(sha256(convert_to(${a}.id,'UTF8')),'hex')
      WHEN 'WOOCOMMERCE' THEN 'arch046-woo-initial-'||encode(sha256(convert_to(${r}."shopId",'UTF8')||decode('00','hex')||convert_to(${a}.id,'UTF8')),'hex')
      ELSE NULL END
    AND EXISTS (
      WITH RECURSIVE ancestors(id, sequence, recipient, message_id) AS (
        SELECT ${a}.id, ${a}.sequence, ${a}.recipient, ${a}."outboundMessageId"
        UNION ALL
        SELECT predecessor.id, predecessor.sequence, predecessor.recipient, predecessor."outboundMessageId"
        FROM ancestors child
        JOIN commerce."RecoveryOutreachRetryIntent" intent ON child.id='retry_'||intent.id
        JOIN commerce."RecoveryOutreachAttempt" predecessor ON predecessor.id=intent."failedAttemptId"
        JOIN whatsapp."ConversationMessage" failed ON failed.id=intent."failedMessageId" AND failed.id=predecessor."outboundMessageId"
        WHERE child.sequence>=3 AND intent.id ~ '^[A-Za-z0-9_-]{1,100}$'
          AND predecessor."checkoutRecoveryId"=${r}.id AND predecessor.sequence<child.sequence
          AND predecessor.trigger='INITIAL' AND predecessor."initiatedBy" IS DISTINCT FROM 'HUMAN'
          AND predecessor.recipient=child.recipient
          AND failed."conversationId"=${c} AND failed.direction='OUTBOUND' AND failed."senderType"='AUTOMATION'
          AND failed."providerMessageId" IS NOT NULL AND failed."failedAt" IS NOT NULL
          AND failed."dispatchProviderAccountId"=${m}."dispatchProviderAccountId"
          AND failed."dispatchProviderPhoneNumberId"=${m}."dispatchProviderPhoneNumberId"
      ) SELECT 1 FROM ancestors WHERE sequence=1
    ))`;
}
