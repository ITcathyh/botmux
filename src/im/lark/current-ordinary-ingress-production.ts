/**
 * Lark composition for the Current ordinary-ingress production Adapter.
 *
 * The exported Module owns the state-neutral materialization workflow. Its
 * external seam accepts only Lark I/O adapters and detached bot facts; mutable
 * Current/Session/worker authority remains private and is re-resolved around
 * every await.
 */

import type { CliId } from '../../adapters/cli/types.js';
import type { PreparedOrdinaryImTurn } from '../../core/current-ordinary-im-turn.js';
import type { CurrentOrdinaryIngressMetadataModule } from '../../core/current-ordinary-ingress-metadata.js';
import type { CurrentOrdinaryIngressPreMaterializationModule } from '../../core/current-ordinary-ingress.js';
import {
  createCurrentOrdinaryIngressProductionPort,
  type CurrentOrdinaryIngressProductionExternalEffectResult,
  type CurrentOrdinaryIngressWorkerProcesses,
} from '../../core/current-ordinary-ingress-production.js';
import type { OrdinaryIngressPort } from '../../core/session-runtime.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  sessionKey,
  type DaemonSession,
} from '../../core/types.js';
import {
  buildBridgeInputContent,
  buildFollowUpCliInput,
  buildNewTopicCliInput,
  snapshotWhiteboardPromptBlock,
} from '../../core/session-manager.js';
import { t, type Locale } from '../../i18n/index.js';
import type {
  LarkAttachment,
  LarkMention,
  SubstituteTrigger,
} from '../../types.js';
import type { ResolvedSender } from './identity-cache.js';
import { buildQuoteHint } from './quote-hint.js';
import { buildTopicThreadContext } from './topic-root-context.js';
import { buildWorkflowGrillPrompt } from './workflow-slash-command.js';
import { renderMessageListenerPrompt } from '../../services/message-listener.js';

export type LarkOrdinaryIngressMaterializationIoResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

export interface LarkOrdinaryIngressMaterializationContext {
  readonly ownerLarkAppId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly route: PreparedOrdinaryImTurn['route'];
}

export interface LarkOrdinaryIngressQuotaInput
  extends LarkOrdinaryIngressMaterializationContext {
  readonly sender: PreparedOrdinaryImTurn['sender'];
  readonly messageListener: boolean;
}

export interface LarkOrdinaryIngressResourceDownloadInput
  extends LarkOrdinaryIngressMaterializationContext {
  readonly resources: PreparedOrdinaryImTurn['resources'];
}

export interface LarkOrdinaryIngressSenderResolutionInput
  extends LarkOrdinaryIngressMaterializationContext {
  readonly sender: PreparedOrdinaryImTurn['sender'];
}

export type LarkOrdinaryIngressAvailableBot = Readonly<{
  name: string;
  displayName: string;
  openId: string;
}>;

export interface LarkOrdinaryIngressReceivedReactionInput
  extends LarkOrdinaryIngressMaterializationContext {
  readonly substitute: boolean;
}

/** True-external I/O seam; production and focused-test adapters share it. */
export interface LarkOrdinaryIngressMaterializationEffects {
  checkQuota(
    input: LarkOrdinaryIngressQuotaInput,
  ): Promise<LarkOrdinaryIngressMaterializationIoResult<null>>;
  downloadResources(
    input: LarkOrdinaryIngressResourceDownloadInput,
  ): Promise<LarkOrdinaryIngressMaterializationIoResult<readonly LarkAttachment[]>>;
  resolveSender(
    input: LarkOrdinaryIngressSenderResolutionInput,
  ): Promise<LarkOrdinaryIngressMaterializationIoResult<ResolvedSender | undefined>>;
  listAvailableBots(
    input: LarkOrdinaryIngressMaterializationContext,
  ): Promise<LarkOrdinaryIngressMaterializationIoResult<
    readonly LarkOrdinaryIngressAvailableBot[]
  >>;
  /**
   * Best-effort received-reaction (✋) on the accepted turn. Gating (card-off,
   * silent opt-out, dedup) lives behind this seam; `null` means no reaction
   * was added and the turn proceeds without evidence.
   */
  addReceivedReaction?(
    input: LarkOrdinaryIngressReceivedReactionInput,
  ): Promise<LarkOrdinaryIngressMaterializationIoResult<
    { readonly reactionId: string } | null
  >>;
}

