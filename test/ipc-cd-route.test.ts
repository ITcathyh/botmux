import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  setDashboardSessionRuntimeSubmitter,
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { setRoleLibraryRootForTests } from '../src/core/role-library.js';
import * as workerPool from '../src/core/worker-pool.js';

const CAP = 'deadbeef'.repeat(8);
const HOST_SECRET = 'test-ipc-cd-host-secret';

let handle: IpcServerHandle | null = null;
let fixtureRoot: string;
let rolesRoot: string;
let roleDir: string;
let roleDirReal: string;
let operationSequence = 0;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'ipc-cd-root-'));
  rolesRoot = join(fixtureRoot, 'botmux-roles');
  roleDir = join(rolesRoot, 'role-a');
  mkdirSync(roleDir, { recursive: true });
  roleDirReal = realpathSync(roleDir);
  setRoleLibraryRootForTests(rolesRoot);
});

afterAll(() => {
  setRoleLibraryRootForTests(undefined);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  setDashboardSessionRuntimeSubmitter(null);
  vi.restoreAllMocks();
});

function mockActive(sessionId: string, overrides: Record<string, unknown> = {}): Record<string, any> {
  const ds = {
    session: { sessionId, cliId: 'claude-code' },
    managedTurnOrigin: { capability: CAP },
    worker: { send: vi.fn(), killed: false },
    adoptedFrom: undefined,
    ...overrides,
  } as Record<string, any>;
  vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds as any);
  return ds;
}

function applied(
  sessionId: string,
  mode: 'respawn-resume' | 'cold-restart',
  workingDir: string,
  kind: 'applied' | 'duplicate' = 'applied',
): Record<string, unknown> {
  return {
    kind,
    action: 'control.mutated',
    policy: 'control-staged-transition',
    sessionId,
    result: { kind: 'workingDirectoryChanged', mode, workingDir },
  };
}

function installRuntimeOutcome(outcome: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const submit = vi.fn().mockResolvedValue(outcome);
  setDashboardSessionRuntimeSubmitter(submit as any);
  return submit;
}

