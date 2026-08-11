import { randomUUID } from 'node:crypto';
import { effectiveDefaultWorkingDir, getBot } from '../bot-registry.js';
import { localeForBot } from '../i18n/index.js';
import * as messageQueue from '../services/message-queue.js';
import * as oncallStore from '../services/oncall-store.js';
import * as sessionStore from '../services/session-store.js';
import type { CliTurnPayload } from '../types.js';
import {
  compileExternalTrigger,
  type CompiledExternalTrigger,
} from './external-trigger-envelope.js';
import {
  ensureSessionWhiteboard,
  buildNewTopicCliInput,
  rememberLastCliInput,
} from './session-manager.js';
import {
  closeSession as closeWorkerSession,
  forkWorker,
  getCurrentCliVersion,
} from './worker-pool.js';
import {
  type KeyedTriggerStartInput,
  type KeyedTriggerTurnAcceptResult,
  type KeyedTriggerTurnCloseResult,
  type KeyedTriggerTurnPort,
  type KeyedTriggerTurnPrepareResult,
} from './session-runtime.js';
import { sessionKey } from './types.js';
import type { DaemonSession } from './types.js';
import { validateWorkingDir } from './working-dir.js';

type PreparedPhase = 'prepared' | 'materializing' | 'accepted' | 'failed' | 'closed';

interface CurrentPreparedKeyedTriggerTurn {
  input: KeyedTriggerStartInput;
  compiled: CompiledExternalTrigger;
  sessionId: string;
  triggerId: string;
  chatId: string;
  createdAt: string;
  workingDir: string;
  phase: PreparedPhase;
  ds?: DaemonSession;
  promptInput?: string | CliTurnPayload;
}

function token(): object {
  return Object.freeze({});
}

/**
 * Current JSON/worker implementation for one fresh keyed async virtual turn.
 * Preparation only mints detached identity and validates configuration. The
 * Session row, runtime registry owner, pending mirror, generation stamp, and
 * worker fork are published only after the idempotency attempt fence crossed.
 */
