import {
  detectCliUsageLimit,
  detectScreenUsageLimit,
  usageLimitStateKey,
  type CliUsageLimitState,
} from './cli-usage-limit.js';

/**
 * Per-turn usage-limit state machine. Owns the turn counter, the
 * "did this turn hit a limit" flag, the stale retry-ready banner suppression,
 * and the stickiness of authoritative STRUCTURED limits — so classify()'s
 * state writes are explicit method calls rather than hidden mutations of
 * module globals.
 *
 * Generic over the runtime status union so the worker can plug in its
 * RuntimeScreenStatus while tests drive it with plain strings.
 */
export interface UsageLimitTracker<S extends string = string> {
  currentTurn(): number;
  beginTurn(snapshot: string): number;
  classify(content: string, status: S): { status: S | 'limited'; usageLimit?: CliUsageLimitState };
  detectedThisTurn(seq: number): boolean;
  noteStructuredLimit(state: CliUsageLimitState): void;
}

export function createUsageLimitTracker<S extends string = string>(opts: {
  isRateKindSuppressed: () => boolean;
}): UsageLimitTracker<S> {
  let turnSeq = 0;
  let detectedTurn: number | undefined;
  let suppressedRetryReadyKey: string | undefined;
  // A STRUCTURED limit (transcript error record, Claude/Codex) is authoritative
  // and one-shot at the source (UUID-deduped emit). Re-emit it on every
  // classify() until the turn ends: a genuinely blocked CLI keeps its
  // 「限额已达」 card even while the active-work gate suppresses the
  // (rate-suppressed) screen text — otherwise a working frame that races ahead
  // of prompt detection would let the daemon-side self-heal clear an
  // authoritative limit, and nothing would re-report it for the rest of the
  // blocked turn. Screen-scan detections stay one-shot: the daemon self-heal is
  // the correct remedy for THEIR false positives (idle-flicker mis-hits).
  let activeStructured: { seq: number; state: CliUsageLimitState } | undefined;

  return {
    currentTurn(): number {
      return turnSeq;
    },
    // Open a new turn; remember any stale retry-ready banner still on screen so
    // classify() doesn't re-flag it as a fresh limit this turn.
    beginTurn(snapshot: string): number {
      turnSeq++;
      detectedTurn = undefined;
      activeStructured = undefined;
      const current = detectCliUsageLimit(snapshot, undefined, { suppressRateKind: opts.isRateKindSuppressed() });
      suppressedRetryReadyKey = current.limited && current.retryReady
        ? usageLimitStateKey(current)
        : undefined;
      return turnSeq;
    },
    // Map a runtime status to a usage-limit-aware status, recording whether this
    // turn hit a limit (read back via detectedThisTurn).
    classify(
      content: string,
      status: S,
    ): { status: S | 'limited'; usageLimit?: CliUsageLimitState } {
      // Gate the screen-scan verdict on the runtime status: while the CLI is
      // actively working, limit-shaped text on screen is its own output (a
      // model answer / tool output quoting a business 429) or a transient retry
      // it is handling internally — never a live block, which would park the
      // CLI at an error/prompt screen (idle/stalled). Suppressing here is the
      // primary fix for the "CLI 还在跑却提示限额已达" false reports.
      const detected = detectScreenUsageLimit(content, status, undefined, { suppressRateKind: opts.isRateKindSuppressed() });
      if (!detected.limited) {
        // Re-emit an authoritative structured limit recorded this turn so a
        // genuinely blocked CLI keeps its card (see activeStructured).
        if (activeStructured?.seq === turnSeq) {
          return { status: 'limited', usageLimit: activeStructured.state };
        }
        return { status };
      }

      const key = usageLimitStateKey(detected);
      if (detected.retryReady && key === suppressedRetryReadyKey) {
        return { status };
      }

      suppressedRetryReadyKey = undefined;
      detectedTurn = turnSeq;
      return { status: 'limited', usageLimit: detected };
    },
    detectedThisTurn(seq: number): boolean {
      return detectedTurn === seq;
    },
    // Record a limit that came from a STRUCTURED signal (transcript error
    // record) rather than screen text. Mirrors classify()'s state writes so
    // the tracker stays coherent: mark this turn as having hit a limit (read
    // by detectedThisTurn for the submit-confirmation recheck), clear any
    // stale retry-ready suppression, and hold the state for re-emission until
    // the turn ends. The actual emit is done by the caller.
    noteStructuredLimit(state: CliUsageLimitState): void {
      suppressedRetryReadyKey = undefined;
      detectedTurn = turnSeq;
      activeStructured = { seq: turnSeq, state };
    },
  };
}
