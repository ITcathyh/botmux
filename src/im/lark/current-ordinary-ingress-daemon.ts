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
import type { OrdinaryIngressPort } from '../../core/session-runtime.js';
import {
  downloadResources,
  ensureSessionWhiteboard,
  getAvailableBots,
} from '../../core/session-manager.js';
import type { DaemonSession } from '../../core/types.js';
import {
  forkAdoptWorker,
  forkWorker,
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
} from './current-ordinary-ingress-production.js';

export interface CurrentOrdinaryIngressDaemonOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
  readonly checkQuota: (
    input: LarkOrdinaryIngressQuotaInput,
  ) => Promise<LarkOrdinaryIngressMaterializationIoResult<null>>;
  /** Best-effort auxiliary notice; its outcome never changes accepted material. */
  readonly notifyDownloadLoginRequired: (
    input: LarkOrdinaryIngressMaterializationContext,
  ) => void | Promise<void>;
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
    forkWorker,
    forkAdoptWorker,
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
        const bots = await getAvailableBots(options.ownerLarkAppId, input.route.chatId);
        return { kind: 'ok', value: bots };
      },
    },
  });
}
