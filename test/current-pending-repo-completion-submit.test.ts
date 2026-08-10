import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBot } from '../src/bot-registry.js';
import {
  createCurrentOrdinaryIngressProductionPort,
  type CurrentOrdinaryIngressProductionExternalEffect,
} from '../src/core/current-ordinary-ingress-production.js';
import {
  currentPendingRepoCompletionPort,
  submitCurrentPendingRepoCompletion,
} from '../src/core/current-pending-repo-completion-submit.js';
import { currentSessionRuntimeHost } from '../src/core/current-session-runtime.js';
import type { OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';
import { stagePendingRepoSetup } from '../src/core/pending-repo-journal.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as gitWorktree from '../src/services/git-worktree.js';
import * as sessionStore from '../src/services/session-store.js';
import type { CliTurnPayload } from '../src/types.js';

const APP = 'local_pending_repo_submit';
const CHAT = 'oc_pending_repo_submit';
const ROOT = 'om_pending_repo_submit';

function pendingSession(): DaemonSession {
  const session = sessionStore.createSession(CHAT, ROOT, 'pending caller cut', 'group', 'thread');
  Object.assign(session, { larkAppId: APP, cliId: 'codex-app' });
  const ds = {
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
    pendingPrompt: 'exact first turn',
    pendingTurnId: 'om_semantic_opening',
  } as DaemonSession;
  stagePendingRepoSetup(ds, {
    mode: 'picker',
    turnId: 'om_semantic_opening',
    cliInput: {
      content: '<exact>first turn</exact>',
      codexAppInput: {
        text: 'first turn',
        clientUserMessageId: 'om_semantic_opening',
      },
      codexAppSteerable: true,
    },
  });
  return ds;
}

function ordinaryTurn(messageKey: string): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: ROOT,
      chatId: CHAT,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey,
    content: `ordinary:${messageKey}`,
    sender: { kind: 'human', openId: 'ou_pending_submit' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function ordinaryIngressFor(
  activeSessions: Map<string, DaemonSession>,
) {
  return createCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: APP,
    activeSessions,
    metadata: {
      apply(_current, input) {
        return {
          kind: 'committed',
          sessionId: input.binding.sessionId,
          turnId: input.turn.messageKey,
        };
      },
    },
    clock: () => Date.parse('2026-08-10T00:00:00.000Z'),
    substituteReplyMode: 'thread',
    externalEffects: {
      async execute(effect: CurrentOrdinaryIngressProductionExternalEffect) {
        if (effect.kind !== 'materialize') return { kind: 'completed' as const };
        return {
          kind: 'materialized' as const,
          material: {
            userPrompt: effect.input.turn.content,
            newTopicUserPrompt: effect.input.turn.content,
            cliInput: { content: `cli:${effect.input.turn.messageKey}` },
            newTopicCliInput: { content: `new-topic:${effect.input.turn.messageKey}` },
            adoptCliInput: { content: `adopt:${effect.input.turn.messageKey}` },
            turnId: effect.input.turn.messageKey,
          },
        };
      },
    },
    workerProcesses: {
      dispatch: () => ({ kind: 'accepted' }),
    },
  });
}

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pending-repo-submit-'));
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
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStore.init();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Current pending-repo completion submit helper', () => {
  it('joins card, text, and auto-worktree callers on the durable opening identity', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const fork = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const input = {
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'directory' as const,
        path: '/repos/exact',
        pinWorkingDir: true,
      },
    };

    const card = submitCurrentPendingRepoCompletion(input);
    const text = submitCurrentPendingRepoCompletion(input);
    const autoWorktree = submitCurrentPendingRepoCompletion(input);

    await expect(Promise.all([card, text, autoWorktree])).resolves.toEqual([
      expect.objectContaining({ kind: 'applied', action: 'pendingRepo.firstStartCommitted' }),
      expect.objectContaining({ kind: 'duplicate' }),
      expect.objectContaining({ kind: 'duplicate' }),
    ]);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({
        content: '<exact>first turn</exact>',
        codexAppSteerable: true,
      }),
      { turnId: 'om_semantic_opening' },
    );
  });

  it('rejects an old caller capability after a same-sessionId replacement without touching the replacement', async () => {
    const oldDs = pendingSession();
    const replacement = pendingSession();
    replacement.session.sessionId = oldDs.session.sessionId;
    replacement.pendingPrompt = 'replacement opening must remain exact';
    replacement.session.pendingRepoSetup = {
      mode: 'picker',
      turnId: 'om_replacement_opening',
      cliInput: { content: '<exact>replacement opening</exact>' },
    };
    const activeSessions = new Map([[activeSessionKey(replacement), replacement]]);
    const fork = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const capturedSession = oldDs.session;

    const outcome = await submitCurrentPendingRepoCompletion({
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: oldDs.session.sessionId,
      daemonSession: oldDs,
      selection: {
        kind: 'directory',
        path: '/repos/stale-card-selection',
        pinWorkingDir: true,
      },
    });

    expect(outcome).toEqual({ kind: 'staleAddress' });
    expect(fork).not.toHaveBeenCalled();
    expect(oldDs.session).toBe(capturedSession);
    expect(replacement).toMatchObject({
      pendingRepo: true,
      pendingPrompt: 'replacement opening must remain exact',
      worker: null,
    });
    expect(replacement.workingDir).toBeUndefined();
    expect(replacement.session.workingDir).toBeUndefined();
  });

  it('durably tails an ordinary turn while a public pending completion owns the opening', async () => {
    const ds = pendingSession();
    ds.session.cliId = 'claude-code';
    ds.pendingPrompt = '';
    delete ds.pendingTurnId;
    delete ds.session.pendingRepoSetup;
    ds.session.initialUserTurnPending = true;
    sessionStore.updateSession(ds.session);
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
    const createWorktree = vi.spyOn(gitWorktree, 'createRepoWorktree')
      .mockImplementation(async () => {
        await createGate;
        return {
          path: '/repos/source-wt-race',
          branch: 'feat/opening-owner-race',
          baseRef: 'origin/main',
        };
      });
    const fork = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);

    const ownerBootId = workerPool.getDaemonBootId();
    const pendingRepoCompletion = currentPendingRepoCompletionPort({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId,
    });
    const ordinaryIngress = ordinaryIngressFor(activeSessions);
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId,
      keyedTriggerAdmissionBlocked: () => false,
      ordinaryIngress,
      pendingRepoCompletion,
    });
    const projected = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: ds.session.sessionId,
    });
    if (projected.kind !== 'one') throw new Error('expected pending Session projection');

    const completion = submitCurrentPendingRepoCompletion({
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'worktree',
        repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
        branch: 'feat/opening-owner-race',
        layout: { kind: 'sibling' },
      },
    });
    await vi.waitFor(() => {
      expect(createWorktree).toHaveBeenCalledTimes(1);
      expect(ds.pendingRepoCommitInFlight).toBe(true);
    });

    const follower = ordinaryTurn('om_later_ordinary_n');
    await expect(host.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: follower.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: follower } },
    })).resolves.toMatchObject({ kind: 'applied', action: 'ordinary.inputCommitted' });

    expect(ds.session.pendingRepoSetup).toBeUndefined();
    expect(ds.pendingPrompt).toBe('');
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        userPrompt: follower.content,
        cliInput: { content: `new-topic:${follower.messageKey}` },
        turnId: follower.messageKey,
      }),
    ]);

    releaseCreate();
    await expect(completion).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationInput).toEqual({
      content: `new-topic:${follower.messageKey}`,
    });
    expect(ds.session.queuedActivationTurnId).toBe(follower.messageKey);
    expect(ds.session.queuedActivationToken).toEqual(expect.any(String));
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.session.initialUserTurnPending).toBeUndefined();
    expect(ds.session.lastUserPrompt).toBe(follower.content);
    expect(ds.session.lastCliInput).toBe(`new-topic:${follower.messageKey}`);
    expect(fork).toHaveBeenCalledWith(
      ds,
      { content: `new-topic:${follower.messageKey}` },
      {
        resume: false,
        turnId: follower.messageKey,
        dispatchAttempt: undefined,
      },
    );
  });

  it('fails closed without forking when late-tail promotion persistence loses its response', async () => {
    const ds = pendingSession();
    ds.session.cliId = 'claude-code';
    ds.pendingPrompt = '';
    delete ds.pendingTurnId;
    delete ds.session.pendingRepoSetup;
    const tailTurnId = 'om_tail_promotion_publish_loss';
    ds.session.queuedActivationTail = [{
      id: 'tail-promotion-publish-loss',
      order: 1,
      userPrompt: 'TAIL_PROMOTION_PUBLISH_LOSS',
      cliInput: { content: 'new-topic:om_tail_promotion_publish_loss' },
      turnId: tailTurnId,
    }];
    ds.session.queuedActivationTailNextOrder = 1;
    sessionStore.updateSession(ds.session);
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const fork = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const pendingRepoCompletion = currentPendingRepoCompletionPort({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: workerPool.getDaemonBootId(),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: workerPool.getDaemonBootId(),
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const projected = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: ds.session.sessionId,
    });
    if (projected.kind !== 'one') throw new Error('expected pending Session projection');
    const persist = sessionStore.updateSession;
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(session => {
      persist(session);
      if (session.sessionId === ds.session.sessionId
        && session.queuedActivationTurnId === tailTurnId) {
        throw new Error('tail promotion persistence response lost');
      }
    });

    await expect(submitCurrentPendingRepoCompletion({
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'directory',
        path: '/repos/promotion-publish-loss',
        pinWorkingDir: true,
      },
    })).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('promotion'),
    });

    expect(fork).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationTurnId).toBe(tailTurnId);
    expect(ds.session.queuedActivationToken).toEqual(expect.any(String));
    expect(ds.session.queuedActivationTail).toBeUndefined();
    expect(ds.quarantinedActivationTailPromotion).toBe(true);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)).toMatchObject({
      queuedActivationPending: true,
      queuedActivationTurnId: tailTurnId,
    });
  });

  it('keeps a sidecar-only exact opening ahead of an already durable successor tail', async () => {
    const ds = pendingSession();
    const sidecarOpening: CliTurnPayload = {
      content: '',
      codexAppInput: {
        text: 'SIDE_CAR_ONLY_OPENING',
        clientUserMessageId: 'om_sidecar_only_opening',
      },
    };
    ds.pendingPrompt = '';
    ds.pendingTurnId = 'om_sidecar_only_opening';
    ds.session.pendingRepoSetup = {
      mode: 'picker',
      prompt: '',
      turnId: 'om_sidecar_only_opening',
      cliInput: structuredClone(sidecarOpening),
    };
    ds.session.queuedActivationTail = [{
      id: 'sidecar-successor-tail',
      order: 1,
      userPrompt: 'SIDE_CAR_SUCCESSOR',
      cliInput: { content: 'new-topic:sidecar-successor' },
      turnId: 'om_sidecar_successor',
    }];
    ds.session.queuedActivationTailNextOrder = 1;
    sessionStore.updateSession(ds.session);
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const fork = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const recoverTail = vi.spyOn(workerPool, 'prepareQueuedActivationRecoveryFork');

    await expect(submitCurrentPendingRepoCompletion({
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'directory',
        path: '/repos/sidecar-opening',
        pinWorkingDir: true,
      },
    })).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });

    expect(recoverTail).not.toHaveBeenCalled();
    expect(fork).toHaveBeenCalledWith(ds, sidecarOpening, {
      turnId: 'om_sidecar_only_opening',
    });
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({ turnId: 'om_sidecar_successor' }),
    ]);
    expect(ds.session.lastCodexAppInput?.text).toBe('SIDE_CAR_ONLY_OPENING');
  });

  it('keeps FIFO tail ownership through typed refusal and promotes the oldest turn on retry', async () => {
    const ds = pendingSession();
    ds.pendingPrompt = '';
    delete ds.pendingTurnId;
    delete ds.session.pendingRepoSetup;
    ds.session.initialUserTurnPending = true;
    sessionStore.updateSession(ds.session);
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
    vi.spyOn(gitWorktree, 'createRepoWorktree').mockImplementation(async () => {
      await createGate;
      return {
        path: '/repos/source-wt-refused-race',
        branch: 'feat/refused-opening-owner-race',
        baseRef: 'origin/main',
      };
    });
    const removeWorktree = vi.spyOn(gitWorktree, 'removeRepoWorktree')
      .mockResolvedValue(undefined);
    const fork = vi.spyOn(workerPool, 'forkWorker')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const ownerBootId = workerPool.getDaemonBootId();
    const pendingRepoCompletion = currentPendingRepoCompletionPort({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId,
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId,
      keyedTriggerAdmissionBlocked: () => false,
      ordinaryIngress: ordinaryIngressFor(activeSessions),
      pendingRepoCompletion,
    });
    const projected = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: ds.session.sessionId,
    });
    if (projected.kind !== 'one') throw new Error('expected pending Session projection');

    const firstCompletion = submitCurrentPendingRepoCompletion({
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'worktree',
        repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
        branch: 'feat/refused-opening-owner-race',
        layout: { kind: 'sibling' },
      },
    });
    await vi.waitFor(() => expect(ds.pendingRepoCommitInFlight).toBe(true));

    const oldest = ordinaryTurn('om_oldest_tail_after_refusal');
    await expect(host.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: oldest.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: oldest } },
    })).resolves.toMatchObject({ kind: 'applied', action: 'ordinary.inputCommitted' });

    releaseCreate();
    await expect(firstCompletion).resolves.toMatchObject({ kind: 'retryable' });
    expect(removeWorktree).toHaveBeenCalledWith(
      '/repos/source',
      '/repos/source-wt-refused-race',
    );
    expect(ds.session.queuedActivationPending).toBeUndefined();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        userPrompt: oldest.content,
        cliInput: { content: `new-topic:${oldest.messageKey}` },
        turnId: oldest.messageKey,
      }),
    ]);

    const successor = ordinaryTurn('om_successor_tail_after_refusal');
    await expect(host.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: successor.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: successor } },
    })).resolves.toMatchObject({ kind: 'applied', action: 'ordinary.inputCommitted' });
    expect(ds.session.pendingRepoSetup).toBeUndefined();
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({ turnId: oldest.messageKey }),
      expect.objectContaining({ turnId: successor.messageKey }),
    ]);

    await expect(submitCurrentPendingRepoCompletion({
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'directory',
        path: '/repos/default-after-refusal',
        pinWorkingDir: true,
      },
    })).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });

    expect(ds.session.queuedActivationPending).toBe(true);
    expect(ds.session.queuedActivationTurnId).toBe(oldest.messageKey);
    expect(ds.session.queuedActivationInput).toEqual({
      content: `new-topic:${oldest.messageKey}`,
    });
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({
        userPrompt: successor.content,
        cliInput: { content: `cli:${successor.messageKey}` },
        turnId: successor.messageKey,
      }),
    ]);
    expect(ds.session.initialUserTurnPending).toBeUndefined();
    expect(fork).toHaveBeenCalledTimes(2);
    expect(fork).toHaveBeenNthCalledWith(2, ds, '', {
      resume: false,
      turnId: oldest.messageKey,
      dispatchAttempt: undefined,
    });
    expect(ds.session.lastUserPrompt).toBe(oldest.content);
    expect(ds.session.lastCliInput).toBe(`new-topic:${oldest.messageKey}`);
  });
});
