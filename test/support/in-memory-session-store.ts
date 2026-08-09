import type {
  SessionStore,
  SessionStoreApplyResult,
  SessionStoreLoadResult,
  SessionStoreVersion,
  StoredSessionState,
} from '../../src/core/session-store.js';
import { normalizeSessionTitle } from '../../src/core/session-board.js';

/** Fault-capable second Adapter used by the shared SessionStore contract. */
export interface InMemorySessionStore extends SessionStore {
  load(sessionId: string): SessionStoreLoadResult;
  apply(input: Parameters<SessionStore['apply']>[0]): SessionStoreApplyResult;
  seed(state: StoredSessionState, extra?: Record<string, unknown>): void;
  replace(state: StoredSessionState): void;
  readExtra(sessionId: string, field: string): unknown;
  faultNext(input: {
    stage: 'beforePublish' | 'afterPublishBeforeReturn';
    readback?: 'unavailable';
  }): void;
  replaceSourceWith(kind: 'corrupt' | 'futureVersion' | 'unavailable'): void;
}

export function createInMemorySessionStore(_input: {
  runtimeEpoch: string;
}): InMemorySessionStore {
  const rows = new Map<string, {
    state: StoredSessionState;
    extra: Record<string, unknown>;
    revision: number;
  }>();
  const versions = new WeakMap<object, {
    runtimeEpoch: string;
    sessionId: string;
    revision: number;
  }>();
  let nextFault: Parameters<InMemorySessionStore['faultNext']>[0] | undefined;
  let sourceFailure: 'corrupt' | 'futureVersion' | 'unavailable' | undefined;

  const cloneState = (state: StoredSessionState): StoredSessionState => ({
    ...state,
    route: { ...state.route },
  });

  const mintVersion = (sessionId: string, revision: number): SessionStoreVersion => {
    const token = Object.freeze({}) as SessionStoreVersion;
    versions.set(token, { runtimeEpoch: _input.runtimeEpoch, sessionId, revision });
    return token;
  };

  const loaded = (sessionId: string, row: NonNullable<ReturnType<typeof rows.get>>) => ({
    state: cloneState(row.state),
    version: mintVersion(sessionId, row.revision),
  });

  return {
    load(sessionId) {
      if (sourceFailure === 'corrupt') return { kind: 'corrupt', message: 'injected corrupt source' };
      if (sourceFailure === 'futureVersion') {
        return { kind: 'futureVersion', message: 'injected future source version' };
      }
      if (sourceFailure === 'unavailable') {
        return { kind: 'unavailable', message: 'injected Store unavailability' };
      }
      const row = rows.get(sessionId);
      return row
        ? { kind: 'loaded', ...loaded(sessionId, row) }
        : { kind: 'notFound' };
    },
    apply(input) {
      if (sourceFailure) {
        return {
          kind: 'unknown',
          message: `in-memory source is ${sourceFailure}; transition cannot be classified`,
        };
      }
      const row = rows.get(input.sessionId);
      const expected = versions.get(input.expected);
      if (!row || !expected
          || expected.runtimeEpoch !== _input.runtimeEpoch
          || expected.sessionId !== input.sessionId
          || expected.revision !== row.revision) {
        return row ? { kind: 'conflict', current: loaded(input.sessionId, row) } : { kind: 'conflict' };
      }
      const title = normalizeSessionTitle(input.transition.title);
      if (!title
          || title !== input.transition.title
          || !Number.isFinite(Date.parse(input.transition.updatedAt))) {
        return { kind: 'rejected', reason: 'invalidTransition', message: 'invalid rename transition' };
      }
      const nextState: StoredSessionState = {
        ...row.state,
        title,
        titleUpdatedAt: input.transition.updatedAt,
        titleSource: input.transition.source,
      };
      const fault = nextFault;
      nextFault = undefined;
      if (fault?.stage === 'beforePublish') {
        return fault.readback === 'unavailable'
          ? { kind: 'unknown', message: 'injected prewrite failure with unavailable readback' }
          : { kind: 'notApplied', message: 'injected prewrite failure; prior source verified' };
      }
      row.state = cloneState(nextState);
      row.revision += 1;
      if (fault?.stage === 'afterPublishBeforeReturn' && fault.readback === 'unavailable') {
        return { kind: 'unknown', message: 'injected response loss with unavailable readback' };
      }
      const next = loaded(input.sessionId, row);
      return { kind: 'applied', state: next.state, nextVersion: next.version };
    },
    seed(state, extra = {}) {
      rows.set(state.sessionId, { state: cloneState(state), extra: { ...extra }, revision: 1 });
    },
    replace(state) {
      const current = rows.get(state.sessionId);
      rows.set(state.sessionId, {
        state: cloneState(state),
        extra: { ...(current?.extra ?? {}) },
        revision: (current?.revision ?? 0) + 1,
      });
    },
    readExtra(sessionId, field) {
      return rows.get(sessionId)?.extra[field];
    },
    faultNext(fault) {
      nextFault = fault;
    },
    replaceSourceWith(kind) {
      sourceFailure = kind;
    },
  };
}