async function postCd(sessionId: string, dir?: string, opts: {
  auth?: 'capability' | 'signed' | 'none';
  authRequired?: boolean;
  operationId?: unknown;
} = {}): Promise<Response> {
  if (!handle) {
    if (opts.authRequired) setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({
      port: 0,
      host: '127.0.0.1',
      ...(opts.authRequired ? { authRequired: true } : {}),
    });
  }
  const auth = opts.auth ?? 'capability';
  const path = `/api/sessions/${sessionId}/cd`;
  const body: Record<string, unknown> = dir === undefined ? {} : { dir };
  body.operationId = opts.operationId ?? `test-cd-${++operationSequence}`;
  if (auth === 'capability') body.originCapability = CAP;
  const headers: HeadersInit = auth === 'signed'
    ? daemonIpcAuthHeaders({
        secret: HOST_SECRET,
        port: handle.port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json' },
      })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions/:sessionId/cd', () => {
  it('404s a missing active Session after trusted-host authentication', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const submit = installRuntimeOutcome(applied('missing', 'cold-restart', roleDirReal));

    const response = await postCd('missing', roleDir, { auth: 'signed', authRequired: true });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: 'session_not_active' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps capability authentication outside the Runtime lane', async () => {
    mockActive('s-unproven', { managedTurnOrigin: { capability: 'f00d'.repeat(16) } });
    const submit = installRuntimeOutcome(applied('s-unproven', 'respawn-resume', roleDirReal));

    const absent = await postCd('s-unproven', roleDir, { auth: 'none' });
    expect(absent.status).toBe(403);
    expect(await absent.json()).toMatchObject({ ok: false, error: 'origin_unproven' });

    const wrong = await postCd('s-unproven', roleDir);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ['outside', 403, 'outside_role_library'],
    ['missing', 400, 'dir_not_found'],
    ['empty', 400, 'empty_path'],
  ] as const)('validates the role-library boundary before submission', async (pathKind, status, error) => {
    const dir = pathKind === 'outside'
      ? fixtureRoot
      : pathKind === 'missing'
        ? join(rolesRoot, 'missing')
        : undefined;
    mockActive(`s-${error}`);
    const submit = installRuntimeOutcome(applied(`s-${error}`, 'respawn-resume', roleDirReal));

    const response = await postCd(`s-${error}`, dir);

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, error });
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits the canonical resolved path and explicit operation identity', async () => {
    mockActive('s-respawn');
    const submit = installRuntimeOutcome(applied('s-respawn', 'respawn-resume', roleDirReal));

    const response = await postCd('s-respawn', roleDir, { operationId: 'cd-op-1' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: 'respawn-resume', dir: roleDirReal });
    expect(submit).toHaveBeenCalledWith({
      target: { kind: 'externalSession', sessionId: 's-respawn' },
      idempotencyKey: 'cd-op-1',
      command: {
        kind: 'control.mutate',
        input: { kind: 'changeWorkingDirectory', resolvedPath: roleDirReal },
      },
    });
  });

  it('preserves cold-restart and duplicate result semantics from the Runtime', async () => {
    mockActive('s-cold');
    installRuntimeOutcome(applied('s-cold', 'cold-restart', roleDirReal, 'duplicate'));

    const response = await postCd('s-cold', roleDir, { operationId: 'cd-op-retry' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: 'cold-restart', dir: roleDirReal });
  });

  it.each([
    ['session_transferring', undefined],
    ['adopt_cd_unsupported', undefined],
    ['session_mutation_pending', {
      blockingSessions: [{ sessionId: 's-guard', reasons: ['workflow_dispatch'] }],
    }],
  ] as const)('maps Current guard %s to 409 without HTTP-side mutation', async (code, details) => {
    mockActive('s-guard');
    installRuntimeOutcome({
      kind: 'rejected',
      reason: 'transitionRejected',
      code,
      message: code,
      ...(details ? { details } : {}),
    });

    const response = await postCd('s-guard', roleDir);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: code, ...(details ?? {}) });
  });

  it('localizes the Riff rejection returned by Current control', async () => {
    mockActive('s-riff');
    installRuntimeOutcome({
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'riff_cd_unsupported',
      message: 'riff_cd_unsupported',
    });

    const response = await postCd('s-riff', roleDir);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'riff_cd_unsupported',
      message: expect.any(String),
    });
  });

  it('fails closed when the Runtime submitter is not installed', async () => {
    mockActive('s-no-runtime');

    const response = await postCd('s-no-runtime', roleDir);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'session_runtime_not_ready' });
  });

  it('403s a path in another bot role subtree', async () => {
    const ownRole = join(rolesRoot, 'cli_self', 'shared', 'default');
    const otherRole = join(rolesRoot, 'cli_other', 'shared', 'default');
    mkdirSync(ownRole, { recursive: true });
    mkdirSync(otherRole, { recursive: true });
    mockActive('s-crossbot', { larkAppId: 'cli_self' });
    const submit = installRuntimeOutcome(applied('s-crossbot', 'respawn-resume', realpathSync(otherRole)));

    const response = await postCd('s-crossbot', otherRole);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: 'outside_own_role_library' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('409s when the owner appId subtree is missing rather than falling back to the global root', async () => {
    const legacyRole = join(rolesRoot, 'human-legacy', 'shared', 'default');
    mkdirSync(legacyRole, { recursive: true });
    mockActive('s-legacy', { larkAppId: 'cli_legacy' });
    const submit = installRuntimeOutcome(applied('s-legacy', 'respawn-resume', realpathSync(legacyRole)));

    const response = await postCd('s-legacy', legacyRole);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'own_role_library_missing' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('allows and canonicalizes a path inside the owner appId subtree', async () => {
    const ownRole = join(rolesRoot, 'cli_self', 'shared', 'pm');
    mkdirSync(ownRole, { recursive: true });
    const ownRoleReal = realpathSync(ownRole);
    mockActive('s-ownbot', { larkAppId: 'cli_self' });
    const submit = installRuntimeOutcome(applied('s-ownbot', 'respawn-resume', ownRoleReal));

    const response = await postCd('s-ownbot', ownRole, { operationId: 'cd-own-op' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: 'respawn-resume', dir: ownRoleReal });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        kind: 'control.mutate',
        input: { kind: 'changeWorkingDirectory', resolvedPath: ownRoleReal },
      },
    }));
  });
});
