import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSessionRuntimeHost } from '../src/core/current-session-runtime.js';
import { DashboardEventBus } from '../src/core/dashboard-events.js';
import { CurrentDashboardProjectionProtocol } from '../src/core/dashboard-projection.js';
import { createCurrentOrdinaryImTurnPreparationPort } from '../src/core/current-ordinary-im-turn.js';
import { createCurrentOrdinaryIngressPort } from '../src/core/current-ordinary-ingress.js';
import type { CurrentOrdinaryRouteOpeningRollbackToken } from '../src/core/current-ordinary-route-registry.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import * as idempotencyStore from '../src/services/idempotency-store.js';
import * as sessionStore from '../src/services/session-store.js';
import { computeInputHash } from '../src/utils/canonical-input-hash.js';
import type {
  NormalizedOrdinaryImTurn,
  OrdinaryImTransportEnvelope,
} from '../src/core/ordinary-im-turn.js';
import type {
  KeyedTriggerStartInput,
  KeyedTriggerTurnPort,
  OrdinaryIngressPort,
  PendingRepoCompletionPort,
} from '../src/core/session-runtime.js';

const APP = 'cli_runtime_projection';
let dataDir: string;
let previousDataDir: string | undefined;

const target = (key: string) => ({
  kind: 'route' as const,
  route: { kind: 'idempotency' as const, key },
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function unusedPendingRepoCompletion(): PendingRepoCompletionPort {
  return {
    begin() {
      throw new Error('pending-repo port is only installed in this test');
    },
    async execute() {
      throw new Error('pending-repo port is only installed in this test');
    },
    resume() {
      throw new Error('pending-repo port is only installed in this test');
    },
  };
}

function startInput(key: string): KeyedTriggerStartInput {
  return {
    business: {
      instruction: key,
      envelope: { format: 'text', sourceName: 'test', trusted: false },
      source: { type: 'webhook' },
      presentation: null,
      options: { asyncReturnSessionId: true },
    },
    persistInputHistory: true,
  };
}

function requestHash(key: string): string {
  const input = startInput(key);
  return computeInputHash({ business: input.business, persistInputHistory: true });
}

function startCommand(key: string) {
  return { kind: 'keyedTrigger.start' as const, input: startInput(key) };
}

class TestTurns implements KeyedTriggerTurnPort {
  accepts = vi.fn();
  prepare(input: KeyedTriggerStartInput) {
    const key = input.business.instruction ?? 'unknown';
    return {
      kind: 'prepared' as const,
      turn: {
        token: Object.freeze({ key }),
        sessionId: `candidate-${key}`,
        triggerId: `trigger-${key}`,
        chatId: `http_async_${key}`,
      },
    };
  }
  acceptAtMostOnce(token: unknown, context: { key: string; pendingCreatedAt: number }) {
    this.accepts(token, context);
    return { kind: 'accepted' as const };
  }
  async failClose() { return { kind: 'closed' as const }; }
}

function ordinaryTurn(
  session: Pick<Session, 'chatId' | 'chatType' | 'rootMessageId' | 'scope'>,
  messageKey: string,
): OrdinaryImTransportEnvelope {
  const scope = session.scope === 'chat' ? 'chat' : 'thread';
  return {
    route: {
      scope,
      canonicalAnchor: scope === 'chat' ? session.chatId : session.rootMessageId,
      chatId: session.chatId,
      chatType: session.chatType ?? 'group',
    },
    source: 'lark.im',
    messageKey,
    content: 'production ordinary input',
    sender: { kind: 'human', openId: 'ou_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function committedOrdinaryIngress(): OrdinaryIngressPort {
  return {
    begin: vi.fn(() => ({ kind: 'committed' as const })),
    execute: vi.fn(async () => {
      throw new Error('committed ordinary ingress must not execute an effect');
    }),
    resume: vi.fn(() => {
      throw new Error('committed ordinary ingress must not resume an effect');
    }),
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'session-runtime-current-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  sessionStore.init(APP);
});

afterEach(() => {
  sessionStore.init();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Current SessionRuntime projection adapter', () => {
  it('rebuilds detached dormant/idle/working views from current lifecycle authority', async () => {
    const session = sessionStore.createSession('oc_chat', 'om_root', 'runtime', 'group');
    session.larkAppId = APP;
    session.scope = 'thread';
    sessionStore.updateSession(session);

    const activeSessions = new Map<string, DaemonSession>();
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
    });

    const dormant = await host.projection.read({
      kind: 'byRoute',
      route: { kind: 'thread', anchorId: 'om_root' },
    });
    expect(dormant.kind).toBe('one');
    if (dormant.kind !== 'one') throw new Error('expected dormant projection');
    expect(dormant.session.executorStatus).toBe('dormant');
    expect('larkAppId' in dormant.session).toBe(false);
    expect('worker' in dormant.session).toBe(false);

    activeSessions.set('live', {
      session,
      worker: null,
      larkAppId: APP,
      chatId: session.chatId,
    } as DaemonSession);
    const workerless = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    expect(workerless.kind).toBe('one');
    if (workerless.kind !== 'one') throw new Error('expected workerless projection');
    expect(workerless.session.executorStatus).toBe('dormant');
    expect(workerless.session.address).toBe(dormant.session.address);

    const ds = activeSessions.get('live')!;
    ds.worker = { killed: false } as DaemonSession['worker'];
    ds.lastScreenStatus = 'idle';
    const idle = await host.projection.read({ kind: 'byExternalSession', sessionId: session.sessionId });
    expect(idle.kind === 'one' && idle.session.executorStatus).toBe('idle');

    ds.lastScreenStatus = 'working';
    const working = await host.projection.read({ kind: 'byExternalSession', sessionId: session.sessionId });
    expect(working.kind === 'one' && working.session.executorStatus).toBe('working');

    ds.worker.killed = true;
    const killed = await host.projection.read({ kind: 'byExternalSession', sessionId: session.sessionId });
    expect(killed.kind === 'one' && killed.session.executorStatus).toBe('dormant');
  });

  it('projects an authoritative owner-scoped dashboard snapshot with Current readiness', async () => {
    const session = sessionStore.createSession('oc_dashboard', 'om_dashboard', 'dashboard', 'group');
    session.larkAppId = APP;
    session.scope = 'thread';
    sessionStore.updateSession(session);
    const ds = {
      session,
      worker: null,
      larkAppId: APP,
      chatId: session.chatId,
      chatType: 'group',
    } as DaemonSession;
    const protocol = new CurrentDashboardProjectionProtocol();
    const bus = new DashboardEventBus(protocol);
    bus.publish({
      type: 'session.update',
      body: { sessionId: session.sessionId, patch: { status: 'idle' } },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      ownerBootId: 'boot-dashboard-snapshot',
      keyedTriggerAdmissionBlocked: () => false,
      dashboardProjectionProtocol: protocol,
    });

    const restoring = await host.projection.read({ kind: 'dashboardSnapshot' });
    expect(restoring.kind).toBe('dashboardSnapshot');
    if (restoring.kind !== 'dashboardSnapshot') throw new Error('expected dashboard snapshot');
    expect(restoring.snapshot).toMatchObject({
      cursor: 1,
      readiness: { contract: 'Current/v1', state: 'restoring', online: true },
      rows: [{ sessionId: session.sessionId, larkAppId: APP, status: 'dormant' }],
    });

    protocol.markReady();
    const ready = await host.projection.read({ kind: 'dashboardSnapshot' });
    expect(ready.kind === 'dashboardSnapshot' && ready.snapshot).toMatchObject({
      projectionEpoch: restoring.snapshot.projectionEpoch,
      cursor: 1,
      readiness: { contract: 'Current/v1', state: 'ready', online: true },
    });
  });

  it('reports a corrupt owner projection as notReady rather than notFound', async () => {
    writeFileSync(join(dataDir, `sessions-${APP}.json`), '{ broken', 'utf8');
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: new Map(),
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
    });

    await expect(host.projection.read({
      kind: 'byExternalSession',
      sessionId: 'missing',
    })).resolves.toMatchObject({ kind: 'notReady' });
  });

  it('reports a structurally malformed Session row as notReady rather than inventing a view', async () => {
    writeFileSync(join(dataDir, `sessions-${APP}.json`), JSON.stringify({ bad: {} }), 'utf8');
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: new Map(),
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
    });

    await expect(host.projection.read({
      kind: 'byExternalSession',
      sessionId: 'bad',
    })).resolves.toMatchObject({ kind: 'notReady' });
  });

  it('rejects a base-valid row whose normalized owner projection fields are malformed', async () => {
    const session = sessionStore.createSession('oc_chat', 'om_shape', 'valid first', 'group');
    session.larkAppId = APP;
    sessionStore.updateSession(session);
    const file = join(dataDir, `sessions-${APP}.json`);
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    rows[session.sessionId]!.scope = 'bogus';
    rows[session.sessionId]!.title = 42;
    writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: new Map(),
      ownerBootId: 'boot-malformed-normalized',
      keyedTriggerAdmissionBlocked: () => false,
    });

    await expect(host.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    })).resolves.toMatchObject({ kind: 'notReady' });
  });

  it('never projects an ownerless row from another owner file through the bound Host', async () => {
    sessionStore.init('cli_OTHER_OWNER');
    const foreign = sessionStore.createSession('oc_foreign', 'om_foreign', 'foreign', 'group');
    sessionStore.updateSession(foreign);
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: new Map(),
      ownerBootId: 'boot-owner-bound',
      keyedTriggerAdmissionBlocked: () => false,
    });

    await expect(host.projection.read({
      kind: 'byExternalSession',
      sessionId: foreign.sessionId,
    })).resolves.toEqual({ kind: 'notFound' });
  });

  it('resolves a stable route to its unique active binding even when closed history shares it', async () => {
    const closedOne = sessionStore.createSession('oc_reopen', 'om_reopen', 'closed one', 'group');
    closedOne.larkAppId = APP;
    closedOne.scope = 'thread';
    sessionStore.updateSession(closedOne);
    sessionStore.closeSession(closedOne.sessionId);
    const closedTwo = sessionStore.createSession('oc_reopen', 'om_reopen', 'closed two', 'group');
    closedTwo.larkAppId = APP;
    closedTwo.scope = 'thread';
    sessionStore.updateSession(closedTwo);
    sessionStore.closeSession(closedTwo.sessionId);
    const active = sessionStore.createSession('oc_reopen', 'om_reopen', 'active', 'group');
    active.larkAppId = APP;
    active.scope = 'thread';
    sessionStore.updateSession(active);
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: new Map(),
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
    });

    const result = await host.projection.read({
      kind: 'byRoute',
      route: { kind: 'thread', anchorId: 'om_reopen' },
    });

    expect(result).toMatchObject({ kind: 'one', session: { sessionId: active.sessionId } });
  });

  it('fails closed when a stable route has multiple active owner bindings', async () => {
    for (const title of ['first', 'second']) {
      const session = sessionStore.createSession('oc_collision', 'om_collision', title, 'group');
      session.larkAppId = APP;
      session.scope = 'thread';
      sessionStore.updateSession(session);
    }
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: new Map(),
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
    });

    await expect(host.projection.read({
      kind: 'byRoute',
      route: { kind: 'thread', anchorId: 'om_collision' },
    })).resolves.toMatchObject({ kind: 'notReady' });
  });

  it('keeps the production-wired ordinary port when a trigger-only caller reuses the owner epoch Host', async () => {
    const session = sessionStore.createSession('oc_wired', 'om_wired', 'wired', 'group');
    session.larkAppId = APP;
    session.scope = 'thread';
    sessionStore.updateSession(session);
    const registry = new Map<string, DaemonSession>();
    const ordinaryIngress = committedOrdinaryIngress();
    const productionOptions = {
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-wired',
      runtimeEpoch: 'epoch-wired',
      keyedTriggerAdmissionBlocked: () => false,
      ordinaryIngress,
    };
    const production = currentSessionRuntimeHost(productionOptions);
    const projected = await production.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    if (projected.kind !== 'one') throw new Error('expected production projection');

    const triggerOnly = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-wired',
      runtimeEpoch: 'epoch-wired',
      keyedTriggerAdmissionBlocked: () => false,
    });
    const turn = ordinaryTurn(session, 'om_wired_followup');
    const outcome = await triggerOnly.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: turn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn } },
    });

    expect(outcome).toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
      durability: 'processLocal',
    });
    expect(ordinaryIngress.begin).toHaveBeenCalledTimes(1);
  });

  it('binds a VC receiver ordinary turn to its exact receiver anchor', async () => {
    const session = sessionStore.createSession(
      'oc_vc_receiver',
      'om_vc_receiver_audit_root',
      'VC receiver',
      'group',
    );
    session.larkAppId = APP;
    session.scope = 'chat';
    session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 3,
    };
    sessionStore.updateSession(session);
    const receiver = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: APP,
      chatId: session.chatId,
      chatType: 'group',
      scope: 'chat',
      spawnedAt: Date.parse(session.createdAt),
      cliVersion: 'test',
      lastMessageAt: Date.parse(session.createdAt),
      hasHistory: false,
    } as DaemonSession;
    const registry = new Map<string, DaemonSession>([[activeSessionKey(receiver), receiver]]);
    const externalEffects = {
      execute: vi.fn(async () => ({ kind: 'materialized' as const })),
    };
    const commands = {
      apply: vi.fn(() => ({ kind: 'accepted' as const })),
    };
    const ordinaryIngress = createCurrentOrdinaryIngressPort({
      ownerLarkAppId: APP,
      activeSessions: registry,
      turnPreparation: createCurrentOrdinaryImTurnPreparationPort(),
      externalEffects,
      commands,
    });
    const begin = vi.spyOn(ordinaryIngress, 'begin');
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-vc-receiver',
      runtimeEpoch: 'epoch-vc-receiver',
      keyedTriggerAdmissionBlocked: () => false,
      ordinaryIngress,
    });
    const projected = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    if (projected.kind !== 'one') throw new Error('expected VC receiver projection');
    const receiverAnchor = `vc-receiver:${session.sessionId}`;
    const turn = {
      ...ordinaryTurn(session, 'om_vc_receiver_exact'),
      route: {
        scope: 'chat' as const,
        canonicalAnchor: receiverAnchor,
        chatId: session.chatId,
        chatType: 'group' as const,
      },
    };

    await expect(host.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: turn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn } },
    })).resolves.toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
      sessionId: session.sessionId,
    });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(externalEffects.execute).toHaveBeenCalledTimes(1);
    expect(commands.apply).toHaveBeenCalledTimes(1);

    begin.mockClear();
    externalEffects.execute.mockClear();
    commands.apply.mockClear();
    const wrongAnchorTurn = {
      ...turn,
      messageKey: 'om_vc_receiver_wrong',
      route: { ...turn.route, canonicalAnchor: 'vc-receiver:another-session' },
    };
    await expect(host.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: wrongAnchorTurn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: wrongAnchorTurn } },
    })).resolves.toMatchObject({ kind: 'rejected', reason: 'invalidCommand' });
    expect(begin).not.toHaveBeenCalled();
    expect(externalEffects.execute).not.toHaveBeenCalled();
    expect(commands.apply).not.toHaveBeenCalled();
  });

  it('replaces an unwired owner epoch Host when production installs ordinary ingress', async () => {
    const session = sessionStore.createSession('oc_install', 'om_install', 'install', 'group');
    session.larkAppId = APP;
    session.scope = 'thread';
    sessionStore.updateSession(session);
    const registry = new Map<string, DaemonSession>();
    const baseOptions = {
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-install',
      runtimeEpoch: 'epoch-install',
      keyedTriggerAdmissionBlocked: () => false,
    };
    const unwired = currentSessionRuntimeHost(baseOptions);
    const before = await unwired.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    if (before.kind !== 'one') throw new Error('expected unwired projection');

    const ordinaryIngress = committedOrdinaryIngress();
    const production = currentSessionRuntimeHost({ ...baseOptions, ordinaryIngress });
    const after = await production.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    if (after.kind !== 'one') throw new Error('expected production projection');
    const staleTurn = ordinaryTurn(session, 'om_install_stale');

    await expect(production.runtime.submit({
      target: { kind: 'session', address: before.session.address },
      idempotencyKey: staleTurn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: staleTurn } },
    })).resolves.toEqual({ kind: 'staleAddress' });
    expect(after.session.address).not.toBe(before.session.address);

    await expect(unwired.runtime.submit({
      target: { kind: 'session', address: before.session.address },
      idempotencyKey: 'revoked-unwired-host',
      command: {
        kind: 'control.rename',
        input: {
          title: 'must not be written by the revoked Host',
          updatedAt: '2026-08-10T00:00:00.000Z',
          source: 'dashboard',
        },
      },
    })).resolves.toEqual({ kind: 'staleAddress' });
    expect(sessionStore.getOwnedSession(session.sessionId)?.title).toBe('install');

    const triggerOnly = currentSessionRuntimeHost(baseOptions);
    const liveTurn = ordinaryTurn(session, 'om_install_live');
    await expect(triggerOnly.runtime.submit({
      target: { kind: 'session', address: after.session.address },
      idempotencyKey: liveTurn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: liveTurn } },
    })).resolves.toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
      durability: 'processLocal',
    });
    expect(ordinaryIngress.begin).toHaveBeenCalledTimes(1);
  });

  it('preserves an in-flight ordinary ledger when pending-repo wiring upgrades the same epoch Host', async () => {
    const session = sessionStore.createSession('oc_ledger', 'om_ledger', 'ledger', 'group');
    session.larkAppId = APP;
    session.scope = 'thread';
    sessionStore.updateSession(session);
    const activeSessions = new Map<string, DaemonSession>();
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    const ordinaryIngress: OrdinaryIngressPort = {
      begin: vi.fn(() => ({
        kind: 'effect' as const,
        intent: Object.freeze({}),
        continuation: Object.freeze({}),
      })),
      execute: vi.fn(async () => {
        effectStarted.resolve();
        await releaseEffect.promise;
        return { kind: 'materialized' };
      }),
      resume: vi.fn(() => ({ kind: 'committed' as const })),
    };
    const baseOptions = {
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: 'boot-ledger-upgrade',
      runtimeEpoch: 'epoch-ledger-upgrade',
      keyedTriggerAdmissionBlocked: () => false,
      ordinaryIngress,
    };
    const initial = currentSessionRuntimeHost(baseOptions);
    const before = await initial.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    if (before.kind !== 'one') throw new Error('expected initial Session projection');
    const envelope = ordinaryTurn(session, 'om_ledger_same_input');
    const first = initial.runtime.submit({
      target: { kind: 'session', address: before.session.address },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: envelope } },
    });
    await effectStarted.promise;

    const upgraded = currentSessionRuntimeHost({
      ...baseOptions,
      pendingRepoCompletion: unusedPendingRepoCompletion(),
    });
    const after = await upgraded.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    if (after.kind !== 'one') throw new Error('expected upgraded Session projection');
    const repeated = upgraded.runtime.submit({
      target: { kind: 'session', address: after.session.address },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: envelope } },
    });
    releaseEffect.resolve();

    const outcomes = await Promise.all([first, repeated]);
    expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(['applied', 'duplicate']);
    expect(ordinaryIngress.begin).toHaveBeenCalledTimes(1);
    expect(ordinaryIngress.execute).toHaveBeenCalledTimes(1);
    expect(ordinaryIngress.resume).toHaveBeenCalledTimes(1);
  });

  it('preserves route-provider admission when pending-repo wiring upgrades the same epoch Host', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    const ordinaryIngress: OrdinaryIngressPort = {
      begin: vi.fn(() => ({
        kind: 'effect' as const,
        intent: Object.freeze({}),
        continuation: Object.freeze({}),
      })),
      execute: vi.fn(async () => {
        effectStarted.resolve();
        await releaseEffect.promise;
        return { kind: 'materialized' };
      }),
      resume: vi.fn(() => ({ kind: 'committed' as const })),
    };
    const created: DaemonSession[] = [];
    const openingPlans = new WeakMap<object, NormalizedOrdinaryImTurn>();
    const openingCreator = {
      begin(turn: NormalizedOrdinaryImTurn) {
        const intent = Object.freeze({});
        const continuation = Object.freeze({});
        openingPlans.set(continuation, turn);
        return { kind: 'effect' as const, intent, continuation };
      },
      async execute() {
        return { kind: 'resolved' as const };
      },
      resume(continuation: unknown, settlement: { readonly kind: string }) {
        const turn = openingPlans.get(continuation as object);
        openingPlans.delete(continuation as object);
        if (settlement.kind === 'superseded') {
          return { kind: 'refused' as const, message: 'superseded' };
        }
        if (!turn || settlement.kind !== 'returned') {
          return { kind: 'unknown' as const, message: 'invalid test opening continuation' };
        }
        const createdAt = '2026-08-10T01:20:00.000Z';
        const session: Session = {
          sessionId: `session-route-ledger-${created.length}`,
          larkAppId: APP,
          chatId: turn.route.chatId,
          chatType: turn.route.chatType,
          rootMessageId: turn.route.canonicalAnchor,
          scope: turn.route.scope,
          title: turn.content,
          status: 'active',
          createdAt,
          initialUserTurnPending: true,
        };
        const current: DaemonSession = {
          session,
          worker: null,
          workerPort: null,
          workerToken: null,
          workerGeneration: 0,
          larkAppId: APP,
          chatId: turn.route.chatId,
          chatType: turn.route.chatType,
          scope: turn.route.scope,
          spawnedAt: Date.parse(createdAt),
          cliVersion: 'test',
          lastMessageAt: Date.parse(createdAt),
          hasHistory: false,
        };
        sessionStore.updateSession(session);
        created.push(current);
        return {
          kind: 'created' as const,
          current,
          rollbackToken: Object.freeze(
            Object.create(null),
          ) as CurrentOrdinaryRouteOpeningRollbackToken,
        };
      },
      rollback() {
        return { kind: 'rolledBack' as const };
      },
    };
    const baseOptions = {
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: 'boot-route-ledger-upgrade',
      runtimeEpoch: 'epoch-route-ledger-upgrade',
      keyedTriggerAdmissionBlocked: () => false,
      ordinaryIngress,
      ordinaryRouteOpeningCreator: openingCreator,
    };
    const initial = currentSessionRuntimeHost(baseOptions);
    const firstTurn = ordinaryTurn({
      chatId: 'oc_route_ledger',
      chatType: 'group',
      rootMessageId: 'om_route_ledger_first',
      scope: 'thread',
    }, 'om_route_ledger_provider_key');
    const first = initial.runtime.submit({
      target: { kind: 'route', route: { kind: 'thread', anchorId: firstTurn.route.canonicalAnchor } },
      idempotencyKey: firstTurn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: firstTurn } },
    });
    await effectStarted.promise;

    const upgraded = currentSessionRuntimeHost({
      ...baseOptions,
      pendingRepoCompletion: unusedPendingRepoCompletion(),
    });
    const conflictingTurn = ordinaryTurn({
      chatId: 'oc_route_ledger',
      chatType: 'group',
      rootMessageId: 'om_route_ledger_conflict',
      scope: 'thread',
    }, firstTurn.messageKey);
    const conflict = upgraded.runtime.submit({
      target: {
        kind: 'route',
        route: { kind: 'thread', anchorId: conflictingTurn.route.canonicalAnchor },
      },
      idempotencyKey: conflictingTurn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: conflictingTurn } },
    });
    await Promise.resolve();
    releaseEffect.resolve();

    await expect(first).resolves.toMatchObject({ kind: 'applied' });
    await expect(conflict).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    expect(created).toHaveLength(1);
    expect(ordinaryIngress.begin).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the same owner epoch is wired to a different ordinary ingress port', () => {
    const registry = new Map<string, DaemonSession>();
    const baseOptions = {
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-port-conflict',
      runtimeEpoch: 'epoch-port-conflict',
      keyedTriggerAdmissionBlocked: () => false,
    };
    const installed = currentSessionRuntimeHost({
      ...baseOptions,
      ordinaryIngress: committedOrdinaryIngress(),
    });

    expect(() => currentSessionRuntimeHost({
      ...baseOptions,
      ordinaryIngress: committedOrdinaryIngress(),
    })).toThrow(/ordinary ingress port/i);
    expect(currentSessionRuntimeHost(baseOptions)).toBe(installed);
  });

  it('rotates the actual Current Host on runtime epoch change and rejects the old address', async () => {
    const session = sessionStore.createSession('oc_epoch', 'om_epoch', 'epoch', 'group');
    session.larkAppId = APP;
    sessionStore.updateSession(session);
    const registry = new Map<string, DaemonSession>();
    const first = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-1',
      keyedTriggerAdmissionBlocked: () => false,
    });
    const same = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-1',
      keyedTriggerAdmissionBlocked: () => false,
    });
    expect(same).toBe(first);
    const projected = await first.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    if (projected.kind !== 'one') throw new Error('expected projected session');

    const second = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-2',
      keyedTriggerAdmissionBlocked: () => false,
    });
    expect(second).not.toBe(first);
    const command = startCommand('stale-epoch');
    await expect(second.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: 'stale-epoch',
      command,
    })).resolves.toEqual({ kind: 'staleAddress' });
    expect(idempotencyStore.lookup(APP, 'stale-epoch')).toBeUndefined();

    const rebound = await second.projection.read({
      kind: 'byExternalSession',
      sessionId: session.sessionId,
    });
    if (rebound.kind !== 'one') throw new Error('expected rebound session');
    await expect(second.runtime.submit({
      target: { kind: 'session', address: rebound.session.address },
      idempotencyKey: 'rename-after-rebind',
      command: {
        kind: 'control.rename',
        input: {
          title: 'Rebound title',
          updatedAt: '2026-08-10T00:00:00.000Z',
          source: 'dashboard',
        },
      },
    })).resolves.toMatchObject({ kind: 'applied', action: 'control.renamed' });
    expect(sessionStore.getOwnedSession(session.sessionId)?.title).toBe('Rebound title');
  });

  it('does not borrow liveness or chat identity from a foreign owner with the same sessionId', async () => {
    const sharedSessionId = 'shared-session-id';
    const claim = idempotencyStore.claim({
      ownerLarkAppId: APP,
      key: 'foreign-collision',
      sessionId: sharedSessionId,
      triggerId: 'old-trigger',
      requestHash: requestHash('foreign-collision'),
      ownerBootId: 'boot-old',
      now: 1,
    });
    if (claim.kind !== 'won') throw new Error('expected claim');
    idempotencyStore.transition(APP, 'foreign-collision', claim.record, { state: 'attempting', now: 2 });
    const foreign = {
      session: {
        sessionId: sharedSessionId,
        chatId: 'foreign-chat',
        rootMessageId: 'foreign-root',
        status: 'active',
        createdAt: new Date().toISOString(),
      },
      worker: { killed: false },
      larkAppId: 'cli_FOREIGN',
      chatId: 'foreign-chat',
    } as DaemonSession;
    const registry = new Map<string, DaemonSession>([['foreign', foreign]]);
    const turns = new TestTurns();
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
      keyedTriggerTurns: turns,
    });
    const command = startCommand('foreign-collision');

    const result = await host.runtime.submit({
      target: target('foreign-collision'),
      idempotencyKey: 'foreign-collision',
      command,
    });

    expect(result).toMatchObject({ kind: 'ambiguous', sessionId: sharedSessionId });
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.chatId).not.toBe('foreign-chat');
    expect(turns.accepts).not.toHaveBeenCalled();
  });

  it('does not borrow chat identity from an ownerless row in another owner file', async () => {
    const sharedSessionId = 'shared-persisted-session-id';
    sessionStore.init('cli_OTHER_OWNER');
    sessionStore.createSessionExact({
      sessionId: sharedSessionId,
      createdAt: '2026-08-10T00:00:00.000Z',
      chatId: 'foreign-persisted-chat',
      rootMessageId: 'foreign-persisted-root',
      title: 'foreign ownerless row',
      chatType: 'group',
      scope: 'thread',
    });
    const claim = idempotencyStore.claim({
      ownerLarkAppId: APP,
      key: 'foreign-persisted-collision',
      sessionId: sharedSessionId,
      triggerId: 'old-trigger',
      requestHash: requestHash('foreign-persisted-collision'),
      ownerBootId: 'boot-old',
      now: 1,
    });
    if (claim.kind !== 'won') throw new Error('expected claim');
    idempotencyStore.transition(APP, 'foreign-persisted-collision', claim.record, {
      state: 'attempting',
      now: 2,
    });
    const turns = new TestTurns();
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: new Map(),
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
      keyedTriggerTurns: turns,
    });

    const result = await host.runtime.submit({
      target: target('foreign-persisted-collision'),
      idempotencyKey: 'foreign-persisted-collision',
      command: startCommand('foreign-persisted-collision'),
    });

    expect(result).toMatchObject({ kind: 'ambiguous', sessionId: sharedSessionId });
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.chatId).not.toBe('foreign-persisted-chat');
    expect(turns.accepts).not.toHaveBeenCalled();
  });

  it('read-backs an exact fresh claim after post-write response loss and continues once', async () => {
    const registry = new Map<string, DaemonSession>();
    const turns = new TestTurns();
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
      keyedTriggerTurns: turns,
    });
    const realClaim = idempotencyStore.claim;
    const claimSpy = vi.spyOn(idempotencyStore, 'claim').mockImplementationOnce((input) => {
      realClaim(input);
      throw new Error('injected post-rename response loss');
    });
    const command = startCommand('claim-readback');

    const result = await host.runtime.submit({
      target: target('claim-readback'),
      idempotencyKey: 'claim-readback',
      command,
    });
    claimSpy.mockRestore();

    expect(result).toMatchObject({ kind: 'applied', action: 'keyedTrigger.started' });
    expect(turns.accepts).toHaveBeenCalledTimes(1);
    expect(idempotencyStore.lookup(APP, 'claim-readback')?.state).toBe('attempting');
  });

  it('read-backs an exact takeover after post-write response loss and continues once', async () => {
    const old = idempotencyStore.claim({
      ownerLarkAppId: APP,
      key: 'takeover-readback',
      sessionId: 'old-session',
      triggerId: 'old-trigger',
      requestHash: requestHash('takeover-readback'),
      ownerBootId: 'boot-old',
      now: 1,
    });
    if (old.kind !== 'won') throw new Error('expected old claim');
    const registry = new Map<string, DaemonSession>();
    const turns = new TestTurns();
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => false,
      keyedTriggerTurns: turns,
    });
    const realTakeover = idempotencyStore.takeover;
    const takeoverSpy = vi.spyOn(idempotencyStore, 'takeover').mockImplementationOnce((input) => {
      realTakeover(input);
      throw new Error('injected takeover response loss');
    });
    const command = startCommand('takeover-readback');

    const result = await host.runtime.submit({
      target: target('takeover-readback'),
      idempotencyKey: 'takeover-readback',
      command,
    });
    takeoverSpy.mockRestore();

    expect(result).toMatchObject({ kind: 'applied', action: 'keyedTrigger.started' });
    expect(turns.accepts).toHaveBeenCalledTimes(1);
    expect(idempotencyStore.lookup(APP, 'takeover-readback')).toMatchObject({
      state: 'attempting',
      sessionId: 'candidate-takeover-readback',
      ownerBootId: 'boot-current',
    });
  });

  it('rechecks a freeze acquired after reserve and proves the lease released before retryable', async () => {
    let blocked = false;
    const registry = new Map<string, DaemonSession>();
    const turns = new TestTurns();
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions: registry,
      ownerBootId: 'boot-current',
      keyedTriggerAdmissionBlocked: () => blocked,
      keyedTriggerTurns: turns,
    });
    const realClaim = idempotencyStore.claim;
    const claimSpy = vi.spyOn(idempotencyStore, 'claim').mockImplementationOnce((input) => {
      const result = realClaim(input);
      blocked = true;
      return result;
    });
    const command = startCommand('late-freeze');

    const result = await host.runtime.submit({
      target: target('late-freeze'),
      idempotencyKey: 'late-freeze',
      command,
    });
    claimSpy.mockRestore();

    expect(result).toMatchObject({ kind: 'retryable' });
    expect(turns.accepts).not.toHaveBeenCalled();
    expect(idempotencyStore.lookup(APP, 'late-freeze')).toBeUndefined();
  });
});
