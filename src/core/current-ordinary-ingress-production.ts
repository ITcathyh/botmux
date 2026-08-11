/**
 * Production-state Adapter for Current ordinary IM ingress.
 *
 * This module deliberately composes the staged Current ingress port: that port
 * remains the sole owner of compilation, Session-lane arrival ordering, and
 * replay classification.  This Adapter owns the mutable daemon projection and
 * exposes only detached materialization and worker-process effects.
 *
 * The daemon wires this policy for resolved ordinary-message owners. Route
 * creation and other producers enter through their own Current adapters rather
 * than reimplementing this state matrix.
 */

import { randomUUID } from 'node:crypto';

import * as sessionStore from '../services/session-store.js';
import type {
  CliTurnPayload,
  CodexAppTurnInput,
  QueuedActivationTailEntry,
  Session,
} from '../types.js';
import {
  createCurrentOrdinaryImTurnPreparationPort,
  type PreparedOrdinaryImTurn,
} from './current-ordinary-im-turn.js';
import type { CurrentOrdinaryIngressMetadataModule } from './current-ordinary-ingress-metadata.js';
import {
  classifyCurrentOrdinaryIngress,
  createCurrentOrdinaryIngressPort,
  type CurrentOrdinaryIngressCommand,
  type CurrentOrdinaryIngressCommandResult,
  type CurrentOrdinaryIngressExternalEffectResult,
  type CurrentOrdinaryIngressPreMaterializationModule,
} from './current-ordinary-ingress.js';
import { stagePendingRepoSetup } from './pending-repo-journal.js';
import {
  publishLastInputFromBotPatch,
  publishSessionActivityPatch,
  publishSessionMessagePreviewPatch,
} from './session-activity.js';
import type { OrdinaryIngressPort } from './session-runtime.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  sessionKey,
  type DaemonSession,
} from './types.js';
import {
  admitQueuedActivationTail,
  hasQueuedActivationAdmissionGate,
  prepareQueuedActivationRecoveryFork,
  reserveQueuedActivationTailAdmission,
} from './worker-pool.js';

export interface CurrentOrdinaryIngressProductionMaterial {
  /** Follow-up/refork semantic prompt. */
  readonly userPrompt: string;
  /** Opening semantic prompt, including opening-only route context. */
  readonly newTopicUserPrompt: string;
  /** Follow-up/refork candidate; opening authority is deliberately unknown here. */
  readonly cliInput: CliTurnPayload;
  /** Opening candidate selected only after the reducer claims the exact opening. */
  readonly newTopicCliInput: CliTurnPayload;
  /** Bridge candidate selected only when Current is an adopted Session. */
  readonly adoptCliInput: CliTurnPayload;
  readonly turnId: string;
  /** Completed received-reaction effect; registration stays with the metadata Module. */
  readonly receivedReaction?: {
    readonly messageKey: string;
    readonly reactionId: string;
  };
}

export type CurrentOrdinaryIngressProductionExternalEffect = {
  readonly kind: 'materialize';
  readonly input: {
    readonly sessionId: string;
    readonly turn: PreparedOrdinaryImTurn;
  };
};

export type CurrentOrdinaryIngressProductionExternalEffectResult =
  | {
      readonly kind: 'materialized';
      readonly material: CurrentOrdinaryIngressProductionMaterial;
    }
  | { readonly kind: 'completed' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

export interface CurrentOrdinaryIngressProductionExternalEffects {
  execute(
    effect: CurrentOrdinaryIngressProductionExternalEffect,
  ): Promise<CurrentOrdinaryIngressProductionExternalEffectResult>;
}

export type CurrentOrdinaryIngressWorkerProcessCommand =
  | {
      readonly kind: 'sendWorkerInput';
      readonly sessionId: string;
      readonly turnId: string;
      readonly input: CliTurnPayload;
      readonly workerGeneration: number;
    }
  | {
      readonly kind: 'forkWorker';
      readonly sessionId: string;
      readonly turnId: string;
      readonly input: CliTurnPayload;
      readonly resume: boolean;
      /** Exact durable activation identity; absent only for a non-journaled cold fork. */
      readonly queuedActivationToken?: string;
      readonly dispatchAttempt?: number;
    }
  | {
      readonly kind: 'forkAdoptWorker';
      readonly sessionId: string;
      readonly turnId: string;
      readonly input: CliTurnPayload;
    };

export type CurrentOrdinaryIngressWorkerProcessResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }
  | { readonly kind: 'stateChanged' };

