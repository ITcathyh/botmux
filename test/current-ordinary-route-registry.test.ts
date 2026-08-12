import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCurrentOrdinaryIngressProductionPort,
  type CurrentOrdinaryIngressProductionExternalEffect,
  type CurrentOrdinaryIngressWorkerProcessCommand,
} from '../src/core/current-ordinary-ingress-production.js';
import { currentSessionRuntimeHost } from '../src/core/current-session-runtime.js';
import {
  createCurrentOrdinaryRouteRegistryRuntime,
  type CurrentOrdinaryRouteOpeningRollbackToken,
} from '../src/core/current-ordinary-route-registry.js';
import {
  currentRouteAdmissionKey,
  isCurrentRouteAdmissionToken,
} from '../src/core/current-route-admission.js';
import {
  createCurrentDashboardRouteOpeningPort,
  type CurrentDashboardRouteInspection,
  type CurrentDashboardRouteOpeningPort,
} from '../src/core/current-dashboard-route-opening.js';
import type {
  NormalizedOrdinaryImTurn,
  OrdinaryImTransportEnvelope,
} from '../src/core/ordinary-im-turn.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type {
  CommandOutcomeFor,
  DashboardSpawnCommand,
  SessionAddress,
  SessionProjection,
  SessionRuntime,
} from '../src/core/session-runtime.js';
import * as sessionStore from '../src/services/session-store.js';
import type { Session } from '../src/types.js';

const OWNER = 'app-current-ordinary-route';
const MESSAGE_KEY = 'om_provider_message_route_create';
const ANCHOR = 'om_current_route_create_root';
const CHAT_ID = 'oc_current_route_create_chat';

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

function testRollbackToken(): CurrentOrdinaryRouteOpeningRollbackToken {
  return Object.freeze(Object.create(null)) as CurrentOrdinaryRouteOpeningRollbackToken;
}

