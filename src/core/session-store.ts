/**
 * Storage-independent seam for Session-owned state.
 *
 * A StoreVersion is an Adapter-local compare-and-set capability. It is not a
 * durable receipt and callers must never serialize or inspect it. Adapters
 * bind each token to one runtime epoch and one exact Session source snapshot.
 */

declare const sessionStoreVersionBrand: unique symbol;

export type SessionStoreVersion = Readonly<Record<never, never>> & {
  readonly [sessionStoreVersionBrand]: true;
};

export type StoredSessionRoute =
  | { kind: 'thread'; anchorId: string }
  | { kind: 'chat'; chatId: string };

export type StoredSessionTitleSource =
  | 'initial'
  | 'user'
  | 'agent'
  | 'cli'
  | 'dashboard'
  | 'system';

/** Detached, allow-listed state. It deliberately is not the legacy Session. */
export interface StoredSessionState {
  sessionId: string;
  route: StoredSessionRoute;
  recordStatus: 'active' | 'closed';
  title: string;
  titleUpdatedAt?: string;
  titleSource?: StoredSessionTitleSource;
  executorGeneration: number;
}

/** Semantic state changes; arbitrary JSON patches are intentionally absent. */
export type SessionStoreTransition = {
  kind: 'rename';
  /** Must already be normalized by the shared Session title policy. */
  title: string;
  updatedAt: string;
  source: StoredSessionTitleSource;
};

export type SessionStoreLoadResult =
  | {
      kind: 'loaded';
      state: StoredSessionState;
      version: SessionStoreVersion;
    }
  | { kind: 'notFound' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'corrupt'; message: string }
  | { kind: 'futureVersion'; message: string };

export type SessionStoreApplyResult =
  | {
      kind: 'applied';
      state: StoredSessionState;
      nextVersion: SessionStoreVersion;
    }
  | {
      kind: 'conflict';
      current?: {
        state: StoredSessionState;
        version: SessionStoreVersion;
      };
    }
  | {
      kind: 'rejected';
      reason: 'invalidTransition' | 'closed';
      message: string;
    }
  | {
      /** The Adapter proved that the prior source is still authoritative. */
      kind: 'notApplied';
      message: string;
    }
  | {
      /** Publication may have happened and strict readback could not prove it. */
      kind: 'unknown';
      message: string;
    };

export interface SessionStore {
  load(sessionId: string): SessionStoreLoadResult;
  apply(input: {
    sessionId: string;
    expected: SessionStoreVersion;
    transition: SessionStoreTransition;
  }): SessionStoreApplyResult;
}
