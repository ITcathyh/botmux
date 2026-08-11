import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const whiteboard = vi.hoisted(() => {
  const state = {
    enabled: false,
    archived: false,
  };
  return {
    state,
    ensureDefault: vi.fn(() => ({
      id: 'wb_pending_opening',
      title: 'Pending opening board',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    })),
    get: vi.fn((id: string) => id === 'wb_pending_opening'
      ? {
          id,
          title: 'Pending opening board',
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z',
          ...(state.archived ? { archived: true } : {}),
        }
      : undefined),
  };
});

vi.mock('../src/services/whiteboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/whiteboard-store.js')>();
  return {
    ...actual,
    whiteboardEnabled: vi.fn(() => whiteboard.state.enabled),
    ensureDefaultWhiteboard: whiteboard.ensureDefault,
    getWhiteboard: whiteboard.get,
  };
});

import { registerBot } from '../src/bot-registry.js';
import {
  createCurrentPendingRepoCompletionProduction,
  type CurrentPendingRepoCompletionProductionAdapters,
} from '../src/core/current-pending-repo-completion-production.js';
import { currentSessionRuntimeHost } from '../src/core/current-session-runtime.js';
import { stagePendingRepoSetup } from '../src/core/pending-repo-journal.js';
import type {
  PendingRepoCompletionCommandOutcome,
  SessionAddress,
  SessionRuntime,
} from '../src/core/session-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { ForkResumeOrTurnId } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import type { CliTurnPayload } from '../src/types.js';

const APP = 'local_pending_repo_opening_production';
const CHAT = 'oc_pending_repo_opening_production';
const ROOT = 'om_pending_repo_opening_production';
let bootSequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function pendingSession(prompt = ''): DaemonSession {
  const session = sessionStore.createSession(
    CHAT,
    ROOT,
    'pending opening production',
    'group',
    'thread',
  );
  Object.assign(session, {
    larkAppId: APP,
    cliId: 'codex-app',
  });
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: false,
    pendingRepo: true,
    pendingPrompt: prompt,
  } as DaemonSession;
}

function externalAdapters(input: {
  availableBots?: CurrentPendingRepoCompletionProductionAdapters['availableBots'];
  forkWorker: (
    current: DaemonSession,
    input: string | CliTurnPayload,
    resumeOrTurnId: ForkResumeOrTurnId,
  ) => unknown;
}): CurrentPendingRepoCompletionProductionAdapters {
  // These tests select an already-resolved directory. Keep the test Adapter at
  // the public effects it exercises instead of coupling it to worktree policy.
  return {
    availableBots: input.availableBots ?? vi.fn(async () => []),
    activationFor({ ownerLarkAppId, activeSessions }) {
      return {
        async ensure(request) {
          const matches = [...activeSessions.values()].filter(current => (
            current.larkAppId === ownerLarkAppId
            && current.session.sessionId === request.sessionId
          ));
          const current = matches.length === 1 ? matches[0] : undefined;
          if (!current) {
            return { kind: 'rejected', reason: 'notFound', message: 'test owner is stale' };
          }
          const accepted = input.forkWorker(
            current,
            request.promptInput,
            request.resumeOrTurnId ?? false,
          );
          if (accepted === true) return { kind: 'active', action: 'activated' };
          if (accepted === false) {
            return { kind: 'retryable', message: 'test executor refused activation' };
          }
          return { kind: 'quarantined', message: 'test executor returned no acceptance proof' };
        },
      };
    },
  } as CurrentPendingRepoCompletionProductionAdapters;
}

async function addressFor(
  host: ReturnType<typeof currentSessionRuntimeHost>,
  sessionId: string,
): Promise<SessionAddress> {
  const read = await host.projection.read({ kind: 'byExternalSession', sessionId });
  if (read.kind !== 'one') throw new Error(`expected one Session projection, got ${read.kind}`);
  return read.session.address;
}

