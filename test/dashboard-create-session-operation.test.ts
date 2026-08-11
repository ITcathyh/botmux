import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dashboardServerHandlers: Array<(req: any, res: any) => Promise<void>> = [];
const registryEntries: Array<{
  larkAppId: string;
  botName: string;
  botIndex: number;
  ipcPort: number;
  pid: number;
  startedAt: number;
  bootInstanceId?: string;
  lastHeartbeat: number;
  resolvedAllowedUsers?: string[];
}> = [];
const aggregatorSessions: Array<Record<string, unknown> & { sessionId: string; larkAppId: string }> = [];
let aggregatorGetSessionsHook: (() => void) | undefined;
const fetchDaemonIpcMock = vi.fn();

class FakeServer extends EventEmitter {
  listening = false;
  keepAliveTimeout = 0;
  headersTimeout = 0;
  listen(_port?: number, _host?: string, callback?: () => void) {
    this.listening = true;
    callback?.();
    return this;
  }
  close(callback?: () => void) {
    this.listening = false;
    callback?.();
    return this;
  }
}

vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn((handler: (req: any, res: any) => Promise<void>) => {
      dashboardServerHandlers.push(handler);
      return new FakeServer();
    }),
  };
});

vi.mock('../src/config.js', () => ({
  config: {
    dashboard: { host: '127.0.0.1', port: 0, publicReadOnly: false },
    session: { dataDir: '/tmp/botmux-dashboard-create-operation-test' },
  },
  isWildcardBindHost: () => false,
}));

vi.mock('../src/core/data-dir.js', () => ({
  resolveBotmuxDataDir: () => '/tmp/botmux-dashboard-create-operation-test',
}));

vi.mock('../src/core/dashboard-secret.js', () => ({
  dashboardSecretPath: () => '/tmp/botmux-dashboard-create-operation-test/secret',
}));

vi.mock('../src/utils/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }));
vi.mock('../src/utils/listen-with-probe.js', () => ({ listenWithProbe: vi.fn(async () => 0) }));

vi.mock('../src/dashboard/auth.js', () => ({
  parseCookie: vi.fn(() => ({})),
  buildSetCookie: vi.fn(() => ''),
  verifyHmac: vi.fn(() => false),
  cliAuthBind: vi.fn(() => ''),
  decideDashboardAuth: vi.fn(() => ({ kind: 'allow' })),
  loadPersistedToken: vi.fn(() => 'test-token'),
  loadOrCreatePersistedToken: vi.fn(() => 'test-token'),
  rotatePersistedToken: vi.fn(() => 'test-token'),
  loadDashboardSecret: vi.fn(() => 'test-secret'),
  loadOrCreateDashboardSecret: vi.fn(() => 'test-secret'),
}));

vi.mock('../src/dashboard/registry.js', () => ({
  botsRosterSignature: vi.fn(() => ''),
  DaemonRegistry: class {
    async start() {}
    stop() {}
    list() { return [...registryEntries]; }
    getByAppId(id: string) { return registryEntries.find(entry => entry.larkAppId === id); }
    on() { return () => {}; }
  },
}));

vi.mock('../src/dashboard/aggregator.js', () => ({
  Aggregator: class {
    on() { return () => {}; }
    getSessions() {
      aggregatorGetSessionsHook?.();
      return aggregatorSessions.map(session => ({ ...session }));
    }
    getSchedules() { return []; }
    hydrateSessions() {}
    hydrateSchedules() {}
    applyEvent() {}
    ownerOf() { return undefined; }
    scheduleOwnerOf() { return undefined; }
    scheduleExists() { return false; }
    terminalProxyPortOf() { return undefined; }
  },
  subscribeDaemon: vi.fn(() => () => {}),
}));

vi.mock('../src/features/codex-notifier/index.js', () => ({
  emitCodexNotifierOutboxItem: vi.fn(),
  installCodexNotifierHook: vi.fn(),
  isCodexNotifierWorkerStateFresh: vi.fn(() => false),
  isCodexNotifierHookInstalled: vi.fn(() => false),
  listCodexNotifierOutbox: vi.fn(() => []),
  readCodexNotifierWorkerState: vi.fn(() => null),
  resolveCodexNotifierConfig: vi.fn(() => ({ enabled: false })),
  runCodexSideConversationMonitor: vi.fn(async () => {}),
  runCodexNotifierWorkerSupervisor: vi.fn(async () => {}),
}));

vi.mock('../src/dashboard/resource-monitor-service.js', () => ({
  buildResourceMonitorDaemonSeeds: vi.fn(() => []),
  createResourceMonitorService: vi.fn(() => ({ start() {}, stop() {} })),
  handleResourceMonitorApi: vi.fn(async () => false),
  toResourceMonitorSessionSeed: vi.fn(),
}));

vi.mock('../src/dashboard/federation-spoke-api.js', () => ({
  handleFederationSpokeApi: vi.fn(async () => false),
  syncAllMemberships: vi.fn(async () => {}),
  autoBindOwnerIfUnambiguous: vi.fn(async () => ({ status: 'already_bound' })),
}));

vi.mock('../src/platform/binding.js', () => ({ readPlatformBinding: vi.fn(() => null) }));

vi.mock('../src/core/daemon-ipc-auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/daemon-ipc-auth.js')>();
  return { ...actual, fetchDaemonIpc: (...args: any[]) => fetchDaemonIpcMock(...args) };
});