export interface LarkOrdinaryIngressBotSnapshot {
  readonly defaultCliId: CliId;
  readonly defaultCliPathOverride?: string;
  readonly name?: string;
  readonly openId?: string;
  readonly locale?: Locale;
}

export interface LarkCurrentOrdinaryIngressProductionOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
  readonly bot: LarkOrdinaryIngressBotSnapshot;
  readonly effects: LarkOrdinaryIngressMaterializationEffects;
  readonly workerProcesses: CurrentOrdinaryIngressWorkerProcesses;
  readonly metadata: CurrentOrdinaryIngressMetadataModule;
  readonly preMaterialization?: CurrentOrdinaryIngressPreMaterializationModule;
  readonly clock: () => number;
  readonly substituteReplyMode: 'thread' | 'quote';
  readonly beginTurnCardRotation?: (
    current: DaemonSession,
    turn: { readonly title: string; readonly mode: 'live' | 'refork' },
  ) => void;
  readonly notifyPendingRepoStash?: (current: DaemonSession) => void;
}

type MaterializationFailure = Extract<
  CurrentOrdinaryIngressProductionExternalEffectResult,
  { readonly kind: 'refused' | 'unknown' }
>;

interface RenderSnapshot {
  readonly cliId: CliId;
  readonly cliPathOverride?: string;
  readonly chatId: string;
  readonly whiteboardId?: string;
  readonly vcMeetingReceiver: boolean;
}

interface BindingStamp {
  readonly key: string;
  readonly sessionId: string;
  readonly bindingToken: object;
  readonly sessionToken: object;
  readonly render: RenderSnapshot;
  readonly whiteboardBlock: string;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object';
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isObject(value) || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unknown(message: string): MaterializationFailure {
  return { kind: 'unknown', message };
}

function routeMatches(ds: DaemonSession, turn: PreparedOrdinaryImTurn): boolean {
  return ds.scope === turn.route.scope
    && ds.chatId === turn.route.chatId
    && ds.session.chatId === turn.route.chatId
    && ds.chatType === turn.route.chatType
    && activeSessionAnchorId(ds) === turn.route.canonicalAnchor;
}

function sameRenderSnapshot(left: RenderSnapshot, right: RenderSnapshot): boolean {
  return left.cliId === right.cliId
    && left.cliPathOverride === right.cliPathOverride
    && left.chatId === right.chatId
    && left.whiteboardId === right.whiteboardId
    && left.vcMeetingReceiver === right.vcMeetingReceiver;
}

function cloneMention(mention: PreparedOrdinaryImTurn['mentions'][number]): LarkMention {
  return {
    key: mention.key,
    name: mention.name,
    ...(mention.openId === undefined ? {} : { openId: mention.openId }),
    ...(mention.userId === undefined ? {} : { userId: mention.userId }),
    ...(mention.unionId === undefined ? {} : { unionId: mention.unionId }),
    ...(mention.appId === undefined ? {} : { appId: mention.appId }),
  };
}

function cloneSubstitute(turn: PreparedOrdinaryImTurn): SubstituteTrigger | undefined {
  if (!turn.substitute) return undefined;
  return {
    target: { ...turn.substitute.target },
    ...(turn.substitute.observedMention
      ? { observedMention: { ...turn.substitute.observedMention } }
      : {}),
    disclosure: turn.substitute.disclosure,
  };
}

function cloneAttachments(value: unknown): LarkAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: LarkAttachment[] = [];
  for (const item of value) {
    if (!isObject(item)
      || (item.type !== 'image' && item.type !== 'file')
      || typeof item.path !== 'string'
      || typeof item.name !== 'string') {
      return undefined;
    }
    attachments.push({ type: item.type, path: item.path, name: item.name });
  }
  return attachments;
}

function cloneSender(
  value: unknown,
  expectedOpenId: string | undefined,
): ResolvedSender | undefined | false {
  if (value === undefined) return undefined;
  if (!isObject(value)
    || typeof value.openId !== 'string'
    || value.openId !== expectedOpenId
    || (value.type !== 'user' && value.type !== 'bot')
    || (value.name !== undefined && typeof value.name !== 'string')) {
    return false;
  }
  return {
    openId: value.openId,
    type: value.type,
    ...(value.name === undefined ? {} : { name: value.name }),
  };
}

function cloneAvailableBots(value: unknown): LarkOrdinaryIngressAvailableBot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const bots: LarkOrdinaryIngressAvailableBot[] = [];
  for (const item of value) {
    if (!isObject(item)
      || typeof item.name !== 'string'
      || typeof item.displayName !== 'string'
      || typeof item.openId !== 'string') {
      return undefined;
    }
    bots.push({ name: item.name, displayName: item.displayName, openId: item.openId });
  }
  return bots;
}

