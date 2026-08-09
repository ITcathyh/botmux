import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionForOwnerStrict, updateSession } = vi.hoisted(() => ({
  getSessionForOwnerStrict: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/services/session-store.js', () => ({
  getSessionForOwnerStrict,
  updateSession,
}));

import { createCurrentDispatchInputCommitEvidencePort } from '../src/core/current-dispatch-input-commit-evidence.js';
import type { Session } from '../src/types.js';

function session(): Session {
  return {
    sessionId: 'sid-evidence',
    larkAppId: 'app-owner',
    rootMessageId: 'oc_chat',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'chat',
    status: 'active',
    title: 'Evidence',
    createdAt: '2026-08-10T00:00:00.000Z',
    workerGeneration: 3,
    replyTargets: {
      turn_exact: {
        rootMessageId: 'om_dispatch_root',
        updatedAt: '2026-08-10T00:00:01.000Z',
      },
    },
  } as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Current dispatch input-commit evidence Adapter', () => {
  it('records exact root-bound evidence through the legacy publisher', () => {
    const current = session();
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });

    expect(port.record({
      sessionId: current.sessionId,
      turnId: 'turn_exact',
      executorGeneration: 3,
      committedAt: '2026-08-10T00:00:02.000Z',
    })).toEqual({ kind: 'recorded' });

    expect(current.dispatchInputReceipts?.turn_exact).toEqual({
      rootMessageId: 'om_dispatch_root',
      workerGeneration: 3,
      committedAt: '2026-08-10T00:00:02.000Z',
    });
    expect(updateSession).toHaveBeenCalledWith(current);
  });

  it('restores the live row when a failed publish is proven absent', () => {
    const current = session();
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });
    updateSession.mockImplementationOnce(() => { throw new Error('before publish'); });
    getSessionForOwnerStrict.mockReturnValueOnce(session());

    expect(port.record({
      sessionId: current.sessionId,
      turnId: 'turn_exact',
      executorGeneration: 3,
      committedAt: '2026-08-10T00:00:02.000Z',
    })).toMatchObject({ kind: 'notRecorded' });
    expect(current.dispatchInputReceipts).toBeUndefined();
  });

  it('accepts response loss when strict owner readback proves the exact generation', () => {
    const current = session();
    const persisted = session();
    persisted.dispatchInputReceipts = {
      turn_exact: {
        rootMessageId: 'om_dispatch_root',
        workerGeneration: 3,
        committedAt: '2026-08-10T00:00:02.000Z',
      },
    };
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    getSessionForOwnerStrict.mockReturnValue(persisted);

    expect(port.record({
      sessionId: current.sessionId,
      turnId: 'turn_exact',
      executorGeneration: 3,
      committedAt: '2026-08-10T00:00:03.000Z',
    })).toEqual({ kind: 'recorded' });
    expect(current.dispatchInputReceipts).toEqual(persisted.dispatchInputReceipts);
  });

  it('does not accept a same-generation receipt bound to another root', () => {
    const current = session();
    const persisted = session();
    persisted.dispatchInputReceipts = {
      turn_exact: {
        rootMessageId: 'om_wrong_root',
        workerGeneration: 3,
        committedAt: '2026-08-10T00:00:02.000Z',
      },
    };
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    getSessionForOwnerStrict.mockReturnValueOnce(persisted);

    expect(port.record({
      sessionId: current.sessionId,
      turnId: 'turn_exact',
      executorGeneration: 3,
      committedAt: '2026-08-10T00:00:03.000Z',
    })).toMatchObject({
      kind: 'conflict',
      current: { rootMessageId: 'om_wrong_root' },
    });
    expect(current.dispatchInputReceipts).toEqual(persisted.dispatchInputReceipts);
  });

  it('keeps conservative local evidence when publish and readback are both unknown', () => {
    const current = session();
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    getSessionForOwnerStrict.mockImplementationOnce(() => { throw new Error('disk unavailable'); });

    expect(port.record({
      sessionId: current.sessionId,
      turnId: 'turn_exact',
      executorGeneration: 3,
      committedAt: '2026-08-10T00:00:03.000Z',
    })).toMatchObject({ kind: 'unknown' });
    expect(current.dispatchInputReceipts?.turn_exact).toEqual({
      rootMessageId: 'om_dispatch_root',
      workerGeneration: 3,
      committedAt: '2026-08-10T00:00:03.000Z',
    });
  });

  it('synchronizes the complete durable receipt map on a conflicting winner', () => {
    const current = session();
    const persisted = session();
    persisted.dispatchInputReceipts = {
      turn_exact: {
        rootMessageId: 'om_wrong_root',
        workerGeneration: 3,
        committedAt: '2026-08-10T00:00:02.000Z',
      },
      turn_other: {
        rootMessageId: 'om_other_root',
        workerGeneration: 3,
        committedAt: '2026-08-10T00:00:01.000Z',
      },
    };
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    getSessionForOwnerStrict.mockReturnValueOnce(persisted);

    expect(port.record({
      sessionId: current.sessionId,
      turnId: 'turn_exact',
      executorGeneration: 3,
      committedAt: '2026-08-10T00:00:03.000Z',
    }).kind).toBe('conflict');
    expect(current.dispatchInputReceipts).toEqual(persisted.dispatchInputReceipts);
  });

  it('preserves other durable receipts when this candidate is proven absent', () => {
    const current = session();
    const persisted = session();
    persisted.dispatchInputReceipts = {
      turn_other: {
        rootMessageId: 'om_other_root',
        workerGeneration: 3,
        committedAt: '2026-08-10T00:00:01.000Z',
      },
    };
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });
    updateSession.mockImplementationOnce(() => { throw new Error('before publish'); });
    getSessionForOwnerStrict.mockReturnValueOnce(persisted);

    expect(port.record({
      sessionId: current.sessionId,
      turnId: 'turn_exact',
      executorGeneration: 3,
      committedAt: '2026-08-10T00:00:03.000Z',
    })).toMatchObject({ kind: 'notRecorded' });
    expect(current.dispatchInputReceipts).toEqual(persisted.dispatchInputReceipts);
  });

  it('fails closed on malformed negative-generation evidence', () => {
    const current = session();
    const persisted = session();
    persisted.dispatchInputReceipts = {
      turn_exact: {
        rootMessageId: 'om_dispatch_root',
        workerGeneration: -1,
        committedAt: '2026-08-10T00:00:02.000Z',
      },
    };
    getSessionForOwnerStrict.mockReturnValueOnce(persisted);
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });

    expect(port.read({ sessionId: current.sessionId, turnId: 'turn_exact' }))
      .toMatchObject({ kind: 'unreadable' });
  });

  it('rejects a stale generation before touching the publisher', () => {
    const current = session();
    const port = createCurrentDispatchInputCommitEvidencePort({
      ownerLarkAppId: 'app-owner',
      session: current,
    });

    expect(port.record({
      sessionId: current.sessionId,
      turnId: 'turn_exact',
      executorGeneration: 2,
      committedAt: '2026-08-10T00:00:02.000Z',
    })).toMatchObject({ kind: 'notRecorded' });
    expect(updateSession).not.toHaveBeenCalled();
  });
});
