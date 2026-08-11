/**
 * Daemon-local composition Adapter for Current ordinary Lark ingress.
 *
 * The public factory accepts only owner/registry authority and the two effects
 * that the daemon must still define locally.  Lark materialization, metadata,
 * worker-process dispatch, and VC authority are composed here once; no mutable
 * DaemonSession crosses either asynchronous effect seam.
 */

import {
  effectiveBotDisplayName,
  getBot,
} from '../../bot-registry.js';
import { config } from '../../config.js';
import { createCurrentOrdinaryIngressMetadataModule } from '../../core/current-ordinary-ingress-metadata.js';
import { createCurrentOrdinaryIngressWorkerProcesses } from '../../core/current-ordinary-ingress-worker-processes.js';
import type { CurrentSessionActivationCoordinator } from '../../core/current-session-activation.js';
import type { OrdinaryIngressPort } from '../../core/session-runtime.js';
import {
  downloadResources,
  ensureSessionWhiteboard,
  getAvailableBots,
} from '../../core/session-manager.js';
import type { DaemonSession } from '../../core/types.js';
import {
  sendWorkerInput,
} from '../../core/worker-pool.js';
import { localeForBot } from '../../i18n/index.js';
import { isCurrentVcMeetingImTurnOrigin } from '../../services/vc-meeting-send-policy.js';
import type { MessageResource } from './message-parser.js';
import { resolveSender } from './identity-cache.js';
import {
  createLarkCurrentOrdinaryIngressProductionPort,
  type LarkOrdinaryIngressMaterializationContext,
  type LarkOrdinaryIngressMaterializationIoResult,
  type LarkOrdinaryIngressQuotaInput,
  type LarkOrdinaryIngressReceivedReactionInput,
} from './current-ordinary-ingress-production.js';

export interface CurrentOrdinaryIngressDaemonOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
  readonly activation: Pick<CurrentSessionActivationCoordinator, 'ensure'>;
  readonly checkQuota: (
    input: LarkOrdinaryIngressQuotaInput,
  ) => Promise<LarkOrdinaryIngressMaterializationIoResult<null>>;
  /** Best-effort auxiliary notice; its outcome never changes accepted material. */
  readonly notifyDownloadLoginRequired: (
    input: LarkOrdinaryIngressMaterializationContext,
  ) => void | Promise<void>;
  /**
   * Per-turn stream-card rotation the daemon still owns: `live` freezes the
   * previous turn's card before a live-worker injection, `refork` parks it and
   * clears the card binding so the replacement worker POSTs a fresh card.
   */
  readonly beginTurnCardRotation: (
    current: DaemonSession,
    turn: { readonly title: string; readonly turnId: string; readonly mode: 'live' | 'refork' },
  ) => void;
  /** Best-effort ✋ on the accepted turn; `null` when gating skipped it. */
  readonly addReceivedReaction: (
    input: LarkOrdinaryIngressReceivedReactionInput,
  ) => Promise<LarkOrdinaryIngressMaterializationIoResult<
    { readonly reactionId: string } | null
  >>;
  /** Fire-and-forget "message stashed" notice behind a pending-repo opening. */
  readonly notifyPendingRepoStash: (current: DaemonSession) => void;
  readonly isPeerBot?: (openId: string) => boolean;
}

function senderType(
  kind: LarkOrdinaryIngressQuotaInput['sender']['kind'],
): 'user' | 'bot' | undefined {
  if (kind === 'human') return 'user';
  if (kind === 'bot') return 'bot';
  return undefined;
}

function notifyDownloadLoginRequired(
  notify: CurrentOrdinaryIngressDaemonOptions['notifyDownloadLoginRequired'],
  input: LarkOrdinaryIngressMaterializationContext,
): void {
  try {
    void Promise.resolve(notify(input)).catch(() => undefined);
  } catch {
    // This notice is auxiliary. Downloaded attachments remain authoritative
    // even when the login hint cannot be published.
  }
}