function turn(input: {
  messageKey?: string;
  anchor?: string;
  chatId?: string;
  content?: string;
  scope?: 'thread' | 'chat';
} = {}): OrdinaryImTransportEnvelope {
  const messageKey = input.messageKey ?? MESSAGE_KEY;
  const scope = input.scope ?? 'thread';
  const chatId = input.chatId ?? CHAT_ID;
  const anchor = scope === 'chat' ? chatId : (input.anchor ?? ANCHOR);
  return {
    route: {
      scope,
      canonicalAnchor: anchor,
      chatId,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey,
    content: input.content ?? 'create this ordinary Session once',
    sender: { kind: 'human', openId: 'ou_route_sender', unionId: 'on_route_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function sessionFor(
  ownerLarkAppId: string,
  sessionId: string,
  input: OrdinaryImTransportEnvelope,
): Session {
  return {
    sessionId,
    larkAppId: ownerLarkAppId,
    rootMessageId: input.route.canonicalAnchor,
    chatId: input.route.chatId,
    chatType: input.route.chatType,
    scope: input.route.scope,
    status: 'active',
    title: input.content,
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
}

function liveDaemonSession(
  ownerLarkAppId: string,
  sessionId: string,
  input: OrdinaryImTransportEnvelope,
): DaemonSession {
  const session = sessionFor(ownerLarkAppId, sessionId, input);
  return {
    session,
    worker: { killed: false } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    workerGeneration: 9,
    larkAppId: ownerLarkAppId,
    chatId: input.route.chatId,
    chatType: input.route.chatType,
    scope: input.route.scope,
    spawnedAt: Date.parse(session.createdAt),
    cliVersion: 'test',
    lastMessageAt: Date.parse(session.createdAt),
    hasHistory: true,
  } as DaemonSession;
}

function materialFor(effect: CurrentOrdinaryIngressProductionExternalEffect) {
  const key = effect.input.turn.messageKey;
  return {
    userPrompt: effect.input.turn.content,
    newTopicUserPrompt: `opening:${effect.input.turn.content}`,
    cliInput: { content: `follow-up:${key}` },
    newTopicCliInput: { content: `opening:${key}` },
    adoptCliInput: { content: `adopt:${key}` },
    turnId: key,
  };
}

function createHarness(input: {
  ownerLarkAppId?: string;
  activeSessions?: Map<string, DaemonSession>;
  materializationGate?: Promise<void>;
  persistMetadata?: boolean;
} = {}) {
  const ownerLarkAppId = input.ownerLarkAppId ?? OWNER;
  const activeSessions = input.activeSessions ?? new Map<string, DaemonSession>();
  const effects: CurrentOrdinaryIngressProductionExternalEffect[] = [];
  const openingSessions: DaemonSession[] = [];
  const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
  const ordinaryIngress = createCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId,
    activeSessions,
    metadata: {
      apply(_current, metadataInput) {
        if (input.persistMetadata) sessionStore.updateSession(_current.session);
        return {
          kind: 'committed',
          sessionId: metadataInput.binding.sessionId,
          turnId: metadataInput.turn.messageKey,
        };
      },
    },
    clock: () => Date.parse('2026-08-10T00:00:01.000Z'),
    substituteReplyMode: 'thread',
    externalEffects: {
      async execute(effect) {
        effects.push(effect);
        if (input.materializationGate) await input.materializationGate;
        return { kind: 'materialized', material: materialFor(effect) };
      },
    },
    workerProcesses: {
      dispatch(command) {
        workerCommands.push(command);
        return { kind: 'accepted' };
      },
    },
  });
  const hostEpoch = epoch++;
  const openingPlans = new WeakMap<object, NormalizedOrdinaryImTurn>();
  const host = currentSessionRuntimeHost({
    ownerLarkAppId,
    activeSessions,
    ownerBootId: `boot-current-route-${hostEpoch}`,
    runtimeEpoch: `epoch-current-route-${hostEpoch}`,
    keyedTriggerAdmissionBlocked: () => false,
    ordinaryIngress,
    ordinaryRouteOpeningCreator: {
      begin(openingTurn: NormalizedOrdinaryImTurn) {
        const intent = Object.freeze({});
        const continuation = Object.freeze({});
        openingPlans.set(continuation, openingTurn);
        return { kind: 'effect' as const, intent, continuation };
      },
      async execute() {
        return { kind: 'resolved' as const };
      },
      resume(continuation, settlement) {
        const openingTurn = openingPlans.get(continuation as object);
        openingPlans.delete(continuation as object);
        if (settlement.kind === 'superseded') {
          return { kind: 'refused' as const, message: 'superseded' };
        }
        if (!openingTurn || settlement.kind !== 'returned') {
          return { kind: 'unknown' as const, message: 'invalid test opening continuation' };
        }
        const current = liveDaemonSession(
          ownerLarkAppId,
          `session-current-route-${hostEpoch}-${openingSessions.length}`,
          openingTurn,
        );
        current.worker = null;
        current.workerGeneration = 0;
        current.hasHistory = false;
        current.session.initialUserTurnPending = true;
        current.currentTurnTitle = `creator:${openingTurn.content}`;
        sessionStore.updateSession(current.session);
        openingSessions.push(current);
        return { kind: 'created' as const, current, rollbackToken: testRollbackToken() };
      },
      rollback() {
        return { kind: 'rolledBack' as const };
      },
    },
  });
  const submit = (inputTurn: OrdinaryImTransportEnvelope) => host.runtime.submit({
    target: {
      kind: 'route' as const,
      route: inputTurn.route.scope === 'thread'
        ? { kind: 'thread' as const, anchorId: inputTurn.route.canonicalAnchor }
        : { kind: 'chat' as const, chatId: inputTurn.route.chatId },
    },
    idempotencyKey: inputTurn.messageKey,
    command: { kind: 'ordinary.ingress' as const, input: { turn: inputTurn } },
  });
  return { activeSessions, effects, host, openingSessions, submit, workerCommands };
}

function expectApplied(
  outcome: Awaited<ReturnType<ReturnType<typeof createHarness>['submit']>>,
): string {
  expect(outcome).toMatchObject({
    kind: 'applied',
    action: 'ordinary.inputCommitted',
    policy: 'ordinary-replayable',
    durability: 'processLocal',
  });
  if (outcome.kind !== 'applied') throw new Error('expected applied ordinary ingress');
  return outcome.sessionId;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-current-ordinary-route-'));
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

describe('Current ordinary route registry', () => {
  it('quarantines a target scratch published under a noncanonical active key', async () => {
    const sourceTurn = turn({
      messageKey: 'om_relocate_alias_source',
      anchor: 'om_relocate_alias_source_root',
      chatId: 'oc_relocate_alias_source',
    });
    const targetTurn = turn({
      messageKey: 'om_relocate_alias_target',
      chatId: 'oc_relocate_alias_target',
      scope: 'chat',
    });
    const source = liveDaemonSession(OWNER, 'session-relocate-alias-source', sourceTurn);
    const scratch = liveDaemonSession(OWNER, 'session-relocate-alias-scratch', targetTurn);
    scratch.worker = null;
    scratch.workerGeneration = 0;
    scratch.hasHistory = false;
    const activeSessions = new Map<string, DaemonSession>([
      [activeSessionKey(source), source],
      ['noncanonical-target-alias', scratch],
    ]);
    sessionStore.updateSession(source.session);
    sessionStore.updateSession(scratch.session);
    const address = Object.freeze({}) as SessionAddress;
    const runtimeSubmit = vi.fn<SessionRuntime['submit']>();
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator: {
        begin: () => ({ kind: 'unknown', message: 'unused' }),
        async execute() { throw new Error('unused'); },
        resume: () => ({ kind: 'unknown', message: 'unused' }),
        rollback: () => ({ kind: 'rolledBack' }),
      },
      downstream: {
        projection: {
          async read(query) {
            if (query.kind !== 'byRoute') return { kind: 'notFound' };
            return {
              kind: 'one',
              session: {
                address,
                sessionId: source.session.sessionId,
                route: { kind: 'thread', anchorId: source.session.rootMessageId },
                recordStatus: 'active',
                executorStatus: 'idle',
              },
            };
          },
        },
        runtime: { submit: runtimeSubmit },
      },
    });

    await expect(routeRuntime.submit({
      target: {
        kind: 'route',
        route: { kind: 'thread', anchorId: source.session.rootMessageId },
      },
      idempotencyKey: 'relocate-noncanonical-target-scratch',
      command: {
        kind: 'control.mutate',
        input: {
          kind: 'relocate',
          sourceAnchor: source.session.rootMessageId,
          targetChatId: targetTurn.route.chatId,
          targetRootMessageId: 'om_relocate_alias_target_audit',
          requester: { larkAppId: 'app-leader', openId: 'ou_route_sender' },
        },
      },
    })).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('noncanonical registry key'),
    });
    expect(runtimeSubmit).not.toHaveBeenCalled();
    expect(activeSessions.get('noncanonical-target-alias')).toBe(scratch);
    expect(sessionStore.getSessionForOwnerStrict(OWNER, scratch.session.sessionId)?.status)
      .toBe('active');
  });

  it('retires a persisted-only target scratch through its projected Session address', async () => {
    const sourceTurn = turn({
      messageKey: 'om_relocate_persisted_source',
      anchor: 'om_relocate_persisted_source_root',
      chatId: 'oc_relocate_persisted_source',
    });
    const targetTurn = turn({
      messageKey: 'om_relocate_persisted_target',
      chatId: 'oc_relocate_persisted_target',
      scope: 'chat',
    });
    const source = liveDaemonSession(OWNER, 'session-relocate-persisted-source', sourceTurn);
    const scratch = sessionFor(
      OWNER,
      'session-relocate-persisted-only-scratch',
      targetTurn,
    );
    const activeSessions = new Map([[activeSessionKey(source), source]]);
    sessionStore.updateSession(source.session);
    sessionStore.updateSession(scratch);
    const sourceAddress = Object.freeze({}) as SessionAddress;
    const scratchAddress = Object.freeze({}) as SessionAddress;
    const submissions: Array<{
      readonly address: SessionAddress;
      readonly operationIdentity: string;
      readonly command: 'close' | 'relocate';
    }> = [];
    const runtime: SessionRuntime = {
      async submit(request) {
        if (request.command.kind !== 'control.mutate' || request.target.kind !== 'session') {
          throw new Error('unexpected persisted scratch command');
        }
        const kind = request.command.input.kind;
        if (kind !== 'close' && kind !== 'relocate') {
          throw new Error('unexpected persisted scratch control');
        }
        submissions.push({
          address: request.target.address,
          operationIdentity: request.idempotencyKey,
          command: kind,
        });
        if (kind === 'close') {
          expect(request.command.input).toMatchObject({
            reason: 'routeScratch',
            source: 'relocate',
            expectedRoute: {
              scope: 'chat',
              canonicalAnchor: targetTurn.route.chatId,
              chatId: targetTurn.route.chatId,
              chatType: 'group',
            },
          });
          expect(request.target.controlRouteReservation).toBeDefined();
          sessionStore.closeSession(scratch.sessionId);
          return {
            kind: 'applied',
            action: 'control.mutated',
            policy: 'control-staged-transition',
            sessionId: scratch.sessionId,
            result: { kind: 'closed', alreadyClosed: false, known: true },
          } as CommandOutcomeFor<typeof request.command>;
        }
        return {
          kind: 'applied',
          action: 'control.mutated',
          policy: 'control-staged-transition',
          sessionId: source.session.sessionId,
          result: {
            kind: 'relocated',
            targetChatId: request.command.input.targetChatId,
            targetRootMessageId: request.command.input.targetRootMessageId,
          },
        } as CommandOutcomeFor<typeof request.command>;
      },
    };
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator: {
        begin: () => ({ kind: 'unknown', message: 'unused' }),
        async execute() { throw new Error('unused'); },
        resume: () => ({ kind: 'unknown', message: 'unused' }),
        rollback: () => ({ kind: 'rolledBack' }),
      },
      downstream: {
        projection: {
          async read(query) {
            if (query.kind === 'byExternalSession'
                && query.sessionId === scratch.sessionId) {
              return {
                kind: 'one',
                session: {
                  address: scratchAddress,
                  sessionId: scratch.sessionId,
                  route: { kind: 'chat', chatId: scratch.chatId },
                  recordStatus: 'active',
                  executorStatus: 'dormant',
                },
              };
            }
            if (query.kind === 'byRoute') {
              return {
                kind: 'one',
                session: {
                  address: sourceAddress,
                  sessionId: source.session.sessionId,
                  route: { kind: 'thread', anchorId: source.session.rootMessageId },
                  recordStatus: 'active',
                  executorStatus: 'idle',
                },
              };
            }
            return { kind: 'notFound' };
          },
        },
        runtime,
      },
    });

    await expect(routeRuntime.submit({
      target: {
        kind: 'route',
        route: { kind: 'thread', anchorId: source.session.rootMessageId },
      },
      idempotencyKey: 'relocate-persisted-target-scratch',
      command: {
        kind: 'control.mutate',
        input: {
          kind: 'relocate',
          sourceAnchor: source.session.rootMessageId,
          targetChatId: targetTurn.route.chatId,
          targetRootMessageId: 'om_relocate_persisted_target_audit',
          requester: { larkAppId: 'app-leader', openId: 'ou_route_sender' },
        },
      },
    })).resolves.toMatchObject({
      kind: 'applied',
      sessionId: source.session.sessionId,
    });
    expect(submissions).toEqual([
      {
        address: scratchAddress,
        operationIdentity: expect.stringMatching(/^route-scratch:/),
        command: 'close',
      },
      {
        address: sourceAddress,
        operationIdentity: 'relocate-persisted-target-scratch',
        command: 'relocate',
      },
    ]);
    expect(sessionStore.getSessionForOwnerStrict(OWNER, scratch.sessionId)?.status)
      .toBe('closed');
  });

  it('reserves a relocation operation hash across a retryable preflight', async () => {
    const sourceTurn = turn({
      messageKey: 'om_relocate_retry_source',
      anchor: 'om_relocate_retry_source_root',
      chatId: 'oc_relocate_retry_source',
    });
    const source = liveDaemonSession(OWNER, 'session-relocate-retry-source', sourceTurn);
    const activeSessions = new Map([[activeSessionKey(source), source]]);
    sessionStore.updateSession(source.session);
    const address = Object.freeze({}) as SessionAddress;
    let projectionReads = 0;
    const runtimeSubmit = vi.fn<SessionRuntime['submit']>(async (request) => ({
      kind: 'applied',
      action: 'control.mutated',
      policy: 'control-staged-transition',
      sessionId: source.session.sessionId,
      result: {
        kind: 'relocated',
        targetChatId: request.command.kind === 'control.mutate'
          && request.command.input.kind === 'relocate'
          ? request.command.input.targetChatId
          : 'unexpected',
        targetRootMessageId: request.command.kind === 'control.mutate'
          && request.command.input.kind === 'relocate'
          ? request.command.input.targetRootMessageId
          : 'unexpected',
      },
    }) as never);
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator: {
        begin: () => ({ kind: 'unknown', message: 'unused' }),
        async execute() { throw new Error('unused'); },
        resume: () => ({ kind: 'unknown', message: 'unused' }),
        rollback: () => ({ kind: 'rolledBack' }),
      },
      downstream: {
        projection: {
          async read(query) {
            if (query.kind !== 'byRoute') return { kind: 'notFound' };
            projectionReads += 1;
            if (projectionReads === 1) {
              return { kind: 'notReady', message: 'owner Store temporarily unavailable' };
            }
            return {
              kind: 'one',
              session: {
                address,
                sessionId: source.session.sessionId,
                route: { kind: 'thread', anchorId: source.session.rootMessageId },
                recordStatus: 'active',
                executorStatus: 'idle',
              },
            };
          },
        },
        runtime: { submit: runtimeSubmit },
      },
    });
    const request = (targetRootMessageId: string) => ({
      target: {
        kind: 'route' as const,
        route: { kind: 'thread' as const, anchorId: source.session.rootMessageId },
      },
      idempotencyKey: 'relocate-retryable-operation',
      command: {
        kind: 'control.mutate' as const,
        input: {
          kind: 'relocate' as const,
          sourceAnchor: source.session.rootMessageId,
          targetChatId: 'oc_relocate_retry_target',
          targetRootMessageId,
          requester: { larkAppId: 'app-leader', openId: 'ou_route_sender' },
        },
      },
    });

    await expect(routeRuntime.submit(request('om_target_a'))).resolves.toMatchObject({
      kind: 'retryable',
    });
    await expect(routeRuntime.submit(request('om_target_b'))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    expect(projectionReads).toBe(1);
    expect(runtimeSubmit).not.toHaveBeenCalled();

    await expect(routeRuntime.submit(request('om_target_a'))).resolves.toMatchObject({
      kind: 'applied',
      sessionId: source.session.sessionId,
    });
    expect(projectionReads).toBe(2);
    expect(runtimeSubmit).toHaveBeenCalledOnce();
  });

  it('holds the target route through relocate detach so an ordinary opener joins the moved Session', async () => {
    const sourceTurn = turn({
      messageKey: 'om_relocate_source',
      anchor: 'om_relocate_source_root',
      chatId: 'oc_relocate_source',
    });
    const targetTurn = turn({
      messageKey: 'om_relocate_target_arrival',
      chatId: 'oc_relocate_target',
      scope: 'chat',
    });
    const source = liveDaemonSession(OWNER, 'session-relocate-route-race', sourceTurn);
    const activeSessions = new Map([[activeSessionKey(source), source]]);
    sessionStore.updateSession(source.session);

    const address = Object.freeze({}) as SessionAddress;
    const detachStarted = deferred<void>();
    const releaseDetach = deferred<void>();
    const openingBegin = vi.fn();
    const controlEffects: string[] = [];
    const ordinaryEffects: string[] = [];
    const projection: SessionProjection = {
      async read(query) {
        const current = [...activeSessions.values()].find(candidate => (
          query.kind === 'byExternalSession'
            ? candidate.session.sessionId === query.sessionId
            : query.kind === 'byRoute'
              && (query.route.kind === 'thread'
                ? candidate.scope === 'thread'
                  && candidate.session.rootMessageId === query.route.anchorId
                : candidate.scope === 'chat' && candidate.chatId === query.route.chatId)
        ));
        if (!current) return { kind: 'notFound' };
        return {
          kind: 'one',
          session: {
            address,
            sessionId: current.session.sessionId,
            route: current.scope === 'chat'
              ? { kind: 'chat', chatId: current.chatId }
              : { kind: 'thread', anchorId: current.session.rootMessageId },
            recordStatus: 'active',
            executorStatus: 'idle',
          },
        };
      },
    };
    const runtime: SessionRuntime = {
      async submit(request) {
        if (request.command.kind === 'control.mutate') {
          controlEffects.push(request.idempotencyKey);
          expect(request.command.input.kind).toBe('relocate');
          if (request.command.input.kind !== 'relocate'
              || request.target.kind !== 'session') throw new Error('invalid relocate test request');
          expect(isCurrentRouteAdmissionToken({
            token: request.target.controlRouteReservation,
            key: currentRouteAdmissionKey({
              ownerLarkAppId: OWNER,
              scope: 'chat',
              canonicalAnchor: request.command.input.targetChatId,
              chatId: request.command.input.targetChatId,
              chatType: 'group',
            }),
          })).toBe(true);
          detachStarted.resolve();
          await releaseDetach.promise;
          activeSessions.delete(activeSessionKey(source));
          source.session.chatId = request.command.input.targetChatId;
          source.session.rootMessageId = request.command.input.targetRootMessageId;
          source.session.scope = 'chat';
          source.chatId = request.command.input.targetChatId;
          source.scope = 'chat';
          sessionStore.updateSession(source.session);
          activeSessions.set(activeSessionKey(source), source);
          return {
            kind: 'applied',
            action: 'control.mutated',
            policy: 'control-staged-transition',
            sessionId: source.session.sessionId,
            result: {
              kind: 'relocated',
              targetChatId: request.command.input.targetChatId,
              targetRootMessageId: request.command.input.targetRootMessageId,
            },
          } as CommandOutcomeFor<typeof request.command>;
        }
        if (request.command.kind !== 'ordinary.ingress') {
          throw new Error('unexpected route-race command');
        }
        ordinaryEffects.push(request.idempotencyKey);
        return {
          kind: 'applied',
          action: 'ordinary.inputCommitted',
          policy: 'ordinary-replayable',
          durability: 'processLocal',
          sessionId: source.session.sessionId,
        } as CommandOutcomeFor<typeof request.command>;
      },
    };
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator: {
        begin: openingBegin.mockImplementation(() => {
          throw new Error('target opener must join the relocated Session');
        }),
        async execute() {
          throw new Error('target opener must not execute');
        },
        resume() {
          throw new Error('target opener must not resume');
        },
        rollback() {
          throw new Error('target opener must not roll back');
        },
      },
      downstream: { projection, runtime },
    });
    const relocateRequest = {
      target: {
        kind: 'route' as const,
        route: { kind: 'thread' as const, anchorId: sourceTurn.route.canonicalAnchor },
      },
      idempotencyKey: 'relay-route-race-op',
      command: {
        kind: 'control.mutate' as const,
        input: {
          kind: 'relocate' as const,
          sourceAnchor: sourceTurn.route.canonicalAnchor,
          targetChatId: targetTurn.route.chatId,
          targetRootMessageId: 'om_relocate_target_audit',
          requester: { larkAppId: 'app-leader', openId: 'ou_route_sender' },
        },
      },
    };
    const moving = routeRuntime.submit(relocateRequest);
    await detachStarted.promise;
    const arriving = routeRuntime.submit({
      target: { kind: 'route', route: { kind: 'chat', chatId: targetTurn.route.chatId } },
      idempotencyKey: targetTurn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: targetTurn } },
    });

    await Promise.resolve();
    expect(openingBegin).not.toHaveBeenCalled();
    expect(ordinaryEffects).toEqual([]);

    releaseDetach.resolve();
    await expect(moving).resolves.toMatchObject({ kind: 'applied' });
    await expect(arriving).resolves.toMatchObject({
      kind: 'applied',
      sessionId: source.session.sessionId,
    });
    expect(openingBegin).not.toHaveBeenCalled();
    expect(controlEffects).toEqual(['relay-route-race-op']);
    expect(ordinaryEffects).toEqual([targetTurn.messageKey]);
    expect([...activeSessions.values()]).toEqual([source]);

    // The source route no longer exists, so duplicate protection must live
    // above projection. Replaying the same operation cannot detach twice.
    await expect(routeRuntime.submit(relocateRequest)).resolves.toMatchObject({
      kind: 'duplicate',
      sessionId: source.session.sessionId,
    });
    expect(controlEffects).toEqual(['relay-route-race-op']);
  });

  it('deduplicates before Session identity resolution and gives concurrent creators one opening', async () => {
    const releaseMaterialization = deferred<void>();
    const harness = createHarness({ materializationGate: releaseMaterialization.promise });
    const envelope = turn();

    const first = harness.submit(envelope);
    const second = harness.submit(envelope);
    await Promise.resolve();
    releaseMaterialization.resolve();

    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(['applied', 'duplicate']);
    const applied = outcomes.find(outcome => outcome.kind === 'applied');
    const duplicate = outcomes.find(outcome => outcome.kind === 'duplicate');
    if (!applied || applied.kind !== 'applied') throw new Error('expected one route-create winner');
    expect(duplicate).toMatchObject({
      kind: 'duplicate',
      state: 'inputCommitted',
      sessionId: applied.sessionId,
    });

    expect(harness.activeSessions.size).toBe(1);
    const [winner] = [...harness.activeSessions.values()];
    expect(harness.openingSessions).toHaveLength(1);
    expect(winner).toBe(harness.openingSessions[0]);
    expect(winner.currentTurnTitle).toBe(`creator:${envelope.content}`);
    expect(winner.session.sessionId).toBe(applied.sessionId);
    expect(winner.session.initialUserTurnPending).toBeUndefined();
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.effects).toHaveLength(1);
    expect(harness.effects[0]?.input.turn).toEqual(envelope);
    expect(harness.workerCommands).toHaveLength(1);
    expect(harness.workerCommands[0]).toMatchObject({
      kind: 'forkWorker',
      sessionId: applied.sessionId,
      turnId: MESSAGE_KEY,
      input: { content: `opening:${MESSAGE_KEY}` },
      resume: false,
    });
  });

  it('rejects one owner/provider key reused for a different route before creating a loser', async () => {
    const harness = createHarness();
    const first = turn();
    const winnerSessionId = expectApplied(await harness.submit(first));
    const conflicting = turn({
      anchor: 'om_conflicting_route',
      chatId: 'oc_conflicting_route',
    });

    await expect(harness.submit(conflicting)).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    expect(harness.activeSessions.size).toBe(1);
    expect(harness.openingSessions).toHaveLength(1);
    expect([...harness.activeSessions.values()][0]?.session.sessionId).toBe(winnerSessionId);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.effects).toHaveLength(1);
    expect(harness.workerCommands).toHaveLength(1);
  });

  it('rejects one owner/provider key reused for different semantics on the same route', async () => {
    const harness = createHarness();
    expectApplied(await harness.submit(turn()));

    await expect(harness.submit(turn({ content: 'different semantic ordinary turn' })))
      .resolves.toMatchObject({
        kind: 'rejected',
        reason: 'idempotencyConflict',
      });
    expect(harness.activeSessions.size).toBe(1);
    expect(harness.openingSessions).toHaveLength(1);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.effects).toHaveLength(1);
    expect(harness.workerCommands).toHaveLength(1);
  });

  it('scopes a provider message key to its owner Host', async () => {
    const firstOwner = 'app-current-route-owner-a';
    const secondOwner = 'app-current-route-owner-b';
    const envelope = turn();
    sessionStore.init(firstOwner);
    const first = createHarness({ ownerLarkAppId: firstOwner });
    const firstSessionId = expectApplied(await first.submit(envelope));

    sessionStore.init(secondOwner);
    const second = createHarness({ ownerLarkAppId: secondOwner });
    const secondSessionId = expectApplied(await second.submit(envelope));

    expect(firstSessionId).not.toBe(secondSessionId);
    expect(first.activeSessions.size).toBe(1);
    expect(second.activeSessions.size).toBe(1);
    expect(first.openingSessions).toHaveLength(1);
    expect(second.openingSessions).toHaveLength(1);
    expect(sessionStore.listSessionsForOwnerStrict(firstOwner)).toHaveLength(1);
    expect(sessionStore.listSessionsForOwnerStrict(secondOwner)).toHaveLength(1);
    expect(first.workerCommands).toHaveLength(1);
    expect(second.workerCommands).toHaveLength(1);
  });

  it('settles a hostile opening-result getter as one terminal quarantine', async () => {
    const envelope = turn({ messageKey: 'om_hostile_creator_result' });
    const begin = vi.fn(() => {
      const hostile = Object.create(null);
      Object.defineProperty(hostile, 'kind', {
        get() {
          throw new Error('hostile creator kind getter');
        },
      });
      return hostile as never;
    });
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      openingCreator: {
        begin,
        async execute() {
          throw new Error('hostile begin must not execute');
        },
        resume() {
          throw new Error('hostile begin must not resume');
        },
        rollback() {
          throw new Error('hostile begin must not roll back');
        },
      },
      downstream: {
        projection: {
          read: vi.fn(async () => ({ kind: 'notFound' as const })),
        },
        runtime: {
          submit: vi.fn(async () => ({ kind: 'quarantined' as const, message: 'must not run' })),
        },
      },
    });
    const request = {
      target: {
        kind: 'route' as const,
        route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
      },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
    };

    const first = await routeRuntime.submit(request);
    expect(first).toMatchObject({
      kind: 'quarantined',
      message: expect.stringMatching(/opening begin result.*unreadable.*hostile creator kind getter/i),
    });
    await expect(routeRuntime.submit(request)).resolves.toEqual(first);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'thenable',
      () => Promise.resolve({ kind: 'refused', message: 'too late' }),
      /opening resume must return synchronously/i,
    ],
    [
      'malformed creation',
      () => ({ kind: 'created' }),
      /opening resume returned an invalid creation result/i,
    ],
  ] as const)(
    'makes one route terminal when opening resume returns a %s',
    async (_label, resumeResult, expectedMessage) => {
      const keyLabel = _label.replaceAll(' ', '_');
      const firstTurn = turn({ messageKey: `om_resume_${keyLabel}_first` });
      const nextTurn = turn({ messageKey: `om_resume_${keyLabel}_next` });
      const begin = vi.fn(() => ({
        kind: 'effect' as const,
        intent: Object.freeze({}),
        continuation: Object.freeze({}),
      }));
      const execute = vi.fn(async () => ({ kind: 'resolved' as const }));
      const resume = vi.fn(() => resumeResult() as never);
      const downstreamSubmit = vi.fn();
      const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
        ownerLarkAppId: OWNER,
        activeSessions: new Map(),
        openingCreator: {
          begin,
          execute,
          resume,
          rollback() {
            throw new Error('invalid resume must not mint a rollback lease');
          },
        },
        downstream: {
          projection: { read: vi.fn() },
          runtime: { submit: downstreamSubmit },
        },
      });
      const submit = (envelope: OrdinaryImTransportEnvelope) => routeRuntime.submit({
        target: {
          kind: 'route' as const,
          route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
        },
        idempotencyKey: envelope.messageKey,
        command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
      });

      const first = await submit(firstTurn);
      expect(first).toMatchObject({ kind: 'quarantined', message: expectedMessage });
      await expect(submit(nextTurn)).resolves.toEqual(first);
      expect(begin).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(downstreamSubmit).not.toHaveBeenCalled();
    },
  );

  it('quarantines an ambiguous route with multiple active owner bindings', async () => {
    const envelope = turn();
    sessionStore.updateSession(sessionFor(OWNER, 'session-ambiguous-a', envelope));
    sessionStore.updateSession(sessionFor(OWNER, 'session-ambiguous-b', envelope));
    const harness = createHarness();

    await expect(harness.submit(envelope)).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringMatching(/multiple active owner bindings/i),
    });
    expect(harness.activeSessions.size).toBe(0);
    expect(harness.openingSessions).toHaveLength(0);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(2);
    expect(harness.effects).toHaveLength(0);
    expect(harness.workerCommands).toHaveLength(0);
  });

  it('submits directly to an existing winner without a daemon legacy fallback', async () => {
    const envelope = turn({ messageKey: 'om_existing_winner' });
    const existing = liveDaemonSession(OWNER, 'session-existing-winner', envelope);
    sessionStore.updateSession(existing.session);
    const registry = new Map<string, DaemonSession>([[activeSessionKey(existing), existing]]);
    const harness = createHarness({ activeSessions: registry });

    const sessionId = expectApplied(await harness.submit(envelope));

    expect(sessionId).toBe(existing.session.sessionId);
    expect(harness.activeSessions.size).toBe(1);
    expect(harness.openingSessions).toHaveLength(0);
    expect([...harness.activeSessions.values()][0]).toBe(existing);
    expect(sessionStore.listSessionsForOwnerStrict(OWNER)).toHaveLength(1);
    expect(harness.effects).toHaveLength(1);
    expect(harness.workerCommands).toEqual([expect.objectContaining({
      kind: 'sendWorkerInput',
      sessionId: existing.session.sessionId,
      turnId: envelope.messageKey,
      input: { content: `follow-up:${envelope.messageKey}` },
      workerGeneration: existing.workerGeneration,
    })]);
  });

  it('rejects a same-id same-route DS or Session replacement across projection await', async () => {
    const envelope = turn({ messageKey: 'om_projection_replacement' });
    const existing = liveDaemonSession(OWNER, 'session-projection-replacement', envelope);
    sessionStore.updateSession(existing.session);
    const registry = new Map<string, DaemonSession>([[activeSessionKey(existing), existing]]);
    const harness = createHarness({ activeSessions: registry });
    const replacement: DaemonSession = {
      ...existing,
      session: { ...existing.session },
    };
    const listSessions = sessionStore.listSessionsForOwnerStrict;
    let reads = 0;
    vi.spyOn(sessionStore, 'listSessionsForOwnerStrict').mockImplementation((owner) => {
      const result = listSessions(owner);
      reads += 1;
      if (reads === 2) {
        queueMicrotask(() => {
          registry.set(activeSessionKey(replacement), replacement);
        });
      }
      return result;
    });

    const pending = harness.submit(envelope);

    await expect(pending).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringMatching(/identity changed.*projection/i),
    });
    expect(harness.openingSessions).toHaveLength(0);
    expect(harness.effects).toHaveLength(0);
    expect(harness.workerCommands).toHaveLength(0);
  });

  it('admits different provider keys on one route into downstream begin in arrival order', async () => {
    const firstTurn = turn({ messageKey: 'om_route_fifo_n', content: 'turn N' });
    const nextTurn = turn({ messageKey: 'om_route_fifo_n_plus_1', content: 'turn N+1' });
    const existing = liveDaemonSession(OWNER, 'session-route-fifo', firstTurn);
    sessionStore.updateSession(existing.session);
    const activeSessions = new Map<string, DaemonSession>([
      [activeSessionKey(existing), existing],
    ]);
    const address = Object.freeze({}) as SessionAddress;
    const projected = {
      kind: 'one' as const,
      session: {
        address,
        sessionId: existing.session.sessionId,
        route: { kind: 'thread' as const, anchorId: ANCHOR },
        recordStatus: 'active' as const,
        executorStatus: 'working' as const,
      },
    };
    const releaseFirstProjection = deferred<typeof projected>();
    const projectionReads: string[] = [];
    const projection: SessionProjection = {
      async read(query) {
        if (query.kind !== 'byExternalSession') throw new Error('unexpected projection query');
        projectionReads.push(query.sessionId);
        return projectionReads.length === 1
          ? releaseFirstProjection.promise
          : projected;
      },
    };
    const downstreamBegins: string[] = [];
    const runtime = {
      async submit(request) {
        downstreamBegins.push(request.idempotencyKey);
        return {
          kind: 'applied',
          action: 'ordinary.inputCommitted',
          policy: 'ordinary-replayable',
          durability: 'processLocal',
          sessionId: existing.session.sessionId,
        };
      },
    } as SessionRuntime;
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator: {
        begin() {
          throw new Error('existing FIFO owner must not create');
        },
        async execute() {
          throw new Error('existing FIFO owner must not execute');
        },
        resume() {
          throw new Error('existing FIFO owner must not resume');
        },
        rollback() {
          throw new Error('existing FIFO owner must not roll back');
        },
      },
      downstream: { projection, runtime },
    });
    const submit = (envelope: OrdinaryImTransportEnvelope) => routeRuntime.submit({
      target: {
        kind: 'route' as const,
        route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
      },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
    });

    const first = submit(firstTurn);
    const next = submit(nextTurn);

    await vi.waitFor(() => expect(projectionReads).toHaveLength(1));
    expect(downstreamBegins).toEqual([]);
    releaseFirstProjection.resolve(projected);
    await expect(Promise.all([first, next])).resolves.toEqual([
      expect.objectContaining({ kind: 'applied' }),
      expect.objectContaining({ kind: 'applied' }),
    ]);
    expect(downstreamBegins).toEqual([firstTurn.messageKey, nextTurn.messageKey]);
  });

  it('keeps asynchronous opening policy inside each route admission without blocking another route', async () => {
    const firstTurn = turn({
      messageKey: 'om_async_policy_route_a',
      anchor: 'om_async_policy_anchor_a',
      chatId: 'oc_async_policy_chat_a',
    });
    const secondTurn = turn({
      messageKey: 'om_async_policy_route_b',
      anchor: 'om_async_policy_anchor_b',
      chatId: 'oc_async_policy_chat_b',
    });
    const activeSessions = new Map<string, DaemonSession>();
    const releaseFirstPolicy = deferred<void>();
    const policyBegins: string[] = [];
    const publications: string[] = [];
    const openingCreator = {
      begin(openingTurn: NormalizedOrdinaryImTurn) {
        return {
          kind: 'effect' as const,
          intent: Object.freeze({ turn: openingTurn }),
          continuation: Object.freeze({ turn: openingTurn }),
        };
      },
      async execute(intent: unknown) {
        const openingTurn = (intent as { turn: NormalizedOrdinaryImTurn }).turn;
        policyBegins.push(openingTurn.messageKey);
        if (openingTurn.messageKey === firstTurn.messageKey) {
          await releaseFirstPolicy.promise;
        }
        return { kind: 'resolved' as const };
      },
      resume(continuation: unknown) {
        const openingTurn = (continuation as { turn: NormalizedOrdinaryImTurn }).turn;
        const current = liveDaemonSession(
          OWNER,
          `session-${openingTurn.messageKey}`,
          openingTurn,
        );
        current.worker = null;
        current.workerGeneration = 0;
        current.hasHistory = false;
        current.session.initialUserTurnPending = true;
        sessionStore.updateSession(current.session);
        publications.push(openingTurn.messageKey);
        return { kind: 'created' as const, current, rollbackToken: testRollbackToken() };
      },
      rollback() {
        return { kind: 'rolledBack' as const };
      },
    };
    const address = Object.freeze({}) as SessionAddress;
    const routeRuntime = createCurrentOrdinaryRouteRegistryRuntime({
      ownerLarkAppId: OWNER,
      activeSessions,
      openingCreator,
      downstream: {
        projection: {
          async read(query) {
            if (query.kind !== 'byExternalSession') return { kind: 'notFound' };
            const current = [...activeSessions.values()].find(
              candidate => candidate.session.sessionId === query.sessionId,
            );
            return current
              ? {
                  kind: 'one' as const,
                  session: {
                    address,
                    sessionId: current.session.sessionId,
                    route: {
                      kind: 'thread' as const,
                      anchorId: current.session.rootMessageId,
                    },
                    recordStatus: 'active' as const,
                    executorStatus: 'dormant' as const,
                  },
                }
              : { kind: 'notFound' as const };
          },
        },
        runtime: {
          async submit(request) {
            return {
              kind: 'applied' as const,
              action: 'ordinary.inputCommitted' as const,
              policy: 'ordinary-replayable' as const,
              durability: 'processLocal' as const,
              sessionId: [...activeSessions.values()].find(
                candidate => candidate.session.rootMessageId
                  === (request.command.input.turn as OrdinaryImTransportEnvelope)
                    .route.canonicalAnchor,
              )!.session.sessionId,
            };
          },
        },
      },
    });
    const submit = (envelope: OrdinaryImTransportEnvelope) => routeRuntime.submit({
      target: {
        kind: 'route' as const,
        route: { kind: 'thread' as const, anchorId: envelope.route.canonicalAnchor },
      },
      idempotencyKey: envelope.messageKey,
      command: { kind: 'ordinary.ingress' as const, input: { turn: envelope } },
    });

    const first = submit(firstTurn);
    await vi.waitFor(() => expect(policyBegins).toEqual([firstTurn.messageKey]));
    const second = submit(secondTurn);

    await expect(second).resolves.toMatchObject({ kind: 'applied' });
    expect(publications).toEqual([secondTurn.messageKey]);
    releaseFirstPolicy.resolve();
    await expect(first).resolves.toMatchObject({ kind: 'applied' });
    expect(publications).toEqual([secondTurn.messageKey, firstTurn.messageKey]);
  });
});