vi.mock('../src/bot-registry.js', () => ({
  effectiveDefaultWorkingDir: vi.fn(() => undefined),
  getBot: vi.fn(() => undefined),
  loadBotConfigs: vi.fn(() => registryEntries.map(entry => ({
    larkAppId: entry.larkAppId,
    cliId: 'codex',
  }))),
  parseBotConfigsFromText: vi.fn(() => []),
}));

vi.mock('../src/global-config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/global-config.js')>();
  return {
    ...actual,
    invalidateGlobalConfigCache: vi.fn(),
    mergeDashboardConfig: vi.fn(),
    mergeGlobalConfig: vi.fn(),
    readGlobalConfig: vi.fn(() => ({ dashboard: { publicReadOnly: false } })),
  };
});

vi.mock('../src/dashboard/webhook-routes.js', () => ({
  handleWebhookRoute: vi.fn(async () => false),
}));

vi.mock('../src/dashboard/federation-api.js', () => ({
  handleFederationApi: vi.fn(async () => false),
}));

const dashboard = await import('../src/dashboard.js');

const terminal = (status: number, body: Record<string, unknown>) => ({
  kind: 'terminal' as const,
  response: { status, body: JSON.stringify(body) },
});

class FakeRequest extends EventEmitter {
  method = 'POST';
  headers: Record<string, string | undefined>;
  constructor(
    private readonly body: string,
    operationId?: string,
    readonly url = '/api/sessions/create',
  ) {
    super();
    this.headers = {
      host: 'localhost',
      cookie: 'botmux_dashboard=test-token',
      ...(operationId ? { 'x-botmux-operation-id': operationId } : {}),
    };
  }
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(this.body);
  }
  pipe() { return undefined; }
}

class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, unknown> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers: Record<string, unknown> = {}) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  setHeader(name: string, value: unknown) { this.headers[name] = value; }
  write(chunk: unknown) { this.body += String(chunk); return true; }
  end(chunk?: unknown) {
    if (chunk !== undefined) this.body += String(chunk);
    this.emit('finish');
    return this;
  }
}

const createRequestBody = (operationId: string, overrides: Record<string, unknown> = {}) => ({
  operationId,
  content: 'implement the plan',
  larkAppIds: ['cli_a'],
  mode: 'all',
  column: 'in_progress',
  ...overrides,
});

const defaultOperationHeader = Symbol('default-operation-header');

async function invokeCreate(
  body: Record<string, unknown>,
  headerOperationId: string | null | typeof defaultOperationHeader = defaultOperationHeader,
): Promise<FakeResponse> {
  const resolvedHeader = headerOperationId === defaultOperationHeader
    ? (typeof body.operationId === 'string' ? body.operationId : undefined)
    : headerOperationId ?? undefined;
  const req = new FakeRequest(JSON.stringify(body), resolvedHeader);
  const res = new FakeResponse();
  await dashboardServerHandlers[0]!(req, res);
  return res;
}

async function invokeIdleCleanup(
  body: Record<string, unknown>,
  headerOperationId: string | null | typeof defaultOperationHeader = defaultOperationHeader,
): Promise<FakeResponse> {
  const resolvedHeader = headerOperationId === defaultOperationHeader
    ? (typeof body.operationId === 'string' ? body.operationId : undefined)
    : headerOperationId ?? undefined;
  const req = new FakeRequest(
    JSON.stringify(body),
    resolvedHeader,
    '/api/sessions/cleanup-idle',
  );
  const res = new FakeResponse();
  await dashboardServerHandlers[0]!(req, res);
  return res;
}

