/**
 * Owner-bound Current port for Dashboard chat rename.
 *
 * The HTTP session id is only an external selector. This port records the
 * operation before resolving that selector, freezes the exact owner/canonical
 * binding used for authorization, owns the Lark side effect, and refreshes
 * local Session projections only through their Runtime lanes.
 */

import { getBot, getBotOpenId } from '../bot-registry.js';
import * as groupsStore from '../services/groups-store.js';
import { logger } from '../utils/logger.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { authorizeSessionScopedIpc } from './daemon-ipc-session-auth.js';
import {
  ChatRenameCooldown,
  ChatRenameSerialQueue,
  normalizeLarkChatName,
} from './chat-rename.js';
import type { CurrentDashboardSessionCommandSubmitter } from './current-dashboard-session-command-client.js';
import { activeSessionKey, larkTransportEnabled, type DaemonSession } from './types.js';

type RenameChatSuccess = Extract<groupsStore.RenameChatResult, { ok: true }>;
type RenameChatFailure = Extract<groupsStore.RenameChatResult, { ok: false }>;

export interface DashboardChatRenameRequester {
  readonly trustedHost: boolean;
  readonly originCapability?: unknown;
  readonly originTurnId?: unknown;
  readonly originDispatchAttempt?: unknown;
}

export interface DashboardChatRenameRequest {
  readonly sessionId: string;
  readonly operationId: string;
  readonly name: unknown;
  readonly proactive?: unknown;
  readonly requester: DashboardChatRenameRequester;
}

export type DashboardChatRenameOutcome =
  | {
      readonly kind: 'completed';
      readonly result: RenameChatSuccess & { readonly chatId: string };
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalidOperation'
        | 'invalidChatName'
        | 'originUnproven'
        | 'managedActionRequired'
        | 'sessionNotActive'
        | 'noFeishuTransport'
        | 'notGroupChat';
      readonly message: string;
    }
  | {
      readonly kind: 'larkRejected';
      readonly result: RenameChatFailure;
    }
  | {
      readonly kind: 'conflict';
      readonly message: string;
    }
  | {
      readonly kind: 'quarantined';
      readonly message: string;
    };

export interface DashboardChatRename {
  submit(input: DashboardChatRenameRequest): Promise<DashboardChatRenameOutcome>;
}

interface NormalizedRequester {
  readonly trustedHost: boolean;
  readonly originCapability?: string;
  readonly originTurnId?: string;
  readonly originDispatchAttempt?: number;
}

interface RenamePlan {
  readonly input: DashboardChatRenameRequest;
  readonly name: string;
  readonly proactive: boolean;
  readonly requester: NormalizedRequester;
}

interface SourceBinding {
  readonly active: DaemonSession;
  readonly session: DaemonSession['session'];
  readonly chatId: string;
  readonly chatType: DaemonSession['chatType'];
}

type BindingInventory =
  | {
      readonly kind: 'ready';
      readonly bindings: readonly DaemonSession[];
    }
  | {
      readonly kind: 'invalid';
      readonly message: string;
    };

type RenameAttempt =
  | {
      readonly requestHash: string;
      readonly state: 'running';
      readonly terminal: Promise<DashboardChatRenameOutcome>;
    }
  | {
      readonly requestHash: string;
      readonly state: 'terminal';
      readonly outcome: DashboardChatRenameOutcome;
    }
  | {
      readonly requestHash: string;
      readonly state: 'reserved';
    };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validOperationIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !value.includes('\0');
}

function normalizedRequester(requester: DashboardChatRenameRequester): NormalizedRequester {
  if (requester.trustedHost) return { trustedHost: true };
  return {
    trustedHost: false,
    ...(typeof requester.originCapability === 'string'
      ? { originCapability: requester.originCapability }
      : {}),
    ...(typeof requester.originTurnId === 'string'
      ? { originTurnId: requester.originTurnId }
      : {}),
    ...(typeof requester.originDispatchAttempt === 'number'
      && Number.isSafeInteger(requester.originDispatchAttempt)
      && requester.originDispatchAttempt > 0
      ? { originDispatchAttempt: requester.originDispatchAttempt }
      : {}),
  };
}

function ownerRelated(
  ownerLarkAppId: string,
  candidate: DaemonSession,
): boolean {
  return candidate.larkAppId === ownerLarkAppId
    || candidate.session.larkAppId === ownerLarkAppId;
}