function dashboardCommand(content = 'Dashboard route opening'): DashboardSpawnCommand {
  return {
    kind: 'dashboard.spawn',
    input: {
      content,
      column: 'backlog',
      role: 'solo',
      coworkers: [],
      images: [],
      postBanner: true,
    },
  };
}

function dashboardOpeningHarness(input: {
  gates?: ReadonlyMap<string, Promise<void>>;
} = {}) {
  const inspections = new Map<string, CurrentDashboardRouteInspection>();
  const intents = new WeakMap<object, string>();
  const continuations = new WeakMap<object, string>();
  const effectResults = new WeakMap<object, string>();
  const begins: string[] = [];
  const executes: string[] = [];
  const port: CurrentDashboardRouteOpeningPort = {
    inspect(route) {
      if (route.kind !== 'chat') return { kind: 'unknown', message: 'chat only' };
      return inspections.get(route.chatId) ?? { kind: 'vacant' };
    },
    begin({ route }) {
      if (route.kind !== 'chat') return { kind: 'refused', reason: 'invalidCommand', message: 'chat only' };
      begins.push(route.chatId);
      const intent = Object.freeze(Object.create(null)) as object;
      const continuation = Object.freeze(Object.create(null)) as object;
      intents.set(intent, route.chatId);
      continuations.set(continuation, route.chatId);
      return { kind: 'effect', intent, continuation };
    },
    async execute(intent) {
      if (!intent || typeof intent !== 'object') throw new Error('invalid fake intent');
      const chatId = intents.get(intent);
      if (!chatId) throw new Error('foreign fake intent');
      executes.push(chatId);
      await input.gates?.get(chatId);
      const result = Object.freeze(Object.create(null)) as object;
      effectResults.set(result, chatId);
      return result;
    },
    resume(continuation, settlement) {
      if (!continuation || typeof continuation !== 'object') {
        return { kind: 'unknown', message: 'invalid fake continuation' };
      }
      const chatId = continuations.get(continuation);
      if (!chatId) return { kind: 'unknown', message: 'foreign fake continuation' };
      if (settlement.kind === 'threw') {
        return { kind: 'unknown', message: String(settlement.error) };
      }
      if (!settlement.value || typeof settlement.value !== 'object'
          || effectResults.get(settlement.value) !== chatId) {
        return { kind: 'unknown', message: 'foreign fake effect result' };
      }
      const sessionId = `session-${chatId}`;
      inspections.set(chatId, { kind: 'occupied', sessionId });
      return { kind: 'created', sessionId };
    },
  };
  return { port, inspections, begins, executes };
}