/** Compose and return one stable ordinary-ingress port for a daemon owner. */
export function createCurrentOrdinaryIngressDaemonPort(
  options: CurrentOrdinaryIngressDaemonOptions,
): OrdinaryIngressPort {
  const botState = getBot(options.ownerLarkAppId);
  const bot = Object.freeze({
    defaultCliId: botState.config.cliId,
    ...(botState.config.cliPathOverride === undefined
      ? {}
      : { defaultCliPathOverride: botState.config.cliPathOverride }),
    name: effectiveBotDisplayName(botState),
    ...(botState.botOpenId === undefined ? {} : { openId: botState.botOpenId }),
    locale: localeForBot(options.ownerLarkAppId),
  });
  const selfBotOpenId = botState.botOpenId;
  const substituteReplyMode = botState.config.substituteMode?.replyMode ?? 'thread';
  const sessionDataDir = config.session.dataDir;

  const metadata = createCurrentOrdinaryIngressMetadataModule({
    ownerLarkAppId: options.ownerLarkAppId,
    ...(selfBotOpenId === undefined ? {} : { selfBotOpenId }),
    selfBotAppId: options.ownerLarkAppId,
    isPeerBot: options.isPeerBot ?? (() => false),
    validateVcOrigin(origin, expected) {
      return origin.receiverSessionId === expected.receiverSessionId
        && origin.agentAppId === expected.agentAppId
        && isCurrentVcMeetingImTurnOrigin(
          sessionDataDir,
          origin,
          expected.targetChatId,
        );
    },
  });
  const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
    ownerLarkAppId: options.ownerLarkAppId,
    activeSessions: options.activeSessions,
    sendWorkerInput,
    activation: options.activation,
  });

  return createLarkCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: options.ownerLarkAppId,
    activeSessions: options.activeSessions,
    bot,
    metadata,
    workerProcesses,
    preMaterialization: {
      apply(current) {
        if (!current.adoptedFrom) ensureSessionWhiteboard(current);
        return { kind: 'ready' };
      },
    },
    clock: Date.now,
    substituteReplyMode,
    beginTurnCardRotation: options.beginTurnCardRotation,
    notifyPendingRepoStash: options.notifyPendingRepoStash,
    effects: {
      checkQuota: options.checkQuota,
      async downloadResources(input) {
        const resources: MessageResource[] = input.resources.map(resource => ({
          type: resource.type,
          key: resource.resourceKey,
          name: resource.name,
          messageId: resource.sourceMessageKey,
        }));
        const downloaded = await downloadResources(
          options.ownerLarkAppId,
          input.turnId,
          resources,
        );
        if (downloaded.needLogin) {
          notifyDownloadLoginRequired(
            options.notifyDownloadLoginRequired,
            Object.freeze({
              ownerLarkAppId: input.ownerLarkAppId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              route: input.route,
            }),
          );
        }
        return { kind: 'ok', value: downloaded.attachments };
      },
      async resolveSender(input) {
        const type = senderType(input.sender.kind);
        const sender = await resolveSender(
          options.ownerLarkAppId,
          input.sender.openId,
          type,
          {
            ...(type === undefined ? {} : { type }),
            messageId: input.turnId,
          },
        );
        return { kind: 'ok', value: sender };
      },
      async listAvailableBots(input) {
        // The listing feeds only opening prompts. A Session that already took
        // a real CLI turn can never claim the opening again, so skip the
        // per-message `listChatBotMembers` fan-out on that hot path (master
        // parity: only opening turns listed).
        for (const current of options.activeSessions.values()) {
          if (current.session.sessionId !== input.sessionId
            || current.larkAppId !== options.ownerLarkAppId) {
            continue;
          }
          if (current.hasHistory
            || current.lastCliInput !== undefined
            || current.session.lastCliInput !== undefined) {
            return { kind: 'ok', value: [] };
          }
          break;
        }
        const bots = await getAvailableBots(options.ownerLarkAppId, input.route.chatId);
        return { kind: 'ok', value: bots };
      },
      addReceivedReaction: options.addReceivedReaction,
    },
  });
}
