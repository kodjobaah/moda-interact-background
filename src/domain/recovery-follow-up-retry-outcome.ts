/** Durable evidence classification only. No caller may infer that a timed-out
 * HTTP request failed, or that a provider permit alone is an acceptance. */
export type RetryOpeningEvidence = {
  status: string;
  providerDispatchKey: string | null;
  providerDispatchAdmittedAt: Date | null;
  providerDispatchControlRevision: number | null;
  dispatchProviderAccountId: string | null;
  dispatchProviderPhoneNumberId: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  providerFailureCode: string | null;
};

export type RetryOpeningOutcome = "unprepared" | "prepared" | "refused" | "accepted" |
  "non-delivery" | "rejected" | "unknown" | "conflict";

export function classifyFollowUpRetryOpening(message: RetryOpeningEvidence | null, dispatchKey: string,
  terminalFailureCode: string | null = null): RetryOpeningOutcome {
  if (!message) return "unprepared";
  const m = message;
  const permitAbsent = m.providerDispatchKey === null && m.providerDispatchAdmittedAt === null &&
    m.providerDispatchControlRevision === null && m.dispatchProviderAccountId === null && m.dispatchProviderPhoneNumberId === null;
  if (permitAbsent) {
    if (m.providerMessageId || m.sentAt || m.deliveredAt || m.readAt || m.failedAt || m.providerFailureCode) return "conflict";
    if (m.status === "PENDING") return "prepared";
    // FAILED before a permit is safe to retire, but is not a provider failure.
    return m.status === "FAILED" ? "refused" : "conflict";
  }
  if (m.providerDispatchKey !== dispatchKey || !m.providerDispatchAdmittedAt ||
      (m.providerDispatchControlRevision === null || !Number.isSafeInteger(m.providerDispatchControlRevision) || m.providerDispatchControlRevision < 0) || !m.dispatchProviderAccountId || !m.dispatchProviderPhoneNumberId) return "conflict";
  if (m.providerMessageId) {
    if (m.status === "FAILED" && m.failedAt && !m.deliveredAt && !m.readAt) return "non-delivery";
    // A later positive receipt can retain the earlier FAILED timestamp. Do not
    // mistake that history for a new negative outcome.
    if (m.sentAt && ((m.status === "SENT" && !m.failedAt && !m.providerFailureCode) ||
      (m.status === "DELIVERED" && !!m.deliveredAt) || (m.status === "READ" && !!m.readAt))) return "accepted";
    return "unknown";
  }
  if (m.sentAt || m.deliveredAt || m.readAt) return "conflict";
  if (m.status === "FAILED" && m.failedAt && terminalFailureCode === "PROVIDER_REJECTED") return "rejected";
  if (m.status === "FAILED" && m.failedAt && m.providerFailureCode === "131026" &&
      terminalFailureCode === "WHATSAPP_RECIPIENT_UNDELIVERABLE") return "non-delivery";
  // Includes FAILED without definitive rejection evidence, timeout, and crash.
  return "unknown";
}
