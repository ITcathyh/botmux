import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  SessionStore,
  SessionStoreVersion,
  StoredSessionState,
} from '../src/core/session-store.js';
import {
  createSession as createLegacySession,
  createCurrentSessionStore,
  init as initLegacySessionStore,
  type CurrentSessionStoreFaults,
  updateSession as updateLegacySession,
} from '../src/services/session-store.js';
import { createInMemorySessionStore } from './support/in-memory-session-store.js';

interface ContractFixture {
  store: SessionStore;
  seed(state: StoredSessionState, extra?: Record<string, unknown>): void;
  replace(state: StoredSessionState): void;
  readExtra(sessionId: string, field: string): unknown;
  faultNext(input: {
    stage: 'beforePublish' | 'afterPublishBeforeReturn';
    readback?: 'unavailable';
  }): void;
  replaceSourceWith(kind: 'corrupt' | 'futureVersion' | 'unavailable'): void;
  versionFromAnotherEpoch(sessionId: string): SessionStoreVersion;
  cleanup(): void;
}

const sessionState = (overrides: Partial<StoredSessionState> = {}): StoredSessionState => ({
  sessionId: 'session-one',
  route: { kind: 'thread', anchorId: 'om_root' },
  recordStatus: 'active',
  title: 'Before',
  executorGeneration: 3,
  ...overrides,
});

function currentRow(state: StoredSessionState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const routeFields = state.route.kind === 'thread'
    ? { chatId: 'oc_chat', rootMessageId: state.route.anchorId, scope: 'thread' }
    : { chatId: state.route.chatId, rootMessageId: 'om_first', scope: 'chat' };
  return {
    sessionId: state.sessionId,
    ...routeFields,
    title: state.title,
    titleUpdatedAt: state.titleUpdatedAt,
    titleSource: state.titleSource,
    status: state.recordStatus,
    createdAt: '2026-08-10T00:00:00.000Z',
    workerGeneration: state.executorGeneration,
    ...extra,
  };
}