export interface CurrentOrdinaryIngressWorkerProcesses {
  dispatch(
    command: CurrentOrdinaryIngressWorkerProcessCommand,
  ): Promise<CurrentOrdinaryIngressWorkerProcessResult>;
}

export interface CurrentOrdinaryIngressProductionOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
  readonly externalEffects: CurrentOrdinaryIngressProductionExternalEffects;
  readonly workerProcesses: CurrentOrdinaryIngressWorkerProcesses;
  readonly metadata: CurrentOrdinaryIngressMetadataModule;
  readonly preMaterialization?: CurrentOrdinaryIngressPreMaterializationModule;
  readonly clock: () => number;
  readonly substituteReplyMode: 'thread' | 'quote';
  /**
   * Synchronous per-turn stream-card rotation applied immediately before a
   * worker delivery attempt. `live` precedes an injection into a running
   * worker; `refork` precedes a fork replacing a dead/absent worker. Skipped
   * only for an opening fork with NO existing card binding (a genuinely fresh
   * Session, whose title is owned by the opening record) — an opening turn on
   * an empty-started session that already POSTed a card still rotates.
   */
  readonly beginTurnCardRotation?: (
    current: DaemonSession,
    turn: { readonly title: string; readonly turnId: string; readonly mode: 'live' | 'refork' },
  ) => void;
  /**
   * Fire-and-forget stash notice after a follower turn was parked behind an
   * existing pending-repo opening ("pick a repo first" / "worktree building").
   */
  readonly notifyPendingRepoStash?: (current: DaemonSession) => void;
}

type FrozenMaterial = Readonly<{
  userPrompt: string;
  newTopicUserPrompt: string;
  cliInput: CliTurnPayload;
  newTopicCliInput: CliTurnPayload;
  adoptCliInput: CliTurnPayload;
  turnId: string;
  receivedReaction?: Readonly<{ messageKey: string; reactionId: string }>;
}>;

type ProductionCommandResult = CurrentOrdinaryIngressCommandResult;

interface WorkerDispatchPlan {
  readonly command: CurrentOrdinaryIngressCommand;
  readonly workerCommand: CurrentOrdinaryIngressWorkerProcessCommand;
  readonly dispatchOptions: {
    readonly durableInput: boolean;
    readonly restoreTransientGate?: () => void;
  };
  readonly current: DaemonSession;
  readonly selectedMaterial: FrozenMaterial;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object';
}

