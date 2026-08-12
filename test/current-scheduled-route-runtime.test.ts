import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, ScheduledTask } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type {
  CommandOutcome,
  SessionAddress,
  SessionCommand,
  SessionCommandRequest,
  SessionProjection,
  SessionRuntime,
} from '../src/core/session-runtime.js';

const boundary = vi.hoisted(() => ({
  bots: vi.fn(),
  sendMessage: vi.fn(),
  replyMessage: vi.fn(),
  getChatMode: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  closeSession: vi.fn(),
  ensureQueue: vi.fn(),
  regularGroupMode: vi.fn(),
  sessionSequence: { value: 0 },
  stored: new Map<string, Session>(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getAllBots: (...args: unknown[]) => boundary.bots(...args),
  getBot: vi.fn(),
  getOwnerOpenId: vi.fn(),
  findOncallChat: vi.fn(),
  findOncallChatForAnyBot: vi.fn(),
  effectiveDefaultWorkingDir: vi.fn(),
}));

vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...args: unknown[]) => boundary.sendMessage(...args),
  replyMessage: (...args: unknown[]) => boundary.replyMessage(...args),
  getChatMode: (...args: unknown[]) => boundary.getChatMode(...args),
  getMessageThreadId: vi.fn(),
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(async () => []),
  UserTokenMissingError: class extends Error {},
}));

vi.mock('../src/services/session-store.js', () => ({
  createSession: (...args: unknown[]) => boundary.createSession(...args),
  updateSession: (...args: unknown[]) => boundary.updateSession(...args),
  getSession: vi.fn((sessionId: string) => boundary.stored.get(sessionId)),
  listSessions: vi.fn(() => [...boundary.stored.values()]),
  closeSession: vi.fn(),
  updateSessionPid: vi.fn(),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({
  ensureQueue: (...args: unknown[]) => boundary.ensureQueue(...args),
}));

vi.mock('../src/services/chat-reply-mode-store.js', () => ({
  resolveRegularGroupMode: (...args: unknown[]) => boundary.regularGroupMode(...args),
}));

vi.mock('../src/services/whiteboard-store.js', () => ({
  whiteboardEnabled: vi.fn(() => false),
  getWhiteboard: vi.fn(),
  ensureDefaultWhiteboard: vi.fn(),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  closeSession: (...args: unknown[]) => boundary.closeSession(...args),
  getCurrentCliVersion: vi.fn(() => 'test-cli-v1'),
  isDisposableCommandScratch: vi.fn((current: DaemonSession) => (
    !current.worker
    && !current.pendingRepo
    && current.pendingPrompt === undefined
    && current.pendingRawInput === undefined
    && !current.adoptedFrom
    && !current.session.adoptedFrom
    && !current.session.queued
    && !current.session.cliId
    && !current.session.lastCliInput
  )),
  isRelayableRealSession: vi.fn((current: DaemonSession) => (
    (!!current.worker && !current.worker.killed)
    || !!current.session.cliId
    || !!current.session.lastCliInput
  )),
  sendWorkerInput: vi.fn(() => true),
  setActiveSessionIfActive: vi.fn((
    activeSessions: Map<string, DaemonSession>,
    key: string,
    current: DaemonSession,
  ) => {
    if (activeSessions.has(key) && activeSessions.get(key) !== current) return false;
    activeSessions.set(key, current);
    return true;
  }),
  forkWorker: vi.fn(() => true),
  forkAdoptWorker: vi.fn(),
  adoptSandboxBlocked: vi.fn(() => false),
  killStalePids: vi.fn(),
  sweepDeadPidMarkers: vi.fn(),
  getDaemonBootId: vi.fn(() => 'test-daemon-epoch'),
  restoreUsageLimitRuntimeState: vi.fn(),
  setActiveSessionSafe: vi.fn(),
  getActiveSessionsRegistry: vi.fn(() => null),
  withActiveSessionKeyLock: vi.fn(async (
    _activeSessions: Map<string, DaemonSession>,
    _key: string,
    action: () => unknown,
  ) => action()),
  suspendWorker: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));
vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn((current: DaemonSession) => ({
    sessionId: current.session.sessionId,
  })),
}));
vi.mock('../src/core/role-resolver.js', () => ({
  resolveRole: vi.fn(() => ({ content: null, source: undefined })),
  resolveRoleInjection: vi.fn(() => ({
    content: null, source: undefined, injectMode: 'none',
  })),
}));