function defineSessionStoreContract(
  adapterName: string,
  createFixture: () => ContractFixture,
): void {
  describe(`${adapterName} SessionStore contract`, () => {
    it('distinguishes an absent Session from an unreadable Store', () => {
      const fixture = createFixture();
      try {
        expect(fixture.store.load('missing')).toEqual({ kind: 'notFound' });
      } finally {
        fixture.cleanup();
      }
    });

    it('loads a detached normalized Session and an opaque version token', () => {
      const fixture = createFixture();
      try {
        const expected = sessionState();
        fixture.seed(expected);

        const result = fixture.store.load(expected.sessionId);

        expect(result).toMatchObject({ kind: 'loaded', state: expected });
        if (result.kind !== 'loaded') throw new Error('expected loaded state');
        expect(Object.keys(result.version)).toEqual([]);
        (result.state.route as { anchorId: string }).anchorId = 'forged';
        expect(fixture.store.load(expected.sessionId)).toMatchObject({
          kind: 'loaded',
          state: { route: { anchorId: 'om_root' } },
        });
      } finally {
        fixture.cleanup();
      }
    });

    it('applies a semantic rename and preserves fields outside the Store interface', () => {
      const fixture = createFixture();
      try {
        const before = sessionState();
        fixture.seed(before, { futureCapability: { enabled: true } });
        const loaded = fixture.store.load(before.sessionId);
        if (loaded.kind !== 'loaded') throw new Error('expected loaded state');

        const applied = fixture.store.apply({
          sessionId: before.sessionId,
          expected: loaded.version,
          transition: {
            kind: 'rename',
            title: 'After',
            updatedAt: '2026-08-10T01:02:03.000Z',
            source: 'dashboard',
          },
        });

        expect(applied).toMatchObject({
          kind: 'applied',
          state: {
            title: 'After',
            titleUpdatedAt: '2026-08-10T01:02:03.000Z',
            titleSource: 'dashboard',
          },
        });
        expect(fixture.store.load(before.sessionId)).toMatchObject({
          kind: 'loaded',
          state: { title: 'After', titleSource: 'dashboard' },
        });
        expect(fixture.readExtra(before.sessionId, 'futureCapability')).toEqual({ enabled: true });
      } finally {
        fixture.cleanup();
      }
    });

    it('rejects a stale exact-source version without overwriting the winner', () => {
      const fixture = createFixture();
      try {
        const before = sessionState();
        fixture.seed(before);
        const stale = fixture.store.load(before.sessionId);
        if (stale.kind !== 'loaded') throw new Error('expected loaded state');
        fixture.replace(sessionState({ title: 'Concurrent winner' }));

        const result = fixture.store.apply({
          sessionId: before.sessionId,
          expected: stale.version,
          transition: {
            kind: 'rename',
            title: 'Stale writer',
            updatedAt: '2026-08-10T01:02:03.000Z',
            source: 'user',
          },
        });

        expect(result).toMatchObject({
          kind: 'conflict',
          current: { state: { title: 'Concurrent winner' } },
        });
        expect(fixture.store.load(before.sessionId)).toMatchObject({
          kind: 'loaded',
          state: { title: 'Concurrent winner' },
        });
      } finally {
        fixture.cleanup();
      }
    });

    it('returns notApplied only when a prewrite failure leaves the exact prior source', () => {
      const fixture = createFixture();
      try {
        const before = sessionState();
        fixture.seed(before);
        const loaded = fixture.store.load(before.sessionId);
        if (loaded.kind !== 'loaded') throw new Error('expected loaded state');
        fixture.faultNext({ stage: 'beforePublish' });

        const result = fixture.store.apply({
          sessionId: before.sessionId,
          expected: loaded.version,
          transition: {
            kind: 'rename',
            title: 'Must not appear',
            updatedAt: '2026-08-10T01:02:03.000Z',
            source: 'user',
          },
        });

        expect(result).toMatchObject({ kind: 'notApplied' });
        expect(fixture.store.load(before.sessionId)).toMatchObject({
          kind: 'loaded',
          state: { title: 'Before' },
        });
      } finally {
        fixture.cleanup();
      }
    });

    it('classifies response loss after publication by exact intended-state readback', () => {
      const fixture = createFixture();
      try {
        const before = sessionState();
        fixture.seed(before);
        const loaded = fixture.store.load(before.sessionId);
        if (loaded.kind !== 'loaded') throw new Error('expected loaded state');
        fixture.faultNext({ stage: 'afterPublishBeforeReturn' });

        const result = fixture.store.apply({
          sessionId: before.sessionId,
          expected: loaded.version,
          transition: {
            kind: 'rename',
            title: 'Published despite response loss',
            updatedAt: '2026-08-10T01:02:03.000Z',
            source: 'dashboard',
          },
        });

        expect(result).toMatchObject({
          kind: 'applied',
          state: { title: 'Published despite response loss' },
        });
        expect(fixture.store.load(before.sessionId)).toMatchObject({
          kind: 'loaded',
          state: { title: 'Published despite response loss' },
        });
      } finally {
        fixture.cleanup();
      }
    });

    it('returns unknown when publication may have happened and readback is unavailable', () => {
      const fixture = createFixture();
      try {
        const before = sessionState();
        fixture.seed(before);
        const loaded = fixture.store.load(before.sessionId);
        if (loaded.kind !== 'loaded') throw new Error('expected loaded state');
        fixture.faultNext({
          stage: 'afterPublishBeforeReturn',
          readback: 'unavailable',
        });

        const result = fixture.store.apply({
          sessionId: before.sessionId,
          expected: loaded.version,
          transition: {
            kind: 'rename',
            title: 'Unprovable publication',
            updatedAt: '2026-08-10T01:02:03.000Z',
            source: 'user',
          },
        });

        expect(result).toMatchObject({ kind: 'unknown' });
        expect(result).not.toHaveProperty('nextVersion');
      } finally {
        fixture.cleanup();
      }
    });

    it('does not claim notApplied when even a prewrite failure lacks strict readback', () => {
      const fixture = createFixture();
      try {
        const before = sessionState();
        fixture.seed(before);
        const loaded = fixture.store.load(before.sessionId);
        if (loaded.kind !== 'loaded') throw new Error('expected loaded state');
        fixture.faultNext({ stage: 'beforePublish', readback: 'unavailable' });

        expect(fixture.store.apply({
          sessionId: before.sessionId,
          expected: loaded.version,
          transition: {
            kind: 'rename',
            title: 'Cannot be proven absent',
            updatedAt: '2026-08-10T01:02:03.000Z',
            source: 'user',
          },
        })).toMatchObject({ kind: 'unknown' });
      } finally {
        fixture.cleanup();
      }
    });

    it('fails closed on a corrupt Session source', () => {
      const fixture = createFixture();
      try {
        fixture.replaceSourceWith('corrupt');
        expect(fixture.store.load('session-one')).toMatchObject({ kind: 'corrupt' });
      } finally {
        fixture.cleanup();
      }
    });

    it('distinguishes an unavailable Store from corrupt persisted bytes', () => {
      const fixture = createFixture();
      try {
        fixture.replaceSourceWith('unavailable');
        expect(fixture.store.load('session-one')).toMatchObject({ kind: 'unavailable' });
      } finally {
        fixture.cleanup();
      }
    });

    it('cannot apply through a source that became corrupt after load', () => {
      const fixture = createFixture();
      try {
        const before = sessionState();
        fixture.seed(before);
        const loaded = fixture.store.load(before.sessionId);
        if (loaded.kind !== 'loaded') throw new Error('expected loaded state');
        fixture.replaceSourceWith('corrupt');

        expect(fixture.store.apply({
          sessionId: before.sessionId,
          expected: loaded.version,
          transition: {
            kind: 'rename',
            title: 'Must fail closed',
            updatedAt: '2026-08-10T01:02:03.000Z',
            source: 'dashboard',
          },
        })).toMatchObject({ kind: 'unknown' });
      } finally {
        fixture.cleanup();
      }
    });

    it('distinguishes a future source version from ordinary corruption', () => {
      const fixture = createFixture();
      try {
        fixture.replaceSourceWith('futureVersion');
        expect(fixture.store.load('session-one')).toMatchObject({ kind: 'futureVersion' });
      } finally {
        fixture.cleanup();
      }
    });

    it('rejects a StoreVersion minted by another Adapter epoch', () => {
      const fixture = createFixture();
      try {
        const before = sessionState();
        fixture.seed(before);
        const foreignVersion = fixture.versionFromAnotherEpoch(before.sessionId);

        expect(fixture.store.apply({
          sessionId: before.sessionId,
          expected: foreignVersion,
          transition: {
            kind: 'rename',
            title: 'Foreign epoch',
            updatedAt: '2026-08-10T01:02:03.000Z',
            source: 'user',
          },
        })).toMatchObject({ kind: 'conflict' });
        expect(fixture.store.load(before.sessionId)).toMatchObject({
          kind: 'loaded',
          state: { title: 'Before' },
        });
      } finally {
        fixture.cleanup();
      }
    });
  });
}

