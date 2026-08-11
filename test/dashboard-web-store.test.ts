import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeEventSource {
  static current: FakeEventSource | undefined;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string, body: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify({ body }) } as MessageEvent);
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeEventSource.current = undefined;
});

describe('Dashboard browser projection repair', () => {
  it('re-reads the aggregate snapshot after an owner slice rebuild', async () => {
    let rows = [{ sessionId: 'stale', status: 'idle' }];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      return new Response(JSON.stringify(
        path === '/api/sessions'
          ? { sessions: rows }
          : { schedules: [], timezone: 'UTC' },
      ), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', fetchMock);

    const { bootstrap, store } = await import('../src/dashboard/web/store.js');
    await bootstrap();
    expect([...store.getSnapshot().sessions.keys()]).toEqual(['stale']);

    rows = [{ sessionId: 'fresh', status: 'working' }];
    FakeEventSource.current!.emit('projection.rebuilt', {});

    await vi.waitFor(() => {
      expect([...store.getSnapshot().sessions.keys()]).toEqual(['fresh']);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions');
  });
});
