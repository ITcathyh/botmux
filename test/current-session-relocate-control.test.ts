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
  settleCurrentSessionRetirement: vi.fn(),
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
  settleCurrentSessionRetirement: lifecycle.settleCurrentSessionRetirement,
}));

vi.mock('../src/im/lark/client.js', () => ({
  resolveUnionIdFromOpenId: lifecycle.resolveOwnerUnionId,
}));

import { createCurrentSessionControlPort as createCurrentSessionControlPortImpl } from '../src/core/current-session-control.js';
import type { CurrentSessionActivationCoordinator } from '../src/core/current-session-activation.js';
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
const OWNER_BOT_ID = 'bot_relocateowner' as never;
const RUNTIME_EPOCH = 'daemon-epoch-1';
const ROUTE_RESERVATION = Object.freeze({ test: 'target-route-reservation' });
const acceptsRouteAdmissionToken = vi.fn(() => true);
const defaultActivation = {
  ensure: lifecycle.ensureCurrentSessionActivation,
  reconcile: vi.fn(),
  retire: lifecycle.retireCurrentSessionActivation,
  settleRetirement: lifecycle.settleCurrentSessionRetirement,
} as unknown as CurrentSessionActivationCoordinator;

type ControlPortOptions = Parameters<typeof createCurrentSessionControlPortImpl>[0];
function createCurrentSessionControlPort(
  options: Omit<ControlPortOptions, 'ownerBotId' | 'runtimeEpoch' | 'activation'>
  & Partial<Pick<ControlPortOptions, 'ownerBotId' | 'runtimeEpoch' | 'activation'>>,
): ReturnType<typeof createCurrentSessionControlPortImpl> {
  return createCurrentSessionControlPortImpl({
    ownerBotId: OWNER_BOT_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    activation: defaultActivation,
    ...options,
  });
}

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
    lifecycle.retireCurrentSessionActivation.mockResolvedValue({
      kind: 'retired',
      action: 'retired',
    });
    lifecycle.settleCurrentSessionRetirement.mockImplementation(async request => (
      request.disposition === 'unknown'
        ? { kind: 'quarantined', message: 'provider outcome is unknown' }
        : { kind: 'settled', disposition: request.disposition }
    ));
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
      isRouteAdmissionToken: acceptsRouteAdmissionToken,
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

  it('publishes the transfer fence before invoking the relocation provider', async () => {
    const events: string[] = [];
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        events.push('retire');
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async ({ disposition }) => {
        events.push(`settle:${disposition}`);
        return { kind: 'settled' as const, disposition: 'applied' as const };
      }),
    };
    lifecycle.transferSession.mockImplementation(async () => {
      events.push('transfer');
      return { ok: true };
    });
    const ds = active();
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: registry,
      sessionStore: unusedStore,
      resolveStoredSession: () => ds.session,
      isRouteAdmissionToken: acceptsRouteAdmissionToken,
    });

    await expect(settle(port, begin(port, relocate()))).resolves.toMatchObject({
      kind: 'committed',
      result: { kind: 'relocated' },
    });
    expect(activation.retire).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-relocate:relay-op-1',
      reason: 'transfer',
    });
    expect(events).toEqual(['retire', 'transfer', 'settle:applied']);
  });

  it('rejects a foreign owner and a non-canonical registry alias', () => {
    const foreign = active({ larkAppId: 'cli_foreign' });
    foreign.session.larkAppId = 'cli_foreign';
    const foreignPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(foreign), foreign]]),
      sessionStore: unusedStore,
      resolveStoredSession: () => undefined,
      isRouteAdmissionToken: acceptsRouteAdmissionToken,
    });
    const aliased = active();
    const aliasPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([['non-canonical-alias', aliased]]),
      sessionStore: unusedStore,
      resolveStoredSession: () => undefined,
      isRouteAdmissionToken: acceptsRouteAdmissionToken,
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
      isRouteAdmissionToken: acceptsRouteAdmissionToken,
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
      isRouteAdmissionToken: acceptsRouteAdmissionToken,
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

  it('keeps the operation sticky-unknown when the source binding is replaced after retirement', async () => {
    const ds = active();
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const replacement = active();
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        registry.set(activeSessionKey(replacement), replacement);
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async () => ({
        kind: 'quarantined' as const,
        message: 'binding changed after retirement',
      })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: registry,
      sessionStore: unusedStore,
      resolveStoredSession: () => ds.session,
      isRouteAdmissionToken: acceptsRouteAdmissionToken,
    });
    const effect = begin(port, relocate());

    await expect(settle(port, effect)).resolves.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('after activation retirement committed'),
    });
    expect(activation.retire).toHaveBeenCalledOnce();
    expect(activation.settleRetirement).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-relocate:relay-op-1',
      reason: 'transfer',
      disposition: 'unknown',
    });
    expect(lifecycle.transferSession).not.toHaveBeenCalled();
  });
});
