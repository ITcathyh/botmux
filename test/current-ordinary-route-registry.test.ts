import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCurrentOrdinaryIngressProductionPort,
  type CurrentOrdinaryIngressProductionExternalEffect,
  type CurrentOrdinaryIngressWorkerProcessCommand,
} from '../src/core/current-ordinary-ingress-production.js';
import { currentSessionRuntimeHost } from '../src/core/current-session-runtime.js';
import {
  createCurrentOrdinaryRouteRegistryRuntime,
  type CurrentOrdinaryRouteOpeningRollbackToken,
} from '../src/core/current-ordinary-route-registry.js';
import type {
  NormalizedOrdinaryImTurn,
  OrdinaryImTransportEnvelope,
} from '../src/core/ordinary-im-turn.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type {
  SessionAddress,
  SessionProjection,
  SessionRuntime,
} from '../src/core/session-runtime.js';
import * as sessionStore from '../src/services/session-store.js';
import type { Session } from '../src/types.js';

const OWNER = 'app-current-ordinary-route';
const MESSAGE_KEY = 'om_provider_message_route_create';
const ANCHOR = 'om_current_route_create_root';
const CHAT_ID = 'oc_current_route_create_chat';

let dataDir: string;
let previousDataDir: string | undefined;
let epoch = 0;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function testRollbackToken(): CurrentOrdinaryRouteOpeningRollbackToken {
  return Object.freeze(Object.create(null)) as CurrentOrdinaryRouteOpeningRollbackToken;
}