import { createCurrentScheduledFireAdapter } from '../src/core/current-scheduled-fire.js';
import {
  currentRouteAdmissionKey,
  isCurrentRouteAdmissionToken,
  reserveCurrentRouteAdmission,
} from '../src/core/current-route-admission.js';
import {
  createDeadlineScheduledFireIdentity,
  createScheduledFireEnvelope,
} from '../src/core/scheduled-fire.js';
import { sessionKey } from '../src/core/types.js';

const OWNER = 'cli_owner';
const CHAT = 'oc_chat';
const BOT = {
  config: {
    larkAppId: OWNER,
    cliId: 'codex',
    cliPathOverride: undefined,
    defaultWorkingDir: '/work',
  },
  botName: 'Schedule Bot',
  botOpenId: 'ou_bot',
};

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'daily',
    definitionRevision: 2,
    name: 'daily',
    schedule: 'every 30m',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
    prompt: 'check',
    workingDir: '/work',
    chatId: CHAT,
    chatType: 'group',
    scope: 'chat',
    executionPosition: 'new-topic',
    larkAppId: OWNER,
    enabled: true,
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function fire(overrides: Partial<ScheduledTask> = {}) {
  const identity = createDeadlineScheduledFireIdentity({
    scheduleId: 'daily',
    definitionRevision: 2,
    scheduledFor: '2026-08-11T01:30:00.000Z',
  });
  return createScheduledFireEnvelope(identity, task(overrides));
}

function requestFor(input: ReturnType<typeof fire>) {
  return {
    target: { kind: 'route' as const, route: { kind: 'schedule' as const, runId: input.runId } },
    idempotencyKey: input.runId,
    command: { kind: 'scheduled.fire' as const, input },
  };
}

function currentSession(session: Session): DaemonSession {
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: OWNER,
    chatId: session.chatId,
    chatType: session.chatType ?? 'group',
    scope: session.scope ?? 'thread',
    spawnedAt: Date.parse(session.createdAt ?? '') || 0,
    cliVersion: 'test-cli-v1',
    lastMessageAt: 0,
    hasHistory: false,
    workingDir: '/work',
  };
}

