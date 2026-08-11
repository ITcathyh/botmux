import { describe, expect, it, vi } from 'vitest';

const sessionStore = vi.hoisted(() => ({
  listSessionsForOwnerStrict: vi.fn(() => []),
}));

vi.mock('../src/services/session-store.js', () => sessionStore);

import {
  createCurrentDashboardRouteOpeningPort,
  inspectCurrentDashboardRoute,
  type CurrentDashboardRouteInspection,
} from '../src/core/current-dashboard-route-opening.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const OWNER = 'app-current-dashboard-opening';
const CHAT = 'oc_current_dashboard_opening';

function active(sessionId: string, chatId = CHAT): DaemonSession {
  return {
    session: {
      sessionId,
      larkAppId: OWNER,
      chatId,
      rootMessageId: chatId,
      status: 'active',
      scope: 'chat',
      chatType: 'group',
    },
    larkAppId: OWNER,
    chatId,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 1,
    lastMessageAt: 1,
    hasHistory: true,
    worker: null,
  } as DaemonSession;
}

function input() {
  return {
    content: 'open from Dashboard',
    column: 'backlog' as const,
    role: 'solo' as const,
    coworkers: [],
    images: [{ name: 'screen.png', mimeType: 'image/png', dataBase64: 'png' }],
    postBanner: true,
  };
}

async function executeOpening(
  port: ReturnType<typeof createCurrentDashboardRouteOpeningPort>,
) {
  const begun = port.begin({
    route: { kind: 'chat', chatId: CHAT },
    command: input(),
  });
  expect(begun.kind).toBe('effect');
  if (begun.kind !== 'effect') throw new Error('expected staged effect');
  let settlement;
  try {
    settlement = { kind: 'returned' as const, value: await port.execute(begun.intent) };
  } catch (error) {
    settlement = { kind: 'threw' as const, error };
  }
  return port.resume(begun.continuation, settlement);
}

describe('Current Dashboard route opening production port', () => {
  it('censuses malformed same-owner evidence before declaring a requested route vacant', () => {
    const malformedSibling = active('malformed-sibling', 'oc_other_route');
    const activeSessions = new Map([['non-canonical-sibling', malformedSibling]]);

    expect(inspectCurrentDashboardRoute({
      ownerLarkAppId: OWNER,
      activeSessions,
      route: { kind: 'chat', chatId: CHAT },
    })).toMatchObject({ kind: 'unknown' });
  });

  it('does not ignore a malformed duplicate while resolving the canonical route owner', () => {
    const canonical = active('same-session');
    const malformedDuplicate = active('same-session');
    malformedDuplicate.session.scope = 'thread';
    sessionStore.listSessionsForOwnerStrict.mockReturnValueOnce([canonical.session]);
    const activeSessions = new Map([
      [activeSessionKey(canonical), canonical],
      ['malformed-duplicate', malformedDuplicate],
    ]);

    expect(inspectCurrentDashboardRoute({
      ownerLarkAppId: OWNER,
      activeSessions,
      route: { kind: 'chat', chatId: CHAT },
    })).toMatchObject({ kind: 'unknown' });
  });

  it('keeps image materialization, banner/fork spawn, and readback behind one staged effect', async () => {
    let inspection: CurrentDashboardRouteInspection = { kind: 'vacant' };
    const materializeImages = vi.fn(() => [{ type: 'image' as const, name: 'screen.png', path: '/tmp/screen.png' }]);
    const cleanupImages = vi.fn();
    const spawn = vi.fn(async (_activeSessions, _refresh, args) => {
      inspection = { kind: 'occupied', sessionId: 'session-dashboard-opened' };
      return { ok: true as const, sessionId: 'session-dashboard-opened' };
    });
    const port = createCurrentDashboardRouteOpeningPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      inspectRoute: () => inspection,
      materializeImages,
      cleanupImages,
      spawn,
    });

    const begun = port.begin({
      route: { kind: 'chat', chatId: CHAT },
      command: input(),
    });
    expect(begun.kind).toBe('effect');
    expect(materializeImages).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    if (begun.kind !== 'effect') return;

    const effectResult = await port.execute(begun.intent);
    expect(materializeImages).toHaveBeenCalledWith(OWNER, input().images);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[2]).toEqual({
      larkAppId: OWNER,
      chatId: CHAT,
      content: 'open from Dashboard',
      column: 'backlog',
      role: 'solo',
      coworkers: [],
      attachments: [{ type: 'image', name: 'screen.png', path: '/tmp/screen.png' }],
      postBanner: true,
    });
    expect(port.resume(begun.continuation, { kind: 'returned', value: effectResult }))
      .toEqual({ kind: 'created', sessionId: 'session-dashboard-opened' });
    expect(cleanupImages).not.toHaveBeenCalled();
  });

  it('cleans materialized images only after a proven vacant refusal', async () => {
    const attachments = [{ type: 'image' as const, name: 'screen.png', path: '/tmp/screen.png' }];
    const cleanupImages = vi.fn();
    const port = createCurrentDashboardRouteOpeningPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      inspectRoute: () => ({ kind: 'vacant' }),
      materializeImages: () => attachments,
      cleanupImages,
      spawn: async () => ({ ok: false, error: 'session_exists' }),
    });

    await expect(executeOpening(port)).resolves.toEqual({
      kind: 'refused',
      reason: 'sessionExists',
      code: 'session_exists',
      message: 'session_exists',
    });
    expect(cleanupImages).toHaveBeenCalledWith(OWNER, attachments);
  });

  it('quarantines a throw or failed return that may already have published a route, without cleanup', async () => {
    const attachments = [{ type: 'image' as const, name: 'screen.png', path: '/tmp/screen.png' }];
    const cleanupImages = vi.fn();
    let inspection: CurrentDashboardRouteInspection = { kind: 'vacant' };
    const port = createCurrentDashboardRouteOpeningPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      inspectRoute: () => inspection,
      materializeImages: () => attachments,
      cleanupImages,
      spawn: async () => {
        inspection = { kind: 'occupied', sessionId: 'session-after-throw' };
        throw new Error('response lost after publication');
      },
    });

    await expect(executeOpening(port)).resolves.toMatchObject({
      kind: 'unknown',
      message: expect.stringMatching(/outcome.*unknown.*response lost after publication/i),
    });
    expect(cleanupImages).not.toHaveBeenCalled();
  });

  it('fails closed on a returned session id that does not match exact Current route readback', async () => {
    const cleanupImages = vi.fn();
    const port = createCurrentDashboardRouteOpeningPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      inspectRoute: () => ({ kind: 'occupied', sessionId: 'different-session' }),
      materializeImages: () => [],
      cleanupImages,
      spawn: async () => ({ ok: true, sessionId: 'reported-session' }),
    });

    await expect(executeOpening(port)).resolves.toMatchObject({
      kind: 'unknown',
      message: expect.stringMatching(/readback.*different/i),
    });
    expect(cleanupImages).not.toHaveBeenCalled();
  });
});