defineSessionStoreContract('in-memory', () => {
  const store = createInMemorySessionStore({ runtimeEpoch: 'epoch-one' });
  return {
    store,
    seed: (state, extra) => store.seed(state, extra),
    replace: state => store.replace(state),
    readExtra: (sessionId, field) => store.readExtra(sessionId, field),
    faultNext: fault => store.faultNext(fault),
    replaceSourceWith: kind => store.replaceSourceWith(kind),
    versionFromAnotherEpoch(sessionId) {
      const foreign = createInMemorySessionStore({ runtimeEpoch: 'epoch-two' });
      foreign.seed(sessionState({ sessionId }));
      const result = foreign.load(sessionId);
      if (result.kind !== 'loaded') throw new Error('expected foreign loaded state');
      return result.version;
    },
    cleanup() {},
  };
});

defineSessionStoreContract('Current', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'session-store-contract-'));
  const previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  const file = join(dataDir, 'sessions-contract-owner.json');
  let nextFault: Parameters<ContractFixture['faultNext']>[0] | undefined;
  let loadUnavailable = false;
  const faults: CurrentSessionStoreFaults = {
    beforeLoad() {
      if (loadUnavailable) throw new Error('injected Store unavailability');
    },
    beforePublish() {
      if (nextFault?.stage === 'beforePublish') throw new Error('injected prewrite failure');
    },
    afterPublishBeforeReturn() {
      if (nextFault?.stage === 'afterPublishBeforeReturn') throw new Error('injected response loss');
    },
    beforeRecoveryRead() {
      const fault = nextFault;
      nextFault = undefined;
      if (fault?.readback === 'unavailable') throw new Error('injected readback failure');
    },
  };
  return {
    store: createCurrentSessionStore({
      ownerLarkAppId: 'contract-owner',
      runtimeEpoch: 'epoch-one',
      faults,
    }),
    seed(state, extra) {
      writeFileSync(file, JSON.stringify({
        [state.sessionId]: currentRow(state, extra),
      }, null, 2));
    },
    replace(state) {
      const source = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
      source[state.sessionId] = currentRow(state);
      writeFileSync(file, JSON.stringify(source, null, 2));
    },
    readExtra(sessionId, field) {
      const source = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
      return source[sessionId]?.[field];
    },
    faultNext(fault) {
      nextFault = fault;
    },
    replaceSourceWith(kind) {
      if (kind === 'unavailable') {
        loadUnavailable = true;
        return;
      }
      writeFileSync(
        file,
        kind === 'corrupt'
          ? '{ broken'
          : JSON.stringify({ schemaVersion: 2, sessions: {} }, null, 2),
      );
    },
    versionFromAnotherEpoch(sessionId) {
      const foreign = createCurrentSessionStore({
        ownerLarkAppId: 'contract-owner',
        runtimeEpoch: 'epoch-two',
      }).load(sessionId);
      if (foreign.kind !== 'loaded') throw new Error('expected foreign loaded state');
      return foreign.version;
    },
    cleanup() {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
});

