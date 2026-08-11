import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCurrentOrdinaryRouteRegistryRuntime } from '../src/core/current-ordinary-route-registry.js';
import {
  currentSessionCommandLane,
  currentSessionLaneAddress,
} from '../src/core/current-session-command-lane.js';
import {
  createSessionRuntimeHost,
  type ControlMutationPort,
  type ExecutorAddress,
  type ExecutorObservationPort,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type SessionDirectory,
} from '../src/core/session-runtime.js';
import type { DispatchInputCommitEvidencePort } from '../src/core/dispatch-input-commit-evidence.js';
import type { SessionStore } from '../src/core/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import * as sessionStore from '../src/services/session-store.js';
import type { Session } from '../src/types.js';

const OWNER = 'app-relocate-scratch-lane';
const RUNTIME_EPOCH = 'epoch-relocate-scratch-lane';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function current(input: {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  scope: 'thread' | 'chat';
  scratch?: boolean;
}): DaemonSession {
  const session: Session = {
    sessionId: input.sessionId,
    larkAppId: OWNER,
    chatId: input.chatId,
    rootMessageId: input.rootMessageId,
    scope: input.scope,
    chatType: 'group',
    status: 'active',
    title: input.sessionId,
    createdAt: '2026-08-12T00:00:00.000Z',
    ...(input.scratch ? {} : { cliId: 'codex', lastCliInput: 'existing turn' }),
  };
  return {
    session,
    worker: input.scratch ? null : { killed: false },
    workerPort: null,
    workerToken: null,
    workerGeneration: input.scratch ? 0 : 1,
    larkAppId: OWNER,
    chatId: input.chatId,
    chatType: 'group',
    scope: input.scope,
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: !input.scratch,
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

function directoryFor(activeSessions: Map<string, DaemonSession>): SessionDirectory {
  return {
    async read(query) {
      const rows = [...activeSessions.values()].map(ds => ({
        key: ds.session.sessionId,
        sessionId: ds.session.sessionId,
        route: ds.scope === 'chat'
          ? { kind: 'chat' as const, chatId: ds.chatId }
          : { kind: 'thread' as const, anchorId: ds.session.rootMessageId },
        ordinaryIngressBinding: {
          scope: ds.scope,
          canonicalAnchor: ds.scope === 'chat' ? ds.chatId : ds.session.rootMessageId,
          chatId: ds.chatId,
          chatType: ds.chatType,
        },
        recordStatus: 'active' as const,
        executorStatus: ds.worker ? 'idle' as const : 'dormant' as const,
      }));
      if (query.kind === 'list') return { kind: 'list', rows };
      const matches = query.kind === 'byExternalSession'
        ? rows.filter(row => row.sessionId === query.sessionId)
        : rows.filter(row => (
            row.route.kind === 'chat' && query.route.kind === 'chat'
              ? row.route.chatId === query.route.chatId
              : row.route.kind === 'thread' && query.route.kind === 'thread'
                && row.route.anchorId === query.route.anchorId
          ));
      if (matches.length === 0) return { kind: 'notFound' };
      if (matches.length > 1) return { kind: 'notReady', message: 'duplicate test route' };
      return { kind: 'one', row: matches[0]! };
    },
  };
}

const unusedKeyedTriggers: KeyedTriggerAuthority = {
  inspect: () => ({ kind: 'unreadable', message: 'unused' }),
  reserve: () => ({ kind: 'unreadable', message: 'unused' }),
  begin: () => ({ kind: 'unreadable', message: 'unused' }),
  settleDispatchUnknown: () => ({ kind: 'unreadable', message: 'unused' }),
};

const unusedKeyedTriggerTurns: KeyedTriggerTurnPort = {
  prepare: () => ({ kind: 'unreadable', message: 'unused' }),
  acceptAtMostOnce: () => ({ kind: 'refused', message: 'unused' }),
  async failClose() { return { kind: 'unreadable', message: 'unused' }; },
};

describe('Current relocate target scratch Session lane', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-relocate-scratch-lane-'));
    previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    sessionStore.init(OWNER);
  });

  afterEach(() => {
    sessionStore.init();
    if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('closes the target scratch once before relocate, queues same-Session control/executor, and leaves another Session parallel', async () => {
    const source = current({
      sessionId: 'session-relocate-source',
      chatId: 'oc_source',
      rootMessageId: 'om_source',
      scope: 'thread',
    });
    const scratch = current({
      sessionId: 'session-target-scratch',
      chatId: 'oc_target',
      rootMessageId: 'oc_target',
      scope: 'chat',
      scratch: true,
    });
    // Live Current rows may retain optional own-properties whose value is
    // undefined, while the exact JSON authority omits those keys. They are the
    // same persisted state and must not quarantine scratch cleanup.
    scratch.session.initialUserTurnPending = undefined;
    const unrelated = current({
      sessionId: 'session-unrelated',
      chatId: 'oc_unrelated',
      rootMessageId: 'om_unrelated',
      scope: 'thread',
    });
    const activeSessions = new Map([
      [activeSessionKey(source), source],
      [activeSessionKey(scratch), scratch],
      [activeSessionKey(unrelated), unrelated],
    ]);
    for (const ds of activeSessions.values()) sessionStore.updateSession(ds.session);

    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const events: string[] = [];
    const effectSessions = new WeakMap<object, string>();
    const continuationSessions = new WeakMap<object, string>();
    const controlMutation: ControlMutationPort = {
      begin(input) {
        events.push(`control.begin:${input.sessionId}:${input.command.kind}`);
        const active = [...activeSessions.values()]
          .find(candidate => candidate.session.sessionId === input.sessionId);
        if (!active) {
          return { kind: 'rejected', reason: 'sessionNotFound', message: 'Session is closed' };
        }
        if (input.command.kind === 'close') {
          expect(input.command).toMatchObject({
            reason: 'relocateScratch',
            expectedRoute: {
              scope: 'chat',
              canonicalAnchor: 'oc_target',
              chatId: 'oc_target',
              chatType: 'group',
            },
          });
          expect(input.routeReservation).toBeDefined();
          const intent = Object.freeze({});
          const continuation = Object.freeze({});
          effectSessions.set(intent, input.sessionId);
          continuationSessions.set(continuation, input.sessionId);
          return { kind: 'effect', intent, continuation };
        }
        if (input.command.kind === 'relocate') {
          return {
            kind: 'committed',
            result: {
              kind: 'relocated',
              targetChatId: input.command.targetChatId,
              targetRootMessageId: input.command.targetRootMessageId,
            },
          };
        }
        return { kind: 'committed', result: { kind: 'lockUpdated', locked: true } };
      },
      async execute(intent) {
        const sessionId = effectSessions.get(intent as object);
        if (!sessionId) throw new Error('unexpected control effect');
        events.push(`control.execute:${sessionId}`);
        closeStarted.resolve();
        await releaseClose.promise;
        return { kind: 'closed', sessionId };
      },
      resume(continuation, settlement) {
        const sessionId = continuationSessions.get(continuation as object);
        if (!sessionId) return { kind: 'unknown', message: 'unknown close continuation' };
        if (settlement.kind === 'threw') return { kind: 'unknown', message: 'close threw' };
        events.push(`control.resume:${sessionId}`);
        const ds = [...activeSessions.values()]
          .find(candidate => candidate.session.sessionId === sessionId);
        if (ds) activeSessions.delete(activeSessionKey(ds));
        sessionStore.closeSession(sessionId);
        return {
          kind: 'committed',
          result: { kind: 'closed', alreadyClosed: false, known: true },
        };
      },
    };

    const scratchExecutor = Object.freeze({}) as ExecutorAddress;
    const unrelatedExecutor = Object.freeze({}) as ExecutorAddress;
    const executorObservations: ExecutorObservationPort = {
      inspect(address) {
        const ds = address === scratchExecutor
          ? scratch
          : address === unrelatedExecutor
            ? unrelated
            : undefined;
        events.push(`executor.inspect:${ds?.session.sessionId ?? 'unknown'}`);
        return ds && activeSessions.has(activeSessionKey(ds))
          ? {
              kind: 'current',
              token: ds,
              sessionId: ds.session.sessionId,
              generation: 1,
            }
          : { kind: 'staleAddress', message: 'Executor is no longer current' };
      },
      reconcileInputCommit({ token }) {
        const ds = token as DaemonSession;
        events.push(`executor.reconcile:${ds.session.sessionId}`);
        return { kind: 'committed' };
      },
    };
    const dispatchInputCommits: DispatchInputCommitEvidencePort = {
      read: () => ({ kind: 'absent' }),
      record(evidence) {
        events.push(`executor.record:${evidence.sessionId}`);
        return { kind: 'recorded' };
      },
    };
    const runtimeStore: SessionStore = {
      load(sessionId) {
        const ds = [...activeSessions.values()]
          .find(candidate => candidate.session.sessionId === sessionId);
        if (!ds) return { kind: 'notFound' };
        return {
          kind: 'loaded',
          state: {
            sessionId,
            route: ds.scope === 'chat'
              ? { kind: 'chat', chatId: ds.chatId }
              : { kind: 'thread', anchorId: ds.session.rootMessageId },
            recordStatus: 'active',
            title: ds.session.title,
            executorGeneration: 1,
            queued: false,
            locked: false,
          },
          version: Object.freeze({}) as never,
        };
      },
      apply: () => ({ kind: 'notApplied', message: 'unused' }),
    };
    const inner = createSessionRuntimeHost({
      directory: directoryFor(activeSessions),
      keyedTriggers: unusedKeyedTriggers,
      keyedTriggerTurns: unusedKeyedTriggerTurns,
      controlMutation,
      executorObservations,
      dispatchInputCommits,
      sessionStore: runtimeStore,
      commandLane: currentSessionCommandLane,
      sessionLaneAddress: sessionId => currentSessionLaneAddress(
        RUNTIME_EPOCH,
        OWNER,
        sessionId,
      ),
    });
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator: {
        begin: () => ({ kind: 'unknown', message: 'unused' }),
        async execute() { throw new Error('unused'); },
        resume: () => ({ kind: 'unknown', message: 'unused' }),
        rollback: () => ({ kind: 'rolledBack' }),
      },
      downstream: inner,
    });
    const scratchView = await inner.projection.read({
      kind: 'byExternalSession',
      sessionId: scratch.session.sessionId,
    });
    const unrelatedView = await inner.projection.read({
      kind: 'byExternalSession',
      sessionId: unrelated.session.sessionId,
    });
    if (scratchView.kind !== 'one' || unrelatedView.kind !== 'one') {
      throw new Error('expected exact test projections');
    }

    const relocating = routeRuntime.submit({
      target: { kind: 'route', route: { kind: 'thread', anchorId: 'om_source' } },
      idempotencyKey: 'relocate-target-scratch-operation',
      command: {
        kind: 'control.mutate',
        input: {
          kind: 'relocate',
          sourceAnchor: 'om_source',
          targetChatId: 'oc_target',
          targetRootMessageId: 'om_target_audit',
          requester: { larkAppId: 'app-leader', openId: 'ou_owner' },
        },
      },
    });

    await vi.waitFor(
      () => expect(events).toContain(`control.execute:${scratch.session.sessionId}`),
      { timeout: 1_000 },
    );
    await closeStarted.promise;
    let scratchControlSettled = false;
    let scratchExecutorSettled = false;
    const scratchControl = inner.runtime.submit({
      target: { kind: 'session', address: scratchView.session.address },
      idempotencyKey: 'scratch-control-after-close',
      command: { kind: 'control.mutate', input: { kind: 'setLocked', locked: true } },
    }).then(outcome => {
      scratchControlSettled = true;
      return outcome;
    });
    const scratchExecutorReport = inner.runtime.submit({
      target: { kind: 'session', address: scratchView.session.address },
      idempotencyKey: 'scratch-executor-after-close',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor: scratchExecutor,
          turnId: 'turn-scratch-close-race',
          committedAt: '2026-08-12T00:00:00.000Z',
        },
      },
    }).then(outcome => {
      scratchExecutorSettled = true;
      return outcome;
    });
    const otherSessionReport = inner.runtime.submit({
      target: { kind: 'session', address: unrelatedView.session.address },
      idempotencyKey: 'unrelated-executor-during-close',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor: unrelatedExecutor,
          turnId: 'turn-unrelated-close-race',
          committedAt: '2026-08-12T00:00:00.000Z',
        },
      },
    });

    await expect(otherSessionReport).resolves.toMatchObject({
      kind: 'applied',
      sessionId: unrelated.session.sessionId,
    });
    expect(scratchControlSettled).toBe(false);
    expect(scratchExecutorSettled).toBe(false);
    expect(events).not.toContain(`executor.inspect:${scratch.session.sessionId}`);

    releaseClose.resolve();
    await expect(relocating).resolves.toMatchObject({
      kind: 'applied',
      result: { kind: 'relocated', targetChatId: 'oc_target' },
    });
    await expect(scratchControl).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'sessionNotFound',
    });
    await expect(scratchExecutorReport).resolves.toMatchObject({ kind: 'staleExecutor' });
    expect(events.filter(event => event === `control.execute:${scratch.session.sessionId}`))
      .toHaveLength(1);
    expect(events.indexOf(`control.resume:${scratch.session.sessionId}`))
      .toBeLessThan(events.indexOf(`control.begin:${scratch.session.sessionId}:setLocked`));
    expect(events.indexOf(`control.resume:${scratch.session.sessionId}`))
      .toBeLessThan(events.indexOf(`executor.inspect:${scratch.session.sessionId}`));
  });
});