function validOwnerBinding(
  ownerLarkAppId: string,
  key: string,
  candidate: DaemonSession,
): boolean {
  try {
    return key === activeSessionKey(candidate)
      && candidate.larkAppId === ownerLarkAppId
      && (!candidate.session.larkAppId || candidate.session.larkAppId === ownerLarkAppId)
      && typeof candidate.session.sessionId === 'string'
      && candidate.session.sessionId.length > 0
      && candidate.session.status === 'active'
      && candidate.session.chatId === candidate.chatId
      && (!candidate.session.chatType || candidate.session.chatType === candidate.chatType)
      && (candidate.session.scope ?? 'thread') === candidate.scope;
  } catch {
    return false;
  }
}

function inspectOwnedBindings(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
  relevant: (candidate: DaemonSession) => boolean,
): BindingInventory {
  const bindings: DaemonSession[] = [];
  const sessionIds = new Set<string>();
  for (const [key, candidate] of activeSessions.entries()) {
    if (!ownerRelated(ownerLarkAppId, candidate)) continue;
    if (!validOwnerBinding(ownerLarkAppId, key, candidate)) {
      return {
        kind: 'invalid',
        message: 'Chat rename encountered a malformed owner Session binding',
      };
    }
    if (sessionIds.has(candidate.session.sessionId)) {
      return {
        kind: 'invalid',
        message: 'Chat rename encountered duplicate owner Session bindings',
      };
    }
    sessionIds.add(candidate.session.sessionId);
    if (relevant(candidate)) bindings.push(candidate);
  }
  return { kind: 'ready', bindings };
}

function inspectSourceBindings(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
  sessionId: string,
): BindingInventory {
  return inspectOwnedBindings(
    ownerLarkAppId,
    activeSessions,
    candidate => candidate.session.sessionId === sessionId,
  );
}

function inspectChatBindings(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
  chatId: string,
): BindingInventory {
  return inspectOwnedBindings(
    ownerLarkAppId,
    activeSessions,
    candidate => candidate.chatId === chatId || candidate.session.chatId === chatId,
  );
}

function revalidateSourceBinding(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
  sessionId: string,
  binding: SourceBinding,
): BindingInventory | { readonly kind: 'replaced' } {
  const current = inspectSourceBindings(ownerLarkAppId, activeSessions, sessionId);
  if (current.kind === 'invalid') return current;
  return current.bindings.length === 1
    && current.bindings[0] === binding.active
    && current.bindings[0].session === binding.session
    && current.bindings[0].chatId === binding.chatId
    && current.bindings[0].chatType === binding.chatType
    ? current
    : { kind: 'replaced' };
}

function defaultTransportEnabled(ownerLarkAppId: string, chatId: string): boolean {
  const apiOnly = getBot(ownerLarkAppId).config.apiOnly === true;
  return larkTransportEnabled({ chatId, apiOnly });
}

function retainOutcome(outcome: DashboardChatRenameOutcome): boolean {
  return outcome.kind === 'completed'
    || outcome.kind === 'quarantined'
    || (outcome.kind === 'larkRejected' && outcome.result.error === 'lark_api_error');
}

function refreshFailure(outcome: Awaited<ReturnType<CurrentDashboardSessionCommandSubmitter>>): string {
  if ('message' in outcome && outcome.message) return outcome.message;
  if ('reason' in outcome && outcome.reason) return outcome.reason;
  return outcome.kind;
}

