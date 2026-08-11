import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCurrentPendingRepoCompletionPort,
  type CurrentPendingRepoCompletionOptions,
  type CurrentPendingRepoCompletionMaterial,
  type CurrentPendingRepoCompletionMaterializeInput,
  type CurrentPendingRepoCompletionMaterializeResult,
  type CurrentPendingRepoCompletionPreMaterializationModule,
  type CurrentPendingRepoCompletionSelection,
  type CurrentPendingRepoWorkerCommand,
} from '../src/core/current-pending-repo-completion.js';
import { createCurrentOrdinaryIngressProductionPort } from '../src/core/current-ordinary-ingress-production.js';
import { currentSessionRuntimeHost } from '../src/core/current-session-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type {
  OrdinaryIngressPort,
  PendingRepoCompletionCommandOutcome,
  SessionAddress,
  SessionRuntime,
} from '../src/core/session-runtime.js';
import * as sessionStore from '../src/services/session-store.js';

/**
 * Proposed C1 seam (RED until the production Module exists):
 *
 * - callers normalize card, text-command, and automatic-worktree completion to
 *   one `pendingRepo.complete` SessionRuntime command;
 * - the command contains selection intent, never transport identity;
 * - Current owns the exact pending first-start state, keyed join/conflict,
 *   effect-outside-lane continuation, live-owner recheck, and one fork commit.
 *
 * This is intentionally first-start only. A live Session repository switch is
 * C2 and must not be smuggled into this Module as a fallback.
 */

const APP = 'pending_repo_runtime_app';
const ROOT = 'om_pending_repo_root';
const CHAT = 'oc_pending_repo_chat';
let bootSequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pendingSession(): DaemonSession {
  const session = sessionStore.createSession(CHAT, ROOT, 'pending first start', 'group', 'thread');
  Object.assign(session, {
    larkAppId: APP,
    scope: 'thread',
    cliId: 'claude-code',
    queued: true,
    queuedPrompt: 'OPENING_N',
    queuedCodexAppText: 'visible opening',
    queuedCodexAppMessageContext: '<message-context/>',
    pendingRepoSetup: {
      mode: 'auto_worktree',
      prompt: 'OPENING_N',
      turnId: 'om_opening_n',
      baseDir: '/repos/base',
      repoCardMessageId: 'om_picker',
      codexAppText: 'visible opening',
      codexAppApplicationContext: '<application-context/>',
      codexAppMessageContext: '<message-context/>',
      attachments: [{ type: 'file', path: '/tmp/spec.md', name: 'spec.md' }],
      mentions: [{ key: '@_user_1', name: 'Owner', openId: 'ou_owner' }],
      sender: { openId: 'ou_owner', type: 'user', name: 'Owner' },
    },
  });
  sessionStore.updateSession(session);
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
    initialStartPending: false,
    repoCardMessageId: 'om_picker',
    pendingPrompt: 'OPENING_N',
    pendingTurnId: 'om_opening_n',
    pendingCodexAppText: 'visible opening',
    pendingCodexAppApplicationContext: '<application-context/>',
    pendingCodexAppMessageContext: '<message-context/>',
    pendingChatContext: {
      chatId: CHAT,
      name: 'Repository setup group',
      mode: 'group',
      fetchStatus: 'ok',
    },
    pendingAttachments: [{ type: 'file', path: '/tmp/spec.md', name: 'spec.md' }],
    pendingMentions: [{ key: '@_user_1', name: 'Owner', openId: 'ou_owner' }],
    pendingSubstituteTrigger: {
      target: { name: 'Reviewer', openId: 'ou_reviewer' },
      observedMention: { name: 'Reviewer' },
      disclosure: 'prefix',
    },
    pendingSender: { openId: 'ou_owner', type: 'user', name: 'Owner' },
    pendingFollowUps: ['FOLLOW_UP_N_PLUS_1'],
    pendingFollowUpTurnId: 'om_follow_up_n_plus_1',
    pendingFollowUpTurnIds: ['om_follow_up_n_plus_1'],
    pendingCodexAppFollowUps: ['visible follow-up'],
    pendingCodexAppFollowUpContexts: ['<follow-up-context/>'],
    pendingCodexAppFollowUpGateAccepted: [true],
  } as DaemonSession;
}

const worktreeSelection = (branch = 'feat/runtime') => ({
  kind: 'worktree' as const,
  repositories: [{ sourcePath: '/repos/base', childName: 'base' }],
  branch,
  layout: { kind: 'sibling' as const },
});

function materialFor(
  input: CurrentPendingRepoCompletionMaterializeInput,
  workingDir = '/repos/base/.worktrees/feat-runtime',
): CurrentPendingRepoCompletionMaterial {
  return {
    sessionId: input.sessionId,
    workingDir,
    userPrompt: 'OPENING_N\n\nFOLLOW_UP_N_PLUS_1',
    cliInput: { content: '<new-topic>OPENING_N\n\nFOLLOW_UP_N_PLUS_1</new-topic>' },
    turnId: 'om_opening_n',
    resume: false,
  };
}

function materialized(
  material: CurrentPendingRepoCompletionMaterial,
): CurrentPendingRepoCompletionMaterializeResult {
  return { kind: 'materialized', material };
}