describe('Current SessionStore ownership and structural gate', () => {
  it('changes the working directory and clears stale Riff repository grants atomically', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-store-cwd-'));
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    try {
      const state = sessionState({
        workingDir: '/roles/old',
        riffRepoDirs: ['/roles/old/repo'],
      });
      const file = join(dataDir, 'sessions-owner-a.json');
      writeFileSync(file, JSON.stringify({
        [state.sessionId]: currentRow(state, {
          larkAppId: 'owner-a',
          workingDir: state.workingDir,
          riffRepoDirs: state.riffRepoDirs,
          futureCapability: { enabled: true },
        }),
      }, null, 2));
      const store = createCurrentSessionStore({
        ownerLarkAppId: 'owner-a',
        runtimeEpoch: 'epoch-cwd',
      });
      const loaded = store.load(state.sessionId);
      if (loaded.kind !== 'loaded') throw new Error('expected loaded state');

      expect(store.apply({
        sessionId: state.sessionId,
        expected: loaded.version,
        transition: { kind: 'changeWorkingDirectory', workingDir: '/roles/new' },
      })).toMatchObject({
        kind: 'applied',
        state: { workingDir: '/roles/new', riffRepoDirs: undefined },
      });
      const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
      expect(persisted[state.sessionId]).toMatchObject({
        workingDir: '/roles/new',
        futureCapability: { enabled: true },
      });
      expect(persisted[state.sessionId]).not.toHaveProperty('riffRepoDirs');
    } finally {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('binds one owner file and rejects a row that claims another owner', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-store-owner-'));
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    try {
      const state = sessionState();
      writeFileSync(join(dataDir, 'sessions-owner-a.json'), JSON.stringify({
        [state.sessionId]: currentRow(state, { larkAppId: 'owner-a' }),
      }));
      writeFileSync(join(dataDir, 'sessions-owner-b.json'), JSON.stringify({
        [state.sessionId]: currentRow({ ...state, title: 'Owner B' }, { larkAppId: 'owner-b' }),
      }));
      const store = createCurrentSessionStore({
        ownerLarkAppId: 'owner-a',
        runtimeEpoch: 'epoch-owner',
      });
      expect(store.load(state.sessionId)).toMatchObject({
        kind: 'loaded',
        state: { title: 'Before' },
      });

      writeFileSync(join(dataDir, 'sessions-owner-a.json'), JSON.stringify({
        [state.sessionId]: currentRow(state, { larkAppId: 'owner-b' }),
      }));
      expect(store.load(state.sessionId)).toMatchObject({ kind: 'corrupt' });
    } finally {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a valid-JSON row whose normalized Session fields are malformed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-store-structure-'));
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    try {
      const state = sessionState();
      writeFileSync(join(dataDir, 'sessions-owner-a.json'), JSON.stringify({
        [state.sessionId]: { ...currentRow(state), title: 42 },
      }));
      const store = createCurrentSessionStore({
        ownerLarkAppId: 'owner-a',
        runtimeEpoch: 'epoch-owner',
      });

      expect(store.load(state.sessionId)).toMatchObject({ kind: 'corrupt' });
    } finally {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves fields learned from fresh Store state across a later legacy cache save', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-store-cache-merge-'));
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    try {
      initLegacySessionStore('owner-a');
      const legacy = createLegacySession('oc_chat', 'om_root', 'Before', 'group', 'thread');
      legacy.larkAppId = 'owner-a';
      legacy.workerGeneration = 3;
      updateLegacySession(legacy);

      const file = join(dataDir, 'sessions-owner-a.json');
      const externallyEnriched = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        Record<string, unknown>
      >;
      externallyEnriched[legacy.sessionId]!.futureCapability = {
        version: 7,
        enabled: true,
      };
      writeFileSync(file, JSON.stringify(externallyEnriched, null, 2));

      const store = createCurrentSessionStore({
        ownerLarkAppId: 'owner-a',
        runtimeEpoch: 'epoch-cache-merge',
      });
      const loaded = store.load(legacy.sessionId);
      if (loaded.kind !== 'loaded') throw new Error('expected loaded state');
      expect(store.apply({
        sessionId: legacy.sessionId,
        expected: loaded.version,
        transition: {
          kind: 'rename',
          title: 'After',
          updatedAt: '2026-08-10T01:02:03.000Z',
          source: 'dashboard',
        },
      })).toMatchObject({ kind: 'applied' });

      legacy.lastMessageAt = '2026-08-10T01:03:00.000Z';
      updateLegacySession(legacy);

      const afterLegacySave = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        Record<string, unknown>
      >;
      expect(afterLegacySave[legacy.sessionId]?.futureCapability).toEqual({
        version: 7,
        enabled: true,
      });
    } finally {
      initLegacySessionStore();
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
