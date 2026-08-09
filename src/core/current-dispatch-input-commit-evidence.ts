import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import { recordDispatchInputCommit } from './dispatch.js';
import type {
  DispatchInputCommitEvidence,
  DispatchInputCommitEvidencePort,
  DispatchInputCommitInspection,
  DispatchInputCommitRecordResult,
} from './dispatch-input-commit-evidence.js';

function evidenceFrom(
  session: Session,
  turnId: string,
): DispatchInputCommitInspection {
  const receipt = session.dispatchInputReceipts?.[turnId];
  if (!receipt) return { kind: 'absent' };
  if (!Number.isSafeInteger(receipt.workerGeneration)
    || (receipt.workerGeneration ?? 0) <= 0
    || !receipt.rootMessageId
    || !receipt.committedAt
    || !Number.isFinite(Date.parse(receipt.committedAt))) {
    return { kind: 'unreadable', message: 'persisted input-commit evidence is malformed' };
  }
  return {
    kind: 'committed',
    evidence: {
      sessionId: session.sessionId,
      turnId,
      executorGeneration: receipt.workerGeneration,
      committedAt: receipt.committedAt,
      rootMessageId: receipt.rootMessageId,
    },
  };
}

function sameEvidence(
  inspection: DispatchInputCommitInspection,
  expected: DispatchInputCommitEvidence & { rootMessageId: string },
): boolean {
  return inspection.kind === 'committed'
    && inspection.evidence.sessionId === expected.sessionId
    && inspection.evidence.turnId === expected.turnId
    && inspection.evidence.executorGeneration === expected.executorGeneration
    && inspection.evidence.rootMessageId === expected.rootMessageId;
}

type StrictReadResult = {
  inspection: DispatchInputCommitInspection;
  session?: Session;
};

/**
 * Current named Adapter for `dispatchInputReceipts`.
 *
 * The field remains path-specific delivery evidence, not generic SessionStore
 * state. The Adapter preserves the existing exact turn→root and bounded-64
 * policy, while classifying a legacy whole-row publish failure by strict
 * owner-file readback.
 */
export function createCurrentDispatchInputCommitEvidencePort(input: {
  ownerLarkAppId: string;
  session: Session;
}): DispatchInputCommitEvidencePort {
  const strictRead = (turnId: string): StrictReadResult => {
    try {
      const exact = sessionStore.getSessionForOwnerStrict(
        input.ownerLarkAppId,
        input.session.sessionId,
      );
      return {
        inspection: exact ? evidenceFrom(exact, turnId) : { kind: 'absent' },
        session: exact,
      };
    } catch (error) {
      return {
        inspection: {
          kind: 'unreadable',
          message: `input-commit evidence owner file is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  };

  const synchronizeReceipts = (exact: Session | undefined): void => {
    if (exact?.dispatchInputReceipts) {
      input.session.dispatchInputReceipts = exact.dispatchInputReceipts;
    } else {
      delete input.session.dispatchInputReceipts;
    }
  };

  return {
    read({ sessionId, turnId }) {
      if (sessionId !== input.session.sessionId) {
        return { kind: 'unreadable', message: 'input-commit evidence Session binding mismatch' };
      }
      return strictRead(turnId).inspection;
    },

    record(evidence): DispatchInputCommitRecordResult {
      if (evidence.sessionId !== input.session.sessionId) {
        return { kind: 'unreadable', message: 'input-commit evidence Session binding mismatch' };
      }
      const exactTurnId = evidence.turnId.trim();
      if (!exactTurnId || exactTurnId !== evidence.turnId) {
        return { kind: 'notRecorded', message: 'input-commit evidence turn identity is not canonical' };
      }
      const before = input.session.dispatchInputReceipts;
      if (!recordDispatchInputCommit(
        input.session,
        exactTurnId,
        evidence.executorGeneration,
        evidence.committedAt,
      )) {
        return { kind: 'notRecorded', message: 'turn/root/generation binding rejected input commitment' };
      }
      const rootMessageId = input.session.dispatchInputReceipts?.[exactTurnId]?.rootMessageId;
      if (!rootMessageId) {
        input.session.dispatchInputReceipts = before;
        return { kind: 'notRecorded', message: 'turn/root binding did not produce exact input-commit evidence' };
      }
      const expected: DispatchInputCommitEvidence & { rootMessageId: string } = {
        ...evidence,
        turnId: exactTurnId,
        rootMessageId,
      };
      try {
        sessionStore.updateSession(input.session);
        return { kind: 'recorded' };
      } catch (error) {
        const readback = strictRead(exactTurnId);
        if (sameEvidence(readback.inspection, expected)) {
          synchronizeReceipts(readback.session);
          return { kind: 'recorded' };
        }
        if (readback.inspection.kind === 'unreadable') {
          // The child already proved queue commitment. Keep the conservative
          // local evidence so a later legacy whole-row save cannot erase a
          // publish that may have landed, but never claim durable success.
          return {
            kind: 'unknown',
            message: `${error instanceof Error ? error.message : String(error)}; ${readback.inspection.message}`,
          };
        }
        if (readback.inspection.kind === 'committed') {
          synchronizeReceipts(readback.session);
          return { kind: 'conflict', current: readback.inspection.evidence };
        }
        if (!readback.session) {
          input.session.dispatchInputReceipts = before;
          return { kind: 'conflict' };
        }
        // A concurrent Current writer may have published other turn receipts
        // while proving this candidate absent. Rotate the complete map into
        // the live row before any later legacy whole-row save.
        synchronizeReceipts(readback.session);
        return {
          kind: 'notRecorded',
          message: `input-commit evidence publish was proven not applied: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
