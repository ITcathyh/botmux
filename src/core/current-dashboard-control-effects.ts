/**
 * Current production Adapter for best-effort effects that follow a committed
 * Dashboard Session command. The HTTP caller only sees immutable command
 * results; mutable worker/Lark handles stay behind this owner-bound port.
 */

import type { CliId } from '../adapters/cli/types.js';
import { getBot } from '../bot-registry.js';
import { getCliDisplayName } from '../im/lark/card-builder.js';
import { getChatMode, replyMessage, sendMessage } from '../im/lark/client.js';
import { localeForBot, t } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
import { sessionConfiguredRuntimeDisplayName } from './cli-runtime-display.js';
import {
  activeSessionKey,
  larkTransportEnabled,
  type DaemonSession,
} from './types.js';

export interface CurrentDashboardControlEffects {
  restartNotice(input: {
    readonly sessionId: string;
    readonly revived: boolean;
  }): void;
  resumeNotice(input: {
    readonly sessionId: string;
    readonly cliId?: string;
  }): void;
}

function exactActiveSession(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
  sessionId: string,
): DaemonSession | undefined {
  const ownerEntries = [...activeSessions.entries()].filter(([, candidate]) => (
    candidate.larkAppId === ownerLarkAppId
    || candidate.session.larkAppId === ownerLarkAppId
  ));
  const seenSessionIds = new Set<string>();
  for (const [key, candidate] of ownerEntries) {
    if (
      candidate.larkAppId !== ownerLarkAppId
      || candidate.session.larkAppId !== ownerLarkAppId
      || candidate.session.status !== 'active'
      || key !== activeSessionKey(candidate)
      || candidate.chatId !== candidate.session.chatId
      || (candidate.session.chatType !== undefined
        && candidate.chatType !== candidate.session.chatType)
      || candidate.scope !== (candidate.session.scope ?? 'thread')
      || !candidate.session.sessionId
      || seenSessionIds.has(candidate.session.sessionId)
    ) {
      return undefined;
    }
    seenSessionIds.add(candidate.session.sessionId);
  }
  const matches = ownerEntries
    .map(([, candidate]) => candidate)
    .filter(candidate => candidate.session.sessionId === sessionId);
  return matches.length === 1 ? matches[0] : undefined;
}

function transportEnabled(ds: DaemonSession): boolean {
  try {
    return larkTransportEnabled({
      chatId: ds.chatId,
      apiOnly: getBot(ds.larkAppId).config.apiOnly,
    });
  } catch {
    return false;
  }
}

function deliverSessionNotice(ds: DaemonSession, text: string, label: string): void {
  if (!ds.larkAppId || !transportEnabled(ds)) return;
  const notice = JSON.stringify({ text });
  if (ds.scope === 'chat' && ds.chatId) {
    getChatMode(ds.larkAppId, ds.chatId, { forceRefresh: true })
      .then((mode) => mode === 'topic' && ds.session.rootMessageId
        ? replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
        : sendMessage(ds.larkAppId, ds.chatId, notice, 'text'))
      .catch(error => logger.debug(`[${label}] failed to post chat-scope notice: ${error}`));
    return;
  }
  if (ds.session.rootMessageId) {
    replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
      .catch(error => logger.debug(`[${label}] failed to post thread-scope notice: ${error}`));
  }
}

export function createCurrentDashboardControlEffects(input: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
}): CurrentDashboardControlEffects {
  const current = (sessionId: string): DaemonSession | undefined => (
    exactActiveSession(input.ownerLarkAppId, input.activeSessions, sessionId)
  );

  return {
    restartNotice(effect) {
      const ds = current(effect.sessionId);
      if (!ds) return;
      try {
        const botConfig = getBot(ds.larkAppId).config;
        const cliName = sessionConfiguredRuntimeDisplayName(ds.session, botConfig.cliRuntime)
          ?? getCliDisplayName(ds.session.cliId ?? botConfig.cliId ?? 'claude-code');
        const text = effect.revived
          ? t('card.action.restarted_fresh', { cliName }, localeForBot(ds.larkAppId))
          : t('cmd.restart.in_progress', { cliName }, localeForBot(ds.larkAppId));
        deliverSessionNotice(ds, text, 'restart');
      } catch (error) {
        logger.debug(`[restart] could not compose post-commit notice: ${error}`);
      }
    },

    resumeNotice(effect) {
      const ds = current(effect.sessionId);
      if (!ds) return;
      try {
        const botConfig = getBot(ds.larkAppId).config;
        const cliName = sessionConfiguredRuntimeDisplayName(ds.session, botConfig.cliRuntime)
          ?? getCliDisplayName((effect.cliId ?? botConfig.cliId ?? 'claude-code') as CliId);
        deliverSessionNotice(
          ds,
          `🔄 会话已通过命令行恢复，发条消息继续与 ${cliName} 对话。`,
          'resume',
        );
      } catch (error) {
        logger.debug(`[resume] could not compose post-commit notice: ${error}`);
      }
    },
  };
}