function createFixture(
  materialize: (
    input: CurrentPendingRepoCompletionMaterializeInput,
  ) => Promise<CurrentPendingRepoCompletionMaterializeResult>,
  options: {
    readonly preMaterialization?: CurrentPendingRepoCompletionPreMaterializationModule;
    readonly cleanupWorktrees?: CurrentPendingRepoCompletionOptions['cleanupWorktrees'];
    readonly ordinaryIngressFactory?: (
      activeSessions: Map<string, DaemonSession>,
    ) => OrdinaryIngressPort;
  } = {},
) {
  const ds = pendingSession();
  const activeSessions = new Map([[activeSessionKey(ds), ds]]);
  const dispatchWorker = vi.fn<(command: CurrentPendingRepoWorkerCommand) => { kind: 'accepted' | 'refused'; message?: string }>(
    () => ({ kind: 'accepted' }),
  );
  const port = createCurrentPendingRepoCompletionPort({
    ownerLarkAppId: APP,
    activeSessions,
    ...(options.preMaterialization
      ? { preMaterialization: options.preMaterialization }
      : {}),
    materialize,
    dispatchWorker,
    ...(options.cleanupWorktrees ? { cleanupWorktrees: options.cleanupWorktrees } : {}),
  });
  const ordinaryIngress = options.ordinaryIngressFactory?.(activeSessions);
  const host = currentSessionRuntimeHost({
    ownerLarkAppId: APP,
    activeSessions,
    ownerBootId: `boot-pending-repo-${++bootSequence}`,
    keyedTriggerAdmissionBlocked: () => false,
    pendingRepoCompletion: port,
    ...(ordinaryIngress ? { ordinaryIngress } : {}),
  } as Parameters<typeof currentSessionRuntimeHost>[0] & { pendingRepoCompletion: typeof port });
  return { ds, activeSessions, dispatchWorker, host };
}

async function addressFor(
  host: ReturnType<typeof currentSessionRuntimeHost>,
  sessionId: string,
): Promise<SessionAddress> {
  const projected = await host.projection.read({ kind: 'byExternalSession', sessionId });
  if (projected.kind !== 'one') throw new Error(`expected one projected Session, got ${projected.kind}`);
  return projected.session.address;
}

function submitCompletion(
  runtime: SessionRuntime,
  address: SessionAddress,
  key: string,
  selection: CurrentPendingRepoCompletionSelection,
): Promise<PendingRepoCompletionCommandOutcome> {
  return runtime.submit({
    target: { kind: 'session', address },
    idempotencyKey: key,
    command: { kind: 'pendingRepo.complete', input: { selection } },
  });
}

function ordinaryIngressFor(
  activeSessions: Map<string, DaemonSession>,
): OrdinaryIngressPort {
  return createCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: APP,
    activeSessions,
    externalEffects: {
      async execute(effect) {
        const content = effect.input.turn.content;
        const input = { content: `CLI:${content}` };
        return {
          kind: 'materialized',
          material: {
            userPrompt: content,
            newTopicUserPrompt: content,
            cliInput: input,
            newTopicCliInput: input,
            adoptCliInput: input,
            turnId: effect.input.turn.messageKey,
          },
        };
      },
    },
    workerProcesses: {
      dispatch() {
        return { kind: 'unknown', message: 'pending follower must not dispatch directly' };
      },
    },
    metadata: {
      apply(_current, input) {
        return {
          kind: 'committed',
          sessionId: input.binding.sessionId,
          turnId: input.turn.messageKey,
        };
      },
    },
    clock: () => Date.parse('2026-08-10T00:00:01.000Z'),
    substituteReplyMode: 'thread',
  });
}

function submitOrdinary(
  runtime: SessionRuntime,
  address: SessionAddress,
  messageKey: string,
  content: string,
) {
  return runtime.submit({
    target: { kind: 'session', address },
    idempotencyKey: messageKey,
    command: {
      kind: 'ordinary.ingress',
      input: {
        turn: {
          route: {
            scope: 'thread',
            canonicalAnchor: ROOT,
            chatId: CHAT,
            chatType: 'group',
          },
          source: 'lark.im',
          messageKey,
          content,
          sender: { kind: 'human', openId: 'ou_follow_up' },
          mentions: [],
          postParticipantMentions: [],
          resources: [],
          foldedForwardContext: false,
          vc: { contextMayLag: false },
        },
      },
    },
  });
}

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pending-repo-completion-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  sessionStore.init(APP);
});

