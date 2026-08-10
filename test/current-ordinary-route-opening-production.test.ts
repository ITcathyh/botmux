import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCurrentOrdinaryIngressProductionPort,
  type CurrentOrdinaryIngressProductionExternalEffect,
  type CurrentOrdinaryIngressProductionExternalEffectResult,
  type CurrentOrdinaryIngressWorkerProcessCommand,
} from '../src/core/current-ordinary-ingress-production.js';
import {
  createCurrentOrdinaryRouteOpeningProduction,
  type CurrentOrdinaryRouteOpeningPolicyFacts,
  type CurrentOrdinaryRouteOpeningPostCommitEffect,
} from '../src/core/current-ordinary-route-opening-production.js';
import { createCurrentOrdinaryRouteRegistryRuntime } from '../src/core/current-ordinary-route-registry.js';
import { currentSessionRuntimeHost } from '../src/core/current-session-runtime.js';
import type { OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import * as sessionStore from '../src/services/session-store.js';

const OWNER = 'app-current-route-opening-production';
const ANCHOR = 'om_route_opening_root';
const CHAT_ID = 'oc_route_opening_chat';

let dataDir: string;
let previousDataDir: string | undefined;
let epoch = 0;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function turn(
  messageKey = 'om_route_opening_first',
  content = 'open the production Session',
): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: ANCHOR,
      chatId: CHAT_ID,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey,
    content,
    sender: {
      kind: 'human',
      openId: 'ou_route_opening_sender',
      unionId: 'on_route_opening_sender',
    },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function pinnedPolicy(): CurrentOrdinaryRouteOpeningPolicyFacts {
  return {
    repository: { kind: 'pinned', workingDir: '/repos/pinned-production' },
    ownership: {
      ownerOpenId: 'ou_route_opening_owner',
      ownerUnionId: 'on_route_opening_owner',
      creatorOpenId: 'ou_route_opening_sender',
    },
    title: {
      sessionTitle: 'Pinned production opening',
      nativeSessionTitle: 'Native pinned production opening',
      chatDisplayName: 'Production route chat',
    },
    cli: {
      cliId: 'codex',
      cliRuntime: {
        id: 'codex-enterprise',
        displayName: 'Codex Enterprise',
        executable: '/opt/botmux/codex',
        source: 'configured',
        update: { provider: 'auto' },
      },
      cliPathOverride: '/opt/botmux/codex',
      wrapperCli: 'sandbox-wrapper codex',
      model: 'gpt-5.6',
      reasoningEffort: 'high',
      cliVersion: '0.99.0-test',
    },
  };
}

function pickerPolicy(): CurrentOrdinaryRouteOpeningPolicyFacts {
  return {
    ...pinnedPolicy(),
    repository: { kind: 'picker' },
    title: {
      sessionTitle: 'Picker production opening',
      nativeSessionTitle: 'Native picker production opening',
    },
  };
}

function autoWorktreePolicy(): CurrentOrdinaryRouteOpeningPolicyFacts {
  return {
    ...pinnedPolicy(),
    repository: { kind: 'autoWorktree', baseDir: '/repos/auto-worktree-base' },
    title: {
      sessionTitle: 'Auto-worktree production opening',
      nativeSessionTitle: 'Native auto-worktree production opening',
    },
  };
}

function materialFor(effect: CurrentOrdinaryIngressProductionExternalEffect) {
  return {
    userPrompt: effect.input.turn.content,
    newTopicUserPrompt: `opening:${effect.input.turn.content}`,
    cliInput: { content: `follow-up:${effect.input.turn.messageKey}` },
    newTopicCliInput: { content: `opening:${effect.input.turn.messageKey}` },
    adoptCliInput: { content: `adopt:${effect.input.turn.messageKey}` },
    turnId: effect.input.turn.messageKey,
  };
}

function createHarness(
  resolveFacts: (messageKey: string) => CurrentOrdinaryRouteOpeningPolicyFacts,
  options: {
    materialize?: (
      effect: CurrentOrdinaryIngressProductionExternalEffect,
      attempt: number,
    ) => Promise<CurrentOrdinaryIngressProductionExternalEffectResult>
      | CurrentOrdinaryIngressProductionExternalEffectResult;
    onWorkerCommand?: (
      command: CurrentOrdinaryIngressWorkerProcessCommand,
      activeSessions: Map<string, DaemonSession>,
    ) => void;
  } = {},
) {
  const activeSessions = new Map<string, DaemonSession>();
  const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
  const postCommitEffects: CurrentOrdinaryRouteOpeningPostCommitEffect[] = [];
  const policyTurns: string[] = [];
  let materializationAttempt = 0;
  const ordinaryIngress = createCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: OWNER,
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
    clock: () => Date.parse('2026-08-10T01:00:00.000Z'),
    substituteReplyMode: 'thread',
    externalEffects: {
      async execute(effect) {
        materializationAttempt += 1;
        if (options.materialize) {
          return await options.materialize(effect, materializationAttempt);
        }
        return { kind: 'materialized', material: materialFor(effect) };
      },
    },
    workerProcesses: {
      dispatch(command) {
        workerCommands.push(command);
        options.onWorkerCommand?.(command, activeSessions);
        return { kind: 'accepted' };
      },
    },
  });
  const openingCreator = createCurrentOrdinaryRouteOpeningProduction({
    ownerLarkAppId: OWNER,
    activeSessions,
    policyEffects: {
      async execute(effect) {
        policyTurns.push(effect.turn.messageKey);
        return { kind: 'resolved', facts: resolveFacts(effect.turn.messageKey) };
      },
    },
    postCommitEffects: {
      dispatch(effect) {
        postCommitEffects.push(effect);
        return { kind: 'accepted' };
      },
    },
  });
  const currentEpoch = epoch++;
  const host = currentSessionRuntimeHost({
    ownerLarkAppId: OWNER,
    activeSessions,
    ownerBootId: `boot-route-opening-${currentEpoch}`,
    runtimeEpoch: `epoch-route-opening-${currentEpoch}`,
    keyedTriggerAdmissionBlocked: () => false,
    ordinaryIngress,
    ordinaryRouteOpeningCreator: openingCreator,
  });
  const submit = (envelope: OrdinaryImTransportEnvelope) => host.runtime.submit({
    target: {
      kind: 'route' as const,
      route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
    },
    idempotencyKey: envelope.messageKey,
    command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
  });
  return {
    activeSessions,
    host,
    openingCreator,
    policyTurns,
    postCommitEffects,
    submit,
    workerCommands,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-current-route-opening-production-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  sessionStore.init(OWNER);
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStore.init();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Current ordinary route opening production', () => {
  it('creates one fully frozen pinned Session and lets the ordinary lane start it cold', async () => {
    const harness = createHarness(() => pinnedPolicy());
    const envelope = turn();

    expect(harness.policyTurns).toEqual([]);
    const outcome = await harness.submit(envelope);

    expect(outcome).toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
    });
    expect(harness.policyTurns).toEqual([envelope.messageKey]);
    expect(harness.activeSessions.size).toBe(1);
    const [current] = [...harness.activeSessions.values()];
    expect(current).toMatchObject({
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: OWNER,
      chatId: CHAT_ID,
      chatType: 'group',
      scope: 'thread',
      cliVersion: '0.99.0-test',
      hasHistory: false,
      workingDir: '/repos/pinned-production',
      ownerOpenId: 'ou_route_opening_owner',
      currentTurnTitle: 'Pinned production opening',
      session: {
        larkAppId: OWNER,
        chatId: CHAT_ID,
        chatType: 'group',
        rootMessageId: ANCHOR,
        scope: 'thread',
        title: 'Pinned production opening',
        nativeSessionTitle: 'Native pinned production opening',
        chatDisplayName: 'Production route chat',
        status: 'active',
        workingDir: '/repos/pinned-production',
        ownerOpenId: 'ou_route_opening_owner',
        ownerUnionId: 'on_route_opening_owner',
        creatorOpenId: 'ou_route_opening_sender',
        lastCallerOpenId: 'ou_route_opening_sender',
        quoteTargetId: envelope.messageKey,
        quoteTargetSenderOpenId: 'ou_route_opening_sender',
        quoteTargetSenderIsBot: false,
        cliId: 'codex',
        cliRuntime: pinnedPolicy().cli.cliRuntime,
        cliPathOverride: '/opt/botmux/codex',
        wrapperCli: 'sandbox-wrapper codex',
        model: 'gpt-5.6',
        reasoningEffort: 'high',
        agentFrozen: true,
      },
    });
    expect(current.session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isFinite(Date.parse(current.session.createdAt))).toBe(true);
    expect(current.session.initialUserTurnPending).toBeUndefined();
    expect(sessionStore.getSessionFresh(current.session.sessionId)).toEqual(current.session);
    expect(harness.workerCommands).toEqual([expect.objectContaining({
      kind: 'forkWorker',
      sessionId: current.session.sessionId,
      turnId: envelope.messageKey,
      input: { content: `opening:${envelope.messageKey}` },
      resume: false,
    })]);
    expect(harness.postCommitEffects).toEqual([]);
  });

  it('stages the exact opening before dispatching an unpinned repo-picker effect', async () => {
    const harness = createHarness(() => pickerPolicy());
    const envelope = turn('om_route_opening_picker', 'choose a repository for this opening');

    await expect(harness.submit(envelope)).resolves.toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
    });

    const [current] = [...harness.activeSessions.values()];
    expect(current).toMatchObject({
      worker: null,
      pendingRepo: true,
      session: {
        queued: true,
        queuedPrompt: `opening:${envelope.content}`,
        pendingRepoSetup: {
          mode: 'picker',
          prompt: `opening:${envelope.content}`,
          turnId: envelope.messageKey,
          cliInput: { content: `opening:${envelope.messageKey}` },
        },
      },
    });
    expect(current.workingDir).toBeUndefined();
    expect(current.session.initialUserTurnPending).toBeUndefined();
    expect(harness.workerCommands).toEqual([]);
    expect(harness.postCommitEffects).toEqual([{
      kind: 'pendingRepo.openingCommitted',
      ownerLarkAppId: OWNER,
      sessionId: current.session.sessionId,
      turnId: envelope.messageKey,
      route: envelope.route,
      mode: 'picker',
    }]);
    expect(sessionStore.getSessionFresh(current.session.sessionId)?.pendingRepoSetup)
      .toEqual(current.session.pendingRepoSetup);
  });

  it('stages an auto-worktree opening against the resolved pinned base', async () => {
    const harness = createHarness(() => autoWorktreePolicy());
    const envelope = turn('om_route_opening_auto_wt', 'open an isolated worktree');

    await expect(harness.submit(envelope)).resolves.toMatchObject({ kind: 'applied' });

    const [current] = [...harness.activeSessions.values()];
    expect(current).toMatchObject({
      worker: null,
      pendingRepo: true,
      workingDir: '/repos/auto-worktree-base',
      session: {
        workingDir: '/repos/auto-worktree-base',
        queued: true,
        queuedPrompt: `opening:${envelope.content}`,
        pendingRepoSetup: {
          mode: 'auto_worktree',
          baseDir: '/repos/auto-worktree-base',
          prompt: `opening:${envelope.content}`,
          turnId: envelope.messageKey,
          cliInput: { content: `opening:${envelope.messageKey}` },
        },
      },
    });
    expect(current.session.initialUserTurnPending).toBeUndefined();
    expect(harness.workerCommands).toEqual([]);
    expect(harness.postCommitEffects).toEqual([{
      kind: 'pendingRepo.openingCommitted',
      ownerLarkAppId: OWNER,
      sessionId: current.session.sessionId,
      turnId: envelope.messageKey,
      route: envelope.route,
      mode: 'auto_worktree',
      baseDir: '/repos/auto-worktree-base',
    }]);
  });

  it('quarantines a store response loss without publishing runtime or worker authority', async () => {
    const updateSession = sessionStore.updateSession;
    vi.spyOn(sessionStore, 'updateSession').mockImplementationOnce((session) => {
      updateSession(session);
      throw new Error('injected opening-store response loss');
    });
    const harness = createHarness(() => pinnedPolicy());
    const envelope = turn('om_route_opening_response_loss');

    await expect(harness.submit(envelope)).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringMatching(/publication outcome is unknown.*response loss/i),
    });

    expect(harness.activeSessions.size).toBe(0);
    expect(harness.workerCommands).toEqual([]);
    expect(harness.postCommitEffects).toEqual([]);
    expect(harness.policyTurns).toEqual([envelope.messageKey]);
    const durable = sessionStore.listSessionsForOwnerStrict(OWNER);
    expect(durable).toHaveLength(1);
    expect(durable[0]).toMatchObject({
      larkAppId: OWNER,
      rootMessageId: ANCHOR,
      status: 'active',
      title: 'Pinned production opening',
      cliId: 'codex',
      agentFrozen: true,
      initialUserTurnPending: true,
    });
  });

  it('rolls back a new opening when downstream quota proves no input was committed', async () => {
    const harness = createHarness(() => pinnedPolicy(), {
      materialize(effect, attempt) {
        return attempt === 1
          ? { kind: 'refused', message: 'opening quota refused' }
          : { kind: 'materialized', material: materialFor(effect) };
      },
    });
    const envelope = turn('om_route_opening_quota_retry');

    await expect(harness.submit(envelope)).resolves.toMatchObject({
      kind: 'retryable',
      message: expect.stringMatching(/quota refused/i),
    });
    expect(harness.activeSessions.size).toBe(0);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toEqual([]);

    await expect(harness.submit(envelope)).resolves.toMatchObject({ kind: 'applied' });
    expect(harness.policyTurns).toEqual([envelope.messageKey, envelope.messageKey]);
    expect(harness.activeSessions.size).toBe(1);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
  });

  it('lets N+1 create and own the opening after provisional N proves no input commit', async () => {
    const firstMaterializationStarted = deferred<void>();
    const releaseFirstMaterialization = deferred<void>();
    const firstTurn = turn('om_route_opening_refused_n', 'opening N is refused');
    const followerTurn = turn('om_route_opening_refused_n_plus_1', 'opening N+1 takes over');
    const harness = createHarness(() => pinnedPolicy(), {
      async materialize(effect) {
        if (effect.input.turn.messageKey === firstTurn.messageKey) {
          firstMaterializationStarted.resolve();
          await releaseFirstMaterialization.promise;
          return { kind: 'refused', message: 'opening N quota refused' };
        }
        return { kind: 'materialized', material: materialFor(effect) };
      },
    });

    const first = harness.submit(firstTurn);
    await firstMaterializationStarted.promise;
    const follower = harness.submit(followerTurn);
    releaseFirstMaterialization.resolve();

    await expect(first).resolves.toMatchObject({
      kind: 'retryable',
      message: expect.stringMatching(/quota refused/i),
    });
    await expect(follower).resolves.toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
    });
    expect(harness.policyTurns).toEqual([
      firstTurn.messageKey,
      followerTurn.messageKey,
    ]);
    expect(harness.workerCommands).toEqual([
      expect.objectContaining({
        kind: 'forkWorker',
        turnId: followerTurn.messageKey,
        input: { content: `opening:${followerTurn.messageKey}` },
        resume: false,
      }),
    ]);
    expect(harness.activeSessions).toHaveLength(1);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
  });

  it('rolls back an exact opening when projection fails before downstream delivery begins', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const openingCreator = createCurrentOrdinaryRouteOpeningProduction({
      ownerLarkAppId: OWNER,
      activeSessions,
      policyEffects: {
        async execute() {
          return { kind: 'resolved', facts: pinnedPolicy() };
        },
      },
      postCommitEffects: {
        dispatch() {
          throw new Error('projection failure must not dispatch post-commit work');
        },
      },
    });
    const downstreamSubmit = vi.fn();
    const runtime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator,
      downstream: {
        projection: {
          async read() {
            return { kind: 'notFound' as const };
          },
        },
        runtime: { submit: downstreamSubmit },
      },
    });
    const envelope = turn('om_route_opening_projection_not_found');

    await expect(runtime.submit({
      target: {
        kind: 'route',
        route: { kind: 'thread', anchorId: envelope.route.canonicalAnchor },
      },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: envelope } },
    })).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringMatching(/no exact Session projection/i),
    });

    expect(downstreamSubmit).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(0);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toEqual([]);
  });

  it('reuses Session N for route turn N+1 and never starts a second worker', async () => {
    const harness = createHarness(() => pinnedPolicy(), {
      onWorkerCommand(command, activeSessions) {
        if (command.kind !== 'forkWorker') return;
        const current = [...activeSessions.values()].find(
          candidate => candidate.session.sessionId === command.sessionId,
        );
        if (!current) throw new Error('expected Current opening owner');
        current.worker = { killed: false } as DaemonSession['worker'];
        current.workerGeneration = 1;
        current.session.workerGeneration = 1;
      },
    });
    const first = turn('om_route_opening_n', 'opening N');
    const next = turn('om_route_opening_n_plus_1', 'follow-up N+1');

    await expect(harness.submit(first)).resolves.toMatchObject({ kind: 'applied' });
    await expect(harness.submit(next)).resolves.toMatchObject({ kind: 'applied' });

    expect(harness.policyTurns).toEqual([first.messageKey]);
    expect(harness.activeSessions.size).toBe(1);
    const [current] = [...harness.activeSessions.values()];
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.workerCommands).toEqual([
      expect.objectContaining({
        kind: 'forkWorker',
        sessionId: current.session.sessionId,
        turnId: first.messageKey,
        input: { content: `opening:${first.messageKey}` },
        resume: false,
      }),
      expect.objectContaining({
        kind: 'sendWorkerInput',
        sessionId: current.session.sessionId,
        turnId: next.messageKey,
        input: { content: `follow-up:${next.messageKey}` },
        workerGeneration: 1,
      }),
    ]);
  });

  it.each(['DaemonSession', 'Session'] as const)(
    'suppresses a post-commit effect when the exact %s is replaced',
    async (replacementKind) => {
      const updateSession = sessionStore.updateSession;
      let activeSessions: Map<string, DaemonSession> | undefined;
      vi.spyOn(sessionStore, 'updateSession').mockImplementation((session) => {
        updateSession(session);
        if (!session.pendingRepoSetup?.cliInput || !activeSessions) return;
        queueMicrotask(() => {
          const [incumbent] = [...activeSessions!.values()];
          if (!incumbent) return;
          if (replacementKind === 'DaemonSession') {
            const replacement: DaemonSession = { ...incumbent };
            activeSessions!.set(activeSessionKey(replacement), replacement);
            return;
          }
          incumbent.session = { ...incumbent.session };
        });
      });
      const harness = createHarness(() => pickerPolicy());
      activeSessions = harness.activeSessions;
      const envelope = turn('om_route_opening_post_effect_fence');

      await expect(harness.submit(envelope)).resolves.toMatchObject({ kind: 'applied' });

      expect(harness.postCommitEffects).toEqual([]);
      expect(harness.activeSessions.size).toBe(1);
      const [replacement] = [...harness.activeSessions.values()];
      expect(replacement.session.pendingRepoSetup?.cliInput).toEqual({
        content: `opening:${envelope.messageKey}`,
      });
    },
  );
});