export function createCurrentKeyedTriggerTurnPort(options: {
  ownerLarkAppId: string;
  activeSessions: Map<string, DaemonSession>;
}): KeyedTriggerTurnPort {
  const slots = new WeakMap<object, CurrentPreparedKeyedTriggerTurn>();

  const prepare = (input: KeyedTriggerStartInput): KeyedTriggerTurnPrepareResult => {
    const chatId = `http_async_${randomUUID()}`;
    const bot = getBot(options.ownerLarkAppId);
    const oncall = oncallStore.getOncallStatus(options.ownerLarkAppId, chatId)?.workingDir;
    const botDefault = effectiveDefaultWorkingDir(bot.config);
    const candidate = oncall || botDefault || bot.config.workingDir || '~';
    const validated = validateWorkingDir(candidate, localeForBot(options.ownerLarkAppId));
    if (!validated.ok) return { kind: 'retryable', message: validated.error };

    const triggerId = `trg_${randomUUID()}`;
    const preparedToken = token();
    const prepared: CurrentPreparedKeyedTriggerTurn = {
      input,
      compiled: compileExternalTrigger(input.business, triggerId, options.ownerLarkAppId),
      sessionId: randomUUID(),
      triggerId,
      chatId,
      createdAt: new Date().toISOString(),
      workingDir: validated.resolvedPath,
      phase: 'prepared',
    };
    slots.set(preparedToken, prepared);
    return {
      kind: 'prepared',
      turn: {
        token: preparedToken,
        sessionId: prepared.sessionId,
        triggerId: prepared.triggerId,
        chatId: prepared.chatId,
      },
    };
  };

  const acceptAtMostOnce = (
    preparedToken: unknown,
    context: { key: string; pendingCreatedAt: number },
  ): KeyedTriggerTurnAcceptResult => {
    if (!preparedToken || typeof preparedToken !== 'object') {
      return { kind: 'refused', message: 'invalid keyed-trigger prepared turn token' };
    }
    const prepared = slots.get(preparedToken);
    if (!prepared || prepared.phase !== 'prepared') {
      return { kind: 'refused', message: 'keyed-trigger prepared turn was already consumed' };
    }
    prepared.phase = 'materializing';

    try {
      const bot = getBot(options.ownerLarkAppId);
      const key = sessionKey(prepared.chatId, options.ownerLarkAppId);
      if (options.activeSessions.has(key)) {
        throw new Error('fresh keyed-trigger route identity unexpectedly collided');
      }

      const session = sessionStore.createSessionExact({
        sessionId: prepared.sessionId,
        createdAt: prepared.createdAt,
        chatId: prepared.chatId,
        rootMessageId: prepared.chatId,
        title: prepared.compiled.title,
        chatType: 'group',
        scope: 'chat',
      });
      const now = Date.now();
      session.larkAppId = options.ownerLarkAppId;
      session.lastMessageAt = new Date(now).toISOString();
      session.workingDir = prepared.workingDir;
      session.cliId = bot.config.cliId;
      const isCodexFamily = bot.config.cliId === 'codex' || bot.config.cliId === 'codex-app';
      if (isCodexFamily) {
        const model = prepared.input.business.options.model;
        if (typeof model === 'string' && model.trim()) session.model = model.trim();
        const reasoningEffort = prepared.input.business.options.reasoningEffort;
        if (reasoningEffort === 'low'
            || reasoningEffort === 'medium'
            || reasoningEffort === 'high'
            || reasoningEffort === 'xhigh') {
          session.reasoningEffort = reasoningEffort;
        }
      }
      sessionStore.updateSession(session);
      messageQueue.ensureQueue(prepared.chatId);

      const ds: DaemonSession = {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId: options.ownerLarkAppId,
        chatId: prepared.chatId,
        chatType: 'group',
        scope: 'chat',
        spawnedAt: Date.parse(session.createdAt) || now,
        cliVersion: getCurrentCliVersion(),
        lastMessageAt: now,
        hasHistory: false,
        workingDir: prepared.workingDir,
        initialStartPending: true,
        pendingPrompt: prepared.compiled.prompt,
        pendingCodexAppText: prepared.compiled.visibleText,
        pendingCodexAppApplicationContext:
          prepared.compiled.applicationContext || undefined,
        pendingCodexAppMessageContext: prepared.compiled.messageContext,
      };
      prepared.ds = ds;
      options.activeSessions.set(key, ds);
      ensureSessionWhiteboard(ds);

      const promptInput = buildNewTopicCliInput(
        prepared.compiled.prompt,
        session.sessionId,
        bot.config.cliId,
        bot.config.cliPathOverride,
        undefined,
        undefined,
        [],
        undefined,
        { name: bot.botName, openId: bot.botOpenId },
        localeForBot(options.ownerLarkAppId),
        undefined,
        {
          larkAppId: options.ownerLarkAppId,
          chatId: prepared.chatId,
          whiteboardId: session.whiteboardId,
          codexAppText: prepared.compiled.visibleText,
          codexAppApplicationContext: prepared.compiled.applicationContext,
          codexAppMessageContext: prepared.compiled.messageContext,
        },
      );
      prepared.promptInput = promptInput;
      if (prepared.input.persistInputHistory) {
        rememberLastCliInput(ds, prepared.compiled.prompt, promptInput);
      }

      ds.asyncTriggerResults ??= new Map();
      ds.asyncTriggerResults.set(prepared.triggerId, {
        status: 'pending',
        createdAt: context.pendingCreatedAt,
      });
      ds.latestAsyncTriggerId = prepared.triggerId;
      const dispatchedGeneration = Math.max(
        ds.workerGeneration ?? 0,
        ds.session.workerGeneration ?? 0,
      ) + 1;
      (ds.idempotentAsyncTurns ??= new Map()).set(prepared.triggerId, {
        ownerLarkAppId: options.ownerLarkAppId,
        key: context.key,
        kind: 'fresh',
        workerGeneration: dispatchedGeneration,
      });

      const accepted = forkWorker(ds, promptInput, {
        turnId: prepared.triggerId,
        atMostOnce: true,
      });
      if (!accepted) {
        prepared.phase = 'failed';
        return { kind: 'refused', message: 'worker refused keyed trigger before acceptance' };
      }

      ds.initialStartPending = false;
      ds.pendingPrompt = undefined;
      ds.pendingCodexAppText = undefined;
      ds.pendingCodexAppApplicationContext = undefined;
      ds.pendingCodexAppMessageContext = undefined;
      prepared.phase = 'accepted';
      return { kind: 'accepted' };
    } catch (error) {
      prepared.phase = 'failed';
      throw error;
    }
  };

  const failClose = async (preparedToken: unknown): Promise<KeyedTriggerTurnCloseResult> => {
    if (!preparedToken || typeof preparedToken !== 'object') {
      return { kind: 'unreadable', message: 'invalid keyed-trigger prepared turn token' };
    }
    const prepared = slots.get(preparedToken);
    if (!prepared) return { kind: 'unreadable', message: 'unknown keyed-trigger prepared turn token' };
    if (prepared.phase === 'closed') return { kind: 'closed' };

    try {
      if (prepared.ds) {
        const result = await closeWorkerSession(prepared.sessionId);
        if (!result.ok) {
          return {
            kind: 'unreadable',
            message: `keyed-trigger fail-close was refused: ${result.error}`,
          };
        }
        for (const [key, candidate] of options.activeSessions) {
          if (candidate === prepared.ds) options.activeSessions.delete(key);
        }
      }
      const stored = sessionStore.getOwnedSession(prepared.sessionId);
      if (stored && stored.status !== 'closed') sessionStore.closeSession(prepared.sessionId);
      prepared.phase = 'closed';
      return { kind: 'closed' };
    } catch (error) {
      return {
        kind: 'unreadable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return { prepare, acceptAtMostOnce, failClose };
}
