/** Pure Current target-scratch policy shared by relocation and Session control. */

import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';

export function isDisposableStoredRouteScratch(session: Session): boolean {
  return session.status === 'active'
    && !session.adoptedFrom
    && !session.queued
    && !session.cliId
    && !session.cliSessionId
    && !session.lastCliInput
    && !session.initialUserTurnPending
    && !session.restoreQuarantinedAt
    && !session.vcMeetingReceiver
    && !hasProtectedSessionMutationOwnership(session);
}

export function isDisposableCurrentRouteScratch(ds: DaemonSession): boolean {
  return isDisposableStoredRouteScratch(ds.session)
    && !ds.worker
    && !ds.pendingRepo
    && ds.pendingPrompt === undefined
    && ds.pendingRawInput === undefined
    && !ds.adoptedFrom
    && !ds.initialStartPending
    && !ds.dashboardSpawnOpeningPending
    && !ds.worktreeCreating
    && !hasProtectedSessionMutationOwnership(ds);
}