function vcApplicationContext(turn: PreparedOrdinaryImTurn): string {
  return (turn.vc.lifecycle === 'sealed'
    ? '[会议上下文状态] 本轮正在复用一场已结束会议的专属会话；这是会后追问。可以基于既有会议上下文回答，但不得声称会议仍在进行，也不要尝试会中文本或语音动作。\n'
    : '')
    + (turn.vc.contextMayLag
      ? '[会议上下文状态] 本轮已路由到对应会议会话，但会前回补未在时限内成功；会议上下文可能滞后。回答时请显式说明这一点，不要把缺失内容当作已同步。\n'
      : '');
}

function materializationContext(
  ownerLarkAppId: string,
  sessionId: string,
  turn: PreparedOrdinaryImTurn,
): LarkOrdinaryIngressMaterializationContext {
  return deepFreeze({
    ownerLarkAppId,
    sessionId,
    turnId: turn.messageKey,
    route: {
      scope: turn.route.scope,
      canonicalAnchor: turn.route.canonicalAnchor,
      chatId: turn.route.chatId,
      chatType: turn.route.chatType,
    },
  });
}

/** Compose exact Current state policy with Lark-specific materialization. */
export function createLarkCurrentOrdinaryIngressProductionPort(
  options: LarkCurrentOrdinaryIngressProductionOptions,
): OrdinaryIngressPort {
  const bot = Object.freeze({ ...options.bot });
  const bindingTokens = new WeakMap<DaemonSession, object>();
  const sessionTokens = new WeakMap<object, object>();

  const tokenFor = (ds: DaemonSession): object => {
    const prior = bindingTokens.get(ds);
    if (prior) return prior;
    const token = Object.freeze({});
    bindingTokens.set(ds, token);
    return token;
  };
  const sessionTokenFor = (session: object): object => {
    const prior = sessionTokens.get(session);
    if (prior) return prior;
    const token = Object.freeze({});
    sessionTokens.set(session, token);
    return token;
  };
  const renderSnapshot = (ds: DaemonSession): RenderSnapshot => Object.freeze({
    cliId: ds.session.cliId ?? bot.defaultCliId,
    cliPathOverride: ds.session.cliPathOverride ?? bot.defaultCliPathOverride,
    chatId: ds.session.chatId,
    whiteboardId: ds.session.whiteboardId,
    vcMeetingReceiver: ds.session.vcMeetingReceiver !== undefined,
  });
  const captureBinding = (
    sessionId: string,
    turn: PreparedOrdinaryImTurn,
  ): BindingStamp | undefined => {
    const key = sessionKey(turn.route.canonicalAnchor, options.ownerLarkAppId);
    const current = options.activeSessions.get(key);
    if (!current
      || activeSessionKey(current) !== key
      || current.larkAppId !== options.ownerLarkAppId
      || current.session.sessionId !== sessionId
      || !routeMatches(current, turn)) {
      return undefined;
    }
    return Object.freeze({
      key,
      sessionId,
      bindingToken: tokenFor(current),
      sessionToken: sessionTokenFor(current.session),
      render: renderSnapshot(current),
      whiteboardBlock: snapshotWhiteboardPromptBlock(current.session.whiteboardId),
    });
  };
  const bindingIsCurrent = (stamp: BindingStamp, turn: PreparedOrdinaryImTurn): boolean => {
    const current = options.activeSessions.get(stamp.key);
    return !!current
      && tokenFor(current) === stamp.bindingToken
      && sessionTokenFor(current.session) === stamp.sessionToken
      && activeSessionKey(current) === stamp.key
      && current.larkAppId === options.ownerLarkAppId
      && current.session.sessionId === stamp.sessionId
      && routeMatches(current, turn)
      && sameRenderSnapshot(renderSnapshot(current), stamp.render);
  };

  const guardedIo = async <T>(
    label: string,
    stamp: BindingStamp,
    turn: PreparedOrdinaryImTurn,
    execute: () => Promise<LarkOrdinaryIngressMaterializationIoResult<T>>,
  ): Promise<LarkOrdinaryIngressMaterializationIoResult<T>> => {
    if (!bindingIsCurrent(stamp, turn)) {
      return unknown(`Current Session identity changed before Lark ${label}`);
    }
    let result: LarkOrdinaryIngressMaterializationIoResult<T>;
    try {
      result = await execute();
    } catch (error) {
      if (!bindingIsCurrent(stamp, turn)) {
        return unknown(`Current Session identity changed during Lark ${label}`);
      }
      return unknown(`Lark ${label} outcome is unknown: ${errorMessage(error)}`);
    }
    if (!bindingIsCurrent(stamp, turn)) {
      return unknown(`Current Session identity changed during Lark ${label}`);
    }
    try {
      if (!isObject(result)) return unknown(`Lark ${label} returned an invalid result`);
      if (result.kind === 'ok') return result;
      if (result.kind === 'refused') {
        return {
          kind: 'refused',
          message: typeof result.message === 'string'
            ? result.message
            : `Lark ${label} refused materialization`,
        };
      }
      if (result.kind === 'unknown') {
        return {
          kind: 'unknown',
          message: typeof result.message === 'string'
            ? result.message
            : `Lark ${label} outcome is unknown`,
        };
      }
    } catch {
      return unknown(`Lark ${label} returned an unreadable result`);
    }
    return unknown(`Lark ${label} returned an invalid result`);
  };

  return createCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: options.ownerLarkAppId,
    activeSessions: options.activeSessions,
    workerProcesses: options.workerProcesses,
    metadata: options.metadata,
    ...(options.preMaterialization
      ? { preMaterialization: options.preMaterialization }
      : {}),
    clock: options.clock,
    substituteReplyMode: options.substituteReplyMode,
    ...(options.beginTurnCardRotation
      ? { beginTurnCardRotation: options.beginTurnCardRotation }
      : {}),
    ...(options.notifyPendingRepoStash
      ? { notifyPendingRepoStash: options.notifyPendingRepoStash }
      : {}),
    externalEffects: {
      async execute(effect): Promise<CurrentOrdinaryIngressProductionExternalEffectResult> {
        const { sessionId, turn } = effect.input;
        const stamp = captureBinding(sessionId, turn);
        if (!stamp) {
          return unknown('Current Session identity changed before Lark materialization');
        }
        const context = materializationContext(options.ownerLarkAppId, sessionId, turn);

        const quota = await guardedIo('quota check', stamp, turn, () => (
          options.effects.checkQuota(deepFreeze({
            ...context,
            sender: { ...turn.sender },
            messageListener: turn.messageListener !== undefined,
          }))
        ));
        if (quota.kind !== 'ok') return quota;

        let attachments: LarkAttachment[] = [];
        if (turn.resources.length > 0) {
          const downloaded = await guardedIo('resource download', stamp, turn, () => (
            options.effects.downloadResources(deepFreeze({
              ...context,
              resources: turn.resources.map(resource => ({ ...resource })),
            }))
          ));
          if (downloaded.kind !== 'ok') return downloaded;
          const detachedAttachments = cloneAttachments(downloaded.value);
          if (!detachedAttachments) return unknown('Lark resource download returned invalid attachments');
          attachments = detachedAttachments;
        }

        let sender: ResolvedSender | undefined;
        if (turn.sender.openId) {
          const resolved = await guardedIo('sender resolution', stamp, turn, () => (
            options.effects.resolveSender(deepFreeze({
              ...context,
              sender: { ...turn.sender },
            }))
          ));
          if (resolved.kind !== 'ok') return resolved;
          const detachedSender = cloneSender(resolved.value, turn.sender.openId);
          if (detachedSender === false) return unknown('Lark sender resolution returned invalid identity');
          sender = detachedSender;
        }

        const listedBots = await guardedIo('available-bot listing', stamp, turn, () => (
          options.effects.listAvailableBots(context)
        ));
        if (listedBots.kind !== 'ok') return listedBots;
        const availableBots = cloneAvailableBots(listedBots.value);
        if (!availableBots) return unknown('Lark available-bot listing returned invalid bots');

        if (!bindingIsCurrent(stamp, turn)) {
          return unknown('Current Session identity changed before Lark prompt rendering');
        }
        const mentions = turn.mentions.map(cloneMention);
        const substituteTrigger = cloneSubstitute(turn);
        const quoteContext = turn.foldedForwardContext
          ? ''
          : buildQuoteHint(
              { parentId: turn.quotedMessageKey, messageId: turn.messageKey },
              turn.route.scope,
              turn.route.canonicalAnchor,
              bot.locale,
            );
        const openingTopicContext = !turn.foldedForwardContext
          && (
            (turn.route.scope === 'thread' && turn.messageKey !== turn.route.canonicalAnchor)
            || (turn.route.scope === 'chat'
              && turn.replyRootMessageKey !== undefined
              && turn.replyRootMessageKey !== turn.messageKey)
          )
          ? buildTopicThreadContext(bot.locale)
          : '';
        const peerBotContext = turn.sender.kind === 'bot'
          ? `${t('daemon.foreign_bot_mention_prefix', {
              botName: sender?.name ?? 'Bot',
            }, bot.locale)}\n`
          : '';
        const workflowPrompt = turn.rewrite
          ? buildWorkflowGrillPrompt(turn.rewrite.goal)
          : undefined;
        const listenerPrompt = turn.messageListener
          ? renderMessageListenerPrompt({ ...turn.messageListener })
          : undefined;
        const applicationContext = vcApplicationContext(turn);
        const messageContext = quoteContext
          + peerBotContext
          + (workflowPrompt ?? '');
        const userPrompt = quoteContext
          + peerBotContext
          + applicationContext
          + (workflowPrompt ?? listenerPrompt ?? turn.content);
        const newTopicUserPrompt = openingTopicContext + userPrompt;
        const visibleText = listenerPrompt ?? turn.content;
        const common = {
          attachments,
          mentions,
          isAdoptMode: false,
          cliId: stamp.render.cliId,
          cliPathOverride: stamp.render.cliPathOverride,
          locale: bot.locale,
          sender,
          larkAppId: options.ownerLarkAppId,
          chatId: stamp.render.chatId,
          whiteboardId: stamp.render.whiteboardId,
          whiteboardBlock: stamp.whiteboardBlock,
          substituteTrigger,
          codexAppText: visibleText,
          codexAppApplicationContext: applicationContext || undefined,
          codexAppMessageContext: messageContext || undefined,
        };
        const steerable = turn.sender.kind === 'human'
          && !turn.rewrite
          && !turn.substitute
          && turn.messageListener === undefined
          && !turn.vc.imTurnOrigin
          && !stamp.render.vcMeetingReceiver;
        const cliInput = {
          ...buildFollowUpCliInput(userPrompt, sessionId, common),
          ...(steerable ? { codexAppSteerable: true as const } : {}),
        };
        // The topic hint is opening-only and must reach BOTH lanes: the
        // wrapped prompt above and the codex-app structured sidecar — a
        // clean-input bot reading only the sidecar would otherwise drop it.
        const newTopicCommon = openingTopicContext
          ? {
              ...common,
              codexAppMessageContext: (openingTopicContext + messageContext) || undefined,
            }
          : common;
        const newTopicCliInput = {
          ...buildNewTopicCliInput(
            newTopicUserPrompt,
            sessionId,
            stamp.render.cliId,
            stamp.render.cliPathOverride,
            attachments,
            mentions,
            availableBots,
            undefined,
            { name: bot.name, openId: bot.openId },
            bot.locale,
            sender,
            newTopicCommon,
          ),
          ...(steerable ? { codexAppSteerable: true as const } : {}),
        };
        const adoptCliInput = {
          content: buildBridgeInputContent(userPrompt, {
            attachments,
            mentions,
            selfMention: { name: bot.name, openId: bot.openId },
            locale: bot.locale,
          }),
        };
        if (!bindingIsCurrent(stamp, turn)) {
          return unknown('Current Session identity changed during Lark prompt rendering');
        }
        let receivedReaction: { messageKey: string; reactionId: string } | undefined;
        if (options.effects.addReceivedReaction) {
          // Best-effort: a failed/refused reaction never blocks the turn — the
          // material simply carries no evidence, matching the legacy behavior
          // where a lost addReaction skipped the ✋ and delivered anyway.
          try {
            const reacted = await options.effects.addReceivedReaction(deepFreeze({
              ...context,
              substitute: turn.substitute !== undefined,
            }));
            if (reacted.kind === 'ok'
              && isObject(reacted.value)
              && typeof reacted.value.reactionId === 'string'
              && reacted.value.reactionId.length > 0) {
              receivedReaction = { messageKey: turn.messageKey, reactionId: reacted.value.reactionId };
            }
          } catch {
            // Reaction evidence stays absent; the turn itself is unaffected.
          }
        }
        return {
          kind: 'materialized',
          material: deepFreeze({
            userPrompt,
            newTopicUserPrompt,
            cliInput,
            newTopicCliInput,
            adoptCliInput,
            turnId: turn.messageKey,
            ...(receivedReaction ? { receivedReaction } : {}),
          }),
        };
      },
    },
  });
}
