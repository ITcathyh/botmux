import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  activateQueuedSession: vi.fn(),
  closeSession: vi.fn(),
  ensureCurrentSessionActivation: vi.fn(),
  isSessionTransferring: vi.fn(() => false),
  latestPerBotEnvForRestart: vi.fn(),
  resolveOwnerUnionId: vi.fn(),
  resumeSession: vi.fn(),
  retireCurrentSessionActivation: vi.fn(),
  suspendWorker: vi.fn(),
  transferSession: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  activateQueuedSession: lifecycle.activateQueuedSession,
  resumeSession: lifecycle.resumeSession,
}));

vi.mock('../src/core/worker-pool.js', () => ({
  closeSession: lifecycle.closeSession,
  isSessionTransferring: lifecycle.isSessionTransferring,
  latestPerBotEnvForRestart: lifecycle.latestPerBotEnvForRestart,
  suspendWorker: lifecycle.suspendWorker,
  transferSession: lifecycle.transferSession,
}));

vi.mock('../src/core/current-session-activation.js', () => ({
  ensureCurrentSessionActivation: lifecycle.ensureCurrentSessionActivation,
  retireCurrentSessionActivation: lifecycle.retireCurrentSessionActivation,
}));

vi.mock('../src/im/lark/client.js', () => ({
  resolveUnionIdFromOpenId: lifecycle.resolveOwnerUnionId,
}));

import { createCurrentSessionControlPort } from '../src/core/current-session-control.js';
import type {
  ControlMutationInput,
  ControlMutationPort,
  ControlMutationTransitionResult,
} from '../src/core/session-runtime.js';
import type { SessionStore } from '../src/core/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

const OWNER = 'cli_peer';
const SESSION_ID = 'session-relocate';
const ROUTE_RESERVATION = Object.freeze({ test: 'target-route-reservation' });
const acceptsRouteReservation = vi.fn(() => true);

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: SESSION_ID,
    chatId: 'oc_source',
    rootMessageId: 'om_source',
    scope: 'thread',
    chatType: 'group',
    title: 'Relocate me',
    status: 'active',
    larkAppId: OWNER,
    ownerOpenId: 'ou_owner',
    createdAt: '2026-08-12T00:00:00.000Z',
    cliId: 'claude-code',
    ...overrides,
  } as Session;
}

function active(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const record = session();
  return {
    session: record,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: OWNER,
    chatId: record.chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: true,
    lastScreenStatus: 'idle',
    ...overrides,
  } as DaemonSession;
}

const unusedStore: SessionStore = {
  load: vi.fn(() => ({ kind: 'notFound' as const })),
  apply: vi.fn(() => ({ kind: 'notApplied' as const, message: 'unused' })),
};

function relocate(overrides: Record<string, unknown> = {}): ControlMutationInput {
  return {
    kind: 'relocate',
    sourceAnchor: 'om_source',
    targetChatId: 'oc_target',
    targetRootMessageId: 'om_target_audit',
    requester: {
      larkAppId: 'cli_leader',
      openId: 'ou_owner',
    },
    ...overrides,
  } as unknown as ControlMutationInput;
}

function begin(
  port: ControlMutationPort,
  command: ControlMutationInput,
): ControlMutationTransitionResult {
  return port.begin({
    sessionId: SESSION_ID,
    operationIdentity: 'relay-op-1',
    command,
    routeReservation: ROUTE_RESERVATION,
  });
}

async function settle(
  port: ControlMutationPort,
  transition: ControlMutationTransitionResult,
): Promise<ControlMutationTransitionResult> {
  let current = transition;
  while (current.kind === 'effect') {
    const value = await port.execute(current.intent);
    current = port.resume(current.continuation, { kind: 'returned', value });
  }
  return current;
}