function dashboardRouteRuntime(
  port: CurrentDashboardRouteOpeningPort
    | (() => CurrentDashboardRouteOpeningPort | undefined),
  activeSessions: Map<string, DaemonSession> = new Map(),
): SessionRuntime {
  return createCurrentOrdinaryRouteRegistryRuntime({
    ownerLarkAppId: OWNER,
    activeSessions,
    openingCreator: {
      begin() { throw new Error('ordinary opening must not run'); },
      async execute() { throw new Error('ordinary opening must not run'); },
      resume() { throw new Error('ordinary opening must not run'); },
      rollback() { throw new Error('ordinary opening must not run'); },
    },
    get dashboardRouteOpening() {
      return typeof port === 'function' ? port() : port;
    },
    downstream: {
      projection: { read: vi.fn(async () => ({ kind: 'notFound' as const })) },
      runtime: {
        submit: vi.fn(async () => ({ kind: 'quarantined', message: 'must not forward' })) as SessionRuntime['submit'],
      },
    },
  });
}

function submitDashboardSpawn(
  runtime: SessionRuntime,
  chatId: string,
  idempotencyKey: string,
  content?: string,
) {
  return runtime.submit({
    target: { kind: 'route', route: { kind: 'chat', chatId } },
    idempotencyKey,
    command: dashboardCommand(content),
  });
}

