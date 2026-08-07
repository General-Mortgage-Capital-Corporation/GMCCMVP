/**
 * Per-request ledger linking a sent email's subject to the address it was
 * ACTUALLY sent to.
 *
 * Why this exists: `sendEmail` and `recordFollowUp` are independent agent tool
 * calls, each given the recipient separately. When the deliverability gate in
 * `sendEmail` rejects the address the model first proposed, the model retries
 * the send with a corrected address — but the address it later passes to
 * `recordFollowUp` can still be the original (rejected) one. That drift is how
 * a follow-up ended up recorded against an address the email never went to.
 *
 * The ledger makes the successful send the source of truth: `sendEmail` records
 * the real recipient (keyed by subject), and `recordFollowUp` reconciles the
 * model-supplied address against it. It is instantiated once per chat request
 * (see the chat route), so it never bleeds across users sharing a warm Fluid
 * Compute instance.
 */
export interface SendLedger {
  /** Note that `address` was the actual recipient of a successful send. */
  record(subject: string, address: string): void;
  /** The real recipient for this subject, or `fallback` if none recorded. */
  resolve(subject: string, fallback: string): string;
}

function key(subject: string): string {
  return subject.trim().toLowerCase();
}

export function createSendLedger(): SendLedger {
  // subject -> most recent actual (successful) send address.
  const bySubject = new Map<string, string>();
  return {
    record(subject, address) {
      if (!subject || !address) return;
      bySubject.set(key(subject), address);
    },
    resolve(subject, fallback) {
      if (!subject) return fallback;
      return bySubject.get(key(subject)) ?? fallback;
    },
  };
}
