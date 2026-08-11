import { describe, it, expect } from 'vitest';
import { Aggregator, subscribeDaemon } from '../src/dashboard/aggregator.js';

describe('Aggregator cache merge', () => {
  it('upsert via session.spawned and session.update', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA', status: 'starting' } as any },
    });
    expect(a.getSessions().length).toBe(1);
    a.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { status: 'idle' } },
    });
    expect(a.getSessions()[0].status).toBe('idle');
  });

  it('marks dormant on session.exited until the authoritative projection says closed', () => {
    const a = new Aggregator();
    const seen: any[] = [];
    a.on(event => seen.push(event));
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA' } as any },
    });
    a.applyEvent('appA', { type: 'session.exited', body: { sessionId: 's1' } });
    expect(a.getSessions().length).toBe(1);
    expect(a.getSessions()[0].status).toBe('dormant');
    expect(seen.at(-1)).toMatchObject({
      type: 'session.update',
      body: { sessionId: 's1', patch: { status: 'dormant' } },
    });
  });

  it('schedule lifecycle', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'schedule.created',
      body: { schedule: { id: 't1', enabled: true } as any },
    });
    a.applyEvent('appA', {
      type: 'schedule.updated',
      body: { id: 't1', patch: { enabled: false } },
    });
    expect(a.getSchedules()[0].enabled).toBe(false);
    a.applyEvent('appA', { type: 'schedule.deleted', body: { id: 't1' } });
    expect(a.getSchedules().length).toBe(0);
  });

  it('hydrate seeds the cache', () => {
    const a = new Aggregator();
    a.hydrateSessions('appA', [{ sessionId: 's1', larkAppId: 'appA' } as any]);
    a.hydrateSchedules([{ id: 't1' } as any]);
    expect(a.getSessions().length).toBe(1);
    expect(a.getSchedules().length).toBe(1);
  });

  it('preserves presentation fields when a daemon replays the same working directory', () => {
    const a = new Aggregator();
    a.hydrateSessions('appA', [{
      sessionId: 's1',
      larkAppId: 'appA',
      workingDir: '/repo/a',
      botAvatarUrl: 'https://img.example/a.png',
      repoName: 'a',
      gitBranch: 'main',
    }]);
    const seen: any[] = [];
    a.on(event => seen.push(event));

    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', workingDir: '/repo/a', status: 'idle' } as any },
    });

    expect(a.getSession('s1')).toMatchObject({
      botAvatarUrl: 'https://img.example/a.png',
      repoName: 'a',
      gitBranch: 'main',
      status: 'idle',
    });
    expect(seen[0].body.session).toMatchObject({
      repoName: 'a',
      gitBranch: 'main',
    });
  });

  it('clears stale repository fields immediately when workingDir changes', () => {
    const a = new Aggregator();
    a.hydrateSessions('appA', [{
      sessionId: 's1',
      larkAppId: 'appA',
      workingDir: '/repo/a',
      repoName: 'a',
      gitBranch: 'main',
    }]);
    const seen: any[] = [];
    a.on(event => seen.push(event));

    a.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { workingDir: '/repo/b' } },
    });

    expect(a.getSession('s1')).toMatchObject({
      workingDir: '/repo/b',
      repoName: null,
      gitBranch: null,
    });
    expect(seen[0].body.patch).toMatchObject({
      workingDir: '/repo/b',
      repoName: null,
      gitBranch: null,
    });
  });

  it('ownerOf returns larkAppId for known sessionId', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA' } as any },
    });
    expect(a.ownerOf('s1')).toBe('appA');
    expect(a.ownerOf('nonexistent')).toBeUndefined();
  });

  it('listeners receive events with larkAppId attached', () => {
    const a = new Aggregator();
    const seen: any[] = [];
    a.on(e => seen.push(e));
    a.applyEvent('appB', { type: 'session.spawned', body: { session: { sessionId: 's2' } as any } });
    expect(seen).toHaveLength(1);
    expect(seen[0].larkAppId).toBe('appB');
    expect(seen[0].type).toBe('session.spawned');
  });

  it('authoritatively replaces one owner slice and deletes stale rows only for that owner', () => {
    const a = new Aggregator();
    a.replaceSessionSnapshot('appA', {
      projectionEpoch: 'epoch-a',
      cursor: 3,
      readiness: { contract: 'Current/v1', state: 'ready', online: true },
      rows: [
        { sessionId: 'keep', larkAppId: 'appA', status: 'idle' } as any,
        { sessionId: 'stale', larkAppId: 'appA', status: 'working' } as any,
      ],
    });
    a.replaceSessionSnapshot('appB', {
      projectionEpoch: 'epoch-b',
      cursor: 1,
      readiness: { contract: 'Current/v1', state: 'ready', online: true },
      rows: [{ sessionId: 'stale', larkAppId: 'appB', status: 'idle' } as any],
    });
    const seen: any[] = [];
    a.on(event => seen.push(event));

    a.replaceSessionSnapshot('appA', {
      projectionEpoch: 'epoch-a',
      cursor: 4,
      readiness: { contract: 'Current/v1', state: 'ready', online: true },
      rows: [{ sessionId: 'keep', larkAppId: 'appA', status: 'working' } as any],
    });

    expect(a.getSessionForOwner('appA', 'stale')).toBeUndefined();
    expect(a.getSessionForOwner('appB', 'stale')?.status).toBe('idle');
    expect(a.getSessionForOwner('appA', 'keep')?.status).toBe('working');
    expect(seen).toContainEqual({
      type: 'projection.rebuilt',
      body: {},
      larkAppId: 'appA',
    });
  });

  it('detects dropped, reordered, and old-epoch daemon session events', () => {
    const a = new Aggregator();
    a.replaceSessionSnapshot('appA', {
      projectionEpoch: 'epoch-a',
      cursor: 10,
      readiness: { contract: 'Current/v1', state: 'ready', online: true },
      rows: [{ sessionId: 's1', larkAppId: 'appA', status: 'idle' } as any],
    });

    expect(a.applyEvent('appA', {
      type: 'session.update',
      projectionEpoch: 'epoch-a',
      sequence: 11,
      body: { sessionId: 's1', patch: { status: 'working' } },
    })).toBe('applied');
    expect(a.applyEvent('appA', {
      type: 'session.update',
      projectionEpoch: 'epoch-a',
      sequence: 11,
      body: { sessionId: 's1', patch: { status: 'idle' } },
    })).toBe('ignored');
    expect(a.getSessionForOwner('appA', 's1')?.status).toBe('working');

    expect(a.applyEvent('appA', {
      type: 'session.update',
      projectionEpoch: 'epoch-a',
      sequence: 13,
      body: { sessionId: 's1', patch: { status: 'idle' } },
    })).toBe('rebuildRequired');
    expect(a.applyEvent('appA', {
      type: 'session.update',
      projectionEpoch: 'epoch-old',
      sequence: 12,
      body: { sessionId: 's1', patch: { status: 'idle' } },
    })).toBe('rebuildRequired');
    expect(a.getSessionForOwner('appA', 's1')?.status).toBe('working');
  });

  it('fails closed on bare sessionId routing when owners collide', () => {
    const a = new Aggregator();
    for (const owner of ['appA', 'appB']) {
      a.replaceSessionSnapshot(owner, {
        projectionEpoch: `epoch-${owner}`,
        cursor: 0,
        readiness: { contract: 'Current/v1', state: 'ready', online: true },
        rows: [{ sessionId: 'same-id', larkAppId: owner, status: 'idle' } as any],
      });
    }

    expect(a.getSessionForOwner('appA', 'same-id')?.larkAppId).toBe('appA');
    expect(a.getSessionForOwner('appB', 'same-id')?.larkAppId).toBe('appB');
    expect(a.getSession('same-id')).toBeUndefined();
    expect(a.getSessions().filter(row => row.sessionId === 'same-id')).toHaveLength(0);
    expect(a.ownerOf('same-id')).toBeUndefined();
    expect(a.terminalProxyPortOf('same-id')).toBeUndefined();
    expect(a.sessionExists('same-id')).toBe(true);
  });

  it('marks runtime stale without closing its session rows', () => {
    const a = new Aggregator();
    a.replaceSessionSnapshot('appA', {
      projectionEpoch: 'epoch-a',
      cursor: 0,
      readiness: { contract: 'Current/v1', state: 'ready', online: true },
      rows: [{ sessionId: 's1', larkAppId: 'appA', status: 'working' } as any],
    });

    a.markRuntimeStale('appA');

    expect(a.runtimeStatusOf('appA')).toEqual({
      contract: 'Current/v1',
      state: 'stale',
      online: false,
    });
    expect(a.getSessionForOwner('appA', 's1')?.status).toBe('working');
  });

  it('rebuilds the owner slice when the daemon SSE tail has a sequence gap', async () => {
    const a = new Aggregator();
    a.replaceSessionSnapshot('appA', {
      projectionEpoch: 'epoch-a',
      cursor: 1,
      readiness: { contract: 'Current/v1', state: 'ready', online: true },
      rows: [{ sessionId: 's1', larkAppId: 'appA', status: 'idle' } as any],
    });
    const bytes = new TextEncoder().encode(
      'event: session.update\n'
      + 'data: {"sessionId":"s1","patch":{"status":"working"},"projectionEpoch":"epoch-a","sequence":3}\n\n',
    );
    let stop = () => {};
    let resolveRebuild!: () => void;
    const rebuilt = new Promise<void>(resolve => { resolveRebuild = resolve; });
    let rebuilds = 0;
    stop = subscribeDaemon(
      { larkAppId: 'appA', ipcPort: 1 } as any,
      a,
      error => { throw error; },
      (async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes); },
      }))) as typeof fetch,
      async () => {
        rebuilds += 1;
        if (rebuilds === 2) {
          resolveRebuild();
          stop();
        }
      },
    );

    await rebuilt;
    expect(rebuilds).toBe(2); // first connect + rejected sequence gap
    expect(a.getSessionForOwner('appA', 's1')?.status).toBe('idle');
  });
});