function wrappedHost(options: {
  readonly activeSessions?: Map<string, DaemonSession>;
  readonly submit: (request: SessionCommandRequest) => Promise<CommandOutcome>;
  readonly readDefinitionRevision?: (scheduleId: string) => number | undefined;
  readonly beforeProjectionRead?: (
    query: Parameters<SessionProjection['read']>[0],
  ) => void | Promise<void>;
}) {
  const activeSessions = options.activeSessions ?? new Map<string, DaemonSession>();
  const addresses = new Map<string, SessionAddress>();
  const projection: SessionProjection = {
    read: vi.fn(async (query) => {
      await options.beforeProjectionRead?.(query);
      const sessions = new Map(boundary.stored);
      for (const current of activeSessions.values()) {
        sessions.set(current.session.sessionId, current.session);
      }
      const matches = [...sessions.values()].filter((session) => {
        if (query.kind === 'byExternalSession') return session.sessionId === query.sessionId;
        if (query.kind !== 'byRoute') return false;
        return query.route.kind === 'thread'
          ? (session.scope ?? 'thread') === 'thread'
            && session.rootMessageId === query.route.anchorId
          : (session.scope ?? 'thread') === 'chat'
            && session.chatId === query.route.chatId;
      });
      const active = matches.filter(session => session.status === 'active');
      const session = query.kind === 'byRoute'
        ? active.length === 1 ? active[0] : undefined
        : matches.length === 1 ? matches[0] : undefined;
      if (!session) {
        return (query.kind === 'byRoute' ? active.length : matches.length) > 1
          ? { kind: 'notReady' as const, message: 'multiple projected Sessions' }
          : { kind: 'notFound' as const };
      }
      let address = addresses.get(session.sessionId);
      if (!address) {
        address = Object.freeze({}) as SessionAddress;
        addresses.set(session.sessionId, address);
      }
      return {
        kind: 'one' as const,
        session: {
          address,
          sessionId: session.sessionId,
          route: (session.scope ?? 'thread') === 'thread'
            ? { kind: 'thread' as const, anchorId: session.rootMessageId }
            : { kind: 'chat' as const, chatId: session.chatId },
          recordStatus: session.status === 'active' ? 'active' as const : 'closed' as const,
          executorStatus: 'dormant' as const,
        },
      };
    }),
  };
  const submit = vi.fn(options.submit) as unknown as SessionRuntime['submit'];
  const adapter = createCurrentScheduledFireAdapter({
    ownerLarkAppId: OWNER,
    activeSessions,
    refreshCliVersion: vi.fn(),
    readDefinitionRevision: options.readDefinitionRevision ?? (() => 2),
  });
  return {
    activeSessions,
    projection,
    submit,
    runtime: adapter.wrapRuntime({ runtime: { submit }, projection }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.stored.clear();
  boundary.sessionSequence.value = 0;
  boundary.bots.mockReturnValue([BOT]);
  boundary.sendMessage.mockImplementation(async () => (
    `om_topic_${boundary.sendMessage.mock.calls.length}`
  ));
  boundary.replyMessage.mockResolvedValue('om_reply');
  boundary.getChatMode.mockResolvedValue('group');
  boundary.regularGroupMode.mockReturnValue('shared');
  boundary.createSession.mockImplementation((
    chatId: string,
    rootMessageId: string,
    title: string,
    chatType: 'group' | 'p2p' = 'group',
  ) => {
    const session: Session = {
      sessionId: `session-${++boundary.sessionSequence.value}`,
      chatId,
      rootMessageId,
      title,
      chatType,
      status: 'active',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(session.sessionId, session);
    return session;
  });
  boundary.updateSession.mockImplementation((session: Session) => {
    boundary.stored.set(session.sessionId, session);
  });
});

describe('Current scheduled route Runtime receipts', () => {
  it('keeps an ambiguous route terminal sticky and rejects another payload for the run', async () => {
    const host = wrappedHost({
      submit: async (request) => ({
        kind: 'ambiguous',
        state: 'dispatchUnknown',
        policy: 'scheduled-process-local',
        durability: 'processLocal',
        sessionId: request.target.kind === 'session' ? 'session-1' : 'unexpected',
        message: 'worker response was lost',
        idempotent: false,
      }),
    });
    const original = fire();

    await expect(host.runtime.submit(requestFor(original))).resolves.toMatchObject({
      kind: 'ambiguous', idempotent: false,
    });
    await expect(host.runtime.submit(requestFor(original))).resolves.toMatchObject({
      kind: 'ambiguous', idempotent: true,
    });
    await expect(host.runtime.submit(requestFor(fire({ prompt: 'different' }))))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'idempotencyConflict' });
    expect(boundary.sendMessage).toHaveBeenCalledOnce();
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it('keeps an execute-level thrown outcome quarantined without reopening the route', async () => {
    const host = wrappedHost({
      submit: async () => { throw new Error('downstream response lost'); },
    });
    const scheduled = fire();

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'quarantined', message: expect.stringContaining('response lost'),
    });
    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'quarantined', message: expect.stringContaining('response lost'),
    });
    expect(boundary.sendMessage).toHaveBeenCalledOnce();
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it('keeps a thrown silent continuation dispatch sticky once the child effect may have started', async () => {
    const existingSession: Session = {
      sessionId: 'session-existing-silent',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'existing silent route',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      cliId: 'codex',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(existingSession.sessionId, existingSession);
    const activeSessions = new Map([
      [sessionKey(CHAT, OWNER), currentSession(existingSession)],
    ]);
    const host = wrappedHost({
      activeSessions,
      submit: async () => { throw new Error('silent child response lost'); },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('response lost'),
    });
    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('response lost'),
    });
    expect(boundary.sendMessage).not.toHaveBeenCalled();
    expect(boundary.createSession).not.toHaveBeenCalled();
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it('re-drives a silent existing route after its final exact projection is not ready', async () => {
    const existingSession: Session = {
      sessionId: 'session-existing-projection-retry',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'existing projection retry',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      cliId: 'codex',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(existingSession.sessionId, existingSession);
    const activeSessions = new Map([
      [sessionKey(CHAT, OWNER), currentSession(existingSession)],
    ]);
    const host = wrappedHost({
      activeSessions,
      submit: async () => ({
        kind: 'applied',
        action: 'scheduled.inputAccepted',
        policy: 'scheduled-process-local',
        durability: 'processLocal',
        sessionId: existingSession.sessionId,
      }),
    });
    vi.mocked(host.projection.read).mockResolvedValueOnce({
      kind: 'notReady',
      message: 'exact projection is rebuilding',
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'retryable',
      message: 'exact projection is rebuilding',
    });
    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'applied',
      sessionId: existingSession.sessionId,
    });
    expect(boundary.sendMessage).not.toHaveBeenCalled();
    expect(boundary.createSession).not.toHaveBeenCalled();
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'typed retryable', outcome: { kind: 'retryable' as const, message: 'child not started' } },
    { label: 'stale address', outcome: { kind: 'staleAddress' as const } },
    {
      label: 'unwired port',
      outcome: {
        kind: 'notWired' as const,
        command: 'scheduled.fire' as const,
        message: 'scheduled port is not wired',
      },
    },
  ])('re-drives a silent existing route after a $label proves no child effect', async ({ outcome }) => {
    const existingSession: Session = {
      sessionId: 'session-existing-child-retry',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'existing child retry',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      cliId: 'codex',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(existingSession.sessionId, existingSession);
    const activeSessions = new Map([
      [sessionKey(CHAT, OWNER), currentSession(existingSession)],
    ]);
    let attempts = 0;
    const host = wrappedHost({
      activeSessions,
      submit: async () => {
        attempts += 1;
        if (attempts === 1) return outcome;
        return {
          kind: 'applied',
          action: 'scheduled.inputAccepted',
          policy: 'scheduled-process-local',
          durability: 'processLocal',
          sessionId: existingSession.sessionId,
        };
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'retryable',
    });
    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'applied',
      sessionId: existingSession.sessionId,
    });
    expect(boundary.sendMessage).not.toHaveBeenCalled();
    expect(boundary.createSession).not.toHaveBeenCalled();
    expect(host.submit).toHaveBeenCalledTimes(2);
  });

  it('re-drives only a same-hash pure pre-effect retryable and reserves its hash', async () => {
    boundary.bots
      .mockReturnValueOnce([])
      .mockReturnValue([BOT]);
    const host = wrappedHost({
      submit: async () => ({
        kind: 'applied',
        action: 'scheduled.inputAccepted',
        policy: 'scheduled-process-local',
        durability: 'processLocal',
        sessionId: 'session-1',
      }),
    });
    const original = fire();

    await expect(host.runtime.submit(requestFor(original))).resolves.toMatchObject({
      kind: 'retryable',
    });
    await expect(host.runtime.submit(requestFor(fire({ prompt: 'different' }))))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'idempotencyConflict' });
    await expect(host.runtime.submit(requestFor(original))).resolves.toMatchObject({
      kind: 'applied', sessionId: 'session-1',
    });
    expect(boundary.sendMessage).toHaveBeenCalledOnce();
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it('re-drives a same-hash definition preflight read failure without releasing its hash', async () => {
    const readDefinitionRevision = vi.fn()
      .mockImplementationOnce(() => { throw new Error('schedule store unavailable'); })
      .mockReturnValue(2);
    const host = wrappedHost({
      readDefinitionRevision,
      submit: async () => ({
        kind: 'applied',
        action: 'scheduled.inputAccepted',
        policy: 'scheduled-process-local',
        durability: 'processLocal',
        sessionId: 'session-1',
      }),
    });
    const original = fire();

    await expect(host.runtime.submit(requestFor(original))).resolves.toMatchObject({
      kind: 'retryable', message: expect.stringContaining('store unavailable'),
    });
    await expect(host.runtime.submit(requestFor(fire({ prompt: 'different' }))))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'idempotencyConflict' });
    await expect(host.runtime.submit(requestFor(original))).resolves.toMatchObject({
      kind: 'applied', sessionId: 'session-1',
    });
    expect(readDefinitionRevision).toHaveBeenCalledTimes(2);
    expect(boundary.sendMessage).toHaveBeenCalledOnce();
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'typed retryable',
      outcome: {
        kind: 'retryable' as const,
        message: 'downstream activation was refused after route publication',
      },
    },
    { label: 'stale address', outcome: { kind: 'staleAddress' as const } },
    {
      label: 'unwired port',
      outcome: {
        kind: 'notWired' as const,
        command: 'scheduled.fire' as const,
        message: 'scheduled port is not wired',
      },
    },
  ])('quarantines a $label settlement after route effects', async ({ outcome }) => {
    const host = wrappedHost({
      submit: async () => outcome,
    });
    const scheduled = fire();

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('after route effects'),
    });
    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('after route effects'),
    });
    expect(boundary.sendMessage).toHaveBeenCalledOnce();
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it('re-drives a silent route after a projection retry before any effect starts', async () => {
    for (const sessionId of ['ambiguous-one', 'ambiguous-two']) {
      boundary.stored.set(sessionId, {
        sessionId,
        chatId: CHAT,
        rootMessageId: CHAT,
        title: sessionId,
        chatType: 'group',
        scope: 'chat',
        status: 'active',
        larkAppId: OWNER,
        createdAt: '2026-08-10T00:00:00.000Z',
      });
    }
    const host = wrappedHost({
      submit: async () => ({
        kind: 'applied',
        action: 'scheduled.inputAccepted',
        policy: 'scheduled-process-local',
        durability: 'processLocal',
        sessionId: 'session-1',
      }),
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    const first = await host.runtime.submit(requestFor(scheduled));
    boundary.stored.clear();
    const second = await host.runtime.submit(requestFor(scheduled));

    expect(first).toMatchObject({ kind: 'retryable' });
    expect(second).toMatchObject({ kind: 'applied', sessionId: 'session-1' });
    expect(boundary.sendMessage).not.toHaveBeenCalled();
    expect(boundary.replyMessage).not.toHaveBeenCalled();
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it('fails closed when the durable route census returns the wrong projection shape', async () => {
    const host = wrappedHost({
      submit: async () => {
        throw new Error('malformed projection must stop dispatch');
      },
    });
    vi.mocked(host.projection.read).mockResolvedValueOnce({
      kind: 'list',
      sessions: [],
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('projection'),
    });
    expect(boundary.createSession).not.toHaveBeenCalled();
    expect(host.submit).not.toHaveBeenCalled();
  });

  it('retires a continuation scratch through exact Session control under the held route admission', async () => {
    const scratchSession: Session = {
      sessionId: 'session-scratch',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'scratch',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(scratchSession.sessionId, scratchSession);
    const activeSessions = new Map([
      [sessionKey(CHAT, OWNER), currentSession(scratchSession)],
    ]);
    const calls: string[] = [];
    const admissionKey = currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      scope: 'chat',
      canonicalAnchor: CHAT,
      chatId: CHAT,
      chatType: 'group',
    });
    const host = wrappedHost({
      activeSessions,
      submit: async (request) => {
        if (request.command.kind === 'control.mutate') {
          calls.push('control.closeScratch');
          expect(request.command.input).toEqual({
            kind: 'close',
            reason: 'routeScratch',
            source: 'scheduler',
            expectedRoute: {
              scope: 'chat', canonicalAnchor: CHAT, chatId: CHAT, chatType: 'group',
            },
          });
          expect(request.target.kind).toBe('session');
          if (request.target.kind !== 'session') throw new Error('expected Session target');
          expect(isCurrentRouteAdmissionToken({
            token: request.target.controlRouteReservation,
            key: admissionKey,
          })).toBe(true);
          activeSessions.delete(sessionKey(CHAT, OWNER));
          scratchSession.status = 'closed';
          return {
            kind: 'applied',
            action: 'control.mutated',
            policy: 'control-staged-transition',
            sessionId: scratchSession.sessionId,
            result: { kind: 'closed', alreadyClosed: false, known: true },
          };
        }
        calls.push('scheduled.fire');
        return {
          kind: 'applied',
          action: 'scheduled.inputAccepted',
          policy: 'scheduled-process-local',
          durability: 'processLocal',
          sessionId: 'session-1',
        };
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'applied', sessionId: 'session-1',
    });
    expect(calls).toEqual(['control.closeScratch', 'scheduled.fire']);
    expect(boundary.closeSession).not.toHaveBeenCalled();
  });

  it('does not create over a continuation owner that is neither resumable nor disposable', async () => {
    const openingSession: Session = {
      sessionId: 'session-dashboard-opening',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'dashboard opening',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(openingSession.sessionId, openingSession);
    const opening = currentSession(openingSession);
    opening.dashboardSpawnOpeningPending = true;
    const activeSessions = new Map([
      [sessionKey(CHAT, OWNER), opening],
    ]);
    const host = wrappedHost({
      activeSessions,
      submit: async () => {
        throw new Error('protected opening owner must stop scheduled dispatch');
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'routeBusy',
    });
    expect(boundary.createSession).not.toHaveBeenCalled();
    expect(host.submit).not.toHaveBeenCalled();
  });

  it('never creates over a persisted-only real continuation owner', async () => {
    const durableOwner: Session = {
      sessionId: 'session-durable-real',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'durable owner',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      cliId: 'codex',
      lastCliInput: 'accepted input',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(durableOwner.sessionId, durableOwner);
    const admissionKey = currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      scope: 'chat',
      canonicalAnchor: CHAT,
      chatId: CHAT,
      chatType: 'group',
    });
    const host = wrappedHost({
      submit: async (request) => {
        expect(request.command).toMatchObject({
          kind: 'control.mutate',
          input: { kind: 'close', reason: 'routeScratch', source: 'scheduler' },
        });
        expect(request.target.kind).toBe('session');
        if (request.target.kind !== 'session') throw new Error('expected Session target');
        expect(isCurrentRouteAdmissionToken({
          token: request.target.controlRouteReservation,
          key: admissionKey,
        })).toBe(true);
        return {
          kind: 'rejected',
          reason: 'transitionRejected',
          code: 'target_chat_has_session',
          message: 'target_chat_has_session',
        };
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'routeBusy',
    });
    expect(boundary.createSession).not.toHaveBeenCalled();
    expect(host.activeSessions).toEqual(new Map());
    expect(host.submit).toHaveBeenCalledOnce();
  });

  it('conditionally retires a persisted-only scratch before publishing one winner', async () => {
    const durableScratch: Session = {
      sessionId: 'session-durable-scratch',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'durable scratch',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(durableScratch.sessionId, durableScratch);
    const calls: string[] = [];
    const admissionKey = currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      scope: 'chat',
      canonicalAnchor: CHAT,
      chatId: CHAT,
      chatType: 'group',
    });
    const host = wrappedHost({
      submit: async (request) => {
        if (request.command.kind === 'control.mutate') {
          calls.push('control.closeScratch');
          expect(request.target.kind).toBe('session');
          if (request.target.kind !== 'session') throw new Error('expected Session target');
          expect(isCurrentRouteAdmissionToken({
            token: request.target.controlRouteReservation,
            key: admissionKey,
          })).toBe(true);
          expect(request.command.input).toEqual({
            kind: 'close',
            reason: 'routeScratch',
            source: 'scheduler',
            expectedRoute: {
              scope: 'chat', canonicalAnchor: CHAT, chatId: CHAT, chatType: 'group',
            },
          });
          durableScratch.status = 'closed';
          return {
            kind: 'applied',
            action: 'control.mutated',
            policy: 'control-staged-transition',
            sessionId: durableScratch.sessionId,
            result: { kind: 'closed', alreadyClosed: false, known: true },
          };
        }
        calls.push('scheduled.fire');
        return {
          kind: 'applied',
          action: 'scheduled.inputAccepted',
          policy: 'scheduled-process-local',
          durability: 'processLocal',
          sessionId: 'session-1',
        };
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-1',
    });
    expect(calls).toEqual(['control.closeScratch', 'scheduled.fire']);
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect([...boundary.stored.values()].filter(session => session.status === 'active'))
      .toEqual([expect.objectContaining({ sessionId: 'session-1' })]);
    expect(boundary.closeSession).not.toHaveBeenCalled();
  });

  it('creates after scratch retirement when the route retains multiple closed histories', async () => {
    for (const sessionId of ['closed-history-one', 'closed-history-two']) {
      boundary.stored.set(sessionId, {
        sessionId,
        chatId: CHAT,
        rootMessageId: CHAT,
        title: sessionId,
        chatType: 'group',
        scope: 'chat',
        status: 'closed',
        larkAppId: OWNER,
        createdAt: '2026-08-09T00:00:00.000Z',
      });
    }
    const durableScratch: Session = {
      sessionId: 'active-scratch-with-history',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'active scratch',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(durableScratch.sessionId, durableScratch);
    const host = wrappedHost({
      submit: async (request) => {
        if (request.command.kind === 'control.mutate') {
          durableScratch.status = 'closed';
          return {
            kind: 'applied',
            action: 'control.mutated',
            policy: 'control-staged-transition',
            sessionId: durableScratch.sessionId,
            result: { kind: 'closed', alreadyClosed: false, known: true },
          };
        }
        return {
          kind: 'applied',
          action: 'scheduled.inputAccepted',
          policy: 'scheduled-process-local',
          durability: 'processLocal',
          sessionId: 'session-1',
        };
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-1',
    });
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect([...boundary.stored.values()].filter(session => session.status === 'active'))
      .toEqual([expect.objectContaining({ sessionId: 'session-1' })]);
  });

  it.each(['closed', 'moved'] as const)(
    'continues to final route census when an in-memory scratch became %s before exact projection',
    async (departure) => {
      const scratchSession: Session = {
        sessionId: `session-scratch-${departure}`,
        chatId: CHAT,
        rootMessageId: CHAT,
        title: 'departing scratch',
        chatType: 'group',
        scope: 'chat',
        status: 'active',
        larkAppId: OWNER,
        createdAt: '2026-08-10T00:00:00.000Z',
      };
      const scratch = currentSession(scratchSession);
      boundary.stored.set(scratchSession.sessionId, scratchSession);
      const targetKey = sessionKey(CHAT, OWNER);
      const activeSessions = new Map([[targetKey, scratch]]);
      let departed = false;
      const host = wrappedHost({
        activeSessions,
        beforeProjectionRead(query) {
          if (departed || query.kind !== 'byExternalSession') return;
          departed = true;
          activeSessions.delete(targetKey);
          if (departure === 'closed') {
            scratchSession.status = 'closed';
            return;
          }
          scratchSession.chatId = 'oc_moved_scratch';
          scratchSession.rootMessageId = 'oc_moved_scratch';
          scratch.chatId = 'oc_moved_scratch';
          activeSessions.set(sessionKey('oc_moved_scratch', OWNER), scratch);
        },
        submit: async (request) => {
          if (request.command.kind === 'control.mutate') {
            throw new Error('departed scratch must not be closed');
          }
          return {
            kind: 'applied',
            action: 'scheduled.inputAccepted',
            policy: 'scheduled-process-local',
            durability: 'processLocal',
            sessionId: 'session-1',
          };
        },
      });
      const scheduled = fire({
        executionPosition: 'top-level',
        scope: 'chat',
        silent: true,
      });

      await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
        kind: 'applied',
        sessionId: 'session-1',
      });
      expect(boundary.createSession).toHaveBeenCalledOnce();
      expect(host.submit).toHaveBeenCalledOnce();
    },
  );

  it('does not create over a reply winner that claims a visible fresh-topic anchor', async () => {
    const topicAnchor = 'om_visible_topic_reply_race';
    const activeSessions = new Map<string, DaemonSession>();
    const replyWinner: Session = {
      sessionId: 'session-reply-winner',
      chatId: CHAT,
      rootMessageId: topicAnchor,
      title: 'reply winner',
      chatType: 'group',
      scope: 'thread',
      status: 'active',
      larkAppId: OWNER,
      cliId: 'codex',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.regularGroupMode.mockReturnValue('new-topic');
    boundary.sendMessage.mockImplementationOnce(async () => {
      const replyAdmission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
        ownerLarkAppId: OWNER,
        scope: 'thread',
        canonicalAnchor: topicAnchor,
        chatId: CHAT,
        chatType: 'group',
      }));
      await replyAdmission.ready;
      boundary.stored.set(replyWinner.sessionId, replyWinner);
      activeSessions.set(sessionKey(topicAnchor, OWNER), currentSession(replyWinner));
      queueMicrotask(() => replyAdmission.release());
      return topicAnchor;
    });
    const host = wrappedHost({
      activeSessions,
      submit: async () => {
        throw new Error('reply winner must stop scheduled dispatch');
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: false,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'routeBusy',
    });
    expect(boundary.createSession).not.toHaveBeenCalled();
    expect(activeSessions.get(sessionKey(topicAnchor, OWNER))?.session.sessionId)
      .toBe(replyWinner.sessionId);
    expect(host.submit).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'typed retryable',
      outcome: {
        kind: 'retryable' as const,
        message: 'conditional close did not publish a fence',
      },
    },
    { label: 'stale address', outcome: { kind: 'staleAddress' as const } },
    {
      label: 'unwired control port',
      outcome: {
        kind: 'notWired' as const,
        command: 'control.mutate' as const,
        message: 'control port is not wired',
      },
    },
  ])('re-drives a persisted-route close after a $label proves no effect', async ({ outcome }) => {
    const durableScratch: Session = {
      sessionId: 'session-durable-retryable',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'durable scratch',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(durableScratch.sessionId, durableScratch);
    let closeAttempts = 0;
    const host = wrappedHost({
      submit: async (request) => {
        if (request.command.kind === 'control.mutate') {
          closeAttempts += 1;
          if (closeAttempts === 1) return outcome;
          durableScratch.status = 'closed';
          return {
            kind: 'applied',
            action: 'control.mutated',
            policy: 'control-staged-transition',
            sessionId: durableScratch.sessionId,
            result: { kind: 'closed', alreadyClosed: false, known: true },
          };
        }
        return {
          kind: 'applied',
          action: 'scheduled.inputAccepted',
          policy: 'scheduled-process-local',
          durability: 'processLocal',
          sessionId: 'session-1',
        };
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'retryable',
    });
    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-1',
    });
    expect(boundary.createSession).toHaveBeenCalledOnce();
    expect(closeAttempts).toBe(2);
    expect(host.submit).toHaveBeenCalledTimes(3);
  });

  it('re-drives after an already-departed close proof and an inconclusive final census', async () => {
    const durableScratch: Session = {
      sessionId: 'session-durable-already-departed',
      chatId: CHAT,
      rootMessageId: CHAT,
      title: 'already departed scratch',
      chatType: 'group',
      scope: 'chat',
      status: 'active',
      larkAppId: OWNER,
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    boundary.stored.set(durableScratch.sessionId, durableScratch);
    let controlCalls = 0;
    const host = wrappedHost({
      submit: async (request) => {
        if (request.command.kind === 'control.mutate') {
          controlCalls += 1;
          boundary.stored.set('session-census-conflict', {
            ...durableScratch,
            sessionId: 'session-census-conflict',
          });
          return {
            kind: 'applied',
            action: 'control.mutated',
            policy: 'control-staged-transition',
            sessionId: durableScratch.sessionId,
            result: { kind: 'closed', alreadyClosed: true, known: false },
          };
        }
        return {
          kind: 'applied',
          action: 'scheduled.inputAccepted',
          policy: 'scheduled-process-local',
          durability: 'processLocal',
          sessionId: 'session-1',
        };
      },
    });
    const scheduled = fire({
      executionPosition: 'top-level',
      scope: 'chat',
      silent: true,
    });

    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'retryable',
    });
    boundary.stored.clear();
    await expect(host.runtime.submit(requestFor(scheduled))).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-1',
    });
    expect(controlCalls).toBe(1);
    expect(boundary.createSession).toHaveBeenCalledOnce();
  });
});