function turn(input: {
  messageKey?: string;
  anchor?: string;
  chatId?: string;
  content?: string;
} = {}): OrdinaryImTransportEnvelope {
  const messageKey = input.messageKey ?? MESSAGE_KEY;
  const anchor = input.anchor ?? ANCHOR;
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: anchor,
      chatId: input.chatId ?? CHAT_ID,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey,
    content: input.content ?? 'create this ordinary Session once',
    sender: { kind: 'human', openId: 'ou_route_sender', unionId: 'on_route_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function sessionFor(
  ownerLarkAppId: string,
  sessionId: string,
  input: OrdinaryImTransportEnvelope,
): Session {
  return {
    sessionId,
    larkAppId: ownerLarkAppId,
    rootMessageId: input.route.canonicalAnchor,
    chatId: input.route.chatId,
    chatType: input.route.chatType,
    scope: input.route.scope,
    status: 'active',
    title: input.content,
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
}

function liveDaemonSession(
  ownerLarkAppId: string,
  sessionId: string,
  input: OrdinaryImTransportEnvelope,
): DaemonSession {
  const session = sessionFor(ownerLarkAppId, sessionId, input);
  return {
    session,
    worker: { killed: false } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    workerGeneration: 9,
    larkAppId: ownerLarkAppId,
    chatId: input.route.chatId,
    chatType: input.route.chatType,
    scope: input.route.scope,
    spawnedAt: Date.parse(session.createdAt),
    cliVersion: 'test',
    lastMessageAt: Date.parse(session.createdAt),
    hasHistory: true,
  } as DaemonSession;
}

function materialFor(effect: CurrentOrdinaryIngressProductionExternalEffect) {
  const key = effect.input.turn.messageKey;
  return {
    userPrompt: effect.input.turn.content,
    newTopicUserPrompt: `opening:${effect.input.turn.content}`,
    cliInput: { content: `follow-up:${key}` },
    newTopicCliInput: { content: `opening:${key}` },
    adoptCliInput: { content: `adopt:${key}` },
    turnId: key,
  };
}

function createHarness(input: {
  ownerLarkAppId?: string;
  activeSessions?: Map<string, DaemonSession>;
  materializationGate?: Promise<void>;
} = {}) {
  const ownerLarkAppId = input.ownerLarkAppId ?? OWNER;
  const activeSessions = input.activeSessions ?? new Map<string, DaemonSession>();
  const effects: CurrentOrdinaryIngressProductionExternalEffect[] = [];
  const openingSessions: DaemonSession[] = [];
  const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
  const ordinaryIngress = createCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId,
    activeSessions,
    metadata: {
      apply(_current, metadataInput) {
        return {
          kind: 'committed',
          sessionId: metadataInput.binding.sessionId,
          turnId: metadataInput.turn.messageKey,
        };
      },
    },
    clock: () => Date.parse('2026-08-10T00:00:01.000Z'),
    substituteReplyMode: 'thread',
    externalEffects: {
      async execute(effect) {
        effects.push(effect);
        if (input.materializationGate) await input.materializationGate;
        return { kind: 'materialized', material: materialFor(effect) };
      },
    },
    workerProcesses: {
      dispatch(command) {
        workerCommands.push(command);
        return { kind: 'accepted' };
      },
    },
  });
  const hostEpoch = epoch++;
  const openingPlans = new WeakMap<object, NormalizedOrdinaryImTurn>();
  const host = currentSessionRuntimeHost({
    ownerLarkAppId,
    activeSessions,
    ownerBootId: `boot-current-route-${hostEpoch}`,
    runtimeEpoch: `epoch-current-route-${hostEpoch}`,
    keyedTriggerAdmissionBlocked: () => false,
    ordinaryIngress,
    ordinaryRouteOpeningCreator: {
      begin(openingTurn: NormalizedOrdinaryImTurn) {
        const intent = Object.freeze({});
        const continuation = Object.freeze({});
        openingPlans.set(continuation, openingTurn);
        return { kind: 'effect' as const, intent, continuation };
      },
      async execute() {
        return { kind: 'resolved' as const };
      },
      resume(continuation, settlement) {
        const openingTurn = openingPlans.get(continuation as object);
        openingPlans.delete(continuation as object);
        if (settlement.kind === 'superseded') {
          return { kind: 'refused' as const, message: 'superseded' };
        }
        if (!openingTurn || settlement.kind !== 'returned') {
          return { kind: 'unknown' as const, message: 'invalid test opening continuation' };
        }
        const current = liveDaemonSession(
          ownerLarkAppId,
          `session-current-route-${hostEpoch}-${openingSessions.length}`,
          openingTurn,
        );
        current.worker = null;
        current.workerGeneration = 0;
        current.hasHistory = false;
        current.session.initialUserTurnPending = true;
        current.currentTurnTitle = `creator:${openingTurn.content}`;
        sessionStore.updateSession(current.session);
        openingSessions.push(current);
        return { kind: 'created' as const, current, rollbackToken: testRollbackToken() };
      },
      rollback() {
        return { kind: 'rolledBack' as const };
      },
    },
  });
  const submit = (inputTurn: OrdinaryImTransportEnvelope) => host.runtime.submit({
    target: {
      kind: 'route' as const,
      route: inputTurn.route.scope === 'thread'
        ? { kind: 'thread' as const, anchorId: inputTurn.route.canonicalAnchor }
        : { kind: 'chat' as const, chatId: inputTurn.route.chatId },
    },
    idempotencyKey: inputTurn.messageKey,
    command: { kind: 'ordinary.ingress' as const, input: { turn: inputTurn } },
  });
  return { activeSessions, effects, host, openingSessions, submit, workerCommands };
}