function complete(
  runtime: SessionRuntime,
  address: SessionAddress,
  key: string,
): Promise<PendingRepoCompletionCommandOutcome> {
  return runtime.submit({
    target: { kind: 'session', address },
    idempotencyKey: key,
    command: {
      kind: 'pendingRepo.complete',
      input: {
        selection: {
          kind: 'directory',
          path: '/repos/pending-opening',
          pinWorkingDir: true,
        },
      },
    },
  });
}

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pending-repo-opening-production-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  sessionStore.init(APP);
  registerBot({
    larkAppId: APP,
    larkAppSecret: '',
    apiOnly: true,
    cliId: 'codex-app',
    codexAppCleanInput: true,
  });
  whiteboard.state.enabled = false;
  whiteboard.state.archived = false;
  whiteboard.ensureDefault.mockClear();
  whiteboard.get.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStore.init();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Current pending-repo opening production seam', () => {
  it('boots a raw-first opening idle and stages buffered replies behind its literal command', async () => {
    const ds = pendingSession();
    Object.assign(ds, {
      pendingRawInput: '/goal 发布 onboarding',
      pendingRawTurnId: 'om_raw_opening',
      pendingTurnId: 'om_raw_opening',
      pendingFollowUps: ['对了顺手看下 CI', '别忘了更新 changelog'],
      pendingFollowUpTurnIds: ['om_follow_up_1', 'om_follow_up_2'],
    });
    stagePendingRepoSetup(ds, {
      mode: 'picker',
      turnId: 'om_raw_opening',
    });
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const forkInputs: CliTurnPayload[] = [];
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        forkWorker: vi.fn((_current, workerInput) => {
          forkInputs.push(structuredClone(
            typeof workerInput === 'string' ? { content: workerInput } : workerInput,
          ));
          return true;
        }),
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-opening-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });

    await expect(complete(
      host.runtime,
      await addressFor(host, ds.session.sessionId),
      'pending-repo/raw-first',
    )).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });

    expect(forkInputs).toEqual([{ content: '' }]);
    expect(ds.pendingRawInput).toBe('/goal 发布 onboarding');
    expect(ds.pendingRawTurnId).toBe('om_raw_opening');
    expect(ds.pendingFollowUpInput).toEqual({
      userPrompt: '对了顺手看下 CI\n\n别忘了更新 changelog',
      cliInput: expect.stringContaining('对了顺手看下 CI\n\n别忘了更新 changelog'),
      turnId: 'om_follow_up_2',
      codexAppInputGateFrozen: true,
    });
    expect(ds.pendingFollowUps).toBeUndefined();
    expect(ds.session.initialUserTurnPending).toBeUndefined();
  });

  it('snapshots the whiteboard before awaiting roster for raw input with buffered follow-ups', async () => {
    whiteboard.state.enabled = true;
    const ds = pendingSession();
    Object.assign(ds, {
      pendingRawInput: '/goal preserve this literal command',
      pendingRawTurnId: 'om_raw_whiteboard_opening',
      pendingTurnId: 'om_raw_whiteboard_opening',
      pendingFollowUps: ['FOLLOW_UP_WITH_FROZEN_BOARD'],
      pendingFollowUpTurnIds: ['om_raw_whiteboard_follow_up'],
    });
    stagePendingRepoSetup(ds, {
      mode: 'picker',
      turnId: 'om_raw_whiteboard_opening',
      cliInput: {
        content: '<frozen-opening-that-raw-mode-must-not-reuse />',
      },
    });
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const roster = deferred<[]>();
    const availableBots = vi.fn(async () => roster.promise);
    const forkInputs: CliTurnPayload[] = [];
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots,
        forkWorker: vi.fn((_current, workerInput) => {
          forkInputs.push(structuredClone(
            typeof workerInput === 'string' ? { content: workerInput } : workerInput,
          ));
          return true;
        }),
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-opening-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const completion = complete(
      host.runtime,
      await addressFor(host, ds.session.sessionId),
      'pending-repo/raw-follow-up-whiteboard',
    );

    await vi.waitFor(() => expect(availableBots).toHaveBeenCalledTimes(1));
    const ensureCallsBeforeRosterRelease = whiteboard.ensureDefault.mock.calls.length;
    const snapshotCallsBeforeRosterRelease = whiteboard.get.mock.calls.length;
    whiteboard.state.archived = true;
    roster.resolve([]);

    await expect(completion).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });
    expect(ensureCallsBeforeRosterRelease).toBe(1);
    expect(snapshotCallsBeforeRosterRelease).toBe(1);
    expect(whiteboard.ensureDefault.mock.invocationCallOrder[0])
      .toBeLessThan(availableBots.mock.invocationCallOrder[0]!);
    expect(whiteboard.get.mock.invocationCallOrder[0])
      .toBeLessThan(availableBots.mock.invocationCallOrder[0]!);
    expect(whiteboard.get).toHaveBeenCalledTimes(1);
    expect(forkInputs).toEqual([{ content: '' }]);
    expect(ds.pendingRawInput).toBe('/goal preserve this literal command');
    expect(ds.pendingRawTurnId).toBe('om_raw_whiteboard_opening');
    expect(ds.pendingFollowUpInput).toMatchObject({
      userPrompt: 'FOLLOW_UP_WITH_FROZEN_BOARD',
      cliInput: expect.stringContaining('<whiteboard id="wb_pending_opening">'),
      turnId: 'om_raw_whiteboard_follow_up',
      codexAppInputGateFrozen: true,
    });
  });

  it('snapshots the whiteboard for a raw opening whose only buffered successor is an attachment', async () => {
    whiteboard.state.enabled = true;
    const ds = pendingSession();
    Object.assign(ds, {
      pendingRawInput: '/goal preserve attachment successor',
      pendingRawTurnId: 'om_raw_attachment_opening',
      pendingTurnId: 'om_raw_attachment_opening',
      pendingAttachments: [{ type: 'file', path: '/tmp/raw-successor.md', name: 'raw-successor.md' }],
    });
    stagePendingRepoSetup(ds, {
      mode: 'picker',
      turnId: 'om_raw_attachment_opening',
    });
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const roster = deferred<[]>();
    const availableBots = vi.fn(async () => roster.promise);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots,
        forkWorker: vi.fn(() => true),
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-opening-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const completion = complete(
      host.runtime,
      await addressFor(host, ds.session.sessionId),
      'pending-repo/raw-attachment-whiteboard',
    );

    await vi.waitFor(() => expect(availableBots).toHaveBeenCalledTimes(1));
    expect(whiteboard.ensureDefault).toHaveBeenCalledTimes(1);
    expect(whiteboard.get).toHaveBeenCalledTimes(1);
    expect(whiteboard.ensureDefault.mock.invocationCallOrder[0])
      .toBeLessThan(availableBots.mock.invocationCallOrder[0]!);
    expect(whiteboard.get.mock.invocationCallOrder[0])
      .toBeLessThan(availableBots.mock.invocationCallOrder[0]!);
    whiteboard.state.archived = true;
    roster.resolve([]);

    await expect(completion).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });
    expect(whiteboard.get).toHaveBeenCalledTimes(1);
    expect(ds.pendingRawInput).toBe('/goal preserve attachment successor');
    expect(ds.pendingFollowUpInput).toMatchObject({
      cliInput: expect.stringContaining('<whiteboard id="wb_pending_opening">'),
      codexAppInputGateFrozen: true,
    });
  });

  it('ensures and snapshots a missing whiteboard before an unfrozen opening crosses external awaits', async () => {
    whiteboard.state.enabled = true;
    const ds = pendingSession('RESTORED_DASHBOARD_TRIGGER_OPENING');
    ds.pendingTurnId = 'om_unfrozen_opening';
    stagePendingRepoSetup(ds, {
      mode: 'picker',
      turnId: 'om_unfrozen_opening',
    });
    expect(ds.session.pendingRepoSetup?.cliInput).toBeUndefined();

    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const roster = deferred<[]>();
    const availableBots = vi.fn(async () => roster.promise);
    const forkInputs: CliTurnPayload[] = [];
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots,
        forkWorker: vi.fn((_current, workerInput) => {
          forkInputs.push(structuredClone(
            typeof workerInput === 'string' ? { content: workerInput } : workerInput,
          ));
          return true;
        }),
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-opening-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const completion = complete(
      host.runtime,
      await addressFor(host, ds.session.sessionId),
      'pending-repo/unfrozen-whiteboard',
    );

    await vi.waitFor(() => expect(availableBots).toHaveBeenCalledTimes(1));
    const ensureCallsBeforeRosterRelease = whiteboard.ensureDefault.mock.calls.length;
    const snapshotCallsBeforeRosterRelease = whiteboard.get.mock.calls.length;
    const capturedWhiteboardId = ds.session.whiteboardId;
    whiteboard.state.archived = true;
    roster.resolve([]);

    await expect(completion).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });
    expect(ensureCallsBeforeRosterRelease).toBe(1);
    expect(snapshotCallsBeforeRosterRelease).toBe(1);
    expect(capturedWhiteboardId).toBe('wb_pending_opening');
    expect(whiteboard.ensureDefault.mock.invocationCallOrder[0])
      .toBeLessThan(availableBots.mock.invocationCallOrder[0]!);
    expect(whiteboard.get.mock.invocationCallOrder[0])
      .toBeLessThan(availableBots.mock.invocationCallOrder[0]!);
    expect(whiteboard.get).toHaveBeenCalledTimes(1);
    expect(forkInputs).toHaveLength(1);
    expect(forkInputs[0]!.content).toContain('<whiteboard id="wb_pending_opening">');
    expect(forkInputs[0]!.codexAppInput?.additionalContext?.botmux_whiteboard?.value)
      .toContain('<whiteboard id="wb_pending_opening">');
  });
});
