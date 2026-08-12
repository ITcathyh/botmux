import { describe, expect, it, vi } from 'vitest';

import {
  currentRouteAdmissionKey,
  reserveCurrentRouteAdmission,
} from '../src/core/current-route-admission.js';
import { createCurrentRouteScratchRetirementPort } from '../src/core/current-route-scratch-retirement.js';
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

const OWNER = 'app-route-scratch-retirement';
const ROUTE = {
  scope: 'chat' as const,
  canonicalAnchor: 'oc_route_scratch',
  chatId: 'oc_route_scratch',
  chatType: 'group' as const,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

interface RowState {
  readonly sessionId: string;
  readonly chatId: string;
  readonly anchor: string;
  readonly scope: 'thread' | 'chat';
  active: boolean;
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

function directoryFor(rows: readonly RowState[]): SessionDirectory {
  return {
    async read(query) {
      const directoryRows = rows.map(row => ({
        key: row.sessionId,
        sessionId: row.sessionId,
        route: row.scope === 'chat'
          ? { kind: 'chat' as const, chatId: row.chatId }
          : { kind: 'thread' as const, anchorId: row.anchor },
        ordinaryIngressBinding: {
          scope: row.scope,
          canonicalAnchor: row.anchor,
          chatId: row.chatId,
          chatType: 'group' as const,
        },
        recordStatus: row.active ? 'active' as const : 'closed' as const,
        executorStatus: 'dormant' as const,
      }));
      if (query.kind === 'list') return { kind: 'list', rows: directoryRows };
      if (query.kind === 'dashboardSnapshot') {
        return { kind: 'notReady', message: 'unused Dashboard projection' };
      }
      const matches = query.kind === 'byExternalSession'
        ? directoryRows.filter(row => row.sessionId === query.sessionId)
        : directoryRows.filter(row => (
            row.route.kind === 'chat' && query.route.kind === 'chat'
              ? row.route.chatId === query.route.chatId
              : row.route.kind === 'thread' && query.route.kind === 'thread'
                && row.route.anchorId === query.route.anchorId
          ));
      if (matches.length === 0) return { kind: 'notFound' };
      if (matches.length > 1) return { kind: 'notReady', message: 'ambiguous test route' };
      return { kind: 'one', row: matches[0]! };
    },
  };
}

function runtimeStore(rows: readonly RowState[]): SessionStore {
  return {
    load(sessionId) {
      const row = rows.find(candidate => candidate.sessionId === sessionId);
      if (!row) return { kind: 'notFound' };
      return {
        kind: 'loaded',
        state: {
          sessionId,
          route: row.scope === 'chat'
            ? { kind: 'chat', chatId: row.chatId }
            : { kind: 'thread', anchorId: row.anchor },
          recordStatus: row.active ? 'active' : 'closed',
          title: sessionId,
          executorGeneration: 1,
          queued: false,
          locked: false,
        },
        version: Object.freeze({}) as never,
      };
    },
    apply: () => ({ kind: 'notApplied', message: 'unused' }),
  };
}

describe('Current route scratch retirement', () => {
  it('closes every initially classified live or persisted-only scratch through opaque Session addresses', async () => {
    const rows: RowState[] = [
      { sessionId: 'scratch-live', chatId: ROUTE.chatId, anchor: ROUTE.canonicalAnchor, scope: 'chat', active: true },
      { sessionId: 'scratch-persisted', chatId: ROUTE.chatId, anchor: ROUTE.canonicalAnchor, scope: 'chat', active: true },
    ];
    const commands: Array<{ sessionId: string; operationIdentity: string; source?: string }> = [];
    const controlMutation: ControlMutationPort = {
      begin(input) {
        commands.push({
          sessionId: input.sessionId,
          operationIdentity: input.operationIdentity,
          source: input.command.kind === 'close' ? input.command.source : undefined,
        });
        const row = rows.find(candidate => candidate.sessionId === input.sessionId);
        if (!row?.active) return { kind: 'staleAddress' };
        row.active = false;
        return {
          kind: 'committed',
          result: { kind: 'closed', alreadyClosed: false, known: true },
        };
      },
      async execute() { throw new Error('unused'); },
      resume: () => ({ kind: 'unknown', message: 'unused' }),
    };
    const host = createSessionRuntimeHost({
      directory: directoryFor(rows),
      keyedTriggers: unusedKeyedTriggers,
      keyedTriggerTurns: unusedKeyedTriggerTurns,
      controlMutation,
    });
    const retirement = createCurrentRouteScratchRetirementPort({
      ownerLarkAppId: OWNER,
      downstream: () => host,
    });
    const admission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      ...ROUTE,
    }));
    await admission.ready;

    await expect(retirement.retire({
      expectedRoute: ROUTE,
      source: 'resume',
      parentSessionId: 'closed-parent',
      parentOperationIdentity: 'reopen-live-and-durable',
      heldRouteAdmissionToken: admission.token,
    })).resolves.toEqual({ kind: 'cleared' });
    admission.release();

    expect(rows.every(row => !row.active)).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands.map(command => command.source)).toEqual(['resume', 'resume']);
    expect(commands[0]!.operationIdentity).toBe(commands[1]!.operationIdentity);
    expect(commands[0]!.operationIdentity).toMatch(/^route-scratch:/);
  });

  it('does not classify a deferred-anchor Session delivered into the same chat as the route occupant', async () => {
    // A deferredScheduleRun Session is isolated on its own routingAnchor while
    // its visible delivery surface is the reopened chat: the census must use
    // the canonical anchor — matching on the visible route would nominate this
    // session, the control Adapter's sessionAnchorId guard would then reject
    // the close, and the reopen would abort with a phantom `occupied` even
    // though the canonical anchor is free.
    const rows: RowState[] = [{
      sessionId: 'deferred-schedule-run',
      chatId: ROUTE.chatId,
      anchor: 'schedule-run:isolated-anchor',
      scope: 'chat',
      active: true,
    }];
    const begin = vi.fn(() => ({
      kind: 'committed' as const,
      result: { kind: 'closed' as const, alreadyClosed: false, known: true },
    }));
    const host = createSessionRuntimeHost({
      directory: directoryFor(rows),
      keyedTriggers: unusedKeyedTriggers,
      keyedTriggerTurns: unusedKeyedTriggerTurns,
      controlMutation: {
        begin,
        async execute() { throw new Error('unused'); },
        resume: () => ({ kind: 'unknown', message: 'unused' }),
      },
    });
    const retirement = createCurrentRouteScratchRetirementPort({
      ownerLarkAppId: OWNER,
      downstream: () => host,
    });
    const admission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      ...ROUTE,
    }));
    await admission.ready;

    await expect(retirement.retire({
      expectedRoute: ROUTE,
      source: 'resume',
      parentSessionId: 'closed-parent',
      parentOperationIdentity: 'reopen-over-deferred-neighbor',
      heldRouteAdmissionToken: admission.token,
    })).resolves.toEqual({ kind: 'cleared' });
    admission.release();

    expect(begin).not.toHaveBeenCalled();
    expect(rows[0]!.active).toBe(true); // the deferred neighbor is untouched
  });

  it.each(['closed', 'moved'] as const)(
    'treats a candidate that became %s before exact reprojection as departed',
    async (departure) => {
      const candidate: RowState = {
        sessionId: `scratch-${departure}`,
        chatId: ROUTE.chatId,
        anchor: ROUTE.canonicalAnchor,
        scope: 'chat',
        active: true,
      };
      const rows = [candidate];
      const baseDirectory = directoryFor(rows);
      const directory: SessionDirectory = {
        async read(query) {
          if (query.kind === 'byExternalSession') {
            if (departure === 'closed') candidate.active = false;
            else {
              // Production coupling: a relocated chat-scope session moves its
              // canonical anchor together with its visible chat.
              candidate.chatId = 'oc_moved_route';
          candidate.anchor = 'oc_moved_route';
              candidate.anchor = 'oc_moved_route';
            }
          }
          return baseDirectory.read(query);
        },
      };
      const begin = vi.fn(() => ({
        kind: 'committed' as const,
        result: { kind: 'closed' as const, alreadyClosed: false, known: true },
      }));
      const host = createSessionRuntimeHost({
        directory,
        keyedTriggers: unusedKeyedTriggers,
        keyedTriggerTurns: unusedKeyedTriggerTurns,
        controlMutation: {
          begin,
          async execute() { throw new Error('unused'); },
          resume: () => ({ kind: 'unknown', message: 'unused' }),
        },
      });
      const retirement = createCurrentRouteScratchRetirementPort({
        ownerLarkAppId: OWNER,
        downstream: () => host,
      });
      const admission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
        ownerLarkAppId: OWNER,
        ...ROUTE,
      }));
      await admission.ready;

      const result = await retirement.retire({
        expectedRoute: ROUTE,
        source: 'resume',
        parentSessionId: 'closed-parent',
        parentOperationIdentity: `reopen-${departure}-candidate`,
        heldRouteAdmissionToken: admission.token,
      });
      admission.release();

      expect(result).toEqual({ kind: 'cleared' });
      expect(begin).not.toHaveBeenCalled();
    },
  );

  it('lets the final route census identify a replacement after the original candidate moved', async () => {
    const candidate: RowState = {
      sessionId: 'scratch-moved-before-exact',
      chatId: ROUTE.chatId,
      anchor: ROUTE.canonicalAnchor,
      scope: 'chat',
      active: true,
    };
    const replacement: RowState = {
      sessionId: 'replacement-route-owner',
      chatId: ROUTE.chatId,
      anchor: ROUTE.canonicalAnchor,
      scope: 'chat',
      active: true,
    };
    const rows = [candidate];
    const baseDirectory = directoryFor(rows);
    const directory: SessionDirectory = {
      async read(query) {
        if (query.kind === 'byExternalSession') {
          candidate.chatId = 'oc_moved_route';
          candidate.anchor = 'oc_moved_route';
          rows.push(replacement);
        }
        return baseDirectory.read(query);
      },
    };
    const begin = vi.fn(() => ({
      kind: 'committed' as const,
      result: { kind: 'closed' as const, alreadyClosed: false, known: true },
    }));
    const host = createSessionRuntimeHost({
      directory,
      keyedTriggers: unusedKeyedTriggers,
      keyedTriggerTurns: unusedKeyedTriggerTurns,
      controlMutation: {
        begin,
        async execute() { throw new Error('unused'); },
        resume: () => ({ kind: 'unknown', message: 'unused' }),
      },
    });
    const retirement = createCurrentRouteScratchRetirementPort({
      ownerLarkAppId: OWNER,
      downstream: () => host,
    });
    const admission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      ...ROUTE,
    }));
    await admission.ready;

    const result = await retirement.retire({
      expectedRoute: ROUTE,
      source: 'resume',
      parentSessionId: 'closed-parent',
      parentOperationIdentity: 'reopen-replacement-census',
      heldRouteAdmissionToken: admission.token,
    });
    admission.release();

    expect(result).toEqual({
      kind: 'occupied',
      activeSessionId: replacement.sessionId,
    });

    expect(begin).not.toHaveBeenCalled();
  });

  it('retries safely before any child effect and reuses one stable child identity', async () => {
    const rows: RowState[] = [{
      sessionId: 'scratch-pre-effect-retry',
      chatId: ROUTE.chatId,
      anchor: ROUTE.canonicalAnchor,
      scope: 'chat',
      active: true,
    }];
    const operationIdentities: string[] = [];
    const controlMutation: ControlMutationPort = {
      begin(input) {
        operationIdentities.push(input.operationIdentity);
        rows[0]!.active = false;
        return {
          kind: 'committed',
          result: { kind: 'closed', alreadyClosed: false, known: true },
        };
      },
      async execute() { throw new Error('unused'); },
      resume: () => ({ kind: 'unknown', message: 'unused' }),
    };
    let host: ReturnType<typeof createSessionRuntimeHost> | undefined;
    const retirement = createCurrentRouteScratchRetirementPort({
      ownerLarkAppId: OWNER,
      downstream: () => {
        if (!host) throw new Error('host booting');
        return host;
      },
    });
    const admission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      ...ROUTE,
    }));
    await admission.ready;
    const input = {
      expectedRoute: ROUTE,
      source: 'resume' as const,
      parentSessionId: 'closed-parent',
      parentOperationIdentity: 'reopen-pre-effect-retry',
      heldRouteAdmissionToken: admission.token,
    };

    await expect(retirement.retire(input)).resolves.toMatchObject({ kind: 'retryable' });
    host = createSessionRuntimeHost({
      directory: directoryFor(rows),
      keyedTriggers: unusedKeyedTriggers,
      keyedTriggerTurns: unusedKeyedTriggerTurns,
      controlMutation,
    });
    await expect(retirement.retire(input)).resolves.toEqual({ kind: 'cleared' });
    admission.release();

    expect(operationIdentities).toHaveLength(1);
    expect(operationIdentities[0]).toMatch(/^route-scratch:/);
  });

  it('keeps an unknown child close sticky across parent retries without repeating the effect', async () => {
    const rows: RowState[] = [{
      sessionId: 'scratch-unknown-sticky',
      chatId: ROUTE.chatId,
      anchor: ROUTE.canonicalAnchor,
      scope: 'chat',
      active: true,
    }];
    const begin = vi.fn(() => {
      const intent = Object.freeze({});
      const continuation = Object.freeze({});
      return { kind: 'effect' as const, intent, continuation };
    });
    const execute = vi.fn(async () => 'child-close-response-lost');
    const resume = vi.fn(() => ({
      kind: 'unknown' as const,
      message: 'child close outcome unknown',
    }));
    const host = createSessionRuntimeHost({
      directory: directoryFor(rows),
      keyedTriggers: unusedKeyedTriggers,
      keyedTriggerTurns: unusedKeyedTriggerTurns,
      controlMutation: { begin, execute, resume },
    });
    const retirement = createCurrentRouteScratchRetirementPort({
      ownerLarkAppId: OWNER,
      downstream: () => host,
    });
    const admission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      ...ROUTE,
    }));
    await admission.ready;
    const input = {
      expectedRoute: ROUTE,
      source: 'resume' as const,
      parentSessionId: 'closed-parent',
      parentOperationIdentity: 'reopen-unknown-child',
      heldRouteAdmissionToken: admission.token,
    };

    await expect(retirement.retire(input)).resolves.toMatchObject({
      kind: 'unknown',
      message: 'child close outcome unknown',
    });
    await expect(retirement.retire(input)).resolves.toMatchObject({
      kind: 'unknown',
      message: 'child close outcome unknown',
    });
    admission.release();

    expect(begin).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('keeps same-scratch control and executor FIFO while another Session remains parallel', async () => {
    const scratch: RowState = {
      sessionId: 'scratch-fifo',
      chatId: ROUTE.chatId,
      anchor: ROUTE.canonicalAnchor,
      scope: 'chat',
      active: true,
    };
    const unrelated: RowState = {
      sessionId: 'session-unrelated',
      chatId: 'oc_unrelated',
      anchor: 'om_unrelated',
      scope: 'thread',
      active: true,
    };
    const rows = [scratch, unrelated];
    const closeStarted = deferred();
    const releaseClose = deferred();
    const intents = new WeakMap<object, string>();
    const continuations = new WeakMap<object, string>();
    const events: string[] = [];
    const controlMutation: ControlMutationPort = {
      begin(input) {
        events.push(`control.begin:${input.sessionId}:${input.command.kind}`);
        const row = rows.find(candidate => candidate.sessionId === input.sessionId);
        if (!row?.active) {
          return { kind: 'rejected', reason: 'sessionNotFound', message: 'closed' };
        }
        if (input.command.kind !== 'close') {
          return { kind: 'committed', result: { kind: 'lockUpdated', locked: true } };
        }
        expect(input.command.source).toBe('resume');
        const intent = Object.freeze({});
        const continuation = Object.freeze({});
        intents.set(intent, input.sessionId);
        continuations.set(continuation, input.sessionId);
        return { kind: 'effect', intent, continuation };
      },
      async execute(intent) {
        const sessionId = intents.get(intent as object)!;
        events.push(`control.execute:${sessionId}`);
        closeStarted.resolve();
        await releaseClose.promise;
        return sessionId;
      },
      resume(continuation, settlement) {
        const sessionId = continuations.get(continuation as object)!;
        if (settlement.kind === 'threw') return { kind: 'unknown', message: 'close threw' };
        rows.find(row => row.sessionId === sessionId)!.active = false;
        events.push(`control.resume:${sessionId}`);
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
        const row = address === scratchExecutor
          ? scratch
          : address === unrelatedExecutor
            ? unrelated
            : undefined;
        events.push(`executor.inspect:${row?.sessionId ?? 'unknown'}`);
        return row?.active
          ? { kind: 'current', token: row, sessionId: row.sessionId, generation: 1 }
          : { kind: 'staleAddress', message: 'closed' };
      },
      reconcileInputCommit: () => ({ kind: 'committed' }),
    };
    const dispatchInputCommits: DispatchInputCommitEvidencePort = {
      read: () => ({ kind: 'absent' }),
      record: () => ({ kind: 'recorded' }),
    };
    const host = createSessionRuntimeHost({
      directory: directoryFor(rows),
      keyedTriggers: unusedKeyedTriggers,
      keyedTriggerTurns: unusedKeyedTriggerTurns,
      controlMutation,
      executorObservations,
      dispatchInputCommits,
      sessionStore: runtimeStore(rows),
    });
    const retirement = createCurrentRouteScratchRetirementPort({
      ownerLarkAppId: OWNER,
      downstream: () => host,
    });
    const admission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      ...ROUTE,
    }));
    await admission.ready;
    const scratchView = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: scratch.sessionId,
    });
    const unrelatedView = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: unrelated.sessionId,
    });
    if (scratchView.kind !== 'one' || unrelatedView.kind !== 'one') {
      throw new Error('expected exact test projections');
    }

    const retiring = retirement.retire({
      expectedRoute: ROUTE,
      source: 'resume',
      parentSessionId: 'closed-parent',
      parentOperationIdentity: 'reopen-fifo',
      heldRouteAdmissionToken: admission.token,
    });
    await closeStarted.promise;
    let sameControlSettled = false;
    let sameExecutorSettled = false;
    const sameControl = host.runtime.submit({
      target: { kind: 'session', address: scratchView.session.address },
      idempotencyKey: 'same-scratch-control',
      command: { kind: 'control.mutate', input: { kind: 'setLocked', locked: true } },
    }).then(outcome => {
      sameControlSettled = true;
      return outcome;
    });
    const sameExecutor = host.runtime.submit({
      target: { kind: 'session', address: scratchView.session.address },
      idempotencyKey: 'same-scratch-executor',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor: scratchExecutor,
          turnId: 'same-scratch-turn',
          committedAt: '2026-08-12T00:00:00.000Z',
        },
      },
    }).then(outcome => {
      sameExecutorSettled = true;
      return outcome;
    });
    const otherExecutor = host.runtime.submit({
      target: { kind: 'session', address: unrelatedView.session.address },
      idempotencyKey: 'other-session-executor',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor: unrelatedExecutor,
          turnId: 'other-session-turn',
          committedAt: '2026-08-12T00:00:00.000Z',
        },
      },
    });

    await expect(otherExecutor).resolves.toMatchObject({
      kind: 'applied',
      sessionId: unrelated.sessionId,
    });
    expect(sameControlSettled).toBe(false);
    expect(sameExecutorSettled).toBe(false);

    releaseClose.resolve();
    await expect(retiring).resolves.toEqual({ kind: 'cleared' });
    admission.release();
    await expect(sameControl).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'sessionNotFound',
    });
    await expect(sameExecutor).resolves.toMatchObject({ kind: 'staleExecutor' });
    expect(events.indexOf(`control.resume:${scratch.sessionId}`))
      .toBeLessThan(events.indexOf(`control.begin:${scratch.sessionId}:setLocked`));
    expect(events.indexOf(`control.resume:${scratch.sessionId}`))
      .toBeLessThan(events.indexOf(`executor.inspect:${scratch.sessionId}`));
  });
});