afterEach(() => {
  sessionStore.init();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Current pending-repo first-start completion', () => {
  it.each([
    ['top-level Proxy', () => ({
      selection: new Proxy({
        kind: 'directory' as const,
        path: '/repos/base',
        pinWorkingDir: true,
      }, {}),
      reads: () => 0,
    })],
    ['nested array Proxy', () => ({
      selection: {
        kind: 'worktree' as const,
        repositories: new Proxy([
          { sourcePath: '/repos/base', childName: 'base' },
        ], {}),
        layout: { kind: 'sibling' as const },
      },
      reads: () => 0,
    })],
    ['accessor-backed field', () => {
      let reads = 0;
      const selection = Object.defineProperty({
        kind: 'directory' as const,
        pinWorkingDir: true,
      }, 'path', {
        enumerable: true,
        get() {
          reads += 1;
          return '/repos/base';
        },
      });
      return { selection, reads: () => reads };
    }],
    ['extra authority field', () => ({
      selection: {
        kind: 'directory' as const,
        path: '/repos/base',
        pinWorkingDir: true,
        sessionId: 'must-not-cross-admission',
      },
      reads: () => 0,
    })],
    ['custom prototype', () => ({
      selection: Object.assign(Object.create({ authority: true }), {
        kind: 'directory' as const,
        path: '/repos/base',
        pinWorkingDir: true,
      }),
      reads: () => 0,
    })],
  ])('rejects a non-exact pending selection (%s) before claiming the Session', async (_label, makeCase) => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { selection, reads } = makeCase();
    const { ds, host, dispatchWorker } = createFixture(materialize);
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      `repo-setup/invalid-selection/${_label}`,
      selection as CurrentPendingRepoCompletionSelection,
    )).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'invalidCommand',
    });
    expect(reads()).toBe(0);
    expect(ds.pendingRepoCommitInFlight).not.toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatchWorker).not.toHaveBeenCalled();
  });

  it('fences a same-id Session replacement performed by synchronous pre-materialization', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    let replacement: DaemonSession['session'] | undefined;
    const preMaterialization: CurrentPendingRepoCompletionPreMaterializationModule = {
      apply(current) {
        replacement = structuredClone(current.session);
        replacement.title = 'same-id replacement from pre-materialization';
        current.session = replacement;
        return { kind: 'ready' };
      },
    };
    const { ds, host, dispatchWorker } = createFixture(materialize, { preMaterialization });
    const original = ds.session;
    const address = await addressFor(host, original.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/pre-materialization-session-replacement',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(ds.session).toBe(replacement);
    expect(ds.session).not.toBe(original);
    expect(ds.session.lastUserPrompt).toBeUndefined();
    expect(ds.session.lastCliInput).toBeUndefined();
    expect(ds.pendingRepoCommitInFlight).not.toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatchWorker).not.toHaveBeenCalled();
  });

  it('fences an unreadable Session replacement before touching any replacement field', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    let replacementReads = 0;
    const preMaterialization: CurrentPendingRepoCompletionPreMaterializationModule = {
      apply(current) {
        const replacement = new Proxy(structuredClone(current.session), {
          get() {
            replacementReads += 1;
            throw new Error('replacement Session must remain opaque');
          },
        });
        current.session = replacement;
        return { kind: 'ready' };
      },
    };
    const { ds, host, dispatchWorker } = createFixture(materialize, { preMaterialization });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/unreadable-pre-materialization-replacement',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(replacementReads).toBe(0);
    expect(ds.pendingRepoCommitInFlight).not.toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatchWorker).not.toHaveBeenCalled();
  });

  it('releases a pre-materialization failure before any Git or worker effect', async () => {
    let preparationCalls = 0;
    const preMaterialization: CurrentPendingRepoCompletionPreMaterializationModule = {
      apply() {
        preparationCalls += 1;
        if (preparationCalls === 1) throw new Error('whiteboard snapshot unavailable');
        return { kind: 'ready' };
      },
    };
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize, { preMaterialization });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/pre-materialization-refusal',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'retryable',
      message: expect.stringContaining('whiteboard snapshot unavailable'),
    });
    expect(ds.pendingRepoCommitInFlight).not.toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatchWorker).not.toHaveBeenCalled();

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/pre-materialization-refusal',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'applied' });
    expect(preparationCalls).toBe(2);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
  });

  it('does not release a newer exact claim installed during pre-materialization failure', async () => {
    const newerClaim = 'newer-pre-materialization-claim';
    const preMaterialization: CurrentPendingRepoCompletionPreMaterializationModule = {
      apply(current) {
        const claimOwner = current as DaemonSession & {
          pendingRepoCommitClaimToken?: string;
        };
        claimOwner.pendingRepoCommitInFlight = false;
        claimOwner.pendingRepoCommitClaimToken = undefined;
        claimOwner.pendingRepoCommitInFlight = true;
        claimOwner.pendingRepoCommitClaimToken = newerClaim;
        throw new Error('old pre-materialization failed after claim replacement');
      },
    };
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize, { preMaterialization });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/pre-materialization-claim-aba',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'retryable',
      message: expect.stringContaining('old pre-materialization failed'),
    });
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect((ds as DaemonSession & { pendingRepoCommitClaimToken?: string })
      .pendingRepoCommitClaimToken).toBe(newerClaim);
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatchWorker).not.toHaveBeenCalled();
  });

  it('releases an opening snapshot that cannot be detached before any external effect', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize);
    ds.pendingAttachments = [{
      type: 'file',
      path: '/tmp/spec.md',
      name: 'spec.md',
      poison: () => undefined,
    } as unknown as NonNullable<DaemonSession['pendingAttachments']>[number]];
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/undetachable-opening',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'retryable',
      message: expect.stringContaining('opening could not be detached'),
    });
    expect(ds.pendingRepoCommitInFlight).not.toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatchWorker).not.toHaveBeenCalled();

    ds.pendingAttachments = [{ type: 'file', path: '/tmp/spec.md', name: 'spec.md' }];
    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/undetachable-opening',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'applied' });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
  });

  it('joins card, text, and auto-worktree callers on one semantic key and commits once', async () => {
    const effect = deferred<CurrentPendingRepoCompletionMaterializeResult>();
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => effect.promise);
    const { host, dispatchWorker } = createFixture(materialize);
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);
    const selection = worktreeSelection();

    // Transport identity is deliberately absent from the command. These are
    // the three caller adapters submitting the same normalized completion.
    const fromCard = submitCompletion(host.runtime, address, 'repo-setup-token', selection);
    const fromText = submitCompletion(host.runtime, address, 'repo-setup-token', selection);
    const fromAutoWorktree = submitCompletion(host.runtime, address, 'repo-setup-token', selection);
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1));

    effect.resolve(materialized(materialFor(materialize.mock.calls[0]![0])));
    await expect(Promise.all([fromCard, fromText, fromAutoWorktree])).resolves.toEqual([
      expect.objectContaining({ kind: 'applied', action: 'pendingRepo.firstStartCommitted' }),
      expect.objectContaining({ kind: 'duplicate' }),
      expect.objectContaining({ kind: 'duplicate' }),
    ]);
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
  });

  it('returns conflict for a changed same-key selection and busy for a competing key without starting another effect', async () => {
    const effect = deferred<CurrentPendingRepoCompletionMaterializeResult>();
    let materializeInput: CurrentPendingRepoCompletionMaterializeInput | undefined;
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => {
      materializeInput = input;
      return effect.promise;
    });
    const { host, dispatchWorker } = createFixture(materialize);
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);
    const winner = submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection('feat/a'));
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1));

    await expect(submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection('feat/b')))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'idempotencyConflict' });
    await expect(submitCompletion(host.runtime, address, 'another-selection', worktreeSelection('feat/c')))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'selectionBusy' });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(dispatchWorker).not.toHaveBeenCalled();

    if (!materializeInput) throw new Error('expected materialize input');
    effect.resolve(materialized(materialFor(materializeInput)));
    await expect(winner).resolves.toMatchObject({ kind: 'applied' });
  });

  it('quarantines a foreign thenable materializer result instead of trusting its fabricated refusal', async () => {
    const foreignThenable = {
      kind: 'refused' as const,
      message: 'fabricated retryable refusal',
      then(resolve: (value: CurrentPendingRepoCompletionMaterializeResult) => void) {
        resolve({ kind: 'refused', message: 'fabricated retryable refusal' });
      },
    };
    const materialize = vi.fn(() => (
      foreignThenable as unknown as Promise<CurrentPendingRepoCompletionMaterializeResult>
    ));
    const { ds, host } = createFixture(materialize);
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/foreign-thenable',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('native Promise'),
    });
    expect(ds.pendingRepoCommitInFlight).toBe(true);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/foreign-thenable',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'ambiguous' });
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  it('quarantines an accessor-backed materializer result instead of invoking its fabricated refusal', async () => {
    let kindReads = 0;
    const hostile = Object.defineProperty(
      { message: 'accessor fabricated retryable refusal' },
      'kind',
      {
        enumerable: true,
        get() {
          kindReads += 1;
          return 'refused';
        },
      },
    );
    const materialize = vi.fn(async () => (
      hostile as unknown as CurrentPendingRepoCompletionMaterializeResult
    ));
    const { ds, host } = createFixture(materialize);
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/hostile-result',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('unreadable'),
    });
    expect(kindReads).toBe(0);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  it('releases the claim only for a typed materialization refusal', async () => {
    let calls = 0;
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => {
      calls += 1;
      if (calls === 1) {
        return {
          kind: 'refused' as const,
          message: 'worktree creation was proven not to start',
        };
      }
      return materialized(materialFor(input));
    });
    const { ds, host, dispatchWorker } = createFixture(materialize);
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/proven-refusal',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'retryable',
      message: 'worktree creation was proven not to start',
    });
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    expect(dispatchWorker).not.toHaveBeenCalled();

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/proven-refusal',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'applied' });
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
  });

  it('keeps a typed unknown materialization sticky and idempotent', async () => {
    const materialize = vi.fn(async () => ({
      kind: 'unknown' as const,
      message: 'worktree publication cannot be proven',
    }));
    const { ds, host, dispatchWorker } = createFixture(materialize);
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/typed-unknown',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      message: 'worktree publication cannot be proven',
    });
    expect(ds.pendingRepoCommitInFlight).toBe(true);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/typed-unknown',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'ambiguous' });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(dispatchWorker).not.toHaveBeenCalled();
  });

  it('runs repository materialization outside the lane without letting a later control pass it', async () => {
    const effect = deferred<CurrentPendingRepoCompletionMaterializeResult>();
    const seenMaterial = deferred<CurrentPendingRepoCompletionMaterializeInput>();
    const { host } = createFixture(async input => {
      seenMaterial.resolve(input);
      return effect.promise;
    });
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);
    const completion = submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection());
    const externalInput = await seenMaterial.promise;

    // The true external Adapter sees a detached description, never mutable
    // DaemonSession/Session/worker state.
    expect(externalInput).toEqual(expect.objectContaining({
      sessionId: expect.any(String),
      selection: worktreeSelection(),
      opening: expect.objectContaining({
        prompt: 'OPENING_N',
        turnId: 'om_opening_n',
        codexAppText: 'visible opening',
        codexAppApplicationContext: '<application-context/>',
        codexAppMessageContext: '<message-context/>',
        followUps: ['FOLLOW_UP_N_PLUS_1'],
        followUpTurnIds: ['om_follow_up_n_plus_1'],
      }),
    }));
    expect(externalInput).not.toHaveProperty('session');
    expect(externalInput).not.toHaveProperty('worker');
    expect(externalInput).not.toHaveProperty('pendingRepo');
    expect(Object.isFrozen(externalInput)).toBe(true);
    expect(Object.isFrozen(externalInput.opening)).toBe(true);
    expect(Object.isFrozen(externalInput.opening.followUps)).toBe(true);

    let renameSettled = false;
    const rename = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'rename-while-worktree-awaits',
      command: {
        kind: 'control.rename',
        input: {
          title: 'renamed while repository setup waits',
          updatedAt: '2026-08-10T00:00:00.000Z',
          source: 'user',
        },
      },
    }).then((result) => {
      renameSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(renameSettled).toBe(false);

    effect.resolve(materialized(materialFor(externalInput)));
    await completion;
    await expect(rename).resolves.toMatchObject({ kind: 'applied', action: 'control.renamed' });
  });

  it('preserves a public control rename ordered after refused-worktree cleanup', async () => {
    const cleanupStarted = deferred<void>();
    const cleanupResult = deferred<{ kind: 'cleaned' }>();
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized({
        ...materialFor(input),
        worktrees: [{ sourcePath: '/repos/base', path: '/repos/base-wt' }],
      })
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize, {
      cleanupWorktrees: async () => {
        cleanupStarted.resolve();
        return cleanupResult.promise;
      },
    });
    dispatchWorker.mockReturnValueOnce({
      kind: 'refused',
      message: 'worker synchronously refused the prepared worktree',
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = submitCompletion(
      host.runtime,
      address,
      'repo-setup/cleanup-preserves-rename',
      worktreeSelection(),
    );
    await cleanupStarted.promise;

    let renameSettled = false;
    const rename = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'rename-during-refused-worktree-cleanup',
      command: {
        kind: 'control.rename',
        input: {
          title: 'rename committed during cleanup',
          updatedAt: '2026-08-10T00:00:02.000Z',
          source: 'user',
        },
      },
    }).then((result) => {
      renameSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(renameSettled).toBe(false);
    expect(ds.session.title).not.toBe('rename committed during cleanup');

    cleanupResult.resolve({ kind: 'cleaned' });
    await expect(completion).resolves.toMatchObject({
      kind: 'retryable',
      message: 'worker synchronously refused the prepared worktree',
    });
    await expect(rename).resolves.toMatchObject({ kind: 'applied', action: 'control.renamed' });
    expect(ds.session.title).toBe('rename committed during cleanup');
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
  });

  it('preserves an ordinary durable tail admitted while refused-worktree cleanup awaits', async () => {
    const cleanupStarted = deferred<void>();
    const cleanupResult = deferred<{ kind: 'cleaned' }>();
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized({
        ...materialFor(input),
        worktrees: [{ sourcePath: '/repos/base', path: '/repos/base-wt' }],
      })
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize, {
      cleanupWorktrees: async () => {
        cleanupStarted.resolve();
        return cleanupResult.promise;
      },
      ordinaryIngressFactory: ordinaryIngressFor,
    });
    dispatchWorker.mockReturnValueOnce({
      kind: 'refused',
      message: 'worker synchronously refused the prepared worktree',
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = submitCompletion(
      host.runtime,
      address,
      'repo-setup/cleanup-preserves-tail',
      worktreeSelection(),
    );
    await cleanupStarted.promise;

    await expect(submitOrdinary(
      host.runtime,
      address,
      'om_tail_during_cleanup',
      'TAIL_DURING_CLEANUP',
    )).resolves.toMatchObject({ kind: 'applied', action: 'ordinary.inputCommitted' });
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        userPrompt: 'TAIL_DURING_CLEANUP',
        turnId: 'om_tail_during_cleanup',
        cliInput: { content: 'CLI:TAIL_DURING_CLEANUP' },
      }),
    ]);

    cleanupResult.resolve({ kind: 'cleaned' });
    await expect(completion).resolves.toMatchObject({ kind: 'retryable' });
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        userPrompt: 'TAIL_DURING_CLEANUP',
        turnId: 'om_tail_during_cleanup',
      }),
    ]);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
  });

  it('keeps the claim sticky and skips cleanup when immediate refusal rollback persistence is unknown', async () => {
    const cleanupWorktrees = vi.fn(async () => ({ kind: 'cleaned' as const }));
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized({
        ...materialFor(input),
        worktrees: [{ sourcePath: '/repos/base', path: '/repos/base-wt' }],
      })
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize, { cleanupWorktrees });
    dispatchWorker.mockReturnValueOnce({
      kind: 'refused',
      message: 'worker synchronously refused the prepared worktree',
    });
    const address = await addressFor(host, ds.session.sessionId);
    const persist = vi.spyOn(sessionStore, 'updateSession')
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('rollback persistence response lost');
      });

    try {
      await expect(submitCompletion(
        host.runtime,
        address,
        'repo-setup/rollback-persistence-unknown',
        worktreeSelection(),
      )).resolves.toMatchObject({
        kind: 'ambiguous',
        message: expect.stringContaining('rollback persistence response lost'),
      });
      expect(cleanupWorktrees).not.toHaveBeenCalled();
      expect(ds.pendingRepo).toBe(true);
      expect(ds.pendingRepoCommitInFlight).toBe(true);
    } finally {
      persist.mockRestore();
    }
  });

  it('keeps cleanup response loss ambiguous when a same-object owner takes over during cleanup', async () => {
    const cleanupStarted = deferred<void>();
    const cleanupResult = deferred<{ kind: 'cleaned' }>();
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized({
        ...materialFor(input),
        worktrees: [{ sourcePath: '/repos/base', path: '/repos/base-wt' }],
      })
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize, {
      cleanupWorktrees: async () => {
        cleanupStarted.resolve();
        return cleanupResult.promise;
      },
    });
    dispatchWorker.mockReturnValueOnce({
      kind: 'refused',
      message: 'worker synchronously refused the prepared worktree',
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = submitCompletion(
      host.runtime,
      address,
      'repo-setup/cleanup-response-loss-after-takeover',
      worktreeSelection(),
    );
    await cleanupStarted.promise;

    ds.pendingRepo = false;
    ds.worker = { killed: false } as DaemonSession['worker'];
    ds.pendingRepoCommitInFlight = true;
    cleanupResult.reject(new Error('cleanup response lost after partial removal'));

    await expect(completion).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('cleanup response lost after partial removal'),
    });
    expect(ds.worker?.killed).toBe(false);
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
  });

  it('does not settle an old cleaned refusal onto a newer exact claim', async () => {
    const cleanupStarted = deferred<void>();
    const cleanupResult = deferred<{ kind: 'cleaned' }>();
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized({
        ...materialFor(input),
        worktrees: [{ sourcePath: '/repos/base', path: '/repos/base-wt' }],
      })
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize, {
      cleanupWorktrees: async () => {
        cleanupStarted.resolve();
        return cleanupResult.promise;
      },
    });
    dispatchWorker.mockReturnValueOnce({
      kind: 'refused',
      message: 'old worker refusal',
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = submitCompletion(
      host.runtime,
      address,
      'repo-setup/cleanup-claim-aba',
      worktreeSelection(),
    );
    await cleanupStarted.promise;

    const newerClaim = 'newer-cleanup-claim';
    ds.pendingRepoCommitInFlight = false;
    ds.pendingRepoCommitClaimToken = undefined;
    ds.pendingRepoCommitInFlight = true;
    ds.pendingRepoCommitClaimToken = newerClaim;
    cleanupResult.resolve({ kind: 'cleaned' });

    await expect(completion).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('owner changed during worktree cleanup'),
    });
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.pendingRepoCommitClaimToken).toBe(newerClaim);
  });

  it('cleans exact returned worktrees when ownership is lost after materialization resolves', async () => {
    let takeOver = (): void => undefined;
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => {
      const result = materialized({
        ...materialFor(input),
        worktrees: [
          { sourcePath: '/repos/alpha', path: '/repos/alpha-wt' },
          { sourcePath: '/repos/beta', path: '/repos/beta-wt' },
        ],
      });
      queueMicrotask(() => takeOver());
      return result;
    });
    const cleanupWorktrees = vi.fn(async () => ({ kind: 'cleaned' as const }));
    const { ds, dispatchWorker, host } = createFixture(materialize, { cleanupWorktrees });
    takeOver = () => {
      ds.pendingRepo = false;
      ds.worker = { killed: false } as DaemonSession['worker'];
    };
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/owner-loss-after-materialize-resolve',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(cleanupWorktrees).toHaveBeenCalledOnce();
    expect(cleanupWorktrees).toHaveBeenCalledWith({
      sessionId: ds.session.sessionId,
      claimToken: materialize.mock.calls[0]![0].claimToken,
      worktrees: [
        { sourcePath: '/repos/alpha', path: '/repos/alpha-wt' },
        { sourcePath: '/repos/beta', path: '/repos/beta-wt' },
      ],
    });
    expect(dispatchWorker).not.toHaveBeenCalled();
  });

  it('does not start external materialization after the exact owner is replaced between begin and execute', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { ds, activeSessions, dispatchWorker, host } = createFixture(materialize);
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);

    const completion = submitCompletion(
      host.runtime,
      address,
      'repo-setup/replaced-before-effect',
      worktreeSelection(),
    );

    const replacement = pendingSession();
    replacement.session.sessionId = ds.session.sessionId;
    replacement.session.title = 'same-id replacement must not receive old I/O';
    activeSessions.set(activeSessionKey(ds), replacement);

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatchWorker).not.toHaveBeenCalled();
    expect(replacement.pendingRepoCommitInFlight).toBeUndefined();
  });

  it('fences a late external result from a closed or replacement Session owner', async () => {
    const effect = deferred<CurrentPendingRepoCompletionMaterializeResult>();
    const seenMaterial = deferred<CurrentPendingRepoCompletionMaterializeInput>();
    const { ds, activeSessions, dispatchWorker, host } = createFixture(async input => {
      seenMaterial.resolve(input);
      return effect.promise;
    });
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);
    const completion = submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection());
    const externalInput = await seenMaterial.promise;

    const replacement = pendingSession();
    replacement.session.sessionId = 'replacement-session';
    replacement.session.title = 'replacement must survive';
    replacement.pendingRepo = false;
    replacement.worker = { killed: false } as DaemonSession['worker'];
    replacement.workingDir = '/repos/replacement';
    replacement.session.workingDir = '/repos/replacement';
    ds.session.status = 'closed';
    activeSessions.set(activeSessionKey(ds), replacement);

    effect.resolve(materialized(materialFor(externalInput)));
    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(dispatchWorker).not.toHaveBeenCalled();
    expect(replacement.session).toMatchObject({
      sessionId: 'replacement-session',
      status: 'active',
      workingDir: '/repos/replacement',
    });
    expect(replacement.worker?.killed).toBe(false);
  });

  it('does not clear a same-object takeover claim when the old materialization returns late', async () => {
    const effect = deferred<CurrentPendingRepoCompletionMaterializeResult>();
    const seenMaterial = deferred<CurrentPendingRepoCompletionMaterializeInput>();
    const { ds, dispatchWorker, host } = createFixture(async input => {
      seenMaterial.resolve(input);
      return effect.promise;
    });
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);
    const completion = submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection());
    const externalInput = await seenMaterial.promise;

    // A takeover can reuse the same DaemonSession shell while installing its
    // own live worker/claim. The stale continuation may observe but not clear it.
    ds.pendingRepo = false;
    ds.worker = { killed: false } as DaemonSession['worker'];
    ds.pendingRepoCommitInFlight = true;
    effect.resolve(materialized(materialFor(externalInput)));

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(dispatchWorker).not.toHaveBeenCalled();
    expect(ds.worker?.killed).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
  });

  it('does not settle a typed materialization refusal onto a newer exact claim', async () => {
    const effect = deferred<CurrentPendingRepoCompletionMaterializeResult>();
    const seenMaterial = deferred<CurrentPendingRepoCompletionMaterializeInput>();
    const { ds, dispatchWorker, host } = createFixture(async input => {
      seenMaterial.resolve(input);
      return effect.promise;
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = submitCompletion(
      host.runtime,
      address,
      'repo-setup/materialization-claim-aba',
      worktreeSelection(),
    );
    await seenMaterial.promise;

    const newerClaim = 'newer-materialization-claim';
    ds.pendingRepoCommitInFlight = false;
    ds.pendingRepoCommitClaimToken = undefined;
    ds.pendingRepoCommitInFlight = true;
    ds.pendingRepoCommitClaimToken = newerClaim;
    effect.resolve({ kind: 'refused', message: 'old materialization refused' });

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.pendingRepoCommitClaimToken).toBe(newerClaim);
    expect(dispatchWorker).not.toHaveBeenCalled();
  });

  it('does not clear a same-object takeover claim when the old materialization fails late', async () => {
    const effect = deferred<CurrentPendingRepoCompletionMaterializeResult>();
    const seenMaterial = deferred<CurrentPendingRepoCompletionMaterializeInput>();
    const { ds, dispatchWorker, host } = createFixture(async input => {
      seenMaterial.resolve(input);
      return effect.promise;
    });
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);
    const completion = submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection());
    await seenMaterial.promise;

    ds.pendingRepo = false;
    ds.worker = { killed: false } as DaemonSession['worker'];
    ds.pendingRepoCommitInFlight = true;
    effect.reject(new Error('late worktree failure'));

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(dispatchWorker).not.toHaveBeenCalled();
    expect(ds.worker?.killed).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
  });

  it('commits one first-start fork, clears only folded runtime buffers, and leaves no mid-session fallback', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize);
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);

    await expect(submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection()))
      .resolves.toMatchObject({
        kind: 'applied',
        action: 'pendingRepo.firstStartCommitted',
        sessionId: ds.session.sessionId,
      });

    expect(dispatchWorker).toHaveBeenCalledTimes(1);
    expect(dispatchWorker).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'forkFirstStart',
      sessionId: ds.session.sessionId,
      claimToken: materialize.mock.calls[0]![0].claimToken,
      workingDir: '/repos/base/.worktrees/feat-runtime',
      input: { content: '<new-topic>OPENING_N\n\nFOLLOW_UP_N_PLUS_1</new-topic>' },
      turnId: 'om_opening_n',
      resume: false,
    }));
    expect(ds).toMatchObject({
      pendingRepo: false,
      workingDir: '/repos/base/.worktrees/feat-runtime',
    });
    expect(ds.pendingRepoCommitInFlight).not.toBe(true);
    expect(ds.repoCardMessageId).toBeUndefined();
    expect(ds.pendingPrompt).toBeUndefined();
    expect(ds.pendingTurnId).toBeUndefined();
    expect(ds.pendingCodexAppText).toBeUndefined();
    expect(ds.pendingCodexAppApplicationContext).toBeUndefined();
    expect(ds.pendingCodexAppMessageContext).toBeUndefined();
    expect(ds.pendingChatContext).toBeUndefined();
    expect(ds.pendingAttachments).toBeUndefined();
    expect(ds.pendingMentions).toBeUndefined();
    expect(ds.pendingSubstituteTrigger).toBeUndefined();
    expect(ds.pendingSender).toBeUndefined();
    expect(ds.pendingFollowUps).toBeUndefined();
    expect(ds.pendingFollowUpTurnId).toBeUndefined();
    expect(ds.pendingFollowUpTurnIds).toBeUndefined();
    expect(ds.pendingCodexAppFollowUps).toBeUndefined();
    expect(ds.pendingCodexAppFollowUpContexts).toBeUndefined();
    expect(ds.pendingCodexAppFollowUpGateAccepted).toBeUndefined();
    expect(ds.session).toMatchObject({
      status: 'active',
      workingDir: '/repos/base/.worktrees/feat-runtime',
      pendingRepoSetup: expect.objectContaining({
        turnId: 'om_opening_n',
        repoCardMessageId: 'om_picker',
      }),
    });

    await expect(submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection()))
      .resolves.toMatchObject({ kind: 'duplicate', state: 'committed' });
    expect(dispatchWorker).toHaveBeenCalledTimes(1);

    // The Session is no longer a first-start placeholder. Reusing this seam
    // may reject, but must never close/refork it as a C2 repository switch.
    await expect(submitCompletion(host.runtime, address, 'another-selection', {
      kind: 'directory',
      path: '/repos/other',
      pinWorkingDir: true,
    })).resolves.toMatchObject({ kind: 'rejected', reason: 'notPendingRepo' });
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
    expect(ds.session.status).toBe('active');
  });

  it('accepts the live worker installed by a successful synchronous first-start dispatch', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize);
    dispatchWorker.mockImplementationOnce(() => {
      ds.worker = { killed: false } as DaemonSession['worker'];
      return { kind: 'accepted' };
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/live-worker-install',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });
    expect(ds.worker?.killed).toBe(false);
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown worker acceptance sticky and never retries the same first-start fork', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize);
    dispatchWorker.mockImplementationOnce(() => {
      throw new Error('worker response lost after acceptance');
    });
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);

    await expect(submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection()))
      .resolves.toMatchObject({
        kind: 'ambiguous',
        message: expect.stringContaining('worker response lost after acceptance'),
      });
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.workingDir).toBe('/repos/base/.worktrees/feat-runtime');

    await expect(submitCompletion(host.runtime, address, 'repo-setup-token', worktreeSelection()))
      .resolves.toMatchObject({ kind: 'ambiguous' });
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
  });

  it('rechecks the exact Session after the worker Adapter returns accepted', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input))
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize);
    const originalSession = ds.session;
    let replacementSession: typeof ds.session | undefined;
    dispatchWorker.mockImplementationOnce(() => {
      replacementSession = structuredClone(ds.session);
      replacementSession.title = 'same-id replacement from worker Adapter';
      delete replacementSession.lastUserPrompt;
      delete replacementSession.lastCliInput;
      delete replacementSession.lastCliTurnPayload;
      ds.session = replacementSession;
      return { kind: 'accepted' };
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/adapter-session-replacement',
      worktreeSelection(),
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('Session identity changed'),
    });
    expect(ds.session).toBe(replacementSession);
    expect(ds.session).not.toBe(originalSession);
    expect(ds.session.sessionId).toBe(originalSession.sessionId);
    expect(ds.session.lastUserPrompt).toBeUndefined();
    expect(ds.session.lastCliInput).toBeUndefined();
    expect(ds.session.lastCliTurnPayload).toBeUndefined();
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.pendingPrompt).toBe('OPENING_N');

    await expect(submitCompletion(
      host.runtime,
      address,
      'repo-setup/adapter-session-replacement',
      worktreeSelection(),
    )).resolves.toMatchObject({ kind: 'ambiguous' });
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
  });

  it('starts directly in a resolved default directory without pinning it onto the Session', async () => {
    const materialize = vi.fn(async (input: CurrentPendingRepoCompletionMaterializeInput) => (
      materialized(materialFor(input, '/repos/default'))
    ));
    const { ds, host, dispatchWorker } = createFixture(materialize);
    const projected = await host.projection.read({ kind: 'list' });
    if (projected.kind !== 'list') throw new Error('expected Session list');
    const address = await addressFor(host, projected.sessions[0]!.sessionId);

    await expect(submitCompletion(host.runtime, address, 'repo-setup-token', {
      kind: 'directory',
      path: '/repos/default',
      pinWorkingDir: false,
    })).resolves.toMatchObject({ kind: 'applied' });

    expect(ds.workingDir).toBeUndefined();
    expect(ds.session.workingDir).toBeUndefined();
    expect(dispatchWorker).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'forkFirstStart',
      workingDir: '/repos/default',
    }));
  });
});