describe('Current Session relocate control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.isSessionTransferring.mockReturnValue(false);
    lifecycle.transferSession.mockResolvedValue({ ok: true });
    lifecycle.resolveOwnerUnionId.mockResolvedValue(null);
  });

  it('rejects relocate without an opaque reservation from the Current route registry', () => {
    const ds = active();
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore,
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, relocate())).toEqual({
      kind: 'rejected',
      reason: 'invalidCommand',
      code: 'target_route_not_reserved',
      message: 'target_route_not_reserved',
    });
    expect(lifecycle.transferSession).not.toHaveBeenCalled();
  });

  it('relocates only the exact owner-bound canonical Session', async () => {
    const ds = active();
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: unusedStore,
      resolveStoredSession: () => ds.session,
      isRelocationRouteReservation: acceptsRouteReservation,
    });

    await expect(settle(port, begin(port, relocate()))).resolves.toEqual({
      kind: 'committed',
      result: {
        kind: 'relocated',
        targetChatId: 'oc_target',
        targetRootMessageId: 'om_target_audit',
      },
    });
    expect(lifecycle.transferSession).toHaveBeenCalledWith(
      SESSION_ID,
      'oc_target',
      'om_target_audit',
      'group',
      'chat',
      {
        owner: { larkAppId: OWNER, activeSessions: registry },
        isCurrent: expect.any(Function),
        isTargetRouteReservationCurrent: expect.any(Function),
      },
    );
  });

  it('rejects a foreign owner and a non-canonical registry alias', () => {
    const foreign = active({ larkAppId: 'cli_foreign' });
    foreign.session.larkAppId = 'cli_foreign';
    const foreignPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(foreign), foreign]]),
      sessionStore: unusedStore,
      resolveStoredSession: () => undefined,
      isRelocationRouteReservation: acceptsRouteReservation,
    });
    const aliased = active();
    const aliasPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([['non-canonical-alias', aliased]]),
      sessionStore: unusedStore,
      resolveStoredSession: () => undefined,
      isRelocationRouteReservation: acceptsRouteReservation,
    });

    expect(begin(foreignPort, relocate())).toMatchObject({
      kind: 'rejected',
      reason: 'sessionNotFound',
    });
    expect(begin(aliasPort, relocate())).toMatchObject({
      kind: 'unknown',
    });
    expect(lifecycle.transferSession).not.toHaveBeenCalled();
  });

  it('rejects a requester who does not own the source Session', () => {
    const ds = active();
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore,
      resolveStoredSession: () => ds.session,
      isRelocationRouteReservation: acceptsRouteReservation,
    });

    expect(begin(port, relocate({
      requester: { larkAppId: 'cli_leader', openId: 'ou_other' },
    }))).toEqual({
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'not_session_owner',
      message: 'not_session_owner',
    });
  });

  it('resolves the peer-scoped owner open_id before authorizing a cross-app union_id', async () => {
    const ds = active();
    ds.session.ownerOpenId = 'ou_peer_owner';
    const registry = new Map([[activeSessionKey(ds), ds]]);
    lifecycle.resolveOwnerUnionId.mockResolvedValue('on_shared_owner');
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: unusedStore,
      resolveStoredSession: () => ds.session,
      isRelocationRouteReservation: acceptsRouteReservation,
    });

    await expect(settle(port, begin(port, relocate({
      requester: {
        larkAppId: 'cli_leader',
        openId: 'ou_leader_owner',
        unionId: 'on_shared_owner',
      },
    })))).resolves.toMatchObject({
      kind: 'committed',
      result: { kind: 'relocated', targetChatId: 'oc_target' },
    });
    expect(lifecycle.resolveOwnerUnionId).toHaveBeenCalledWith(OWNER, 'ou_peer_owner');
    expect(lifecycle.transferSession).toHaveBeenCalledOnce();
  });

  it('fails stale when the source binding is replaced before the effect', async () => {
    const ds = active();
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: unusedStore,
      resolveStoredSession: () => ds.session,
      isRelocationRouteReservation: acceptsRouteReservation,
    });
    const effect = begin(port, relocate());
    const replacement = active();
    registry.set(activeSessionKey(replacement), replacement);

    await expect(settle(port, effect)).resolves.toEqual({ kind: 'staleAddress' });
    expect(lifecycle.transferSession).not.toHaveBeenCalled();
  });
});