function expectApplied(
  outcome: Awaited<ReturnType<ReturnType<typeof createHarness>['submit']>>,
): string {
  expect(outcome).toMatchObject({
    kind: 'applied',
    action: 'ordinary.inputCommitted',
    policy: 'ordinary-replayable',
    durability: 'processLocal',
  });
  if (outcome.kind !== 'applied') throw new Error('expected applied ordinary ingress');
  return outcome.sessionId;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-current-ordinary-route-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  sessionStore.init(OWNER);
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStore.init();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Current ordinary route registry', () => {
  it('deduplicates before Session identity resolution and gives concurrent creators one opening', async () => {
    const releaseMaterialization = deferred<void>();
    const harness = createHarness({ materializationGate: releaseMaterialization.promise });
    const envelope = turn();

    const first = harness.submit(envelope);
    const second = harness.submit(envelope);
    await Promise.resolve();
    releaseMaterialization.resolve();

    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(['applied', 'duplicate']);
    const applied = outcomes.find(outcome => outcome.kind === 'applied');
    const duplicate = outcomes.find(outcome => outcome.kind === 'duplicate');
    if (!applied || applied.kind !== 'applied') throw new Error('expected one route-create winner');
    expect(duplicate).toMatchObject({
      kind: 'duplicate',
      state: 'inputCommitted',
      sessionId: applied.sessionId,
    });

    expect(harness.activeSessions.size).toBe(1);
    const [winner] = [...harness.activeSessions.values()];
    expect(harness.openingSessions).toHaveLength(1);
    expect(winner).toBe(harness.openingSessions[0]);
    expect(winner.currentTurnTitle).toBe(`creator:${envelope.content}`);
    expect(winner.session.sessionId).toBe(applied.sessionId);
    expect(winner.session.initialUserTurnPending).toBeUndefined();
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.effects).toHaveLength(1);
    expect(harness.effects[0]?.input.turn).toEqual(envelope);
    expect(harness.workerCommands).toHaveLength(1);
    expect(harness.workerCommands[0]).toMatchObject({
      kind: 'forkWorker',
      sessionId: applied.sessionId,
      turnId: MESSAGE_KEY,
      input: { content: `opening:${MESSAGE_KEY}` },
      resume: false,
    });
  });

  it('rejects one owner/provider key reused for a different route before creating a loser', async () => {
    const harness = createHarness();
    const first = turn();
    const winnerSessionId = expectApplied(await harness.submit(first));
    const conflicting = turn({
      anchor: 'om_conflicting_route',
      chatId: 'oc_conflicting_route',
    });

    await expect(harness.submit(conflicting)).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    expect(harness.activeSessions.size).toBe(1);
    expect(harness.openingSessions).toHaveLength(1);
    expect([...harness.activeSessions.values()][0]?.session.sessionId).toBe(winnerSessionId);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.effects).toHaveLength(1);
    expect(harness.workerCommands).toHaveLength(1);
  });

  it('rejects one owner/provider key reused for different semantics on the same route', async () => {
    const harness = createHarness();
    expectApplied(await harness.submit(turn()));

    await expect(harness.submit(turn({ content: 'different semantic ordinary turn' })))
      .resolves.toMatchObject({
        kind: 'rejected',
        reason: 'idempotencyConflict',
      });
    expect(harness.activeSessions.size).toBe(1);
    expect(harness.openingSessions).toHaveLength(1);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.effects).toHaveLength(1);
    expect(harness.workerCommands).toHaveLength(1);
  });

  it('scopes a provider message key to its owner Host', async () => {
    const firstOwner = 'app-current-route-owner-a';
    const secondOwner = 'app-current-route-owner-b';
    const envelope = turn();
    sessionStore.init(firstOwner);
    const first = createHarness({ ownerLarkAppId: firstOwner });
    const firstSessionId = expectApplied(await first.submit(envelope));

    sessionStore.init(secondOwner);
    const second = createHarness({ ownerLarkAppId: secondOwner });
    const secondSessionId = expectApplied(await second.submit(envelope));

    expect(firstSessionId).not.toBe(secondSessionId);
    expect(first.activeSessions.size).toBe(1);
    expect(second.activeSessions.size).toBe(1);
    expect(first.openingSessions).toHaveLength(1);
    expect(second.openingSessions).toHaveLength(1);
    expect(sessionStore.listSessionsForOwnerStrict(firstOwner)).toHaveLength(1);
    expect(sessionStore.listSessionsForOwnerStrict(secondOwner)).toHaveLength(1);
    expect(first.workerCommands).toHaveLength(1);
    expect(second.workerCommands).toHaveLength(1);
  });

  it('settles a hostile opening-result getter as one terminal quarantine', async () => {
    const envelope = turn({ messageKey: 'om_hostile_creator_result' });
    const begin = vi.fn(() => {
      const hostile = Object.create(null);
      Object.defineProperty(hostile, 'kind', {
        get() {
          throw new Error('hostile creator kind getter');
        },
      });
      return hostile as never;
    });
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      openingCreator: {
        begin,
        async execute() {
          throw new Error('hostile begin must not execute');
        },
        resume() {
          throw new Error('hostile begin must not resume');
        },
        rollback() {
          throw new Error('hostile begin must not roll back');
        },
      },
      downstream: {
        projection: {
          read: vi.fn(async () => ({ kind: 'notFound' as const })),
        },
        runtime: {
          submit: vi.fn(async () => ({ kind: 'quarantined' as const, message: 'must not run' })),
        },
      },
    });
    const request = {
      target: {
        kind: 'route' as const,
        route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
      },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
    };

    const first = await routeRuntime.submit(request);
    expect(first).toMatchObject({
      kind: 'quarantined',
      message: expect.stringMatching(/opening begin result.*unreadable.*hostile creator kind getter/i),
    });
    await expect(routeRuntime.submit(request)).resolves.toEqual(first);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'thenable',
      () => Promise.resolve({ kind: 'refused', message: 'too late' }),
      /opening resume must return synchronously/i,
    ],
    [
      'malformed creation',
      () => ({ kind: 'created' }),
      /opening resume returned an invalid creation result/i,
    ],
  ] as const)(
    'makes one route terminal when opening resume returns a %s',
    async (_label, resumeResult, expectedMessage) => {
      const keyLabel = _label.replaceAll(' ', '_');
      const firstTurn = turn({ messageKey: `om_resume_${keyLabel}_first` });
      const nextTurn = turn({ messageKey: `om_resume_${keyLabel}_next` });
      const begin = vi.fn(() => ({
        kind: 'effect' as const,
        intent: Object.freeze({}),
        continuation: Object.freeze({}),
      }));
      const execute = vi.fn(async () => ({ kind: 'resolved' as const }));
      const resume = vi.fn(() => resumeResult() as never);
      const downstreamSubmit = vi.fn();
      const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
        ownerLarkAppId: OWNER,
        activeSessions: new Map(),
        openingCreator: {
          begin,
          execute,
          resume,
          rollback() {
            throw new Error('invalid resume must not mint a rollback lease');
          },
        },
        downstream: {
          projection: { read: vi.fn() },
          runtime: { submit: downstreamSubmit },
        },
      });
      const submit = (envelope: OrdinaryImTransportEnvelope) => routeRuntime.submit({
        target: {
          kind: 'route' as const,
          route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
        },
        idempotencyKey: envelope.messageKey,
        command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
      });

      const first = await submit(firstTurn);
      expect(first).toMatchObject({ kind: 'quarantined', message: expectedMessage });
      await expect(submit(nextTurn)).resolves.toEqual(first);
      expect(begin).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(downstreamSubmit).not.toHaveBeenCalled();
    },
  );

  it('quarantines an ambiguous route with multiple active owner bindings', async () => {
    const envelope = turn();
    sessionStore.updateSession(sessionFor(OWNER, 'session-ambiguous-a', envelope));
    sessionStore.updateSession(sessionFor(OWNER, 'session-ambiguous-b', envelope));
    const harness = createHarness();

    await expect(harness.submit(envelope)).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringMatching(/multiple active owner bindings/i),
    });
    expect(harness.activeSessions.size).toBe(0);
    expect(harness.openingSessions).toHaveLength(0);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(2);
    expect(harness.effects).toHaveLength(0);
    expect(harness.workerCommands).toHaveLength(0);
  });

  it('submits directly to an existing winner without a daemon legacy fallback', async () => {
    const envelope = turn({ messageKey: 'om_existing_winner' });
    const existing = liveDaemonSession(OWNER, 'session-existing-winner', envelope);
    sessionStore.updateSession(existing.session);
    const registry = new Map<string, DaemonSession>([[activeSessionKey(existing), existing]]);
    const harness = createHarness({ activeSessions: registry });

    const sessionId = expectApplied(await harness.submit(envelope));

    expect(sessionId).toBe(existing.session.sessionId);
    expect(harness.activeSessions.size).toBe(1);
    expect(harness.openingSessions).toHaveLength(0);
    expect([...harness.activeSessions.values()][0]).toBe(existing);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.effects).toHaveLength(1);
    expect(harness.workerCommands).toEqual([expect.objectContaining({
      kind: 'sendWorkerInput',
      sessionId: existing.session.sessionId,
      turnId: envelope.messageKey,
      input: { content: `follow-up:${envelope.messageKey}` },
      workerGeneration: existing.workerGeneration,
    })]);
  });

  it('rejects a same-id same-route DS or Session replacement across projection await', async () => {
    const envelope = turn({ messageKey: 'om_projection_replacement' });
    const existing = liveDaemonSession(OWNER, 'session-projection-replacement', envelope);
    sessionStore.updateSession(existing.session);
    const registry = new Map<string, DaemonSession>([[activeSessionKey(existing), existing]]);
    const harness = createHarness({ activeSessions: registry });
    const replacement: DaemonSession = {
      ...existing,
      session: { ...existing.session },
    };
    const listSessions = sessionStore.listSessionsForOwnerStrict;
    let reads = 0;
    vi.spyOn(sessionStore, 'listSessionsForOwnerStrict').mockImplementation((owner) => {
      const result = listSessions(owner);
      reads += 1;
      if (reads === 2) {
        queueMicrotask(() => {
          registry.set(activeSessionKey(replacement), replacement);
        });
      }
      return result;
    });

    const pending = harness.submit(envelope);

    await expect(pending).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringMatching(/identity changed.*projection/i),
    });
    expect(harness.openingSessions).toHaveLength(0);
    expect(harness.effects).toHaveLength(0);
    expect(harness.workerCommands).toHaveLength(0);
  });

  it('admits different provider keys on one route into downstream begin in arrival order', async () => {
    const firstTurn = turn({ messageKey: 'om_route_fifo_n', content: 'turn N' });
    const nextTurn = turn({ messageKey: 'om_route_fifo_n_plus_1', content: 'turn N+1' });
    const existing = liveDaemonSession(OWNER, 'session-route-fifo', firstTurn);
    sessionStore.updateSession(existing.session);
    const activeSessions = new Map<string, DaemonSession>([
      [activeSessionKey(existing), existing],
    ]);
    const address = Object.freeze({}) as SessionAddress;
    const projected = {
      kind: 'one' as const,
      session: {
        address,
        sessionId: existing.session.sessionId,
        route: { kind: 'thread' as const, anchorId: ANCHOR },
        recordStatus: 'active' as const,
        executorStatus: 'working' as const,
      },
    };
    const releaseFirstProjection = deferred<typeof projected>();
    const projectionReads: string[] = [];
    const projection: SessionProjection = {
      async read(query) {
        if (query.kind !== 'byExternalSession') throw new Error('unexpected projection query');
        projectionReads.push(query.sessionId);
        return projectionReads.length === 1
          ? releaseFirstProjection.promise
          : projected;
      },
    };
    const downstreamBegins: string[] = [];
    const runtime = {
      async submit(request) {
        downstreamBegins.push(request.idempotencyKey);
        return {
          kind: 'applied',
          action: 'ordinary.inputCommitted',
          policy: 'ordinary-replayable',
          durability: 'processLocal',
          sessionId: existing.session.sessionId,
        };
      },
    } as SessionRuntime;
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator: {
        begin() {
          throw new Error('existing FIFO owner must not create');
        },
        async execute() {
          throw new Error('existing FIFO owner must not execute');
        },
        resume() {
          throw new Error('existing FIFO owner must not resume');
        },
        rollback() {
          throw new Error('existing FIFO owner must not roll back');
        },
      },
      downstream: { projection, runtime },
    });
    const submit = (envelope: OrdinaryImTransportEnvelope) => routeRuntime.submit({
      target: {
        kind: 'route' as const,
        route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
      },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
    });

    const first = submit(firstTurn);
    const next = submit(nextTurn);

    await vi.waitFor(() => expect(projectionReads).toHaveLength(1));
    expect(downstreamBegins).toEqual([]);
    releaseFirstProjection.resolve(projected);
    await expect(Promise.all([first, next])).resolves.toEqual([
      expect.objectContaining({ kind: 'applied' }),
      expect.objectContaining({ kind: 'applied' }),
    ]);
    expect(downstreamBegins).toEqual([firstTurn.messageKey, nextTurn.messageKey]);
  });

  it('keeps asynchronous opening policy inside each route admission without blocking another route', async () => {
    const firstTurn = turn({
      messageKey: 'om_async_policy_route_a',
      anchor: 'om_async_policy_anchor_a',
      chatId: 'oc_async_policy_chat_a',
    });
    const secondTurn = turn({
      messageKey: 'om_async_policy_route_b',
      anchor: 'om_async_policy_anchor_b',
      chatId: 'oc_async_policy_chat_b',
    });
    const activeSessions = new Map<string, DaemonSession>();
    const releaseFirstPolicy = deferred<void>();
    const policyBegins: string[] = [];
    const publications: string[] = [];
    const openingCreator = {
      begin(openingTurn: NormalizedOrdinaryImTurn) {
        return {
          kind: 'effect' as const,
          intent: Object.freeze({ turn: openingTurn }),
          continuation: Object.freeze({ turn: openingTurn }),
        };
      },
      async execute(intent: unknown) {
        const openingTurn = (intent as { turn: NormalizedOrdinaryImTurn }).turn;
        policyBegins.push(openingTurn.messageKey);
        if (openingTurn.messageKey === firstTurn.messageKey) {
          await releaseFirstPolicy.promise;
        }
        return { kind: 'resolved' as const };
      },
      resume(continuation: unknown) {
        const openingTurn = (continuation as { turn: NormalizedOrdinaryImTurn }).turn;
        const current = liveDaemonSession(
          OWNER,
          `session-${openingTurn.messageKey}`,
          openingTurn,
        );
        current.worker = null;
        current.workerGeneration = 0;
        current.hasHistory = false;
        current.session.initialUserTurnPending = true;
        sessionStore.updateSession(current.session);
        publications.push(openingTurn.messageKey);
        return { kind: 'created' as const, current, rollbackToken: testRollbackToken() };
      },
      rollback() {
        return { kind: 'rolledBack' as const };
      },
    };
    const address = Object.freeze({}) as SessionAddress;
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator,
      downstream: {
        projection: {
          async read(query) {
            if (query.kind !== 'byExternalSession') return { kind: 'notFound' };
            const current = [...activeSessions.values()].find(
              candidate => candidate.session.sessionId === query.sessionId,
            );
            return current
              ? {
                  kind: 'one' as const,
                  session: {
                    address,
                    sessionId: current.session.sessionId,
                    route: {
                      kind: 'thread' as const,
                      anchorId: current.session.rootMessageId,
                    },
                    recordStatus: 'active' as const,
                    executorStatus: 'dormant' as const,
                  },
                }
              : { kind: 'notFound' as const };
          },
        },
        runtime: {
          async submit(request) {
            return {
              kind: 'applied' as const,
              action: 'ordinary.inputCommitted' as const,
              policy: 'ordinary-replayable' as const,
              durability: 'processLocal' as const,
              sessionId: [...activeSessions.values()].find(
                candidate => candidate.session.rootMessageId
                  === (request.command.input.turn as OrdinaryImTransportEnvelope)
                    .route.canonicalAnchor,
              )!.session.sessionId,
            };
          },
        },
      },
    });
    const submit = (envelope: OrdinaryImTransportEnvelope) => routeRuntime.submit({
      target: {
        kind: 'route' as const,
        route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
      },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
    });

    const first = submit(firstTurn);
    await vi.waitFor(() => expect(policyBegins).toEqual([firstTurn.messageKey]));
    const second = submit(secondTurn);

    await expect(second).resolves.toMatchObject({ kind: 'applied' });
    expect(publications).toEqual([secondTurn.messageKey]);
    releaseFirstPolicy.resolve();
    await expect(first).resolves.toMatchObject({ kind: 'applied' });
    expect(publications).toEqual([secondTurn.messageKey, firstTurn.messageKey]);
  });
});