const MATERIAL_KEYS = new Set([
  'userPrompt',
  'newTopicUserPrompt',
  'cliInput',
  'newTopicCliInput',
  'adoptCliInput',
  'turnId',
  'receivedReaction',
]);
const RECEIVED_REACTION_KEYS = new Set(['messageKey', 'reactionId']);
const CLI_INPUT_KEYS = new Set(['content', 'codexAppInput', 'codexAppSteerable']);
const CODEX_INPUT_KEYS = new Set([
  'text',
  'additionalContext',
  'localImages',
  'clientUserMessageId',
]);
const CODEX_CONTEXT_KEYS = new Set(['kind', 'value']);
const LOCAL_IMAGE_KEYS = new Set(['path', 'detail']);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isObject(value) || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function hasOnlyDataProperties(value: object, allowed: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

function cloneCodexAppInput(value: unknown): CodexAppTurnInput | undefined {
  try {
    if (!isObject(value)
      || !hasOnlyDataProperties(value, CODEX_INPUT_KEYS)
      || typeof value.text !== 'string') {
      return undefined;
    }

    let additionalContext: CodexAppTurnInput['additionalContext'];
    if (value.additionalContext !== undefined) {
      if (!isObject(value.additionalContext)) return undefined;
      additionalContext = {};
      for (const key of Reflect.ownKeys(value.additionalContext)) {
        if (typeof key !== 'string') return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(value.additionalContext, key);
        if (!descriptor || !('value' in descriptor) || !isObject(descriptor.value)) {
          return undefined;
        }
        const entry = descriptor.value;
        if (!hasOnlyDataProperties(entry, CODEX_CONTEXT_KEYS)
          || (entry.kind !== 'untrusted' && entry.kind !== 'application')
          || typeof entry.value !== 'string') {
          return undefined;
        }
        additionalContext[key] = { kind: entry.kind, value: entry.value };
      }
    }

    let localImages: CodexAppTurnInput['localImages'];
    if (value.localImages !== undefined) {
      if (!Array.isArray(value.localImages)) return undefined;
      localImages = [];
      for (const candidate of value.localImages) {
        if (!isObject(candidate)
          || !hasOnlyDataProperties(candidate, LOCAL_IMAGE_KEYS)
          || typeof candidate.path !== 'string'
          || (candidate.detail !== undefined
            && candidate.detail !== 'auto'
            && candidate.detail !== 'low'
            && candidate.detail !== 'high'
            && candidate.detail !== 'original')) {
          return undefined;
        }
        localImages.push({
          path: candidate.path,
          ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
        });
      }
    }

    if (value.clientUserMessageId !== undefined
      && typeof value.clientUserMessageId !== 'string') {
      return undefined;
    }
    return deepFreeze({
      text: value.text,
      ...(additionalContext !== undefined ? { additionalContext } : {}),
      ...(localImages !== undefined ? { localImages } : {}),
      ...(value.clientUserMessageId !== undefined
        ? { clientUserMessageId: value.clientUserMessageId }
        : {}),
    });
  } catch {
    return undefined;
  }
}

function cloneCliInput(value: unknown): CliTurnPayload | undefined {
  try {
    if (!isObject(value)
      || !hasOnlyDataProperties(value, CLI_INPUT_KEYS)
      || typeof value.content !== 'string'
      || (value.codexAppSteerable !== undefined && value.codexAppSteerable !== true)) {
      return undefined;
    }
    const codexAppInput = value.codexAppInput === undefined
      ? undefined
      : cloneCodexAppInput(value.codexAppInput);
    if (value.codexAppInput !== undefined && !codexAppInput) return undefined;
    const cloned: CliTurnPayload = {
      content: value.content,
      ...(codexAppInput ? { codexAppInput } : {}),
      ...(value.codexAppSteerable === true ? { codexAppSteerable: true } : {}),
    };
    return deepFreeze(cloned);
  } catch {
    return undefined;
  }
}

function cloneMaterial(value: unknown): FrozenMaterial | undefined {
  try {
    if (!isObject(value)
      || !hasOnlyDataProperties(value, MATERIAL_KEYS)
      || typeof value.userPrompt !== 'string'
      || typeof value.newTopicUserPrompt !== 'string'
      || typeof value.turnId !== 'string') {
      return undefined;
    }
    const cliInput = cloneCliInput(value.cliInput);
    const newTopicCliInput = cloneCliInput(value.newTopicCliInput);
    const adoptCliInput = cloneCliInput(value.adoptCliInput);
    if (!cliInput || !newTopicCliInput || !adoptCliInput) return undefined;
    let receivedReaction: FrozenMaterial['receivedReaction'];
    if (value.receivedReaction !== undefined) {
      const evidence = value.receivedReaction;
      if (!isObject(evidence)
        || !hasOnlyDataProperties(evidence, RECEIVED_REACTION_KEYS)
        || typeof evidence.messageKey !== 'string'
        || typeof evidence.reactionId !== 'string'
        || evidence.reactionId.length === 0) {
        return undefined;
      }
      receivedReaction = Object.freeze({
        messageKey: evidence.messageKey,
        reactionId: evidence.reactionId,
      });
    }
    return Object.freeze({
      userPrompt: value.userPrompt,
      newTopicUserPrompt: value.newTopicUserPrompt,
      cliInput,
      newTopicCliInput,
      adoptCliInput,
      turnId: value.turnId,
      ...(receivedReaction ? { receivedReaction } : {}),
    });
  } catch {
    return undefined;
  }
}

function cloneKnownCliInput(value: CliTurnPayload): CliTurnPayload {
  return deepFreeze({
    content: value.content,
    ...(value.codexAppInput
      ? { codexAppInput: structuredClone(value.codexAppInput) }
      : {}),
    ...(value.codexAppSteerable === true ? { codexAppSteerable: true } : {}),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refused(reason: string): ProductionCommandResult {
  return { kind: 'refused', message: reason };
}

function unknown(reason: string): ProductionCommandResult {
  return { kind: 'unknown', message: reason };
}

function routeMatches(ds: DaemonSession, turn: PreparedOrdinaryImTurn): boolean {
  return ds.scope === turn.route.scope
    && ds.chatId === turn.route.chatId
    && ds.chatType === turn.route.chatType
    && activeSessionAnchorId(ds) === turn.route.canonicalAnchor;
}

function resolveCurrent(
  options: CurrentOrdinaryIngressProductionOptions,
  command: CurrentOrdinaryIngressCommand,
): DaemonSession | undefined {
  const { turn, sessionId } = command.input;
  const key = sessionKey(turn.route.canonicalAnchor, options.ownerLarkAppId);
  const current = options.activeSessions.get(key);
  if (!current
    || activeSessionKey(current) !== key
    || current.larkAppId !== options.ownerLarkAppId
    || current.session.sessionId !== sessionId
    || !routeMatches(current, turn)) {
    return undefined;
  }
  return current;
}

function stageActivationJournal(
  ds: DaemonSession,
  args: {
    readonly input: CliTurnPayload;
    readonly turnId: string;
    readonly dispatchAttempt?: number;
    readonly resume: boolean;
    readonly tail?: QueuedActivationTailEntry[];
  },
): { readonly kind: 'staged'; readonly token: string }
  | { readonly kind: 'unknown'; readonly message: string } {
  const token = randomUUID();
  ds.session.queued = false;
  ds.session.queuedPrompt = undefined;
  ds.session.queuedCodexAppText = undefined;
  ds.session.queuedCodexAppMessageContext = undefined;
  ds.session.queuedAttachments = undefined;
  ds.session.queuedActivationPending = true;
  ds.session.queuedActivationToken = token;
  ds.session.queuedActivationInput = args.input;
  ds.session.queuedActivationTurnId = args.turnId;
  ds.session.queuedActivationDispatchAttempt = args.dispatchAttempt;
  ds.session.queuedActivationResume = args.resume;
  ds.session.queuedActivationTail = args.tail && args.tail.length > 0
    ? args.tail
    : undefined;
  ds.session.pendingRepoSetup = undefined;
  ds.pendingPrompt = args.input.content;
  ds.initialStartPending = true;
  try {
    sessionStore.updateSession(ds.session);
    return { kind: 'staged', token };
  } catch (error) {
    // The synchronous Store API cannot distinguish a pre-write failure from a
    // published write whose response was lost.  Keep the exact candidate as
    // the live mirror so a later whole-row save cannot erase a durable journal
    // that may already exist.  Runtime settles this attempt as commit-unknown.
    return {
      kind: 'unknown',
      message: `ordinary ingress activation journal was not persisted: ${message(error)}`,
    };
  }
}

function admitTail(
  ds: DaemonSession,
  material: FrozenMaterial,
): ProductionCommandResult | undefined {
  const reservation = reserveQueuedActivationTailAdmission(ds);
  const candidate: QueuedActivationTailEntry = {
    id: reservation.id,
    order: reservation.order,
    userPrompt: material.userPrompt,
    cliInput: cloneKnownCliInput(material.cliInput),
    turnId: material.turnId,
  };
  try {
    admitQueuedActivationTail(ds, {
      userPrompt: candidate.userPrompt,
      cliInput: candidate.cliInput,
      turnId: candidate.turnId,
    }, reservation, { codexAppInputGateFrozen: true });
    return undefined;
  } catch (error) {
    const tail = [...(ds.session.queuedActivationTail ?? [])];
    if (!tail.some(entry => entry.id === candidate.id)) tail.push(candidate);
    tail.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    ds.session.queuedActivationTail = tail;
    return unknown(`ordinary ingress activation tail was not persisted: ${message(error)}`);
  }
}

function settleWorkerDispatch(
  result: CurrentOrdinaryIngressWorkerProcessResult,
  options: {
    readonly durableInput: boolean;
    readonly restoreTransientGate?: () => void;
  },
): ProductionCommandResult {
  if (!isObject(result)) {
    return unknown('ordinary ingress worker process Adapter returned an invalid result');
  }
  if (result.kind === 'accepted') return { kind: 'accepted' };
  if (result.kind === 'stateChanged') return { kind: 'stateChanged' };
  if (result.kind === 'unknown') {
    return unknown(typeof result.message === 'string'
      ? result.message
      : 'ordinary ingress worker dispatch outcome is unknown');
  }
  if (result.kind === 'refused') {
    options.restoreTransientGate?.();
    return options.durableInput
      ? { kind: 'accepted' }
      : refused(typeof result.message === 'string'
        ? result.message
        : 'ordinary ingress worker process refused the command');
  }
  return unknown('ordinary ingress worker process Adapter returned an invalid result');
}

function pendingRepoHasOpening(ds: DaemonSession): boolean {
  return ds.pendingRepoCommitInFlight === true
    || (ds.session.queuedActivationTail?.length ?? 0) > 0
    || ds.session.pendingRepoSetup?.cliInput !== undefined
    || (ds.pendingPrompt?.trim().length ?? 0) > 0
    || (ds.pendingAttachments?.length ?? 0) > 0
    || !!ds.pendingRawInput;
}

function stagePendingRepoOpening(
  ds: DaemonSession,
  material: FrozenMaterial,
): ProductionCommandResult {
  ds.pendingPrompt = material.userPrompt;
  ds.pendingTurnId = material.turnId;
  ds.pendingCodexAppText = material.cliInput.codexAppInput?.text;
  const existingSetup = ds.session.pendingRepoSetup;
  const candidateSetup: NonNullable<Session['pendingRepoSetup']> = {
    mode: existingSetup?.mode ?? 'picker',
    prompt: material.userPrompt,
    cliInput: cloneKnownCliInput(material.cliInput),
    ...(existingSetup?.baseDir ? { baseDir: existingSetup.baseDir } : {}),
    turnId: material.turnId,
    ...(ds.pendingCodexAppText === undefined
      ? {}
      : { codexAppText: ds.pendingCodexAppText }),
  };
  try {
    stagePendingRepoSetup(ds, {
      mode: candidateSetup.mode,
      ...(candidateSetup.baseDir ? { baseDir: candidateSetup.baseDir } : {}),
      turnId: candidateSetup.turnId,
      cliInput: candidateSetup.cliInput,
    });
    return { kind: 'accepted' };
  } catch (error) {
    // As with activation journals, an exception may be a lost response after
    // publication. Preserve the exact candidate mirror rather than restoring
    // stale pre-write fields that a later whole-row save could republish.
    ds.session.queued = true;
    ds.session.queuedPrompt = candidateSetup.prompt;
    ds.session.queuedCodexAppText = candidateSetup.codexAppText;
    ds.session.queuedCodexAppMessageContext = candidateSetup.codexAppMessageContext;
    ds.session.pendingRepoSetup = candidateSetup;
    return unknown(`ordinary ingress pending-repo opening was not persisted: ${message(error)}`);
  }
}

function rememberAcceptedInput(
  ds: DaemonSession,
  material: FrozenMaterial,
): ProductionCommandResult | undefined {
  const exactInput = cloneKnownCliInput(material.cliInput);
  ds.suppressRecoveryCard = undefined;
  ds.lastUserPrompt = material.userPrompt;
  ds.lastCliInput = exactInput.content;
  ds.lastCodexAppInput = exactInput.codexAppInput;
  ds.session.lastUserPrompt = material.userPrompt;
  ds.session.lastCliInput = exactInput.content;
  ds.session.lastCodexAppInput = exactInput.codexAppInput;
  ds.session.replyThreadAliases = ds.replyThreadAliases;
  ds.session.currentReplyTarget = ds.currentReplyTarget;
  try {
    sessionStore.updateSession(ds.session);
    return undefined;
  } catch (error) {
    return unknown(
      `ordinary ingress accepted-input metadata outcome is unknown: ${message(error)}`,
    );
  }
}

function orderedTail(session: Session): QueuedActivationTailEntry[] {
  return [...(session.queuedActivationTail ?? [])]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** Neither seam receives mutable Session/worker authority; dispatch is synchronous. */
export function createCurrentOrdinaryIngressProductionPort(
  options: CurrentOrdinaryIngressProductionOptions,
): OrdinaryIngressPort {
  const materials = new WeakMap<PreparedOrdinaryImTurn, FrozenMaterial>();
  const metadataCommitted = new WeakSet<PreparedOrdinaryImTurn>();
  const workerEffects = new WeakMap<object, WorkerDispatchPlan>();
  const workerContinuations = new WeakMap<object, WorkerDispatchPlan>();
  const effectToken = (): object => Object.freeze(Object.create(null)) as object;

  return createCurrentOrdinaryIngressPort({
    ownerLarkAppId: options.ownerLarkAppId,
    activeSessions: options.activeSessions,
    turnPreparation: createCurrentOrdinaryImTurnPreparationPort(),
    ...(options.preMaterialization
      ? { preMaterialization: options.preMaterialization }
      : {}),
    externalEffects: {
      async execute(effect): Promise<CurrentOrdinaryIngressExternalEffectResult> {
        const detachedEffect: CurrentOrdinaryIngressProductionExternalEffect = Object.freeze({
          kind: 'materialize',
          input: Object.freeze({
            sessionId: effect.input.sessionId,
            turn: effect.input.turn,
          }),
        });
        const result = await options.externalEffects.execute(detachedEffect);
        if (!isObject(result)) {
          return { kind: 'unknown', message: 'ordinary ingress materializer returned an invalid result' };
        }
        if (result.kind === 'refused') {
          return {
            kind: 'refused',
            message: typeof result.message === 'string'
              ? result.message
              : 'ordinary ingress materializer refused the turn',
          };
        }
        if (result.kind === 'unknown') {
          return {
            kind: 'unknown',
            message: typeof result.message === 'string'
              ? result.message
              : 'ordinary ingress materialization outcome is unknown',
          };
        }
        if (result.kind !== 'materialized') {
          return { kind: 'unknown', message: 'ordinary ingress materializer did not return material' };
        }
        const material = cloneMaterial(result.material);
        if (!material || material.turnId !== effect.input.turn.messageKey) {
          return { kind: 'unknown', message: 'ordinary ingress materializer returned invalid turn material' };
        }
        materials.set(effect.input.turn, material);
        return { kind: 'materialized' };
      },
    },
    commands: {
      apply(command): ProductionCommandResult {
        const material = materials.get(command.input.turn);
        if (!material) {
          return unknown('ordinary ingress material was not retained for delivery');
        }
        const current = resolveCurrent(options, command);
        if (!current) {
          materials.delete(command.input.turn);
          return unknown('Current Session identity changed before production-state delivery');
        }
        if (classifyCurrentOrdinaryIngress(current) !== command.kind) {
          return { kind: 'stateChanged' };
        }
        if (!metadataCommitted.has(command.input.turn)) {
          const activityAtMs = options.clock();
          const metadata = options.metadata.apply(current, {
            binding: {
              ownerLarkAppId: options.ownerLarkAppId,
              sessionId: command.input.sessionId,
              route: command.input.turn.route,
            },
            turn: command.input.turn,
            activityAtMs,
            replyMode: command.input.turn.substitute
              ? options.substituteReplyMode
              : 'thread',
            ...(material.receivedReaction
              ? { receivedReaction: material.receivedReaction }
              : {}),
          });
          if (metadata.kind === 'unknown') return unknown(metadata.message);
          if (metadata.kind === 'rejected') {
            if (metadata.reason === 'bindingMismatch') return { kind: 'stateChanged' };
            if (metadata.reason === 'vcOriginUnproven') return refused(metadata.message);
            return unknown(metadata.message);
          }
          metadataCommitted.add(command.input.turn);
          // Dashboard SSE patches derived from the metadata the Module just
          // committed. Pure projection — no store writes belong here, and a
          // failed publish must not change the turn's outcome.
          try {
            publishSessionActivityPatch(current, activityAtMs);
            publishLastInputFromBotPatch(current);
            publishSessionMessagePreviewPatch(current);
          } catch {
            // Rebuilt on the next full hydrate.
          }
        }
        const selectedCliInput = current.adoptedFrom
          ? material.adoptCliInput
          : command.input.opening
            ? material.newTopicCliInput
            : material.cliInput;
        const selectedUserPrompt = !current.adoptedFrom && command.input.opening
          ? material.newTopicUserPrompt
          : material.userPrompt;
        const selectedMaterial: FrozenMaterial = selectedCliInput === material.cliInput
          && selectedUserPrompt === material.userPrompt
          ? material
          : Object.freeze({
              ...material,
              userPrompt: selectedUserPrompt,
              cliInput: selectedCliInput,
            });

        const deliverWorker = (
          workerCommand: CurrentOrdinaryIngressWorkerProcessCommand,
          dispatchOptions: {
            readonly durableInput: boolean;
            readonly restoreTransientGate?: () => void;
          },
        ): ProductionCommandResult => {
          const live = workerCommand.kind === 'sendWorkerInput';
          // The opening exemption is keyed on CARD state, not the opening flag
          // alone: `opening` comes from the persisted initialUserTurnPending,
          // which also covers empty-started sessions (repo picker / mid-session
          // /repo switch) whose worker_ready already POSTed a real card. A cold
          // refork of such a session must still park + rotate, or the new turn
          // PATCHes the stale card and revives its stale image key. Only a
          // genuinely card-less opening keeps its title/card slot owned by the
          // opening record.
          const openingWithoutCard = command.input.opening === true
            && current.streamCardId === undefined;
          if (options.beginTurnCardRotation && (live || !openingWithoutCard)) {
            options.beginTurnCardRotation(current, {
              title: command.input.turn.content,
              turnId: workerCommand.turnId,
              mode: live ? 'live' : 'refork',
            });
          }
          const plan: WorkerDispatchPlan = {
            command,
            workerCommand: deepFreeze(workerCommand),
            dispatchOptions,
            current,
            selectedMaterial,
          };
          const intent = effectToken();
          const continuation = effectToken();
          workerEffects.set(intent, plan);
          workerContinuations.set(continuation, plan);
          return { kind: 'effect', intent, continuation };
        };

        let result: ProductionCommandResult;
        switch (command.kind) {
          case 'sendLive': {
            if (current.workerGeneration !== command.guard.workerGeneration
              || command.guard.workerGeneration === undefined) {
              return { kind: 'stateChanged' };
            }
            result = deliverWorker({
              kind: 'sendWorkerInput',
              sessionId: current.session.sessionId,
              turnId: selectedMaterial.turnId,
              input: cloneKnownCliInput(selectedMaterial.cliInput),
              workerGeneration: command.guard.workerGeneration,
            }, { durableInput: false });
            break;
          }

          case 'parkPendingRepoFollower': {
            const hasOpening = pendingRepoHasOpening(current);
            result = hasOpening
              ? (admitTail(current, selectedMaterial) ?? { kind: 'accepted' })
              : stagePendingRepoOpening(current, Object.freeze({
                  ...material,
                  userPrompt: material.newTopicUserPrompt,
                  cliInput: material.newTopicCliInput,
                }));
            if (hasOpening && result.kind === 'accepted') {
              try {
                options.notifyPendingRepoStash?.(current);
              } catch {
                // Auxiliary notice; the parked turn itself is committed.
              }
            }
            break;
          }

          case 'parkOpeningFollower': {
            const tailAdmission = admitTail(current, selectedMaterial);
            if (tailAdmission) {
              result = tailAdmission;
              break;
            }
            if (!current.quarantinedActivationTailPromotion) {
              result = { kind: 'accepted' };
              break;
            }
            // The quarantine may describe either a tail-only restore failure or
            // a journal whose store publish succeeded before its response was
            // lost. Only worker-pool can distinguish those states: the latter
            // requires an exact fresh-row proof and must never be reconstructed
            // from tail[0], which is already the successor.
            const recovery = prepareQueuedActivationRecoveryFork(current);
            if (recovery.kind !== 'ready') {
              // The current turn already crossed its tail-store boundary. Keep
              // this result commit-unknown so Runtime never replays that turn.
              result = unknown(recovery.message);
              break;
            }
            const recoveredInput = typeof recovery.promptInput === 'string'
              ? cloneKnownCliInput({ content: recovery.promptInput })
              : cloneKnownCliInput(recovery.promptInput);
            current.quarantinedActivationTailPromotion = undefined;
            result = deliverWorker({
              kind: 'forkWorker',
              sessionId: current.session.sessionId,
              turnId: recovery.resumeOrTurnId.turnId,
              input: recoveredInput,
              resume: recovery.resumeOrTurnId.resume,
              queuedActivationToken: current.session.queuedActivationToken,
              ...(recovery.resumeOrTurnId.dispatchAttempt === undefined
                ? {}
                : { dispatchAttempt: recovery.resumeOrTurnId.dispatchAttempt }),
            }, {
              durableInput: true,
              restoreTransientGate: () => { current.initialStartPending = false; },
            });
            break;
          }

          case 'recoverParkedActivation': {
            const retainedInput = cloneCliInput(current.session.queuedActivationInput);
            const retainedTurnId = current.session.queuedActivationTurnId;
            const retainedToken = current.session.queuedActivationToken;
            const retainedDispatchAttempt = current.session.queuedActivationDispatchAttempt;
            const retainedResume = current.session.queuedActivationResume ?? current.hasHistory;
            if (!retainedInput
              || typeof retainedTurnId !== 'string'
              || typeof retainedToken !== 'string'
              || retainedToken.length === 0) {
              result = unknown('queued activation journal is incomplete');
              break;
            }
            const tailAdmission = admitTail(current, selectedMaterial);
            if (tailAdmission) {
              result = tailAdmission;
              break;
            }
            const priorStartPending = current.initialStartPending;
            current.initialStartPending = true;
            result = deliverWorker({
              kind: 'forkWorker',
              sessionId: current.session.sessionId,
              turnId: retainedTurnId,
              input: cloneKnownCliInput(retainedInput),
              resume: retainedResume,
              queuedActivationToken: retainedToken,
              ...(retainedDispatchAttempt === undefined
                ? {}
                : { dispatchAttempt: retainedDispatchAttempt }),
            }, {
              durableInput: true,
              restoreTransientGate: () => { current.initialStartPending = priorStartPending; },
            });
            break;
          }

          case 'startQueuedActivation': {
            const queuedPrompt = current.session.queuedPrompt;
            if (queuedPrompt === undefined) return { kind: 'stateChanged' };
            const existingTail = orderedTail(current.session);
            let activationInput: CliTurnPayload;
            let activationTurnId: string;
            if (existingTail.length > 0) {
              const tailAdmission = admitTail(current, selectedMaterial);
              if (tailAdmission) {
                result = tailAdmission;
                break;
              }
              activationInput = cloneKnownCliInput({ content: queuedPrompt });
              activationTurnId = current.session.queuedActivationTurnId
                ?? `queued-opening:${current.session.sessionId}`;
            } else {
              activationInput = cloneKnownCliInput({
                ...selectedMaterial.cliInput,
                content: queuedPrompt.length > 0
                  ? `${queuedPrompt}\n\n${selectedMaterial.cliInput.content}`
                  : selectedMaterial.cliInput.content,
              });
              activationTurnId = selectedMaterial.turnId;
            }
            const staged = stageActivationJournal(current, {
              input: activationInput,
              turnId: activationTurnId,
              resume: false,
              tail: orderedTail(current.session),
            });
            if (staged.kind === 'unknown') {
              result = unknown(staged.message);
              break;
            }
            result = deliverWorker({
              kind: 'forkWorker',
              sessionId: current.session.sessionId,
              turnId: activationTurnId,
              input: cloneKnownCliInput(activationInput),
              resume: false,
              queuedActivationToken: staged.token,
            }, {
              durableInput: true,
              restoreTransientGate: () => { current.initialStartPending = false; },
            });
            break;
          }

          case 'startColdReplacement': {
            const priorStartPending = current.initialStartPending;
            current.initialStartPending = true;
            const workerCommand: CurrentOrdinaryIngressWorkerProcessCommand = current.adoptedFrom
              ? {
                  kind: 'forkAdoptWorker',
                  sessionId: current.session.sessionId,
                  turnId: selectedMaterial.turnId,
                  input: cloneKnownCliInput(selectedMaterial.cliInput),
                }
              : {
                  kind: 'forkWorker',
                  sessionId: current.session.sessionId,
                  turnId: selectedMaterial.turnId,
                  input: cloneKnownCliInput(selectedMaterial.cliInput),
                  resume: current.hasHistory
                    && !(command.input.opening
                      && !(current.lastCliInput ?? current.session.lastCliInput)),
                };
            result = deliverWorker(workerCommand, {
              durableInput: false,
              restoreTransientGate: () => { current.initialStartPending = priorStartPending; },
            });
            break;
          }
        }

        if (result.kind === 'accepted'
          && (command.kind === 'sendLive' || command.kind === 'startColdReplacement')) {
          result = rememberAcceptedInput(current, selectedMaterial) ?? result;
        }

        if (result.kind !== 'stateChanged' && result.kind !== 'effect') {
          materials.delete(command.input.turn);
        }
        return result;
      },
      async execute(intent): Promise<unknown> {
        if (!isObject(intent)) throw new Error('invalid ordinary worker effect token');
        const plan = workerEffects.get(intent);
        if (!plan) throw new Error('ordinary worker effect token was already consumed');
        workerEffects.delete(intent);
        return options.workerProcesses.dispatch(plan.workerCommand);
      },
      resume(continuation, settlement): ProductionCommandResult {
        if (!isObject(continuation)) {
          return unknown('invalid ordinary worker continuation token');
        }
        const plan = workerContinuations.get(continuation);
        if (!plan) return unknown('ordinary worker continuation token was already consumed');
        workerContinuations.delete(continuation);
        let result: ProductionCommandResult;
        if (settlement.kind === 'threw') {
          result = unknown(
            `ordinary ingress worker dispatch outcome is unknown: ${message(settlement.error)}`,
          );
        } else {
          result = settleWorkerDispatch(
            settlement.value as CurrentOrdinaryIngressWorkerProcessResult,
            plan.dispatchOptions,
          );
        }
        if (!resolveCurrent(options, plan.command)) {
          materials.delete(plan.command.input.turn);
          return unknown('Current Session identity changed during ordinary worker activation');
        }
        if (result.kind === 'accepted'
            && (plan.command.kind === 'sendLive'
              || plan.command.kind === 'startColdReplacement')) {
          result = rememberAcceptedInput(plan.current, plan.selectedMaterial) ?? result;
        }
        if (result.kind !== 'stateChanged') materials.delete(plan.command.input.turn);
        return result;
      },
    },
  });
}
