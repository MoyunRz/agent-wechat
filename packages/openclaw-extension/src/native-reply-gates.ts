/**
 * Risk-control valves for autonomous replies. A person reads a burst of
 * messages and answers once; a script that answers every message within
 * seconds is how accounts get flagged. Three fixed valves apply to every
 * automatic reply, deliberately not user-configurable:
 *
 * 1. Debounce: a thread only dispatches after it has stayed quiet for a
 *    moment, so consecutive messages aggregate into one model turn.
 * 2. Spacing: at least 30 seconds between replies to the same thread.
 * 3. Circuit: one uncertain reply outcome (`needs_review`) stops every
 *    automatic reply for one hour; the daemon's own send circuit enforces the
 *    same window at the submission layer.
 */
export const NATIVE_REPLY_DEBOUNCE_MS = 10_000;
export const NATIVE_REPLY_INTERVAL_MS = 30_000;
export const NATIVE_REPLY_CIRCUIT_MS = 3_600_000;
const SEEN_LIMIT = 5000;
const SEEN_PRUNE_TO = 4000;
export class NativeReplyGates {
  private seenAt = new Map<string, number>();
  private lastReplyAt = new Map<string, number>();
  private circuitUntil = 0;
  /** First observation of an inbound message; the debounce window measures quiet time from here. */
  markSeen(messageId: string, now = Date.now()): void {
    if (this.seenAt.has(messageId)) return;
    this.seenAt.set(messageId, now);
    if (this.seenAt.size > SEEN_LIMIT) {
      for (const key of this.seenAt.keys()) {
        this.seenAt.delete(key);
        if (this.seenAt.size <= SEEN_PRUNE_TO) break;
      }
    }
  }
  seenAtOf(messageId: string): number {
    return this.seenAt.get(messageId) ?? 0;
  }
  /** True while an automatic reply to this thread must wait. */
  deferReply(threadId: string, newestSeenAt: number, now = Date.now()): boolean {
    if (now < this.circuitUntil) return true;
    const last = this.lastReplyAt.get(threadId);
    if (last !== undefined && now - last < NATIVE_REPLY_INTERVAL_MS) return true;
    return now - newestSeenAt < NATIVE_REPLY_DEBOUNCE_MS;
  }
  /** A delivered reply opens the per-thread spacing window. */
  recordReply(threadId: string, now = Date.now()): void {
    this.lastReplyAt.set(threadId, now);
  }
  /** An uncertain reply outcome stops every automatic reply for one hour. */
  tripCircuit(now = Date.now()): void {
    this.circuitUntil = now + NATIVE_REPLY_CIRCUIT_MS;
  }
}