export function createCurrentDashboardChatRename(options: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
  readonly submit: CurrentDashboardSessionCommandSubmitter;
  readonly renameChat?: typeof groupsStore.renameChat;
  readonly transportEnabled?: (ownerLarkAppId: string, chatId: string) => boolean;
  readonly botOpenId?: (ownerLarkAppId: string) => string | undefined;
}): DashboardChatRename {
  const renameChat = options.renameChat ?? groupsStore.renameChat;
  const transportEnabled = options.transportEnabled ?? defaultTransportEnabled;
  const botOpenId = options.botOpenId ?? getBotOpenId;
  const cooldown = new ChatRenameCooldown();
  const serialQueue = new ChatRenameSerialQueue();
  // Current has no durable receipt store for this host-level external effect.
  // Terminal success and ambiguous outcomes therefore live for the daemon epoch.
  const attempts = new Map<string, RenameAttempt>();

  async function refreshLocalProjections(
    operationId: string,
    chatId: string,
    sessionIds: readonly string[],
    chatDisplayName: string,
  ): Promise<void> {
    await Promise.all(sessionIds.map(async sessionId => {
      try {
        const outcome = await options.submit({
          target: { kind: 'externalSession', sessionId },
          idempotencyKey: `${operationId}:${sessionId}`,
          command: {
            kind: 'control.mutate',
            input: { kind: 'setChatDisplayName', chatDisplayName },
          },
        });
        if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
          throw new Error(refreshFailure(outcome));
        }
      } catch (error) {
        logger.warn(
          `[chat-rename:audit] cache_refresh_failed session=${sessionId} chat=${chatId} `
          + `app=${options.ownerLarkAppId} detail=${message(error)}`,
        );
      }
    }));
  }

  async function execute(plan: RenamePlan): Promise<DashboardChatRenameOutcome> {
    const sourceInventory = inspectSourceBindings(
      options.ownerLarkAppId,
      options.activeSessions,
      plan.input.sessionId,
    );
    if (sourceInventory.kind === 'invalid') {
      return { kind: 'quarantined', message: sourceInventory.message };
    }
    const candidates = sourceInventory.bindings;
    const source = candidates.length === 1 ? candidates[0] : undefined;
    const auth = authorizeSessionScopedIpc({
      trustedHost: plan.requester.trustedHost,
      sessionExists: !!source,
      receiverSession: !!source?.session.vcMeetingReceiver,
      allowReceiver: false,
      sessionId: plan.input.sessionId,
      liveOrigin: source?.managedTurnOrigin,
      claimedCapability: plan.requester.originCapability,
      claimedTurnId: plan.requester.originTurnId,
      claimedDispatchAttempt: plan.requester.originDispatchAttempt,
    });
    if (!auth.ok) {
      return {
        kind: 'rejected',
        reason: auth.error === 'managed_action_required'
          ? 'managedActionRequired'
          : 'originUnproven',
        message: auth.error,
      };
    }
    if (!source) {
      return {
        kind: 'rejected',
        reason: 'sessionNotActive',
        message: 'session_not_active',
      };
    }
    if (!transportEnabled(options.ownerLarkAppId, source.chatId)) {
      return {
        kind: 'rejected',
        reason: 'noFeishuTransport',
        message: 'no_feishu_transport',
      };
    }
    if (source.chatType !== 'group') {
      return {
        kind: 'rejected',
        reason: 'notGroupChat',
        message: 'not_group_chat',
      };
    }
    const chatInventory = inspectChatBindings(
      options.ownerLarkAppId,
      options.activeSessions,
      source.chatId,
    );
    if (chatInventory.kind === 'invalid') {
      return { kind: 'quarantined', message: chatInventory.message };
    }

    const binding: SourceBinding = {
      active: source,
      session: source.session,
      chatId: source.chatId,
      chatType: source.chatType,
    };
    const trigger = plan.proactive ? 'ai_proactive' : 'user_explicit';
    const cooldownKey = `${options.ownerLarkAppId}:${binding.chatId}`;
    return serialQueue.run(cooldownKey, async () => {
      const currentSource = revalidateSourceBinding(
        options.ownerLarkAppId,
        options.activeSessions,
        plan.input.sessionId,
        binding,
      );
      if (currentSource.kind === 'invalid') {
        return { kind: 'quarantined' as const, message: currentSource.message };
      }
      if (currentSource.kind === 'replaced') {
        return {
          kind: 'rejected' as const,
          reason: 'sessionNotActive' as const,
          message: 'session_not_active',
        };
      }
      const currentChat = inspectChatBindings(
        options.ownerLarkAppId,
        options.activeSessions,
        binding.chatId,
      );
      if (currentChat.kind === 'invalid') {
        return { kind: 'quarantined' as const, message: currentChat.message };
      }
      const effectAuth = authorizeSessionScopedIpc({
        trustedHost: plan.requester.trustedHost,
        sessionExists: true,
        receiverSession: !!binding.active.session.vcMeetingReceiver,
        allowReceiver: false,
        sessionId: plan.input.sessionId,
        liveOrigin: binding.active.managedTurnOrigin,
        claimedCapability: plan.requester.originCapability,
        claimedTurnId: plan.requester.originTurnId,
        claimedDispatchAttempt: plan.requester.originDispatchAttempt,
      });
      if (!effectAuth.ok) {
        return {
          kind: 'rejected' as const,
          reason: effectAuth.error === 'managed_action_required'
            ? 'managedActionRequired' as const
            : 'originUnproven' as const,
          message: effectAuth.error,
        };
      }
      if (!transportEnabled(options.ownerLarkAppId, binding.chatId)) {
        return {
          kind: 'rejected' as const,
          reason: 'noFeishuTransport' as const,
          message: 'no_feishu_transport',
        };
      }

      let actingBotOpenId = '-';
      try { actingBotOpenId = botOpenId(options.ownerLarkAppId) ?? '-'; }
      catch (error) {
        return {
          kind: 'quarantined' as const,
          message: `Bot identity is unreadable before chat rename: ${message(error)}`,
        };
      }

      const result = await renameChat(
        options.ownerLarkAppId,
        binding.chatId,
        plan.name,
        {
          beforeUpdate: plan.proactive
            ? () => {
                const gate = cooldown.check(cooldownKey);
                return gate.ok
                  ? gate
                  : { ...gate, error: 'rate_limited' as const };
              }
            : undefined,
        },
      );
      if (!result.ok) {
        logger.warn(
          `[chat-rename:audit] result=failed session=${plan.input.sessionId} chat=${binding.chatId} `
          + `app=${options.ownerLarkAppId} botOpenId=${actingBotOpenId} trigger=${trigger} `
          + `old=${JSON.stringify(result.oldName ?? null)} new=${JSON.stringify(result.newName ?? plan.name)} `
          + `error=${result.error} larkCode=${result.larkCode ?? '-'} detail=${result.detail ?? '-'}`,
        );
        return { kind: 'larkRejected' as const, result };
      }

      if (result.changed && plan.proactive) cooldown.record(cooldownKey);
      // A same-name response is also a reconciliation opportunity: an earlier
      // Lark success may have lost its response before local Session repair.
      await refreshLocalProjections(
        plan.input.operationId,
        binding.chatId,
        currentChat.bindings.map(candidate => candidate.session.sessionId),
        result.newName,
      );
      logger.info(
        `[chat-rename:audit] result=success session=${plan.input.sessionId} chat=${binding.chatId} `
        + `app=${options.ownerLarkAppId} botOpenId=${actingBotOpenId} trigger=${trigger} `
        + `old=${JSON.stringify(result.oldName)} new=${JSON.stringify(result.newName)} `
        + `changed=${result.changed} larkCode=0`,
      );
      return {
        kind: 'completed' as const,
        result: { ...result, chatId: binding.chatId },
      };
    });
  }

  return {
    async submit(input) {
      if (!validOperationIdentity(input.operationId) || !input.sessionId) {
        return {
          kind: 'rejected',
          reason: 'invalidOperation',
          message: 'bad_operation_id',
        };
      }
      const normalized = normalizeLarkChatName(input.name);
      if (!normalized.ok) {
        return {
          kind: 'rejected',
          reason: 'invalidChatName',
          message: normalized.error,
        };
      }
      const plan: RenamePlan = {
        input,
        name: normalized.name,
        proactive: input.proactive === true,
        requester: normalizedRequester(input.requester),
      };
      const requestHash = computeInputHash({
        name: plan.name,
        proactive: plan.proactive,
        requester: plan.requester,
      });
      const key = `${input.sessionId}\0${input.operationId}`;
      const prior = attempts.get(key);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return {
            kind: 'conflict',
            message: 'Chat rename operation identity belongs to different semantic input',
          };
        }
        if (prior.state === 'running') return prior.terminal;
        if (prior.state === 'terminal') return prior.outcome;
      }

      // Publish the outer receipt before Session projection, authorization, or
      // any Lark interaction can synchronously re-enter this port.
      const terminal = Promise.resolve()
        .then(() => execute(plan))
        .catch(error => ({
          kind: 'quarantined' as const,
          message: `Chat rename outcome is unknown: ${message(error)}`,
        }));
      const running: RenameAttempt = { requestHash, state: 'running', terminal };
      attempts.set(key, running);
      const outcome = await terminal;
      if (retainOutcome(outcome)) {
        attempts.set(key, { requestHash, state: 'terminal', outcome });
      } else if (attempts.get(key) === running) {
        attempts.set(key, { requestHash, state: 'reserved' });
      }
      return outcome;
    },
  };
}