describe('Current Dashboard route opening admission', () => {
  it('joins a repeated stable operation before identity exists and executes its external effect once', async () => {
    const release = deferred<void>();
    const harness = dashboardOpeningHarness({ gates: new Map([[CHAT_ID, release.promise]]) });
    const runtime = dashboardRouteRuntime(harness.port);

    const first = submitDashboardSpawn(runtime, CHAT_ID, 'dashboard-spawn:same');
    const repeated = submitDashboardSpawn(runtime, CHAT_ID, 'dashboard-spawn:same');
    await vi.waitFor(() => expect(harness.executes).toEqual([CHAT_ID]));
    release.resolve();

    const outcomes = await Promise.all([first, repeated]);
    expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(['applied', 'duplicate']);
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'applied', sessionId: `session-${CHAT_ID}` }),
      expect.objectContaining({ kind: 'duplicate', sessionId: `session-${CHAT_ID}` }),
    ]));
    expect(harness.begins).toEqual([CHAT_ID]);
    expect(harness.executes).toEqual([CHAT_ID]);
  });

  it('rejects a stable operation key reused for different spawn semantics without a second effect', async () => {
    const harness = dashboardOpeningHarness();
    const runtime = dashboardRouteRuntime(harness.port);
    await expect(submitDashboardSpawn(runtime, CHAT_ID, 'dashboard-spawn:conflict', 'first'))
      .resolves.toMatchObject({ kind: 'applied' });

    await expect(submitDashboardSpawn(runtime, CHAT_ID, 'dashboard-spawn:conflict', 'different'))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'idempotencyConflict' });
    expect(harness.executes).toEqual([CHAT_ID]);
  });

  it('reserves not-wired spawn semantics while allowing the same input to retry', async () => {
    const harness = dashboardOpeningHarness();
    let wired = false;
    const runtime = dashboardRouteRuntime(() => wired ? harness.port : undefined);

    await expect(submitDashboardSpawn(
      runtime,
      CHAT_ID,
      'dashboard-spawn:not-wired-reservation',
      'first',
    )).resolves.toMatchObject({ kind: 'notWired' });
    wired = true;

    await expect(submitDashboardSpawn(
      runtime,
      CHAT_ID,
      'dashboard-spawn:not-wired-reservation',
      'different',
    )).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    expect(harness.begins).toEqual([]);
    expect(harness.executes).toEqual([]);

    await expect(submitDashboardSpawn(
      runtime,
      CHAT_ID,
      'dashboard-spawn:not-wired-reservation',
      'first',
    )).resolves.toMatchObject({
      kind: 'applied',
      sessionId: `session-${CHAT_ID}`,
    });
    expect(harness.begins).toEqual([CHAT_ID]);
    expect(harness.executes).toEqual([CHAT_ID]);
  });

  it('retries strict Store inspection failure under the same spawn hash without duplicating the effect', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const materializeImages = vi.fn(() => []);
    const spawn = vi.fn(async () => {
      const current = liveDaemonSession(
        OWNER,
        'session-dashboard-store-recovered',
        turn({
          messageKey: 'om_dashboard_store_recovered',
          scope: 'chat',
          chatId: CHAT_ID,
        }),
      );
      sessionStore.updateSession(current.session);
      activeSessions.set(activeSessionKey(current), current);
      return { ok: true as const, sessionId: current.session.sessionId };
    });
    const port = createCurrentDashboardRouteOpeningPort({
      ownerLarkAppId: OWNER,
      activeSessions,
      materializeImages,
      cleanupImages: vi.fn(),
      spawn,
    });
    const runtime = dashboardRouteRuntime(port, activeSessions);
    vi.spyOn(sessionStore, 'listSessionsForOwnerStrict')
      .mockImplementationOnce(() => { throw new Error('EIO: strict Store unavailable'); });
    const operationId = 'dashboard-spawn:strict-store-retry';

    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'first'))
      .resolves.toMatchObject({
        kind: 'retryable',
        message: expect.stringContaining('EIO'),
      });
    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'different'))
      .resolves.toMatchObject({
        kind: 'rejected',
        reason: 'idempotencyConflict',
      });
    expect(materializeImages).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();

    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'first'))
      .resolves.toMatchObject({
        kind: 'applied',
        sessionId: 'session-dashboard-store-recovered',
      });
    expect(materializeImages).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('retries a thrown route inspection without poisoning the route or operation hash', async () => {
    const harness = dashboardOpeningHarness();
    let inspectionReady = false;
    const inspect = vi.fn((route: Parameters<CurrentDashboardRouteOpeningPort['inspect']>[0]) => {
      if (!inspectionReady) throw new Error('route census temporarily unavailable');
      return harness.port.inspect(route);
    });
    const runtime = dashboardRouteRuntime({ ...harness.port, inspect });
    const operationId = 'dashboard-spawn:inspection-throw-retry';

    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'first'))
      .resolves.toMatchObject({
        kind: 'retryable',
        message: expect.stringContaining('temporarily unavailable'),
      });
    inspectionReady = true;
    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'different'))
      .resolves.toMatchObject({
        kind: 'rejected',
        reason: 'idempotencyConflict',
      });
    expect(harness.executes).toEqual([]);

    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'first'))
      .resolves.toMatchObject({ kind: 'applied' });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(harness.executes).toEqual([CHAT_ID]);
  });

  it('retries a pure opening-begin throw under the same hash without duplicating the effect', async () => {
    const harness = dashboardOpeningHarness();
    let beginReady = false;
    const begin = vi.fn((input: Parameters<CurrentDashboardRouteOpeningPort['begin']>[0]) => {
      if (!beginReady) throw new Error('opening policy temporarily unavailable');
      return harness.port.begin(input);
    });
    const runtime = dashboardRouteRuntime({ ...harness.port, begin });
    const operationId = 'dashboard-spawn:begin-retry';

    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'first'))
      .resolves.toMatchObject({
        kind: 'retryable',
        message: expect.stringContaining('temporarily unavailable'),
      });
    beginReady = true;
    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'different'))
      .resolves.toMatchObject({
        kind: 'rejected',
        reason: 'idempotencyConflict',
      });
    expect(harness.executes).toEqual([]);

    await expect(submitDashboardSpawn(runtime, CHAT_ID, operationId, 'first'))
      .resolves.toMatchObject({ kind: 'applied' });
    expect(begin).toHaveBeenCalledTimes(2);
    expect(harness.executes).toEqual([CHAT_ID]);
  });

  it('replays a terminal spawn rejection and permanently rejects different semantics', async () => {
    const harness = dashboardOpeningHarness();
    harness.inspections.set(CHAT_ID, {
      kind: 'occupied',
      sessionId: 'session-existing-dashboard-route',
    });
    const runtime = dashboardRouteRuntime(harness.port);

    await expect(submitDashboardSpawn(
      runtime,
      CHAT_ID,
      'dashboard-spawn:terminal-rejected',
      'first',
    )).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'sessionExists',
    });
    harness.inspections.set(CHAT_ID, { kind: 'vacant' });

    await expect(submitDashboardSpawn(
      runtime,
      CHAT_ID,
      'dashboard-spawn:terminal-rejected',
      'different',
    )).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    await expect(submitDashboardSpawn(
      runtime,
      CHAT_ID,
      'dashboard-spawn:terminal-rejected',
      'first',
    )).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'sessionExists',
    });
    expect(harness.begins).toEqual([]);
    expect(harness.executes).toEqual([]);
  });

  it('gives distinct concurrent operations on one route one creator and one occupied-route refusal', async () => {
    const release = deferred<void>();
    const harness = dashboardOpeningHarness({ gates: new Map([[CHAT_ID, release.promise]]) });
    const runtime = dashboardRouteRuntime(harness.port);

    const first = submitDashboardSpawn(runtime, CHAT_ID, 'dashboard-spawn:winner');
    await vi.waitFor(() => expect(harness.executes).toEqual([CHAT_ID]));
    const loser = submitDashboardSpawn(runtime, CHAT_ID, 'dashboard-spawn:loser');
    await Promise.resolve();
    expect(harness.begins).toEqual([CHAT_ID]);
    release.resolve();

    await expect(first).resolves.toMatchObject({ kind: 'applied' });
    await expect(loser).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'sessionExists',
    });
    expect(harness.executes).toEqual([CHAT_ID]);
  });

  it('does not serialize a slow Dashboard opening on route A with route B', async () => {
    const chatA = 'oc_dashboard_route_a';
    const chatB = 'oc_dashboard_route_b';
    const releaseA = deferred<void>();
    const harness = dashboardOpeningHarness({ gates: new Map([[chatA, releaseA.promise]]) });
    const runtime = dashboardRouteRuntime(harness.port);

    const first = submitDashboardSpawn(runtime, chatA, 'dashboard-spawn:route-a');
    await vi.waitFor(() => expect(harness.executes).toEqual([chatA]));
    const second = submitDashboardSpawn(runtime, chatB, 'dashboard-spawn:route-b');

    await expect(second).resolves.toMatchObject({ kind: 'applied', sessionId: `session-${chatB}` });
    expect(harness.executes).toEqual([chatA, chatB]);
    releaseA.resolve();
    await expect(first).resolves.toMatchObject({ kind: 'applied', sessionId: `session-${chatA}` });
  });

  it('lets an earlier ordinary opening win the shared chat route before Dashboard materializes', async () => {
    const routeTurn = turn({
      messageKey: 'om_ordinary_wins_dashboard_race',
      scope: 'chat',
      chatId: 'oc_ordinary_wins_dashboard_race',
    });
    const releaseOrdinary = deferred<void>();
    const ordinary = createHarness({
      materializationGate: releaseOrdinary.promise,
      persistMetadata: true,
    });
    const dashboardSpawn = vi.fn();
    const dashboardImages = vi.fn(() => []);
    const dashboardPort = createCurrentDashboardRouteOpeningPort({
      ownerLarkAppId: OWNER,
      activeSessions: ordinary.activeSessions,
      materializeImages: dashboardImages,
      cleanupImages: vi.fn(),
      spawn: dashboardSpawn,
    });
    const dashboard = dashboardRouteRuntime(dashboardPort, ordinary.activeSessions);

    const opening = ordinary.submit(routeTurn);
    await vi.waitFor(() => expect(ordinary.effects).toHaveLength(1));
    const competing = submitDashboardSpawn(
      dashboard,
      routeTurn.route.chatId,
      'dashboard-spawn:ordinary-winner',
    );
    await Promise.resolve();
    expect(dashboardImages).not.toHaveBeenCalled();
    expect(dashboardSpawn).not.toHaveBeenCalled();
    releaseOrdinary.resolve();

    await expect(opening).resolves.toMatchObject({ kind: 'applied' });
    const competingOutcome = await competing;
    expect(competingOutcome).toMatchObject({
      kind: 'rejected',
      reason: 'sessionExists',
    });
    expect(ordinary.openingSessions).toHaveLength(1);
    expect(ordinary.activeSessions.size).toBe(1);
    expect(dashboardImages).not.toHaveBeenCalled();
    expect(dashboardSpawn).not.toHaveBeenCalled();
  });

  it('lets an earlier Dashboard opening publish one route before ordinary ingress resolves it', async () => {
    const routeTurn = turn({
      messageKey: 'om_dashboard_wins_ordinary_race',
      scope: 'chat',
      chatId: 'oc_dashboard_wins_ordinary_race',
    });
    const activeSessions = new Map<string, DaemonSession>();
    const releaseDashboard = deferred<void>();
    const dashboardStarted = deferred<void>();
    const materializeImages = vi.fn(() => []);
    const spawn = vi.fn(async () => {
      dashboardStarted.resolve();
      await releaseDashboard.promise;
      const current = liveDaemonSession(
        OWNER,
        'session-dashboard-wins-route',
        routeTurn,
      );
      sessionStore.updateSession(current.session);
      activeSessions.set(activeSessionKey(current), current);
      return { ok: true as const, sessionId: current.session.sessionId };
    });
    const dashboardPort = createCurrentDashboardRouteOpeningPort({
      ownerLarkAppId: OWNER,
      activeSessions,
      materializeImages,
      cleanupImages: vi.fn(),
      spawn,
    });
    const dashboard = dashboardRouteRuntime(dashboardPort, activeSessions);
    const ordinary = createHarness({ activeSessions, persistMetadata: true });

    const opening = submitDashboardSpawn(
      dashboard,
      routeTurn.route.chatId,
      'dashboard-spawn:dashboard-winner',
    );
    await dashboardStarted.promise;
    const competing = ordinary.submit(routeTurn);
    await Promise.resolve();
    expect(ordinary.openingSessions).toHaveLength(0);
    expect(ordinary.effects).toHaveLength(0);
    releaseDashboard.resolve();

    await expect(opening).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-dashboard-wins-route',
    });
    await expect(competing).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-dashboard-wins-route',
    });
    expect(activeSessions.size).toBe(1);
    expect(ordinary.openingSessions).toHaveLength(0);
    expect(ordinary.effects).toHaveLength(1);
    expect(materializeImages).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
