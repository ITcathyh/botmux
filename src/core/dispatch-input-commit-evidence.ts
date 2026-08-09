/**
 * Named path-specific authority for worker input-queue commitment evidence.
 *
 * This is deliberately not part of SessionStore: A0 classifies
 * `dispatchInputReceipts` as delivery/effect evidence rather than Session
 * lifecycle truth. Target-A keeps its Current persistence contract behind
 * this port; A2 wires the production Adapter when executor callbacks move
 * behind SessionRuntime.
 */

export interface DispatchInputCommitEvidence {
  sessionId: string;
  turnId: string;
  executorGeneration: number;
  committedAt: string;
}

export type DispatchInputCommitInspection =
  | { kind: 'absent' }
  | { kind: 'committed'; evidence: DispatchInputCommitEvidence }
  | { kind: 'unreadable'; message: string };

export type DispatchInputCommitRecordResult =
  | { kind: 'recorded' }
  | { kind: 'conflict'; current?: DispatchInputCommitEvidence }
  | { kind: 'notRecorded'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'unreadable'; message: string };

export interface DispatchInputCommitEvidencePort {
  read(input: { sessionId: string; turnId: string }): DispatchInputCommitInspection;
  record(evidence: DispatchInputCommitEvidence): DispatchInputCommitRecordResult;
}