function onlineBot(id: string, port: number, bootInstanceId = `boot-${id}-${port}`) {
  return {
    larkAppId: id,
    botName: id.toUpperCase(),
    botIndex: port,
    ipcPort: port,
    pid: port,
    startedAt: 1,
    bootInstanceId,
    lastHeartbeat: Date.now(),
    resolvedAllowedUsers: ['ou_owner'],
  };
}

describe('Dashboard create-session process-local parent receipt', () => {
  it('publishes a running receipt before synchronous effect re-entry and joins the exact response', async () => {
    const host = dashboard.createDashboardSessionCreateOperationHost();
    expect(host.receiptDurability).toBe('processLocal');
    const execute = vi.fn();
    let follower!: Promise<unknown>;
    execute.mockImplementation(async () => {
      follower = host.run(
        { operationId: 'create:reentrant', requestHash: 'hash-a' },
        execute,
      );
      return terminal(200, { ok: true, chatId: 'oc_once' });
    });

    const first = host.run(
      { operationId: 'create:reentrant', requestHash: 'hash-a' },
      execute,
    );
    const firstResult = await first;
    await expect(follower).resolves.toEqual(firstResult);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('replays the exact terminal response after caller response loss without re-running the effect', async () => {
    const host = dashboard.createDashboardSessionCreateOperationHost();
    const execute = vi.fn(async () => terminal(200, {
      ok: true,
      chatId: 'oc_response_loss',
      spawned: ['cli_a'],
    }));
    const input = { operationId: 'create:response-loss', requestHash: 'hash-a' };

    const first = await host.run(input, execute);
    const replay = await host.run(input, execute);

    expect(replay).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('permanently rejects the same operation id with different canonical semantics', async () => {
    const host = dashboard.createDashboardSessionCreateOperationHost();
    const execute = vi.fn(async () => terminal(200, { ok: true, chatId: 'oc_hash_a' }));
    await host.run({ operationId: 'create:conflict', requestHash: 'hash-a' }, execute);

    await expect(host.run(
      { operationId: 'create:conflict', requestHash: 'hash-b' },
      execute,
    )).resolves.toEqual({ kind: 'conflict' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('sticks an unknown effect outcome and never blindly re-runs it', async () => {
    const host = dashboard.createDashboardSessionCreateOperationHost();
    const execute = vi.fn(async () => { throw new Error('response lost after create-chat'); });
    const input = { operationId: 'create:unknown', requestHash: 'hash-a' };

    const first = await host.run(input, execute);
    const replay = await host.run(input, execute);

    expect(first).toEqual({
      kind: 'response',
      response: {
        status: 503,
        body: JSON.stringify({ ok: false, error: 'dispatch_unknown' }),
      },
    });
    expect(replay).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retains only the semantic hash after a pre-effect retryable result', async () => {
    const host = dashboard.createDashboardSessionCreateOperationHost();
    const unavailable = vi.fn(async () => ({
      kind: 'retryable' as const,
      response: { status: 503, body: JSON.stringify({ ok: false, error: 'no_online_daemon' }) },
    }));
    const success = vi.fn(async () => terminal(200, { ok: true, chatId: 'oc_recovered' }));

    await expect(host.run(
      { operationId: 'create:retryable', requestHash: 'hash-a' },
      unavailable,
    )).resolves.toMatchObject({ response: { status: 503 } });
    await expect(host.run(
      { operationId: 'create:retryable', requestHash: 'hash-b' },
      success,
    )).resolves.toEqual({ kind: 'conflict' });
    await expect(host.run(
      { operationId: 'create:retryable', requestHash: 'hash-a' },
      success,
    )).resolves.toMatchObject({ response: { status: 200 } });
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/sessions/create parent operation receipt', () => {
  beforeEach(() => {
    aggregatorSessions.splice(0, aggregatorSessions.length);
    aggregatorGetSessionsHook = undefined;
    registryEntries.splice(0, registryEntries.length, onlineBot('cli_a', 4101));
    fetchDaemonIpcMock.mockReset();
    fetchDaemonIpcMock.mockImplementation(async (_port: number, path: string) => {
      if (path === '/api/groups/create') {
        return new Response(JSON.stringify({ ok: true, chatId: 'oc_created', shareLink: 'https://example.test/chat' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/sessions/spawn') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected daemon path ${path}`);
    });
  });

  it('requires matching stable operation ids in the body and header before any effect', async () => {
    const missing = await invokeCreate(createRequestBody('create:missing'), null);
    const mismatch = await invokeCreate(createRequestBody('create:body'), 'create:header');

    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ ok: false, error: 'bad_operation_id' });
    expect(mismatch.status).toBe(400);
    expect(JSON.parse(mismatch.body)).toEqual({ ok: false, error: 'bad_operation_id' });
    expect(fetchDaemonIpcMock).not.toHaveBeenCalled();
  });

  it('publishes the parent receipt before create-group re-entry and performs the composite effect once', async () => {
    const operationId = 'create:route-reentrant';
    const body = createRequestBody(operationId);
    let follower!: Promise<FakeResponse>;
    fetchDaemonIpcMock.mockImplementation(async (_port: number, path: string) => {
      if (path === '/api/groups/create') {
        follower = invokeCreate(body);
        return new Response(JSON.stringify({ ok: true, chatId: 'oc_route_reentrant' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const first = await invokeCreate(body);
    const joined = await follower;

    expect(first.status).toBe(200);
    expect(joined.status).toBe(200);
    expect(joined.body).toBe(first.body);
    expect(fetchDaemonIpcMock.mock.calls.filter(call => call[1] === '/api/groups/create')).toHaveLength(1);
    expect(fetchDaemonIpcMock.mock.calls.filter(call => call[1] === '/api/sessions/spawn')).toHaveLength(1);
  });

  it('replays the exact completed response and never expands the frozen child bot plan', async () => {
    const operationId = 'create:frozen-plan';
    const body = createRequestBody(operationId, { larkAppIds: ['cli_a', 'cli_b'] });

    const first = await invokeCreate(body);
    registryEntries.push(onlineBot('cli_b', 4102));
    const replay = await invokeCreate(body);

    expect(replay.status).toBe(first.status);
    expect(replay.body).toBe(first.body);
    const groupCalls = fetchDaemonIpcMock.mock.calls.filter(call => call[1] === '/api/groups/create');
    const spawnCalls = fetchDaemonIpcMock.mock.calls.filter(call => call[1] === '/api/sessions/spawn');
    expect(groupCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]![0]).toBe(4101);
  });

  it('joins semantically equivalent normalized bodies under the canonical hash', async () => {
    const operationId = 'create:canonical-semantics';
    const first = await invokeCreate(createRequestBody(operationId, {
      content: 'same task   ',
      larkAppIds: ['cli_a', 'cli_a'],
      bindWorkingDir: ' /tmp/project ',
    }));
    const replay = await invokeCreate(createRequestBody(operationId, {
      content: 'same task',
      larkAppIds: ['cli_a'],
      bindWorkingDir: '/tmp/project',
    }));

    expect(replay.status).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(fetchDaemonIpcMock.mock.calls.filter(call => call[1] === '/api/groups/create')).toHaveLength(1);
  });

  it('returns 409 for the same operation id with different canonical semantics', async () => {
    const operationId = 'create:route-conflict';
    await invokeCreate(createRequestBody(operationId));
    const conflict = await invokeCreate(createRequestBody(operationId, { content: 'different task' }));

    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(fetchDaemonIpcMock.mock.calls.filter(call => call[1] === '/api/groups/create')).toHaveLength(1);
  });

  it('sticks create-group response loss as dispatch_unknown and never re-dispatches', async () => {
    const operationId = 'create:route-unknown';
    const body = createRequestBody(operationId);
    fetchDaemonIpcMock.mockRejectedValue(new Error('response lost after group creation'));

    const first = await invokeCreate(body);
    const replay = await invokeCreate(body);

    expect(first.status).toBe(503);
    expect(JSON.parse(first.body)).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(replay.body).toBe(first.body);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(1);
  });

  it('sticks an unreadable create-group response as dispatch_unknown and never re-dispatches', async () => {
    const operationId = 'create:route-unreadable-response';
    const body = createRequestBody(operationId);
    fetchDaemonIpcMock.mockResolvedValue(new Response('not-json', { status: 200 }));

    const first = await invokeCreate(body);
    const replay = await invokeCreate(body);

    expect(first.status).toBe(503);
    expect(JSON.parse(first.body)).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(replay.body).toBe(first.body);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(1);
  });

  it('retains a hash-only reservation across a known pre-effect unavailable result', async () => {
    const operationId = 'create:route-retryable';
    const body = createRequestBody(operationId);
    registryEntries.splice(0, registryEntries.length);

    const unavailable = await invokeCreate(body);
    const conflict = await invokeCreate(createRequestBody(operationId, { content: 'different task' }));
    registryEntries.push(onlineBot('cli_a', 4101));
    const recovered = await invokeCreate(body);

    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailable.body)).toEqual({ ok: false, error: 'no_online_daemon' });
    expect(conflict.status).toBe(409);
    expect(recovered.status).toBe(200);
    expect(fetchDaemonIpcMock.mock.calls.filter(call => call[1] === '/api/groups/create')).toHaveLength(1);
  });
});

function idleSession(
  sessionId: string,
  larkAppId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    sessionId,
    larkAppId,
    status: 'idle',
    lastMessageAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function cleanupBody(operationId: string, overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    olderThanHours: 168,
    sessionIds: ['session-a', 'session-b'],
    ...overrides,
  };
}

describe('POST /api/sessions/cleanup-idle process-local fixed batch', () => {
  beforeEach(() => {
    aggregatorSessions.splice(
      0,
      aggregatorSessions.length,
      idleSession('session-a', 'cli_a'),
      idleSession('session-b', 'cli_b'),
    );
    aggregatorGetSessionsHook = undefined;
    registryEntries.splice(
      0,
      registryEntries.length,
      onlineBot('cli_a', 4201, 'boot-a-1'),
      onlineBot('cli_b', 4202, 'boot-b-1'),
    );
    fetchDaemonIpcMock.mockReset();
    fetchDaemonIpcMock.mockImplementation(async () => new Response(JSON.stringify({
      ok: true,
      alreadyClosed: false,
      known: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });

  it('requires one matching parent operation id before candidate discovery', async () => {
    const getSessions = vi.fn();
    aggregatorGetSessionsHook = getSessions;

    const missing = await invokeIdleCleanup(cleanupBody('cleanup:missing'), null);
    const mismatch = await invokeIdleCleanup(cleanupBody('cleanup:body'), 'cleanup:header');

    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ ok: false, error: 'bad_operation_id' });
    expect(mismatch.status).toBe(400);
    expect(JSON.parse(mismatch.body)).toEqual({ ok: false, error: 'bad_operation_id' });
    expect(getSessions).not.toHaveBeenCalled();
    expect(fetchDaemonIpcMock).not.toHaveBeenCalled();
  });

  it('publishes the parent receipt before candidate discovery and joins synchronous re-entry', async () => {
    const operationId = 'cleanup:discovery-reentry';
    const body = cleanupBody(operationId);
    let follower!: Promise<FakeResponse>;
    let reentered = false;
    aggregatorGetSessionsHook = () => {
      if (reentered) return;
      reentered = true;
      follower = invokeIdleCleanup(body);
    };

    const first = await invokeIdleCleanup(body);
    const joined = await follower;

    expect(first.status).toBe(200);
    expect(joined.status).toBe(200);
    expect(joined.body).toBe(first.body);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(2);
    const childOperationIds = fetchDaemonIpcMock.mock.calls.map(call => (
      JSON.parse(String((call[2] as RequestInit).body)).operationId
    ));
    expect(new Set(childOperationIds).size).toBe(2);
    expect(childOperationIds.every(id => typeof id === 'string' && id.startsWith('dashboard-cleanup:'))).toBe(true);
    expect(fetchDaemonIpcMock.mock.calls.every(call => (
      (call[2] as RequestInit).headers
      && (call[2] as RequestInit).headers!['x-botmux-operation-id' as keyof HeadersInit]
    ))).toBe(true);
  });

  it('retries only the frozen unresolved child without re-closing success or adding a late candidate', async () => {
    const operationId = 'cleanup:frozen-unresolved';
    const body = cleanupBody(operationId);
    let bAttempts = 0;
    fetchDaemonIpcMock.mockImplementation(async (port: number) => {
      if (port === 4201) {
        return new Response(JSON.stringify({ ok: true, alreadyClosed: false, known: true }), { status: 200 });
      }
      bAttempts += 1;
      if (bAttempts === 1) {
        return new Response(JSON.stringify({ ok: false, error: 'session_runtime_not_ready' }), { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true, alreadyClosed: false, known: true }), { status: 200 });
    });

    const first = await invokeIdleCleanup(body);
    const conflict = await invokeIdleCleanup(cleanupBody(operationId, { olderThanHours: 72 }));
    registryEntries.splice(0, 1, onlineBot('cli_a', 4291, 'boot-a-2'));
    registryEntries.push(onlineBot('cli_c', 4203, 'boot-c-1'));
    aggregatorSessions.push(idleSession('session-c', 'cli_c'));
    const recovered = await invokeIdleCleanup(body);
    const replay = await invokeIdleCleanup(body);

    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ ok: false, matched: 2, closed: 1, failed: 1 });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(recovered.status).toBe(200);
    expect(JSON.parse(recovered.body)).toMatchObject({ ok: true, matched: 2, closed: 2, failed: 0 });
    expect(replay.body).toBe(recovered.body);
    expect(fetchDaemonIpcMock.mock.calls.map(call => call[0])).toEqual([4201, 4202, 4202]);
    expect(fetchDaemonIpcMock.mock.calls.some(call => call[0] === 4291 || call[0] === 4203)).toBe(false);
    const bOperationIds = fetchDaemonIpcMock.mock.calls
      .filter(call => call[0] === 4202)
      .map(call => JSON.parse(String((call[2] as RequestInit).body)).operationId);
    expect(new Set(bOperationIds).size).toBe(1);
  });

  it('sticks unresolved daemon epoch drift as dispatch_unknown without calling the replacement', async () => {
    const operationId = 'cleanup:boot-drift';
    const body = cleanupBody(operationId);
    fetchDaemonIpcMock.mockImplementation(async (port: number) => new Response(JSON.stringify(
      port === 4202
        ? { ok: false, error: 'dispatch_retryable' }
        : { ok: true, alreadyClosed: false, known: true },
    ), { status: port === 4202 ? 503 : 200 }));

    await invokeIdleCleanup(body);
    registryEntries.splice(1, 1, onlineBot('cli_b', 4292, 'boot-b-2'));
    const drift = await invokeIdleCleanup(body);
    const replay = await invokeIdleCleanup(body);

    expect(drift.status).toBe(503);
    expect(JSON.parse(drift.body)).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(replay.body).toBe(drift.body);
    expect(fetchDaemonIpcMock.mock.calls.map(call => call[0])).toEqual([4201, 4202]);
  });

  it('sticks a child response-loss outcome and never blindly re-dispatches it', async () => {
    const operationId = 'cleanup:child-unknown';
    const body = cleanupBody(operationId, { sessionIds: ['session-a'] });
    fetchDaemonIpcMock.mockRejectedValue(new Error('response lost after close'));

    const first = await invokeIdleCleanup(body);
    const replay = await invokeIdleCleanup(body);

    expect(first.status).toBe(503);
    expect(JSON.parse(first.body)).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(replay.body).toBe(first.body);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(1);
  });

  it('reserves the semantic hash across pre-effect inventory unavailability and later recovers', async () => {
    const operationId = 'cleanup:inventory-retry';
    const body = cleanupBody(operationId, { sessionIds: ['session-a'] });
    registryEntries.splice(0, registryEntries.length);

    const unavailable = await invokeIdleCleanup(body);
    const conflict = await invokeIdleCleanup(cleanupBody(operationId, {
      olderThanHours: 72,
      sessionIds: ['session-a'],
    }));
    registryEntries.push(onlineBot('cli_a', 4201, 'boot-a-1'));
    const recovered = await invokeIdleCleanup(body);

    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailable.body)).toEqual({ ok: false, error: 'dispatch_retryable' });
    expect(conflict.status).toBe(409);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(1);
    expect(recovered.status).toBe(200);
  });

  it('treats sessionIds as a canonical set for same-operation replay', async () => {
    const operationId = 'cleanup:canonical-session-set';
    const first = await invokeIdleCleanup(cleanupBody(operationId, {
      sessionIds: ['session-b', 'session-a', 'session-a'],
    }));
    const replay = await invokeIdleCleanup(cleanupBody(operationId, {
      sessionIds: ['session-a', 'session-b'],
    }));

    expect(replay.status).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(2);
  });
});
