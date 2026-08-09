import type { DaemonSession } from './types.js';

export type DeferredScheduleSettlementResult =
  | { action: 'ignored' }
  | { action: 'materialized'; rootMessageId: string }
  | { action: 'closed' };

/** Execute the exact-turn lifecycle decision after a hidden schedule run
 * reaches a terminal/idle edge. Timer debounce lives in daemon.ts; keeping the
 * decision here makes the close-vs-retain contract independently testable. */
export async function settleDeferredScheduleRun(
  ds: DaemonSession,
  context: { turnId: string; source: 'terminal' | 'idle' },
  deps: {
    reconcile: (ds: DaemonSession) => string | undefined;
    closeSession: (
      sessionId: string,
      options?: { isCurrent?: () => boolean },
    ) => Promise<boolean | void>;
    /** Dynamic executor-generation proof for timer-delayed settlement. */
    isCurrent?: () => boolean;
  },
): Promise<DeferredScheduleSettlementResult> {
  const run = ds.session.deferredScheduleRun;
  if (!run || run.turnId !== context.turnId || ds.session.status === 'closed') {
    return { action: 'ignored' };
  }
  if (context.source === 'idle' && ds.lastScreenStatus !== 'idle') {
    return { action: 'ignored' };
  }
  if (deps.isCurrent && !deps.isCurrent()) return { action: 'ignored' };
  const rootMessageId = deps.reconcile(ds);
  if (rootMessageId) return { action: 'materialized', rootMessageId };
  if (deps.isCurrent && !deps.isCurrent()) return { action: 'ignored' };
  const closed = deps.isCurrent
    ? await deps.closeSession(ds.session.sessionId, { isCurrent: deps.isCurrent })
    : await deps.closeSession(ds.session.sessionId);
  if (closed === false) return { action: 'ignored' };
  return { action: 'closed' };
}
