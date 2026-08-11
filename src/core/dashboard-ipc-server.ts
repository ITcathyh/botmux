// src/core/dashboard-ipc-server.ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { cliAuthBind, verifyHmac } from '../dashboard/auth.js';
import { WORKFLOW_DAEMON_IPC_ROUTE_PREFIX } from '../workflows/v3/daemon-ipc-auth.js';
import { V3_SESSION_RUN_MUTATION_ROUTE_PREFIX } from '../workflows/v3/session-relay.js';
import { REPORT_SESSION_RELAY_ROUTE } from './report-session-relay.js';
import { DISPATCH_REPORT_REGISTER_ROUTE } from './dispatch-report-binding.js';
import { listenWithProbe } from '../utils/listen-with-probe.js';
import { dashboardSecretPath } from './dashboard-secret.js';
import {
  MANAGED_ORIGIN_ATTEST_ROUTE,
  MANAGED_ORIGIN_PROOF_DOMAIN,
  MANAGED_ORIGIN_PROOF_TTL_MS,
  writeManagedOriginAttestationProof,
} from './managed-origin-attestation.js';
import * as sessionStore from '../services/session-store.js';
import { cliSupportsNativeUsage } from '../services/transcript-resolver.js';
import * as asyncTriggerStore from '../services/async-trigger-store.js';
import { resolveAsyncTriggerState, decideAsyncOwnership } from '../services/async-trigger-state.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as groupsStore from '../services/groups-store.js';
import { createGroupWithBots, transferGroupOwner } from '../services/group-creator.js';
import * as oncallStore from '../services/oncall-store.js';
import * as brandStore from '../services/brand-store.js';
import * as sandboxStore from '../services/sandbox-store.js';
import * as backendTypeStore from '../services/backend-type-store.js';
import { isValidRiffBaseUrl, isValidRiffSandboxCluster } from '../adapters/backend/riff-backend.js';
import { ensureBackendAvailable } from '../services/backend-availability.js';
import type { BackendType } from '../adapters/backend/types.js';
import * as persistentBackend from './persistent-backend.js';
import * as cardPrefsStore from '../services/card-prefs-store.js';
import * as substituteModeStore from '../services/substitute-mode-store.js';
import type { CliRuntimeConfig } from '../adapters/cli/runtime.js';
import { dashboardAgentReadIsolationEnforceableFor } from './current-dashboard-host-maintenance.js';

/** Whether read isolation can actually be ENFORCED for this bot right now — the
 *  SAME gate the worker fail-closes on (adapter support + no wrapperCli + macOS).
 *  The dashboard uses it to disable the toggle and to reject persisting an
 *  unenforceable flag, so flipping it on can never brick the bot's next session
 *  (the worker would otherwise refuse to start). Turning it OFF is always allowed. */
function readIsolationEnforceable(larkAppId: string): boolean {
  try { return dashboardAgentReadIsolationEnforceableFor(getBot(larkAppId).config); }
  catch { return false; }
}
import * as observedBotsStore from '../services/observed-bots-store.js';
import { getDeploymentIdentity } from '../services/deployment-identity.js';
import { getBotUnionId } from '../services/bot-union-ids-store.js';
import * as grantPrefsStore from '../services/grant-prefs-store.js';
import { applyExactChatGrantRequest } from '../services/exact-chat-grant.js';
import { findConfigField, applyConfigField, coerceConfigValue } from '../services/bot-config-store.js';
import { globalBuiltinSkillInjectionDefault, resolveSkillInjectionSupport } from '../skills/injection-mode.js';
import { summaryRangeFromBotConfig, updateDashboardSummaryRange } from '../services/summary-range-store.js';
import { config } from '../config.js';
import { buildSafeInsightConversation, buildSafeInsightOverview, buildSafeInsightReport, buildSafeInsightTurnDetail } from '../services/insight/report.js';
import type { InsightConversationRole, InsightDetail, InsightSeverity, SafeSpanTag } from '../services/insight/types.js';
import { readRawConfig, findEntryIndex, requireConfigPath, rmwBotEntry } from '../services/config-store.js';
import { setDefaultLocale, localeForBot, t } from '../i18n/index.js';
import { isLocale, type Locale } from '../i18n/types.js';
import { readGlobalConfig } from '../global-config.js';
import { normalizeChatReplyMode, setChatReplyMode, type ChatReplyMode } from '../services/chat-reply-mode-store.js';
import * as chatFirstSeenStore from '../services/chat-first-seen-store.js';
import * as scheduler from './scheduler.js';
import { listActiveSessions, findActiveBySessionId, getActiveSessionsRegistry, getDaemonBootId, deliverWriteLinkCardToOwners, getDaemonReplyCardUsageSnapshot, sessionSupportsWebTerminal } from './worker-pool.js';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';
import { replyMessage, sendMessage, listThreadMessages, listChatMessages, listChatMessagesUntil, listChatBotMembers, getUserProfile, getUserProfileStrict, resolveAllowedUsersWithMap, type ChatBotMember } from '../im/lark/client.js';
import { parseApiMessage, cardContentHasUpgradeFallback, resolveMergedCardContent, messageMentionsBot } from '../im/lark/message-parser.js';
import { parseSpawnRequest } from './session-create.js';
import { locateLimiter } from './dashboard-locate.js';
import { buildTerminalUrl } from './terminal-url.js';
import { dashboardEventBus } from './dashboard-events.js';
import { currentDashboardProjectionProtocol } from './dashboard-projection.js';
import { currentSessionRuntimeHost } from './current-session-runtime.js';
import { validateWorkingDir } from './working-dir.js';
import { isValidRoleChatId, resolveRole, resolveRoleFile, writeRoleFile, deleteRoleFile, readRoleInjectMode, writeRoleInjectMode, deleteRoleMeta, readRoleDispatchCompletionEnabled, writeRoleDispatchCompletionEnabled, type RoleInjectMode } from './role-resolver.js';
import {
  deleteRoleProfileEntry,
  deleteRoleProfileIfEmpty,
  isValidRoleProfileId,
  listRoleProfileEntries,
  listRoleProfiles,
  MAX_ROLE_PROFILE_ENTRY_BYTES,
  readRoleProfileEntry,
  writeRoleProfileEntry,
} from '../services/role-profile-store.js';
import { triggerSessionTurn } from './trigger-session.js';
import { validateTriggerRequest, type TriggerResponse } from '../services/trigger-types.js';
import { selectionKeyForBot } from '../setup/cli-selection.js';
import { enrichHistorySenders, type HistoryBotInfo } from '../dashboard/history-senders.js';
import {
  validateCodexAppManagedSendOrigin,
} from '../utils/codex-app-dispatch-ledger.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import {
  protectedSessionMutationReasons,
} from './session-mutation-guard.js';
import { listPendingAsks, submitAskFromDesktop } from './ask-broker.js';
import { getMessageListenerConfig, sanitizeMessageListenerUpdate, updateMessageListenerConfig, validateMessageListenerUpdate } from '../services/message-listener-store.js';
import {
  MAX_MESSAGE_LISTENER_PROMPT_BYTES,
  normalizeMessageListenerPreviewLimit,
  previewMessageListenerMatches,
  buildListenerBotAppIdToOpenId,
  collectListenerBotAppIds,
  renderMessageListenerInstruction,
  type MessageListenerPreviewMatch,
} from '../services/message-listener.js';
import {
  createMessageListenerRunPreview,
  createMessageListenerRunPreviewTurnId,
  getMessageListenerRunPreview,
  markMessageListenerRunPreviewFailed,
  markMessageListenerRunPreviewTriggered,
} from '../services/message-listener-run-preview-store.js';
import { listChatMemberDisplays } from '../services/groups-store.js';

const MESSAGE_LISTENER_PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
import {
  SUPERVISOR_SHUTDOWN_ROUTE,
  isExactSupervisorShutdownRequest,
  type SupervisorShutdownIdentity,
} from './supervisor-shutdown-ipc.js';
import type {
  CurrentDashboardSessionCommandSubmitter,
  CurrentDashboardSessionRuntimeCommand,
  CurrentDashboardSessionRuntimeTarget,
} from './current-dashboard-session-command-client.js';
import type { CurrentDashboardControlEffects } from './current-dashboard-control-effects.js';
import type {
  DashboardHostMaintenance,
  DashboardHostMaintenanceMode,
} from './current-dashboard-host-maintenance.js';
import type { DashboardChatRename } from './current-dashboard-chat-rename.js';

export type DashboardSessionRuntimeCommand = CurrentDashboardSessionRuntimeCommand;
export type DashboardSessionRuntimeTarget = CurrentDashboardSessionRuntimeTarget;
export type DashboardSessionRuntimeSubmitter = CurrentDashboardSessionCommandSubmitter;

let dashboardSessionRuntimeSubmitter: DashboardSessionRuntimeSubmitter | undefined;
let dashboardControlEffects: CurrentDashboardControlEffects | undefined;
let dashboardHostMaintenance: DashboardHostMaintenance | undefined;
let dashboardChatRename: DashboardChatRename | undefined;

export function setDashboardSessionRuntimeSubmitter(
  submitter: DashboardSessionRuntimeSubmitter | null,
): void {
  dashboardSessionRuntimeSubmitter = submitter ?? undefined;
}

export function setDashboardControlEffects(
  effects: CurrentDashboardControlEffects | null,
): void {
  dashboardControlEffects = effects ?? undefined;
}

export function setDashboardHostMaintenance(
  maintenance: DashboardHostMaintenance | null,
): void {
  dashboardHostMaintenance = maintenance ?? undefined;
}

export function setDashboardChatRename(rename: DashboardChatRename | null): void {
  dashboardChatRename = rename ?? undefined;
}


type SessionOperationIdResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: 'bad_operation_id' };

function isValidSessionOperationId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !value.includes('\0');
}

function sessionOperationId(
  req: IncomingMessage,
  body: unknown,
): SessionOperationIdResult {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
  const hasBodyId = !!record && Object.prototype.hasOwnProperty.call(record, 'operationId');
  const bodyId = record?.operationId;
  const headerId = req.headers['x-botmux-operation-id'];
  const hasHeaderId = headerId !== undefined;

  // An explicitly supplied malformed value is a client error. Silently
  // replacing it with a fresh UUID defeats retry identity: the caller believes
  // it retried one operation while the Runtime sees a different command.
  if ((hasBodyId && !isValidSessionOperationId(bodyId))
    || (hasHeaderId && !isValidSessionOperationId(headerId))) {
    return { ok: false, error: 'bad_operation_id' };
  }
  if (hasBodyId && hasHeaderId && bodyId !== headerId) {
    return { ok: false, error: 'bad_operation_id' };
  }
  if (!hasBodyId && !hasHeaderId) {
    return { ok: false, error: 'bad_operation_id' };
  }
  return {
    ok: true,
    value: hasBodyId
      ? bodyId as string
      : headerId as string,
  };
}

let exactChatGrantHandler: typeof applyExactChatGrantRequest = applyExactChatGrantRequest;
/** Test seam: replace the exact-grant service without touching live Feishu/config state. */
export function setExactChatGrantHandler(handler: typeof applyExactChatGrantRequest | null): void {
  exactChatGrantHandler = handler ?? applyExactChatGrantRequest;
}
// 机器人真·改名 renamer，由 daemon 启动时注册（开放平台自动化 + daemon 侧
// botName/descriptor/bots-info 同步都在 daemon 的闭包里做）。未注册（测试环境）
// 时 PUT /api/bot-rename 降级为仅改 displayName。
export type BotRenameOutcome =
  | { ok: true; name: string }
  | { ok: false; reason: string; message: string };
let botRenamer: ((newName: string) => Promise<BotRenameOutcome>) | null = null;
export function setBotRenamer(fn: ((newName: string) => Promise<BotRenameOutcome>) | null): void {
  botRenamer = fn;
}
// 机器人真·改头像，注册方式同 renamer（开放平台自动化 + daemon 侧
// botAvatarUrl/descriptor/bots-info 同步在 daemon 闭包里做）。头像没有
// botmux 侧的本地等价物，失败不降级，把结构化原因原样返回给前端。
export type BotAvatarOutcome =
  | { ok: true; avatarUrl: string; versionId?: string }
  | { ok: false; reason: string; message: string };
let botAvatarChanger: ((image: Buffer) => Promise<BotAvatarOutcome>) | null = null;
export function setBotAvatarChanger(fn: ((image: Buffer) => Promise<BotAvatarOutcome>) | null): void {
  botAvatarChanger = fn;
}

type SupervisorShutdownRegistration = SupervisorShutdownIdentity & {
  shutdown: () => Promise<void>;
};
let supervisorShutdownRegistration: SupervisorShutdownRegistration | null = null;
export function setSupervisorShutdownHandler(
  registration: SupervisorShutdownRegistration | null,
): void {
  supervisorShutdownRegistration = registration;
}
import {
  composeRowFromActive,
  composeRowFromClosed,
  composeRowFromPersistedActive,
  feishuChatLink,
  setBotName as setRowsBotName,
  getBotName,
  type SessionRow,
} from './dashboard-rows.js';
import { getBotBrand, getBot, loadBotConfigs, readBotSkillPolicy, getBotTuiSlashAllow, requireBotId, type UsageDisplayMode, type MessageListenerConfig } from '../bot-registry.js';
import { normalizeKanbanColumn, normalizeKanbanPosition, normalizeSessionTitle } from './session-board.js';
import { validateSlashInjection } from './slash-inject.js';
import { validateRoleLibraryPath } from './role-library.js';
import { authorizeSessionScopedIpc } from './daemon-ipc-session-auth.js';
import { normalizeSessionTitleSource } from './session-title.js';
import type { ScheduledTask, ParsedSchedule, ScheduleExecutionPosition, Session } from '../types.js';
import { sessionAnchorId, larkTransportEnabled, type DaemonSession } from './types.js';
import { attachSkillPolicy, detachSkillPolicy } from './skills/im-command.js';
import { readSkillRegistry } from '../services/skill-registry-store.js';
import {
  commitDeviceIsolationActivation,
  DEVICE_ISOLATION_COMMIT_PATH,
  DEVICE_ISOLATION_PREPARE_PATH,
  DEVICE_ISOLATION_RELEASE_PATH,
  logDeviceIsolationActivationError,
  prepareDeviceIsolationActivation,
  releaseDeviceIsolationActivation,
  type DeviceIsolationDaemonResult,
} from './device-isolation-daemon.js';

export interface IpcServerHandle {
  port: number;
  close: () => Promise<void>;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Requests that crossed the server-wide trusted-host gate. The legacy
 * write-link handlers consult this marker so they do not verify (and consume)
 * the same one-shot nonce twice. */
const trustedHostRequests = new WeakSet<IncomingMessage>();
export function isTrustedHostIpcRequest(req: IncomingMessage): boolean {
  return trustedHostRequests.has(req);
}

/** Register a handler. Path supports `:name` segments captured into the params object. */
export function ipcRoute(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$',
  );
  routes.push({ method: method.toUpperCase(), pattern, keys, handler });
}

export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rejectProtectedSessionMutation(
  res: ServerResponse,
  values: readonly (DaemonSession | Session)[],
): boolean {
  const bySessionId = new Map<string, {
    sessionId: string;
    cliId?: string;
    reasons: ReturnType<typeof protectedSessionMutationReasons>;
  }>();
  for (const value of values) {
    const session = 'session' in value ? value.session : value;
    const reasons = protectedSessionMutationReasons(value);
    if (reasons.length === 0) continue;
    const existing = bySessionId.get(session.sessionId);
    if (existing) {
      existing.reasons = [...new Set([...existing.reasons, ...reasons])];
      continue;
    }
    bySessionId.set(session.sessionId, {
      sessionId: session.sessionId,
      ...(session.cliId ? { cliId: session.cliId } : {}),
      reasons,
    });
  }
  const blockingSessions = [...bySessionId.values()];
  if (blockingSessions.length === 0) return false;
  const codexDispatchOnly = blockingSessions.every(blocker =>
    blocker.reasons.every(reason => reason === 'codex_app_dispatch'));
  jsonRes(res, 409, {
    ok: false,
    error: codexDispatchOnly
      ? 'codex_app_dispatch_pending'
      : 'session_mutation_pending',
    blockingSessions,
  });
  return true;
}

ipcRoute('POST', SUPERVISOR_SHUTDOWN_ROUTE, async (req, res) => {
  // The production server-wide HMAC gate records trusted requests here. Keep
  // an explicit route-local check: shutdown is never a bare loopback API.
  if (!isTrustedHostIpcRequest(req)) {
    return jsonRes(res, 403, { ok: false, error: 'supervisor_shutdown_unauthorized' });
  }
  const registration = supervisorShutdownRegistration;
  if (!registration) {
    return jsonRes(res, 503, { ok: false, error: 'supervisor_shutdown_not_ready' });
  }
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  if (!isExactSupervisorShutdownRequest(registration, body)) {
    return jsonRes(res, 409, { ok: false, error: 'supervisor_shutdown_generation_mismatch' });
  }
  // ACK means this exact in-memory generation accepted the request; the CLI
  // still proves OS/PM2 quiescence. Start after flushing the ACK so a long Riff
  // drain cannot turn a valid request into an ambiguous transport timeout.
  jsonRes(res, 202, {
    ok: true,
    accepted: true,
    larkAppId: registration.larkAppId,
    bootInstanceId: registration.bootInstanceId,
    processStartIdentity: registration.processStartIdentity,
  });
  setImmediate(() => {
    void registration.shutdown().catch(error => {
      logger.error(`supervisor shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
});
export class JsonBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`JSON request body exceeds ${maxBytes} bytes`);
    this.name = 'JsonBodyTooLargeError';
  }
}

export class AbortDeadlineError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'AbortDeadlineError';
  }
}

/** 校验跨进程 JSON envelope，只接受普通对象和完整、精确的自有字段集合。 */
export function hasExactSafeJsonKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length) return false;
  if (['__proto__', 'prototype', 'constructor'].some(key => Object.hasOwn(value, key))) {
    return false;
  }
  const expected = new Set(expectedKeys);
  return keys.every(key => expected.has(key));
}

/**
 * 为支持 AbortSignal 的底层操作设置硬截止时间。Promise.race 保证调用方按时释放
 * in-flight 状态，AbortController 同时取消仍在执行的网络或子进程操作。
 */
export async function runWithAbortDeadline<T>(
  label: string,
  timeoutMs: number,
  task: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive safe integer');
  }
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new AbortDeadlineError(label, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([task(controller.signal, deadlineAt), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  maxBytes?: number,
): Promise<T> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  if (maxBytes !== undefined) {
    const declared = req.headers?.['content-length'];
    const declaredBytes = typeof declared === 'string' && /^\d+$/.test(declared)
      ? Number(declared)
      : undefined;
    if (declaredBytes !== undefined && declaredBytes > maxBytes) {
      req.once('error', () => {});
      req.resume();
      throw new JsonBodyTooLargeError(maxBytes);
    }

    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAborted);
      };
      const rejectOnce = (error: Error, drain = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (drain) {
          // 不销毁 keep-alive socket，只丢弃剩余正文，让调用方仍能返回 413。
          req.once('error', () => {});
          req.resume();
        }
        reject(error);
      };
      const onData = (raw: Buffer | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          chunks.length = 0;
          rejectOnce(new JsonBodyTooLargeError(maxBytes), true);
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks, totalBytes));
      };
      const onError = (error: Error) => rejectOnce(error);
      const onAborted = () => rejectOnce(new Error('request aborted'));
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAborted);
    });
    if (body.byteLength === 0) return {} as T;
    return JSON.parse(body.toString('utf8'));
  }

  const chunks: Buffer[] = [];
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

class IpcBodyTooLargeError extends Error {}
class IpcBodyTimeoutError extends Error {}

/** Strict reader for the one unauthenticated capability challenge route. The
 * generic IPC reader intentionally has no cap for trusted-host endpoints; a
 * loopback-confined process must not be able to buffer arbitrary chunked input
 * before its capability is checked. */
async function readBoundedJsonBody<T = unknown>(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<T> {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new IpcBodyTooLargeError('request body too large');
    }
  }
  return await new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.pause();
      cleanup();
      reject(err);
    };
    const onData = (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > maxBytes) {
        fail(new IpcBodyTooLargeError('request body too large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(chunks.length === 0
          ? {} as T
          : JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as T);
      } catch (err) {
        reject(err);
      }
    };
    const onError = (err: Error) => fail(err);
    const onAborted = () => fail(new Error('request aborted'));
    const timer = setTimeout(
      () => fail(new IpcBodyTimeoutError('request body timed out')),
      timeoutMs,
    );
    timer.unref?.();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function closeUntrustedRequestAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('connection', 'close');
  res.once('finish', () => req.destroy());
  // Drain whatever is already buffered until the response has been flushed;
  // the finish hook then closes a partial/slow body instead of reusing it as a
  // keep-alive request.
  req.resume();
}

// ─── Trusted-host auth (loopback + route-bound HMAC) ────────────────────────
//
// Production start enables a server-wide gate: loopback is connectivity, not
// identity, because a Linux bwrap CLI keeps host networking for model egress.
// Every data/read or mutation route therefore requires proof that the caller
// can read ~/.botmux/.dashboard-secret. Only health and a tiny set of handlers
// with their own exact live-worker capability checks are admitted without it.
// The two write-link handlers retain their historical local check for unit-test
// compatibility; production requests arrive pre-authorized and are marked in
// trustedHostRequests so the one-shot nonce is not consumed twice.
let injectedIpcSecret: string | null = null;
/** Test seam: override the secret used to verify token-route HMAC. */
export function setIpcAuthSecret(secret: string | null): void { injectedIpcSecret = secret; }
function ipcAuthSecret(): string | null {
  if (injectedIpcSecret) return injectedIpcSecret;
  try { return readFileSync(dashboardSecretPath(), 'utf8').trim() || null; }
  catch { return null; }
}
/** Authenticate legacy terminal-token routes with the machine-local dashboard
 * secret. Workflow v3 mutations intentionally use their separate, full-request
 * protocol (`workflows/v3/daemon-ipc-auth`) and must never call this bare
 * ts:nonce verifier. */
export function ipcHmacAuthorized(req: IncomingMessage, bind?: string): boolean {
  if (trustedHostRequests.has(req)) return true;
  const secret = ipcAuthSecret();
  if (!secret) return false; // fail-closed: no secret on disk → nobody can sign
  const ts = req.headers['x-botmux-cli-ts'];
  const nonce = req.headers['x-botmux-cli-nonce'];
  const sig = req.headers['x-botmux-cli-auth'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') return false;
  return verifyHmac(secret, { ts, nonce, sig }, req.socket.remoteAddress ?? '', bind).ok;
}

function tokenRouteAuthorized(req: IncomingMessage, bind?: string): boolean {
  return ipcHmacAuthorized(req, bind);
}

function routeHasPublicAccess(method: string, pathname: string): boolean {
  // Liveness contains no data and performs no mutation. /healthz is the
  // core-only public alias of /__health (riff's sandbox launcher polls it).
  return method === 'GET' && (pathname === '/__health' || pathname === '/healthz');
}

/**
 * Core-only ONLY: the exact riff-facing routes that bypass the trusted-host HMAC
 * when the daemon runs headless in riff's sandbox. Everything else STILL requires
 * the HMAC (codex P1: authRequired:false opened all 96 IPC routes — a co-resident
 * model turn could read/perturb sessions, scheduler, mutations). This is a tight
 * allowlist of drive-my-own-turn + poll-my-own-output surfaces:
 *   POST /api/trigger                              (start a turn)
 *   GET  /api/sessions/:id/trigger-result          (poll final)
 *   GET  /api/sessions/:id/insight                 (poll conversation/progress)
 * `/api/asks/answer` is deliberately EXCLUDED — it is askId-keyed with no
 * session/turn binding, so exposing it would let any co-resident turn hijack
 * another pending ask (codex). riff's async main-link needs no awaiting_input;
 * a future clarify path must be a sessionId+interaction-bound endpoint.
 */
function routeIsCoreOnlyPublic(method: string, pathname: string): boolean {
  if (method === 'POST' && pathname === '/api/trigger') return true;
  if (method === 'GET') {
    return /^\/api\/sessions\/[^/]+\/trigger-result$/.test(pathname)
      || /^\/api\/sessions\/[^/]+\/insight$/.test(pathname);
  }
  return false;
}

function routeHasNarrowUntrustedAuth(method: string, pathname: string): boolean {
  // The receiver action endpoint performs its own rotating worker-capability
  // verification and then enters the durable action ledger. Keeping this one
  // aperture is what preserves managed meeting actions from inside bwrap.
  if (method === 'POST' && pathname === '/api/vc-meetings/action-request') return true;
  // These two CLI-in-sandbox endpoints verify the same rotating capability in
  // their handlers and bind it to body.sessionId. They cannot be bare loopback
  // exceptions: a receiver that learned another session id could otherwise
  // forge readiness or an ask for that session.
  if (method === 'POST' && pathname === '/api/session-ready') return true;
  if (method === 'POST' && pathname === '/api/asks') return true;
  // botmux slash / botmux role switch（角色切换）/ botmux delete（关闭自身）：合法调用方
  // 是会话内的 CLI 自身，沙箱 / 读隔离下读不到 host secret。handler 内验证
  // 该会话的 rotating per-turn
  // capability 并绑定到 URL 里的 sessionId（同 /api/asks 姿势）——capability 只
  // 证明「我是这个会话当前这一轮的 CLI」，选不了别的会话。
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/(?:slash|cd|close|chat-rename)$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/api/hooks/emit') return true;
  if (method === 'POST' && pathname === '/api/attention') return true;
  // A sandboxed report cannot read the host HMAC secret. This narrow route
  // validates the current session's rotating capability, binds the dispatch
  // root server-side, then lets the trusted daemon relay to the orchestrator.
  if (method === 'POST' && pathname === REPORT_SESSION_RELAY_ROUTE) return true;
  if (method === 'POST' && pathname === DISPATCH_REPORT_REGISTER_ROUTE) return true;
  // macOS read-isolated `botmux send` presents a rotating worker capability;
  // the handler writes the authoritative tuple into a host-owned read-only
  // proof sidecar, so loopback response spoofing cannot confer authority.
  if (method === 'POST' && pathname === MANAGED_ORIGIN_ATTEST_ROUTE) return true;
  // Workflow v3 mutations carry their own domain-separated full-envelope
  // protocol (request signature over method/path/exact body with nonce
  // anti-replay + boot audience, signed response), keyed on the same host
  // secret as the outer gate. The handler fail-closes on that envelope, which
  // is strictly stronger binding than the outer ts:nonce HMAC, so the prefix
  // is admitted here instead of being double-signed with the same secret.
  if (method === 'POST' && pathname.startsWith(`${WORKFLOW_DAEMON_IPC_ROUTE_PREFIX}/`)) return true;
  // Workflow v3 session relay: sandboxed / read-isolated chat CLIs cannot read
  // the host secret, so these handlers verify the session's rotating per-turn
  // capability and re-derive the caller tuple from the daemon's own live
  // session record (same posture as /api/asks above).
  if (method === 'POST' && pathname.startsWith(`${V3_SESSION_RUN_MUTATION_ROUTE_PREFIX}/`)) return true;
  return false;
}

function trustedHostAuthorized(
  req: IncomingMessage,
  pathname: string,
  port: number,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  const ts = req.headers['x-botmux-cli-ts'];
  const nonce = req.headers['x-botmux-cli-nonce'];
  const sig = req.headers['x-botmux-cli-auth'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    return { ok: false, reason: 'missing_headers' };
  }
  const bind = cliAuthBind(req.method ?? 'GET', pathname, port);
  const verified = verifyHmac(
    secret,
    { ts, nonce, sig },
    req.socket.remoteAddress ?? '',
    bind,
  );
  return verified.ok
    ? { ok: true }
    : { ok: false, reason: verified.reason ?? 'unauthorized' };
}

ipcRoute('GET', '/__health', (_req, res) => {
  jsonRes(res, 200, { ok: true });
});
// Core-only readiness barrier (codex P1-3): the daemon binds its HTTP port BEFORE
// restoreActiveSessions / v3 cold-attach / scheduler finish, so a launcher that
// triggers the instant the port answers would race durable restore (transient
// not_found / re-fire). /healthz returns 503 until the daemon marks itself ready
// (setCoreOnlyReady, called AFTER restore in daemon.ts). Non-core-only daemons
// never set this gate, so /healthz stays an unconditional 200 there.
let coreOnlyReadinessGate = false; // true only in core-only, until ready
let coreOnlyReady = false;
export function armCoreOnlyReadinessGate(): void { coreOnlyReadinessGate = true; }
export function setCoreOnlyReady(): void { coreOnlyReady = true; }
/** @internal test-only: reset the core-only readiness gate between cases. */
export function __testOnly_resetCoreOnlyReadiness(): void { coreOnlyReadinessGate = false; coreOnlyReady = false; }
/** True when the readiness gate is armed (core-only) but restore hasn't finished.
 *  The server-level gate returns 503 for the public control routes in this state,
 *  and /healthz reports 'starting' — a barrier so riff can't trigger into a racing
 *  durable restore even if it skips the healthz probe (codex P1). */
function coreOnlyNotReady(): boolean { return coreOnlyReadinessGate && !coreOnlyReady; }
// Public alias for core-only: riff's sandbox launcher polls GET /healthz to know
// the service is FULLY up (bound AND restore-complete). 200 {ok:true} once ready;
// 503 {ok:false,status:'starting'} while the readiness gate is armed but not ready.
ipcRoute('GET', '/healthz', (_req, res) => {
  if (coreOnlyNotReady()) {
    return jsonRes(res, 503, { ok: false, status: 'starting' });
  }
  jsonRes(res, 200, { ok: true });
});

const MANAGED_ORIGIN_ATTEST_BODY_MAX_BYTES = 2 * 1024;
const MANAGED_ORIGIN_ATTEST_BODY_TIMEOUT_MS = 1_000;
const MANAGED_ORIGIN_ATTEST_MAX_PREAUTH_IN_FLIGHT = 128;
const MANAGED_ORIGIN_ATTEST_MAX_OUTSTANDING_PER_SESSION = 64;
const managedOriginOutstandingProofs = new Map<string, number>();
let managedOriginPreauthInFlight = 0;

async function handleManagedOriginAttestation(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: {
    sessionId?: unknown;
    originChannelId?: unknown;
    channelId?: unknown;
    originCapability?: unknown;
    nonce?: unknown;
  };
  try {
    body = await readBoundedJsonBody(
      req,
      MANAGED_ORIGIN_ATTEST_BODY_MAX_BYTES,
      MANAGED_ORIGIN_ATTEST_BODY_TIMEOUT_MS,
    );
  }
  catch (err) {
    if (err instanceof IpcBodyTooLargeError || err instanceof IpcBodyTimeoutError) {
      closeUntrustedRequestAfterResponse(req, res);
    }
    return jsonRes(
      res,
      err instanceof IpcBodyTooLargeError
        ? 413
        : err instanceof IpcBodyTimeoutError
          ? 408
          : 400,
      {
        ok: false,
        error: err instanceof IpcBodyTooLargeError
          ? 'body_too_large'
          : err instanceof IpcBodyTimeoutError
            ? 'body_timeout'
            : 'bad_json',
      },
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonRes(res, 400, { ok: false, error: 'bad_attestation_request' });
  }
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.length <= 256
    ? body.sessionId
    : '';
  const capability = typeof body.originCapability === 'string'
    && /^[a-f0-9]{32,128}$/i.test(body.originCapability)
    ? body.originCapability
    : '';
  const channelId = typeof (body.originChannelId ?? body.channelId) === 'string'
    && /^[a-f0-9]{64}$/.test((body.originChannelId ?? body.channelId) as string)
    ? (body.originChannelId ?? body.channelId) as string
    : '';
  const nonce = typeof body.nonce === 'string' && /^[a-f0-9]{64}$/.test(body.nonce)
    ? body.nonce
    : '';
  if (!sessionId || !channelId || !capability || !nonce) {
    return jsonRes(res, 400, { ok: false, error: 'bad_attestation_request' });
  }
  const ds = findActiveBySessionId(sessionId);
  const worker = ds?.worker;
  let workerPidLive = false;
  if (worker && Number.isSafeInteger(worker.pid) && (worker.pid ?? 0) > 0) {
    try {
      process.kill(worker.pid!, 0);
      workerPidLive = true;
    } catch { /* ESRCH/EPERM/invalid pid all fail closed */ }
  }
  const workerLive = !!worker
    && worker.connected === true
    && !worker.killed
    && worker.exitCode === null
    && worker.signalCode === null
    && workerPidLive;
  const liveTurnId = ds?.managedTurnOrigin?.turnId;
  const verified = authorizeSessionScopedIpc({
    trustedHost: false,
    sessionExists: !!ds,
    receiverSession: !!ds?.session.vcMeetingReceiver,
    allowReceiver: true,
    sessionId,
    liveOrigin: ds?.managedTurnOrigin,
    claimedCapability: capability,
  });
  if (!verified.ok || !ds?.managedTurnOrigin || !liveTurnId || !workerLive) {
    return jsonRes(res, 403, { ok: false, error: 'origin_unproven' });
  }
  const origin = ds.managedTurnOrigin;
  if (!origin.originChannelId || !/^[a-f0-9]{64}$/.test(origin.originChannelId)) {
    return jsonRes(res, 403, { ok: false, error: 'origin_channel_unproven' });
  }
  if (channelId !== origin.originChannelId) {
    return jsonRes(res, 403, { ok: false, error: 'origin_channel_unproven' });
  }
  const codexDecision = validateCodexAppManagedSendOrigin(
    ds.session.codexAppDispatchLedger,
    origin,
    ds.initConfig?.cliId === 'codex-app' || ds.session.cliId === 'codex-app',
  );
  if (!codexDecision.ok) {
    return jsonRes(res, 409, { ok: false, error: 'origin_not_sendable' });
  }
  const outstanding = managedOriginOutstandingProofs.get(sessionId) ?? 0;
  if (outstanding >= MANAGED_ORIGIN_ATTEST_MAX_OUTSTANDING_PER_SESSION) {
    return jsonRes(res, 429, { ok: false, error: 'too_many_attestations' });
  }
  let proofPath: string;
  try {
    proofPath = writeManagedOriginAttestationProof({
      dataDir: config.session.dataDir,
      proof: {
        domain: MANAGED_ORIGIN_PROOF_DOMAIN,
        version: 1,
        nonce,
        channelId: origin.originChannelId,
        sessionId,
        turnId: liveTurnId,
        ...(origin.dispatchAttempt !== undefined
          ? { dispatchAttempt: origin.dispatchAttempt }
          : {}),
        requiresCodexAppLedger: codexDecision.requiresLedger,
        issuedAtMs: Date.now(),
      },
    });
  } catch (err) {
    logger.warn(`[managed-origin] could not write attestation proof: ${err}`);
    return jsonRes(res, 409, { ok: false, error: 'proof_unavailable' });
  }
  managedOriginOutstandingProofs.set(sessionId, outstanding + 1);
  const cleanupTimer = setTimeout(() => {
    try { unlinkSync(proofPath); } catch { /* expired/already gone */ }
    const remaining = (managedOriginOutstandingProofs.get(sessionId) ?? 1) - 1;
    if (remaining > 0) managedOriginOutstandingProofs.set(sessionId, remaining);
    else managedOriginOutstandingProofs.delete(sessionId);
  }, MANAGED_ORIGIN_PROOF_TTL_MS + 1_000);
  cleanupTimer.unref?.();
  return jsonRes(res, 200, { ok: true });
}

ipcRoute('POST', MANAGED_ORIGIN_ATTEST_ROUTE, async (req, res) => {
  // This counter is acquired before parsing or capability lookup.  Per-session
  // proof quotas cannot protect the unauthenticated slow-body phase because a
  // session id is not trustworthy until the complete request has been read.
  if (managedOriginPreauthInFlight >= MANAGED_ORIGIN_ATTEST_MAX_PREAUTH_IN_FLIGHT) {
    closeUntrustedRequestAfterResponse(req, res);
    return jsonRes(res, 429, { ok: false, error: 'too_many_attestation_requests' });
  }
  managedOriginPreauthInFlight += 1;
  try {
    await handleManagedOriginAttestation(req, res);
  } finally {
    managedOriginPreauthInFlight -= 1;
  }
});

// ─── Session list / detail ─────────────────────────────────────────────────
// Row shape + composers live in dashboard-rows.ts so worker-pool can publish
// SessionRow events without importing this module (which would create a cycle:
// worker-pool → dashboard-ipc-server → worker-pool).

export type { SessionRow };
export { composeRowFromActive, composeRowFromClosed, composeRowFromPersistedActive };

// Re-export setBotName for backwards-compatible imports (daemon.ts).  Both
// callers (this module's cachedBotName + dashboard-rows' cachedBotName) need
// to be primed; here we forward to the rows module which is the canonical
// holder.
export function setBotName(name: string): void { setRowsBotName(name); }

export async function readCurrentDashboardSessionSnapshot() {
  if (!cachedLarkAppId) return currentDashboardProjectionProtocol.snapshot([]);
  const activeSessions = getActiveSessionsRegistry();
  if (!activeSessions) {
    throw new Error('Current Session registry is not connected');
  }
  const host = currentSessionRuntimeHost({
    ownerBotId: requireBotId(cachedLarkAppId),
    ownerLarkAppId: cachedLarkAppId,
    activeSessions,
    ownerBootId: getDaemonBootId(),
    keyedTriggerAdmissionBlocked: () => false,
  });
  const projected = await host.projection.read({ kind: 'dashboardSnapshot' });
  if (projected.kind !== 'dashboardSnapshot') {
    throw new Error(
      projected.kind === 'notReady'
        ? projected.message
        : `Current dashboard projection returned ${projected.kind}`,
    );
  }
  return projected.snapshot;
}

// The daemon's own larkAppId, primed at startup. Required for the groups
// endpoints below which proxy calls into groups-store on this bot's behalf.
let cachedLarkAppId = '';
export function setLarkAppId(id: string): void { cachedLarkAppId = id; }

async function handleDeviceIsolationActivationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (body: unknown) => DeviceIsolationDaemonResult | Promise<DeviceIsolationDaemonResult>,
): Promise<void> {
  // Keep this explicit even though production enables the server-wide gate:
  // unit-test/dev servers must not accidentally turn this authority-bearing
  // transition into a bare-loopback endpoint.
  if (!ipcHmacAuthorized(req)) {
    return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }
  try {
    const body = await readJsonBody(req);
    const result = await handler(body);
    jsonRes(res, result.status, result.body);
  } catch (error) {
    logDeviceIsolationActivationError(error);
    jsonRes(res, 503, { ok: false, error: 'activation_unavailable' });
  }
}

ipcRoute('POST', DEVICE_ISOLATION_PREPARE_PATH, (req, res) =>
  handleDeviceIsolationActivationRoute(req, res, prepareDeviceIsolationActivation));
ipcRoute('POST', DEVICE_ISOLATION_COMMIT_PATH, (req, res) =>
  handleDeviceIsolationActivationRoute(req, res, commitDeviceIsolationActivation));
ipcRoute('POST', DEVICE_ISOLATION_RELEASE_PATH, (req, res) =>
  handleDeviceIsolationActivationRoute(req, res, releaseDeviceIsolationActivation));

// ─── Pending asks (trusted Desktop/dashboard operator only) ─────────────────

ipcRoute('GET', '/api/asks/pending', (req, res) => {
  if (!isTrustedHostIpcRequest(req)) {
    return jsonRes(res, 403, { ok: false, error: 'trusted_host_required' });
  }
  const asks = listPendingAsks().map((ask) => ({
    askId: ask.askId,
    sessionId: ask.sessionId,
    larkAppId: ask.larkAppId,
    chatId: ask.chatId,
    rootMessageId: ask.rootMessageId,
    questions: ask.questions,
    deadlineAt: ask.deadlineAt,
    createdAt: ask.createdAt,
  }));
  return jsonRes(res, 200, { asks });
});

ipcRoute('POST', '/api/asks/answer', async (req, res) => {
  if (!isTrustedHostIpcRequest(req)) {
    return jsonRes(res, 403, { ok: false, error: 'trusted_host_required' });
  }
  let body: { askId?: string; selections?: string[][]; by?: string };
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  if (!body.askId || !Array.isArray(body.selections)) {
    return jsonRes(res, 400, { ok: false, error: 'askId_and_selections_required' });
  }
  const outcome = submitAskFromDesktop({
    askId: body.askId,
    selections: body.selections,
    by: typeof body.by === 'string' ? body.by : 'desktop',
  });
  if (outcome !== 'accepted') {
    return jsonRes(res, 409, { ok: false, error: outcome });
  }
  return jsonRes(res, 200, { ok: true, outcome });
});

ipcRoute('GET', '/api/sessions', async (_req, res) => {
  try {
    jsonRes(res, 200, await readCurrentDashboardSessionSnapshot());
  } catch (error) {
    jsonRes(res, 503, {
      error: 'projection_not_ready',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

ipcRoute('GET', '/api/runtime-status', (_req, res) => {
  jsonRes(res, 200, {
    ...currentDashboardProjectionProtocol.position(),
    readiness: currentDashboardProjectionProtocol.status(),
  });
});

ipcRoute('GET', '/api/sessions/:sessionId', async (_req, res, params) => {
  try {
    const snapshot = await readCurrentDashboardSessionSnapshot();
    const row = snapshot.rows.find(candidate => candidate.sessionId === params.sessionId);
    return row
      ? jsonRes(res, 200, { session: row })
      : jsonRes(res, 404, { error: 'not_found' });
  } catch (error) {
    return jsonRes(res, 503, {
      error: 'projection_not_ready',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/** Low-frequency card-display read used by `botmux send`. Keeping the
 * transcript reader and per-bot visibility decision in the resident daemon
 * preserves its incremental cache and live config instead of making every
 * short-lived CLI process rescan the Session or guess from sandboxed files. */
ipcRoute('GET', '/api/sessions/:sessionId/usage', (_req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { error: 'not_found' });
  jsonRes(res, 200, { usage: getDaemonReplyCardUsageSnapshot(ds) });
});

/** Canonical daemon-side close used by the dashboard and `botmux delete`.
 *  Host callers authenticate with HMAC; a read-isolated CLI may close only its
 *  exact live session with the rotating per-turn capability. */
ipcRoute('POST', '/api/sessions/:sessionId/close', async (req, res, params) => {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const auth = sessionCliIpcAuth(req, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  if (!dashboardSessionRuntimeSubmitter) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await dashboardSessionRuntimeSubmitter({
      target: { kind: 'externalSession', sessionId: params.sessionId },
      idempotencyKey: operationId.value,
      command: {
        kind: 'control.mutate',
        input: {
          kind: 'close',
          reason: isTrustedHostIpcRequest(req) ? 'dashboard' : 'cli',
        },
      },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, {
      notFound: 'session_not_found',
      retryable: { status: 503, error: 'dispatch_retryable' },
    });
    return jsonRes(res, failure.status, failure.body);
  }
  const result = outcome.result;
  jsonRes(res, 200, {
    ok: true,
    alreadyClosed: result?.kind === 'closed' ? result.alreadyClosed : true,
    known: result?.kind === 'closed' ? result.known : true,
  });
});

// `botmux list` zombie pruning is maintenance, not explicit abandon. The
// Current control Adapter revalidates protected ownership inside the Session
// lane before running the close effect.
ipcRoute('POST', '/api/sessions/:sessionId/prune', async (req, res, params) => {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  if (!dashboardSessionRuntimeSubmitter) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await dashboardSessionRuntimeSubmitter({
    target: { kind: 'externalSession', sessionId: params.sessionId },
    idempotencyKey: operationId.value,
    command: {
      kind: 'control.mutate',
      input: { kind: 'close', reason: 'prune' },
    },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, {
      notFound: 'session_not_found',
      retryable: { status: 503, error: 'dispatch_retryable' },
    });
    return jsonRes(res, failure.status, failure.body);
  }
  const result = outcome.result;
  if (result?.kind === 'closed' && !result.known) {
    return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  }
  return jsonRes(res, 200, {
    ok: true,
    alreadyClosed: result?.kind === 'closed' ? result.alreadyClosed : true,
    known: result?.kind === 'closed' ? result.known : true,
  });
});

ipcRoute('POST', '/api/sessions/:sessionId/restart', async (req, res, params) => {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const submitControl = dashboardSessionRuntimeSubmitter;
  if (!submitControl) return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  const outcome = await submitControl({
    target: { kind: 'externalSession', sessionId: params.sessionId },
    idempotencyKey: operationId.value,
    command: {
      kind: 'control.mutate',
      input: { kind: 'restart', source: 'dashboard' },
    },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, {
      notFound: 'session_not_active',
      transitionRejected: { status: 404, error: 'session_not_active' },
      transitionCodeStatus: code => code === 'session_not_active' ? 404 : 409,
    });
    return jsonRes(res, failure.status, {
      ...failure.body,
      ...(failure.body.error === 'riff_restart_unsupported'
        ? { message: t('cmd.restart.riff_unsupported', undefined, localeForBot(cachedLarkAppId)) }
        : {}),
    });
  }
  const result = outcome.result;
  if (result?.kind !== 'restarted') {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_invalid_result' });
  }
  if (outcome.kind === 'applied') {
    dashboardControlEffects?.restartNotice({
      sessionId: params.sessionId,
      revived: result.revived,
    });
  }
  jsonRes(res, 200, {
    ok: true,
    sessionId: params.sessionId,
    cliId: result.session.cliId ?? 'unknown',
    revived: result.revived,
  });
});

/** Manually suspend one active session: kill the worker + CLI/pane, session
 *  stays active and cold-resumes from its transcript on the next message —
 *  the same semantics the idle-worker sweeper applies over the live cap.
 *  Primary use: `botmux suspend --isolated` after a credential rotation, so
 *  isolated bots' next cold spawn re-provisions the freshest creds. */
ipcRoute('POST', '/api/sessions/:sessionId/suspend', async (req, res, params) => {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const submitControl = dashboardSessionRuntimeSubmitter;
  if (!submitControl) return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  const outcome = await submitControl({
    target: { kind: 'externalSession', sessionId: params.sessionId },
    idempotencyKey: operationId.value,
    command: {
      kind: 'control.mutate',
      input: { kind: 'suspend', source: 'dashboard' },
    },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, {
      notFound: 'session_not_active',
      transitionRejected: { status: 404, error: 'session_not_active' },
      transitionCodeStatus: code => code === 'session_not_active' ? 404 : 409,
    });
    return jsonRes(res, failure.status, failure.body);
  }
  const result = outcome.result;
  const suspended = result?.kind === 'suspended' ? result.suspended : false;
  jsonRes(res, 200, {
    ok: true,
    sessionId: params.sessionId,
    suspended,
    ...(!suspended ? { reason: 'no_live_worker' } : {}),
  });
});

/**
 * Count host-overload降压 candidates for THIS daemon's scope, so the alert card
 * can show "僵尸 N / 闲置 M" before the owner clicks. Both counts are local to
 * THIS daemon: its session store is bot-scoped, and live workers only exist in
 * their owning process. The card handler sums every daemon's response. Mirrors
 * the exact classification the sweep uses so the preview matches a click.
 */
ipcRoute('GET', '/api/host-overload/counts', (_req, res) => {
  if (!dashboardHostMaintenance) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const counts = dashboardHostMaintenance.counts();
  if (counts.kind === 'notReady') {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  jsonRes(res, 200, { ok: true, stopped: counts.stopped, idle: counts.idle });
});

/**
 * Bulk host-overload降压 sweep, driven by the overload-alert card buttons.
 * `mode`:
 *   - `clean_stopped`: close stopped zombie sessions (dead CLI + no exact
 *     persistent backing) from THIS daemon's bot-scoped session store. The
 *     card handler fans this mode out to every online daemon.
 *   - `suspend_idle`: suspend THIS daemon's own idle (non-busy, suspendable,
 *     non-adopt) live workers. Live workers only exist in their owning daemon's
 *     process, so the card handler fans this mode out to every online daemon.
 * Returns `{ ok, mode, affected }` — `affected` counts sessions acted on here.
 */
ipcRoute('POST', '/api/host-overload/sweep', async (req, res) => {
  let body: { mode?: unknown; operationId?: unknown } & Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const mode = body?.mode;
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const maintenance = dashboardHostMaintenance;
  if (!maintenance) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  if (mode !== 'clean_stopped' && mode !== 'suspend_idle') {
    return jsonRes(res, 400, { ok: false, error: 'bad_mode' });
  }
  const outcome = await maintenance.sweep({
    operationId: operationId.value,
    mode: mode as DashboardHostMaintenanceMode,
  });
  if (outcome.kind === 'conflict') {
    return jsonRes(res, 409, { ok: false, error: 'operation_conflict' });
  }
  if (outcome.kind === 'quarantined') {
    return jsonRes(res, 503, { ok: false, error: 'dispatch_unknown' });
  }
  if (outcome.kind === 'retryable') {
    return jsonRes(res, 503, { ok: false, error: 'dispatch_retryable' });
  }
  logger.info(
    `[overload-sweep] ${mode}: affected ${outcome.affected}/${outcome.candidates} session(s)`,
  );
  return jsonRes(res, 200, { ok: true, mode, affected: outcome.affected });
});

/** 会话级 CLI IPC（slash/cd）的调用方证明：trusted-host（.dashboard-secret HMAC，
 *  外层 gate 已验）直接放行；否则（沙箱/读隔离 CLI 读不到 secret，走
 *  routeHasNarrowUntrustedAuth 窄孔进来）必须出示该会话当前轮换的 capability，
 *  与 daemon 活跃记录里的 managedTurnOrigin 比对（/api/asks 同款姿势）。
 *  capability 只证明「我是这个会话当前这一轮的 CLI」——绑定 URL sessionId，
 *  拿到别的 sessionId 也伪造不了它的 capability。会话不存在时对未签名调用方
 *  同样回 origin_unproven，不提供「哪些 sessionId 活跃」的探针。 */
function sessionCliIpcAuth(
  req: IncomingMessage,
  sessionId: string,
  body: Record<string, unknown> | undefined,
): { ok: true } | { ok: false; error: string } {
  const ds = findActiveBySessionId(sessionId);
  const claimedAttempt = typeof body?.originDispatchAttempt === 'number'
    && Number.isSafeInteger(body.originDispatchAttempt)
    && body.originDispatchAttempt > 0
    ? body.originDispatchAttempt
    : undefined;
  const decision = authorizeSessionScopedIpc({
    trustedHost: isTrustedHostIpcRequest(req),
    sessionExists: !!ds,
    receiverSession: !!ds?.session.vcMeetingReceiver,
    allowReceiver: false,
    sessionId,
    liveOrigin: ds?.managedTurnOrigin,
    claimedCapability: typeof body?.originCapability === 'string' ? body.originCapability : undefined,
    claimedTurnId: typeof body?.originTurnId === 'string' ? body.originTurnId : undefined,
    claimedDispatchAttempt: claimedAttempt,
  });
  return decision.ok ? { ok: true } : { ok: false, error: decision.error };
}

/** 向本会话 CLI 注入一条 allowlist 内的原生斜杠命令（idle 后生效）。
 *  鉴权双路径（见 sessionCliIpcAuth）：trusted-host 签名或本会话 rotating
 *  capability；命令面由 allowlist（默认空=全拒）承担。 */
ipcRoute('POST', '/api/sessions/:sessionId/slash', async (req, res, params) => {
  let body: { command?: unknown } & Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const ds = findActiveBySessionId(params.sessionId);
  const auth = sessionCliIpcAuth(req, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const allow = getBotTuiSlashAllow(ds.larkAppId);
  const v = validateSlashInjection(typeof body.command === 'string' ? body.command : '', allow);
  if (!v.ok) return jsonRes(res, 403, { ok: false, error: v.error });
  const submit = dashboardSessionRuntimeSubmitter;
  if (!submit) return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  const outcome = await submit({
    target: { kind: 'externalSession', sessionId: params.sessionId },
    idempotencyKey: operationId.value,
    command: {
      kind: 'control.mutate',
      input: { kind: 'injectCommand', command: v.command },
    },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, {
      notFound: 'session_not_active',
      unknown: { status: 502, error: 'worker_send_failed' },
    });
    return jsonRes(res, failure.status, failure.body);
  }
  const result = outcome.result;
  if (!result || result.kind !== 'commandInjected') {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_invalid_result' });
  }
  jsonRes(res, 200, { ok: true, sessionId: params.sessionId, queued: result.command });
});

/** Session-scoped external mutation used by the botmux-chat-rename Skill. */
ipcRoute('POST', '/api/sessions/:sessionId/chat-rename', async (req, res, params) => {
  let body: { name?: unknown; proactive?: unknown } & Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const port = dashboardChatRename;
  if (!port) return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  const outcome = await port.submit({
    sessionId: params.sessionId,
    operationId: operationId.value,
    name: body.name,
    proactive: body.proactive,
    requester: {
      trustedHost: isTrustedHostIpcRequest(req),
      originCapability: body.originCapability,
      originTurnId: body.originTurnId,
      originDispatchAttempt: body.originDispatchAttempt,
    },
  });
  if (outcome.kind === 'completed') return jsonRes(res, 200, outcome.result);
  if (outcome.kind === 'larkRejected') {
    const status = outcome.result.error === 'bot_not_in_chat' ? 403
      : outcome.result.error === 'permission_denied' ? 403
        : outcome.result.error === 'rate_limited' ? 429
          : 502;
    return jsonRes(res, status, outcome.result);
  }
  if (outcome.kind === 'conflict') {
    return jsonRes(res, 409, { ok: false, error: 'operation_conflict' });
  }
  if (outcome.kind === 'quarantined') {
    return jsonRes(res, 503, { ok: false, error: 'dispatch_unknown' });
  }
  const status = outcome.reason === 'sessionNotActive' ? 404
    : outcome.reason === 'noFeishuTransport' ? 200
      : outcome.reason === 'originUnproven' || outcome.reason === 'managedActionRequired' ? 403
        : 400;
  const error = outcome.reason === 'originUnproven' ? 'origin_unproven'
    : outcome.reason === 'managedActionRequired' ? 'managed_action_required'
      : outcome.reason === 'sessionNotActive' ? 'session_not_active'
        : outcome.reason === 'noFeishuTransport' ? 'no_feishu_transport'
          : outcome.reason === 'notGroupChat' ? 'not_group_chat'
            : outcome.reason === 'invalidChatName' ? 'invalid_chat_name'
              : 'bad_operation_id';
  return jsonRes(res, status, { ok: false, error });
});

/** 会话内切换工作目录（角色切换专用）：硬校验角色库根 → 更新记录落盘（唯一事实源）
 *  → 活 worker 走「带 --resume 的进程重启、respawn 在新 cwd」，无活 worker 杀残留
 *  pane 让下条消息冷启动。
 *
 *  为什么是 respawn 而不是向活进程注入 /cd（旧实现）：CLI 的系统上下文（CLAUDE.md、
 *  记忆路径/索引）是开场按启动 cwd 注入一次的静态快照，/cd 只改 cwd 不重刷——注入
 *  切换后模型仍拿着旧角色的记忆索引读写（读旧索引、写错桶）。respawn 让「开场」在
 *  新 cwd 重新发生：新角色的 CLAUDE.md/记忆索引开场即注入，--resume 回放对话历史
 *  保留上下文（“换角色外壳、留对话内核”）。旧桶 transcript 由 claude-code 适配器的
 *  resume 预检 syncClaudeResumeTargetToCwd（worker.ts 每次 resume respawn、probe 之前
 *  把最新 <sid>.jsonl COPY 进新 cwd 的 project 目录，已在 master）接住，不会探空丢
 *  上下文。故本改动可独立部署，不硬依赖任何跨桶迁移专项 PR。
 *
 *  鉴权双路径（见 sessionCliIpcAuth）：trusted-host 签名或本会话 rotating
 *  capability；目录面由 validateRoleLibraryPath 硬校验承担（realpath 归一 +
 *  dev/ino 包含判断，角色库根之外一律拒）。
 *  不发话题消息（AI 自己发角色化确认）。 */
ipcRoute('POST', '/api/sessions/:sessionId/cd', async (req, res, params) => {
  let body: { dir?: string } & Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const ds = findActiveBySessionId(params.sessionId);
  const auth = sessionCliIpcAuth(req, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  // ownAppId 收窄到本 bot 自己的角色库子树：不收窄就能切进别的 bot 的角色目录，
  // 下面 repinSessionWorkingDir 把 ds.workingDir 钉过去之后，那个 bot 的沙盒会话
  // 就拿到了对方整棵角色库的 readWrite（打穿 fs-policy 的跨 bot 隔离）。
  const v = validateRoleLibraryPath(body?.dir ?? '', undefined, ds.larkAppId);
  if (!v.ok) {
    const forbidden = v.error === 'outside_role_library' || v.error === 'outside_own_role_library';
    // own_role_library_missing：本 bot 的 `<角色库根>/<appId>` 不是真目录（存量用
    // 人类 slug 命名这一层，未按 deploy-runbook §8 迁移）。FAIL-CLOSED——不回落全局
    // 根（回落是 fail-open，会让存量部署继续能跨 bot 切并经 workingDir 拿 rw）。回
    // 409 + 迁移指引，让运营看得见查得到，而不是静默放行或静默拒绝。
    if (v.error === 'own_role_library_missing') {
      logger.warn(`[role] 角色库每-bot 目录名不是 appId（期望 ~/botmux-roles/${ds.larkAppId}）——`
        + 'role switch 已 fail-closed 拒绝，避免跨 bot 越权。按 docs/roles/deploy-runbook.md '
        + '§8「迁移：每-bot 目录名改为 appId」重命名该目录即恢复。');
      return jsonRes(res, 409, { ok: false, error: v.error });
    }
    return jsonRes(res, forbidden ? 403 : 400, { ok: false, error: v.error });
  }
  const submitControl = dashboardSessionRuntimeSubmitter;
  if (!submitControl) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await submitControl({
    target: { kind: 'externalSession', sessionId: params.sessionId },
    idempotencyKey: operationId.value,
    command: {
      kind: 'control.mutate',
      input: { kind: 'changeWorkingDirectory', resolvedPath: v.resolvedPath },
    },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, { notFound: 'session_not_active' });
    return jsonRes(res, failure.status, {
      ...failure.body,
      ...(failure.body.error === 'riff_cd_unsupported'
        ? { message: t('cmd.cd.riff_unsupported', undefined, localeForBot(ds.larkAppId)) }
        : {}),
    });
  }
  const result = outcome.result;
  if (result?.kind !== 'workingDirectoryChanged') {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_invalid_result' });
  }
  jsonRes(res, 200, { ok: true, mode: result.mode, dir: result.workingDir });
});

/** 解析 session（活跃优先，已关闭兜底）。活跃会话取 ds.session —— registry 与
 *  store 持有同一对象，改字段后 updateSession 即落盘。 */
function findSessionRecord(sessionId: string): Session | undefined {
  return findActiveBySessionId(sessionId)?.session ?? sessionStore.getSession(sessionId);
}

/** True when a session-bound IPC route must NOT touch Feishu: the owning bot is
 *  core-only (apiOnly) OR the session is an HTTP virtual chat. Central guard for
 *  every session-write route (chat-rename / write-link-card / resume-notice /
 *  locate / restart-notice …) — the daemon owns the authoritative bot config,
 *  so gating here catches the normal-bot-in-virtual-session case that
 *  getBotClient (which only throws for apiOnly) cannot. Accepts a live
 *  DaemonSession or a stored Session record. Never throws. */
function sessionTransportDisabled(s: { chatId?: string; larkAppId?: string }): boolean {
  const appId = s.larkAppId;
  let apiOnly = false;
  if (appId) { try { apiOnly = getBot(appId).config.apiOnly === true; } catch { /* unknown bot → not apiOnly */ } }
  return !larkTransportEnabled({ chatId: s.chatId ?? '', apiOnly });
}

/** Mutating IPC routes may only touch this daemon's own bot-partitioned store. */
function findOwnedSessionRecord(sessionId: string): Session | undefined {
  return findActiveBySessionId(sessionId)?.session ?? sessionStore.getOwnedSession(sessionId);
}

interface RuntimeMutationWirePolicy {
  readonly notFound: string;
  readonly transitionRejected?: { readonly status: number; readonly error: string };
  readonly transitionCodeStatus?: number | ((code: string) => number);
  readonly retryable?: { readonly status: number; readonly error: string };
  readonly unknown?: { readonly status: number; readonly error: string };
}

interface RuntimeMutationWireFailure {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

function stableRuntimeCode(value: unknown): string | undefined {
  return typeof value === 'string'
      && value.length > 0
      && value.length <= 128
      && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value)
    ? value
    : undefined;
}

/** Translate internal Runtime outcomes into the stable public HTTP vocabulary.
 * Runtime reason enums and diagnostic prose are deliberately never emitted as
 * `error`; structured evidence remains available to callers as response fields. */
function runtimeMutationWireFailure(
  outcome: { kind: string; reason?: string; code?: string; details?: Readonly<Record<string, unknown>> },
  policy: RuntimeMutationWirePolicy,
): RuntimeMutationWireFailure {
  const details = outcome.details ?? {};
  const response = (status: number, error: string): RuntimeMutationWireFailure => ({
    status,
    body: { ok: false, ...details, error },
  });
  const code = stableRuntimeCode(outcome.code);

  if (outcome.kind === 'rejected') {
    if (outcome.reason === 'sessionNotFound') return response(404, policy.notFound);
    if (outcome.reason === 'idempotencyConflict') return response(409, 'idempotency_conflict');
    if (outcome.reason === 'invalidCommand') return response(400, code ?? 'invalid_command');
    if (outcome.reason === 'sessionExists') return response(409, code ?? 'session_exists');
    if (outcome.reason === 'transitionRejected') {
      if (code) {
        const status = typeof policy.transitionCodeStatus === 'function'
          ? policy.transitionCodeStatus(code)
          : policy.transitionCodeStatus ?? 409;
        return response(status, code);
      }
      const rejected = policy.transitionRejected ?? { status: 409, error: 'operation_rejected' };
      return response(rejected.status, rejected.error);
    }
    return response(409, code ?? 'operation_rejected');
  }
  if (outcome.kind === 'staleAddress') return response(409, 'stale_address');
  if (outcome.kind === 'ambiguous' || outcome.kind === 'quarantined' || outcome.kind === 'unknown') {
    const unknown = policy.unknown ?? { status: 503, error: 'dispatch_unknown' };
    return response(unknown.status, unknown.error);
  }
  if (outcome.kind === 'retryable' || outcome.kind === 'notWired') {
    const retryable = policy.retryable ?? { status: 503, error: 'session_runtime_not_ready' };
    return response(retryable.status, retryable.error);
  }
  return response(503, 'session_runtime_unavailable');
}

/** Four-state async lookup with durable fallback (design A).
 *
 *  In-memory `asyncTriggerResults` lives only on the active DaemonSession and is
 *  lost on daemon restart / idle-suspend. To keep a poller from misreading an
 *  already-completed turn as `not_found`, this resolves against BOTH the live
 *  session and the on-disk stores:
 *   - completed (mem or disk)          → completed + output.content + finishedAt
 *   - pending in mem / session active  → running
 *   - session record closed, no output → failed (no_output; soft terminal —
 *                                         may be a real failure OR a caller close)
 *   - no session record AND no result  → not_found (never existed / invalid id)
 *
 *  Legacy `action`/`async` fields are still populated so existing webhook
 *  consumers keep working; new callers branch on `state`. */
async function buildAsyncTriggerLookupResponse(
  sessionId: string,
  triggerId?: string,
): Promise<TriggerResponse> {
  const ds = findActiveBySessionId(sessionId);
  const memTriggerId = triggerId || ds?.latestAsyncTriggerId;
  const faultEntry = ds && memTriggerId
    ? ds.idempotentAsyncTurns?.get(memTriggerId)
    : undefined;
  if (faultEntry?.postBarrierFault && memTriggerId && dashboardSessionRuntimeSubmitter) {
    const convergence = await dashboardSessionRuntimeSubmitter({
      target: { kind: 'externalSession', sessionId },
      idempotencyKey: `trigger-result-fault:${memTriggerId}`,
      command: {
        kind: 'control.mutate',
        input: { kind: 'convergeAsyncTriggerFault', triggerId: memTriggerId },
      },
    });
    const result = convergence.kind === 'applied' || convergence.kind === 'duplicate'
      ? convergence.result
      : undefined;
    if (result?.kind === 'asyncTriggerFaultConverged' && result.state === 'failed') {
      return {
        ok: true,
        state: 'failed',
        triggerId: result.triggerId,
        target: {
          kind: 'turn',
          sessionId,
          ...(result.chatId ? { chatId: result.chatId } : {}),
        },
        errorCode: 'no_output',
        error: 'previous dispatch was interrupted with unknown outcome; not re-run (at-most-once)',
        message: 'async trigger terminated without output',
      };
    }
  }
  const storedRaw = ds?.session ?? sessionStore.getSession(sessionId);
  const persistedRaw = asyncTriggerStore.lookup(sessionId, triggerId);

  // Cross-bot isolation (fail-closed / positive-proof) — see decideAsyncOwnership.
  // Both sessionStore.getSession() (cross-scans every bot's sessions-*.json) and
  // the async store (machine-wide shared dir) can surface another bot's data for
  // a sessionId routed to THIS daemon; keep only sources positively proven ours.
  const decision = decideAsyncOwnership({
    owner: cachedLarkAppId,
    liveDs: !!ds,
    storedOwner: storedRaw?.larkAppId,
    storedExists: !!storedRaw,
    persistedOwner: persistedRaw?.ownerLarkAppId,
    persistedExists: !!persistedRaw,
  });
  const stored = decision.keepStored ? storedRaw : undefined;
  const persisted = decision.keepPersisted ? persistedRaw : undefined;

  if (decision.foreignLeak) {
    return {
      ok: true,
      state: 'not_found',
      triggerId,
      errorCode: 'session_not_found',
      error: `no session record for: ${sessionId}`,
      message: 'no session found',
    };
  }

  const memResult = ds && memTriggerId ? ds.asyncTriggerResults?.get(memTriggerId) : undefined;

  const resolved = resolveAsyncTriggerState({
    sessionId,
    liveActive: !!ds,
    chatId: ds?.chatId ?? stored?.chatId,
    memResult: memResult ? { status: memResult.status, content: memResult.content, completedAt: memResult.completedAt, usage: memResult.usage } : undefined,
    memTriggerId: memResult ? memTriggerId : undefined,
    persisted,
    storedStatus: stored ? (stored.status === 'closed' ? 'closed' : 'open') : undefined,
    closedAt: stored?.closedAt,
    requestedTriggerId: triggerId,
  });

  // Form C: attach the read-only web-terminal URL ONLY in core-only mode, and
  // only when a LIVE worker terminal exists (workerPort bound + view capability
  // minted). Core-only is the single-tenant loopback path where trigger-result
  // is a public (no-HMAC) route and riff's in-sandbox runner polls it to open
  // the visible CLI TUI. Gating on BOTMUX_CORE_ONLY keeps this OFF the normal/
  // mixed fleet: there trigger-result is HMAC-gated, but we still must not widen
  // the token surface by minting a terminal read-capability into a poll response
  // that historically carried none (the dashboard mints view/write tokens only
  // on explicit /write-link request). buildTerminalUrl carries ?viewToken=
  // inline; the write token is never included. Closed/restored sessions have no
  // live worker terminal, so no stale URL is ever advertised.
  if (process.env.BOTMUX_CORE_ONLY === '1' && ds && ds.workerPort && ds.workerViewToken) {
    resolved.readOnlyUrl = buildTerminalUrl(ds);
    resolved.viewToken = ds.workerViewToken;
  }
  return resolved;
}

// 看板放置：dashboard 看板视图拖拽卡片后持久化列 + 列内排序位置。
// 改完广播 session.update，所有打开的 dashboard 实时同步。
ipcRoute('POST', '/api/sessions/:sessionId/board', async (req, res, params) => {
  let body: { column?: unknown; position?: unknown; operationId?: unknown } & Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const column = normalizeKanbanColumn(body.column);
  const position = normalizeKanbanPosition(body.position);
  if (!column && position === null) return jsonRes(res, 400, { ok: false, error: 'bad_request' });
  if (!dashboardSessionRuntimeSubmitter) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await dashboardSessionRuntimeSubmitter({
      target: { kind: 'externalSession', sessionId: params.sessionId },
      idempotencyKey: operationId.value,
      command: {
        kind: 'control.mutate',
        input: {
          kind: 'setBoardPlacement',
          ...(column ? { column } : {}),
          ...(position === null ? {} : { position }),
        },
      },
    });
    if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
      const failure = runtimeMutationWireFailure(outcome, { notFound: 'session_not_found' });
      return jsonRes(res, failure.status, failure.body);
    }
    const result = outcome.result;
    if (outcome.kind === 'applied' && result?.kind === 'boardPlacementUpdated') {
      dashboardEventBus.publish({
        type: 'session.update',
        body: {
          sessionId: params.sessionId,
          patch: {
            kanbanColumn: result.column,
            kanbanPosition: result.position,
            queued: result.queued,
          },
        },
      });
    }
  jsonRes(res, 200, { ok: true });
});

// Narrow CLI whiteboard binding mutation. Keeping this daemon-side avoids a
// short-lived `botmux whiteboard` process rewriting a stale whole Session row
// over a concurrent Codex App FIFO transition.
ipcRoute('POST', '/api/sessions/:sessionId/whiteboard', async (req, res, params) => {
  let body: { whiteboardId?: unknown; operationId?: unknown } & Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  if (typeof body.whiteboardId !== 'string'
    || body.whiteboardId.length === 0
    || body.whiteboardId.length > 256) {
    return jsonRes(res, 400, { ok: false, error: 'bad_whiteboard_id' });
  }
  if (!dashboardSessionRuntimeSubmitter) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await dashboardSessionRuntimeSubmitter({
      target: { kind: 'externalSession', sessionId: params.sessionId },
      idempotencyKey: operationId.value,
      command: {
        kind: 'control.mutate',
        input: { kind: 'bindWhiteboard', whiteboardId: body.whiteboardId as string },
      },
    });
    if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
      const failure = runtimeMutationWireFailure(outcome, { notFound: 'session_not_found' });
      return jsonRes(res, failure.status, failure.body);
    }
    const result = outcome.result;
    jsonRes(res, 200, {
      ok: true,
      whiteboardId: result?.kind === 'whiteboardBound'
        ? result.whiteboardId
        : body.whiteboardId,
  });
});

// 待办池会话「开始」：把 parked 会话激活（发首轮、起 CLI），与拖到「进行中」同义。
ipcRoute('POST', '/api/sessions/:sessionId/start', async (req, res, params) => {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  if (!dashboardSessionRuntimeSubmitter) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const submit = dashboardSessionRuntimeSubmitter;
  const outcome = await submit({
      target: { kind: 'externalSession', sessionId: params.sessionId },
      idempotencyKey: operationId.value,
      command: {
        kind: 'control.mutate',
        input: { kind: 'activateQueued', source: 'dashboard' },
      },
    });
    if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
      const failure = runtimeMutationWireFailure(outcome, { notFound: 'session_not_found' });
      return jsonRes(res, failure.status, failure.body);
    }
    const result = outcome.result;
    if (outcome.kind === 'applied' && result?.kind === 'queuedActivated') {
      dashboardEventBus.publish({
        type: 'session.update',
        body: {
          sessionId: params.sessionId,
          patch: {
            kanbanColumn: result.column,
            queued: result.queued,
          },
        },
      });
    }
  jsonRes(res, 200, { ok: true });
});

// Dashboard「创建会话」spawn：在新建的群里为本 daemon 的 bot 拉起/暂存一条 chat-scope
// 会话。aggregator 建完群后按模式(一起开工/lead 分配)对每个目标 bot 的 daemon 调一次。
ipcRoute('POST', '/api/sessions/spawn', async (req, res) => {
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const parsed = parseSpawnRequest(body);
  if (!parsed.ok) return jsonRes(res, 400, { ok: false, error: parsed.error });
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'bot_not_found' });
  const submit = dashboardSessionRuntimeSubmitter;
  if (!submit) return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  const outcome = await submit({
    target: { kind: 'route', route: { kind: 'chat', chatId: parsed.value.chatId } },
    idempotencyKey: operationId.value,
    command: {
      kind: 'dashboard.spawn',
      input: {
        content: parsed.value.content,
        column: parsed.value.column,
        role: parsed.value.role,
        coworkers: parsed.value.coworkers,
        images: parsed.value.images,
        postBanner: (body as Record<string, unknown>).postBanner === true,
        ...(parsed.value.title === undefined ? {} : { title: parsed.value.title }),
        ...(parsed.value.ownerOpenId === undefined
          ? {}
          : { ownerOpenId: parsed.value.ownerOpenId }),
        ...(parsed.value.ownerUnionId === undefined
          ? {}
          : { ownerUnionId: parsed.value.ownerUnionId }),
      },
    },
  });
  if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
    return jsonRes(res, 200, { ok: true, sessionId: outcome.sessionId });
  }
  const failure = runtimeMutationWireFailure(outcome, {
    notFound: 'session_not_found',
    transitionRejected: { status: 500, error: 'spawn_rejected' },
    transitionCodeStatus: 500,
  });
  return jsonRes(res, failure.status, failure.body);
});

ipcRoute('POST', '/api/chat-reply-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, reason: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, reason: 'invalid_json' }); }
  const chatId = typeof (body as any)?.chatId === 'string' ? (body as any).chatId.trim() : '';
  const mode = normalizeChatReplyMode(typeof (body as any)?.mode === 'string' ? (body as any).mode : undefined);
  if (!chatId) return jsonRes(res, 400, { ok: false, reason: 'chatId_required' });
  if (!mode) return jsonRes(res, 400, { ok: false, reason: 'invalid_mode' });
  const result = await setChatReplyMode(cachedLarkAppId, chatId, mode);
  if (!result.ok) return jsonRes(res, 500, { ok: false, reason: result.reason });
  jsonRes(res, 200, { ok: true, mode: result.mode });
});

// 会话历史：实时拉取该会话所在话题/群的飞书消息（与 botmux history 同链路，
// 消息体不落盘），给 dashboard 的会话历史弹窗。复杂卡片的「请升级」兜底文本
// 用 message.get 的完整表示补齐；merge_forward 保持占位符（原型不展开）。
ipcRoute('GET', '/api/sessions/:sessionId/history', async (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const appId = session.larkAppId || cachedLarkAppId;
  if (!appId) return jsonRes(res, 422, { ok: false, error: 'no_lark_app' });
  // No-transport session (apiOnly bot or HTTP virtual chat) has no Feishu chat
  // history — listChatMessages/listThreadMessages would dial Feishu with a
  // synthetic chatId. Return empty history instead of making the network call.
  if (!larkTransportEnabled({ chatId: session.chatId, apiOnly: getBot(appId).config.apiOnly })) {
    return jsonRes(res, 200, { ok: true, messages: [], hint: 'no_feishu_transport' });
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '80', 10) || 80, 1), 200);
  try {
    const raw = session.scope === 'chat'
      ? await listChatMessages(appId, session.chatId, limit)
      : await listThreadMessages(appId, session.chatId, session.rootMessageId, limit);
    const messages = await Promise.all(raw.map(async (m: any) => {
      const parsed = parseApiMessage(m);
      if (parsed.msgType === 'interactive' && cardContentHasUpgradeFallback(parsed.content)) {
        const merged = await resolveMergedCardContent(appId, parsed.messageId).catch(() => null);
        if (merged) parsed.content = merged.text;
      }
      return {
        messageId: parsed.messageId,
        senderId: parsed.senderId,
        senderType: parsed.senderType,
        // 服务端返回的发送者名（with_sender_name=true，bot 也有）。enrich 阶段
        // 本地花名册/contact 解析不到时兜底用它——第三方 bot 不再是一串 open_id。
        ...(parsed.senderName ? { senderName: parsed.senderName } : {}),
        msgType: parsed.msgType,
        content: parsed.content,
        // Lark create_time 是毫秒 epoch 字符串——规范成数字，前端 new Date 直接用
        createTime: Number(parsed.createTime) || undefined,
      };
    }));
    // 真人发送者补名字+头像（contact API，带缓存；不在可见范围的回退占位）
    const senders = new Map<string, { name: string; avatarUrl?: string } | null>();
    await Promise.all(
      [...new Set(messages.filter(m => m.senderType === 'user' && m.senderId).map(m => m.senderId))]
        .map(async id => { senders.set(id, await getUserProfile(appId, id)); }),
    );
    // Bot sender ids are scoped to the observing app. Reuse the chat-member
    // resolver (cross-ref + observed bot roster) instead of assuming every
    // non-user message came from the bot that owns this dashboard session.
    const botMembers: ChatBotMember[] = await listChatBotMembers(appId, session.chatId).catch(() => [] as ChatBotMember[]);
    let botInfos: HistoryBotInfo[] = [];
    try {
      const parsed = JSON.parse(readFileSync(join(config.session.dataDir, 'bots-info.json'), 'utf8'));
      if (Array.isArray(parsed)) botInfos = parsed;
    } catch { /* missing/corrupt cache degrades to name/open_id placeholders */ }
    // listChatBotMembers can be temporarily unavailable during startup. Always
    // retain a local self-bot fallback so its own messages still have identity.
    try {
      const self = getBot(appId);
      if (self.botOpenId && !botMembers.some(member => member.openId === self.botOpenId)) {
        const selfName = self.botName || appId;
        botMembers.push({
          openId: self.botOpenId,
          displayName: selfName,
          name: selfName,
          larkAppId: appId,
          source: 'configured',
          mentionable: true,
          mentionSource: 'self',
          hasTeamRole: false,
        });
      }
      if (!botInfos.some(info => info.larkAppId === appId)) {
        botInfos.push({ larkAppId: appId, botOpenId: self.botOpenId, botName: self.botName, botAvatarUrl: self.botAvatarUrl });
      }
    } catch { /* session record may outlive a removed bot config */ }

    jsonRes(res, 200, {
      ok: true,
      scope: session.scope ?? 'thread',
      ownerOpenId: session.ownerOpenId,
      messages: enrichHistorySenders(messages, senders, botMembers, botInfos),
    });
  } catch (err: any) {
    jsonRes(res, 502, { ok: false, error: String(err?.message ?? err) });
  }
});

ipcRoute('GET', '/api/sessions/:sessionId/trigger-result', async (req, res, params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const triggerId = url.searchParams.get('triggerId') ?? undefined;
  const result = await buildAsyncTriggerLookupResponse(params.sessionId, triggerId);
  // Four-state semantics: the query itself succeeds (HTTP 200) for every
  // resolved state including not_found — task state lives in `result.state`,
  // not the HTTP status. Only a malformed lookup (ok:false) maps to non-200.
  jsonRes(res, result.ok ? 200 : 400, result);
});

// 会话 insight：只读解析本会话的 transcript，产出动作 span / 失败聚合 / 规则建议
// （SafeInsightReport）。底层 services/insight 已做 fail-closed 脱敏投影——raw 命令
// 与输出永不进结构。detail=summary 只返聚合+建议（/insight 卡片、抽屉概览用）；
// detail=spans 才带脱敏 span（详情 tab 用）。owner-only 由 dashboard 外层 authed-only
// 路由 + /insight 命令层把关，IPC 自身 loopback-trusted。
ipcRoute('GET', '/api/sessions/:sessionId/insight', (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.searchParams.get('detail') === 'conversation') {
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
    const role = url.searchParams.get('role') as InsightConversationRole | null;
    const severity = url.searchParams.get('severity') as InsightSeverity | null;
    const tag = url.searchParams.get('tag') as SafeSpanTag | null;
    const turnIndexes = url.searchParams.getAll('turnIndexes')
      .flatMap(v => v.split(','))
      .map(v => parseInt(v, 10))
      .filter(Number.isFinite);
    const conversation = buildSafeInsightConversation({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
      larkAppId: session.larkAppId,
    }, {
      offset,
      limit,
      q: url.searchParams.get('q') ?? undefined,
      role: role && ['user', 'a2a_agent', 'system', 'agent'].includes(role) ? role : undefined,
      severity: severity && ['bad', 'warn', 'info'].includes(severity) ? severity : undefined,
      tag: tag && ['failure', 'slow', 'retry', 'read_write_imbalance', 'diagnostic', 'normal'].includes(tag) ? tag : undefined,
      turnIndexes: turnIndexes.length ? turnIndexes : undefined,
    });
    return jsonRes(res, 200, { ok: true, conversation });
  }
  const detail: InsightDetail = url.searchParams.get('detail') === 'spans' ? 'spans' : 'summary';
  try {
    const report = buildSafeInsightReport({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
      larkAppId: session.larkAppId,
    }, { detail });
    jsonRes(res, 200, { ok: true, report });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

ipcRoute('GET', '/api/sessions/:sessionId/insight/turn/:turnIndex', (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
  const limit = parseInt(url.searchParams.get('limit') ?? '4000', 10) || 4000;
  try {
    const turn = buildSafeInsightTurnDetail({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
      larkAppId: session.larkAppId,
    }, parseInt(params.turnIndex, 10) || 0, { offset, limit });
    jsonRes(res, 200, { ok: true, turn });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

// 跨会话 insight 总览：仍然只读、按需、owner-only（外层 dashboard route
// 不在 public-read 白名单）。只聚合本 daemon registry 里的 botmux 会话；
// 不扫整机 transcript，不返回 raw span/input/output。
ipcRoute('GET', '/api/insights/summary', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
  const rows = (await readCurrentDashboardSessionSnapshot()).rows;
  const overview = await buildSafeInsightOverview(rows.map(row => {
    const session = findSessionRecord(row.sessionId);
    return {
      cliId: row.cliId,
      sessionId: row.sessionId,
      cliSessionId: session?.cliSessionId,
      cwd: row.workingDir,
      workingDir: row.workingDir,
      title: row.title,
      botName: row.botName,
      larkAppId: row.larkAppId,
      status: row.status,
      lastMessageAt: row.lastMessageAt,
    };
  }), { limit });
  jsonRes(res, 200, { ok: true, overview });
});

// 部署 owner 的资料（名字 + 头像）——dashboard 左上角和历史弹窗展示「我」。
// owner 身份来自 deployment identity（ownerUnionId），头像经 contact API 查询
// （带缓存）；未绑定 owner 或查不到时回退名字/null。
ipcRoute('GET', '/api/owner-profile', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  const me = getDeploymentIdentity(config.session.dataDir);
  if (!me.ownerUnionId) return jsonRes(res, 200, { ok: false, error: 'owner_unbound', name: me.ownerName ?? null });
  const p = await getUserProfile(cachedLarkAppId, me.ownerUnionId, 'union_id');
  jsonRes(res, 200, { ok: true, name: p?.name ?? me.ownerName ?? null, avatarUrl: p?.avatarUrl ?? null });
});

// 会话重命名：dashboard 看板卡片就地编辑 Botmux 的 canonical title；运行中的
// Codex/Claude Code 再收到一条 best-effort 原生 /rename，同步其 resume picker。
// 飞书话题标题不受影响。全视图（看板/状态板/表格/抽屉）读同一字段。
ipcRoute('POST', '/api/sessions/:sessionId/rename', async (req, res, params) => {
  let body: { title?: unknown; source?: unknown } & Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const auth = sessionCliIpcAuth(req, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  const title = normalizeSessionTitle(body.title);
  if (!title) return jsonRes(res, 400, { ok: false, error: 'bad_title' });
  const source = normalizeSessionTitleSource(body.source, 'dashboard');
  if (!dashboardSessionRuntimeSubmitter) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await dashboardSessionRuntimeSubmitter({
    target: { kind: 'externalSession', sessionId: params.sessionId },
    idempotencyKey: operationId.value,
    command: {
      kind: 'control.rename',
      input: { title, source },
    },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, { notFound: 'session_not_found' });
    return jsonRes(res, failure.status, failure.body);
  }
  const renameResult = outcome.kind === 'applied'
    ? outcome
    : outcome.result;
  if (!renameResult) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_invalid_result' });
  }
  const effectiveTitle = renameResult.title;
  const effectiveUpdatedAt = renameResult.updatedAt;
  const effectiveSource = renameResult.source;
  if (outcome.kind === 'applied') {
    dashboardEventBus.publish({
      type: 'session.update',
      body: {
        sessionId: params.sessionId,
        patch: {
          title: effectiveTitle,
          titleUpdatedAt: effectiveUpdatedAt,
          titleSource: effectiveSource,
        },
      },
    });
  }
  jsonRes(res, 200, {
    ok: true,
    title: effectiveTitle,
    titleUpdatedAt: effectiveUpdatedAt,
    titleSource: effectiveSource,
    agentSync: renameResult.agentSync.status,
  });
});

// 会话锁定：保护被锁定会话不被 dashboard「清理空闲」批量关闭。锁定是会话元数据，
// 不影响用户显式点击关闭/批量关闭，避免把会话变成不可管理状态。
ipcRoute('POST', '/api/sessions/:sessionId/lock', async (req, res, params) => {
  let body: { locked?: unknown; operationId?: unknown } & Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  if (typeof body.locked !== 'boolean') return jsonRes(res, 400, { ok: false, error: 'bad_locked' });
  if (!dashboardSessionRuntimeSubmitter) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await dashboardSessionRuntimeSubmitter({
    target: { kind: 'externalSession', sessionId: params.sessionId },
    idempotencyKey: operationId.value,
    command: { kind: 'control.mutate', input: { kind: 'setLocked', locked: body.locked } },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, { notFound: 'session_not_found' });
    return jsonRes(res, failure.status, failure.body);
  }
  const result = outcome.result;
  const locked = result?.kind === 'lockUpdated' ? result.locked : body.locked;
  if (outcome.kind === 'applied') {
    dashboardEventBus.publish({
      type: 'session.update',
      body: { sessionId: params.sessionId, patch: { locked } },
    });
  }
  jsonRes(res, 200, { ok: true, locked });
});

/**
 * Mint the WRITABLE web-terminal link for a live session — the dashboard
 * counterpart to the Lark card's "🔑 获取操作链接" button. Returns the URL with
 * the worker's write `?token=` appended, built daemon-side via buildTerminalUrl
 * so it picks up this process's live terminal-proxy state (the dashboard
 * aggregator can't see it). The token is returned ONLY here, on demand —
 * deliberately never embedded in /api/sessions rows or the SSE stream.
 *
 * Two gates protect it: at the dashboard's HTTP boundary this path is absent
 * from the public allow-list, so an anonymous browser 401s; and here on the
 * daemon IPC, ipcHmacAuthorized requires a loopback-HMAC signed with
 * .dashboard-secret, so a local process that merely knows the ipcPort still
 * can't pull a write token.
 */
ipcRoute('GET', '/api/sessions/:sessionId/write-link', (req, res, params) => {
  if (!ipcHmacAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (!sessionSupportsWebTerminal(ds)) {
    return jsonRes(res, 409, { ok: false, error: 'terminal_unsupported' });
  }
  // Riff backend: the sandbox URL is the writable link — no local worker needed.
  if (ds.riffAccessUrl) {
    jsonRes(res, 200, { ok: true, url: ds.riffAccessUrl });
    return;
  }
  const port = ds.workerPort ?? ds.session.webPort;
  if (!port || !ds.workerToken) return jsonRes(res, 409, { ok: false, error: 'terminal_unavailable' });
  jsonRes(res, 200, { ok: true, url: buildTerminalUrl(ds, { write: true }) });
});

/**
 * Dashboard「复现命令」：返回该 active session 本次冷启的**近似**可复现 CLI 调用
 * （bin + argv + cwd + 权威注入 env），供用户粘到调试终端改参数复现。命令原样保留
 * （含 write token / --append-system-prompt / 凭证 env），与 write-link 同一把
 * loopback-HMAC 锁：匿名浏览器在 dashboard HTTP 边界就 401（该路径不在 allow-list），
 * 本机知道 ipcPort 的进程也过不了 ipcHmacAuthorized。仅持管理 cookie 的写权限视图能取。
 *
 * 只读 active session 的**内存**字段（DaemonSession.spawnCommand）：命令含凭证，
 * 绝不落盘，也绝不从 closed/持久化 session 取（那既无值也避免误暴露）。daemon 重启后
 * 到 worker 再次 ready 之前返回 unavailable——可接受。warm reattach 不重算命令，此时
 * 亦为空。riff 后端无本地 bin/args，worker 侧不产出命令，这里同样 unavailable。
 */
ipcRoute('GET', '/api/sessions/:sessionId/spawn-command', (req, res, params) => {
  if (!ipcHmacAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const cmd = ds.spawnCommand;
  if (!cmd) return jsonRes(res, 404, { ok: false, error: 'spawn_command_unavailable' });
  jsonRes(res, 200, { ok: true, command: cmd });
});

/**
 * Deliver the writable-terminal card privately to the bot's owner(s) — the
 * `botmux term-link <id>` CLI command's backend. Unlike the GET route above
 * (which returns the URL to its single authenticated caller), this POSTs the
 * card into the owners' private Lark channels (ephemeral → DM fallback) and
 * returns ONLY delivery counts: the write token never crosses back to the CLI /
 * stdout. Same loopback-HMAC gate as write-link — it still hands out a control
 * credential, just into Lark rather than into the HTTP response.
 */
ipcRoute('POST', '/api/sessions/:sessionId/write-link-card', async (req, res, params) => {
  if (!ipcHmacAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (sessionTransportDisabled(ds)) return jsonRes(res, 200, { ok: false, error: 'no_feishu_transport' });
  const r = await deliverWriteLinkCardToOwners(ds);
  const status = r.ok ? 200
    : r.error === 'terminal_unavailable' || r.error === 'terminal_unsupported' ? 409
    : r.error === 'no_owner' ? 422
    : 502;
  jsonRes(res, status, r);
});

// ─── Sandbox landing (owner reviews the clone's diff then applies it back) ───
function workingDirForSession(sessionId: string): string | undefined {
  const ds = findActiveBySessionId(sessionId);
  if (ds) return ds.session.workingDir;
  return sessionStore.listSessions().find(s => s.sessionId === sessionId)?.workingDir;
}

/**
 * Reactivate a closed session — counterpart to `/close`. Used by both the
 * "▶️ 恢复会话" card button (via card-handler) and the `botmux resume <id>`
 * CLI command (via this HTTP route). The CLI route also drops a notice into
 * the original Lark thread so users see why the session is alive again.
 */
ipcRoute('POST', '/api/sessions/:sessionId/resume', async (req, res, params) => {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const sessionId = params.sessionId;
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  // `?wake=1` is an opt-in operational hook (no UI/CLI caller wires it today —
  // it's meant for direct recovery). The Current control Adapter performs the
  // activation through the same Session lifecycle seam.
  const wake = new URL(req.url ?? '/', 'http://localhost').searchParams.get('wake') === '1';
  if (!dashboardSessionRuntimeSubmitter) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await dashboardSessionRuntimeSubmitter({
    target: { kind: 'externalSession', sessionId },
    idempotencyKey: operationId.value,
    command: {
      kind: 'control.mutate',
      input: { kind: 'reopen', source: 'dashboard', wake },
    },
  });
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
    const failure = runtimeMutationWireFailure(outcome, {
      notFound: 'not_found',
      transitionRejected: { status: 409, error: 'not_closed' },
    });
    return jsonRes(res, failure.status, failure.body);
  }
  const controlResult = outcome.result;
  if (controlResult?.kind !== 'reopened') {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_invalid_result' });
  }
  const responseSession = controlResult.session;
  const woke = controlResult.executor === 'active';
  // Tell the dashboard the row flipped back to active (mirror of session.update
  // emitted by closeSession). Use `null` for closedAt — `undefined` would be
  // dropped by JSON.stringify on the SSE wire and the aggregator's spread
  // (`{...cur, ...patch}`) would leave the stale closedAt in place.
  if (outcome.kind === 'applied') {
    dashboardEventBus.publish({
      type: 'session.update',
      body: {
        sessionId,
        patch: { status: 'active', closedAt: null },
      },
    });
  }

  const cliId = responseSession.cliId;
  if (outcome.kind === 'applied') {
    dashboardControlEffects?.resumeNotice({ sessionId, cliId });
  }

  jsonRes(res, 200, {
    ok: true,
    sessionId,
    wake: woke,
    title: responseSession.title,
    chatId: responseSession.chatId,
    rootMessageId: responseSession.rootMessageId,
    workingDir: responseSession.workingDir,
    cliId,
  });
});

/**
 * Cross-daemon session transfer endpoint.
 *
 * Called by a *leader* daemon during `/relay --create` to instruct *peer*
 * daemons to migrate their own session (located by `sourceAnchor`) into a
 * newly-created chat. The peer daemon authenticates the request and runs its
 * own `transferSession()` internally — the leader never touches another
 * daemon's process / tmux / jsonl directly.
 *
 * Security:
 *   - Only accepts requests from 127.0.0.1 (no remote daemon coordination).
 *   - `requesterLarkAppId` must be a known bot in this machine's bots
 *     registry. The threat model assumes a malicious bot daemon process is
 *     already root-equivalent on the box; this check just prevents random
 *     other 127.0.0.1 processes from forging migrations.
 *   - `sourceAnchor` must match a session currently owned by *this* daemon
 *     (peer can only move its own sessions — never anybody else's).
 *   - Owner-only: only the original session owner may relocate the session.
 *
 * The leader passes `targetRootMessageId` — typically the leader's M1
 * notification message — so the peer's session lands anchored on a real
 * message in the new chat. Since the new chat is always chat-scope, the
 * rootMessageId is only used for audit / display, not routing.
 */
ipcRoute('POST', '/api/sessions/migrate-to-chat', async (req, res) => {
  const remote = req.socket.remoteAddress;
  // node may report '127.0.0.1' or '::ffff:127.0.0.1' (IPv4 mapped) or '::1'.
  const localish = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!localish) return jsonRes(res, 403, { ok: false, error: 'not_local' });

  let body: {
    sourceAnchor?: string;
    sourceScope?: 'thread' | 'chat';
    targetChatId?: string;
    targetRootMessageId?: string;
    requesterLarkAppId?: string;
    requestingUserOpenId?: string;
    requestingUserUnionId?: string;
    operationId?: unknown;
  } & Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'invalid_json' });
  }
  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  const {
    sourceAnchor,
    sourceScope,
    targetChatId,
    targetRootMessageId,
    requesterLarkAppId,
    requestingUserOpenId,
    requestingUserUnionId,
  } = body;
  if (typeof sourceAnchor !== 'string' || !sourceAnchor
    || typeof targetChatId !== 'string' || !targetChatId
    || typeof targetRootMessageId !== 'string' || !targetRootMessageId
    || typeof requesterLarkAppId !== 'string' || !requesterLarkAppId
    || typeof requestingUserOpenId !== 'string' || !requestingUserOpenId) {
    return jsonRes(res, 400, { ok: false, error: 'missing_field' });
  }
  if (sourceScope !== undefined && sourceScope !== 'thread' && sourceScope !== 'chat') {
    return jsonRes(res, 400, { ok: false, error: 'bad_source_scope' });
  }

  // Requester must be a live botmux daemon — not a random localhost process
  // pretending to be one. We check the cross-process daemon registry
  // (~/.botmux/data/dashboard-daemons/<larkAppId>.json + heartbeat) rather
  // than this process's local bot list: in production each bot has its own
  // daemon process, and a per-process `getAllBots()` only sees its OWN bot
  // (botmux is one-daemon-per-bot at boot, daemon.ts:2367). Using the
  // registry lets the peer recognise the leader bot.
  const requesterKnown = listOnlineDaemons().some(d => d.larkAppId === requesterLarkAppId);
  if (!requesterKnown) return jsonRes(res, 403, { ok: false, error: 'unknown_requester' });

  const submitControl = dashboardSessionRuntimeSubmitter;
  if (!submitControl) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await submitControl({
    target: {
      kind: 'route',
      route: sourceScope === 'chat'
        ? { kind: 'chat', chatId: sourceAnchor }
        : { kind: 'thread', anchorId: sourceAnchor },
    },
    idempotencyKey: operationId.value,
    command: {
      kind: 'control.mutate',
      input: {
        kind: 'relocate',
        sourceAnchor,
        targetChatId,
        targetRootMessageId,
        requester: {
          larkAppId: requesterLarkAppId,
          openId: requestingUserOpenId,
          ...(typeof requestingUserUnionId === 'string' && requestingUserUnionId
            ? { unionId: requestingUserUnionId }
            : {}),
        },
      },
    },
  });
  if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
    return jsonRes(res, 200, { ok: true, sessionId: outcome.sessionId });
  }
  if (outcome.kind === 'rejected' && outcome.reason === 'sessionNotFound') {
    return jsonRes(res, 404, { ok: false, error: 'no_session_at_anchor' });
  }
  const failure = runtimeMutationWireFailure(outcome, {
    notFound: 'no_session_at_anchor',
    transitionRejected: { status: 500, error: 'migration_rejected' },
    transitionCodeStatus: code => code === 'not_session_owner' ? 403 : 500,
  });
  return jsonRes(res, failure.status, failure.body);
});

ipcRoute('POST', '/api/sessions/:sessionId/locate', async (_req, res, params) => {
  const sid = params.sessionId;
  const acq = locateLimiter.tryAcquire(sid);
  if (!acq.ok) {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(Math.ceil(acq.retryAfterMs / 1000)),
    });
    res.end(JSON.stringify({ ok: false, error: 'rate_limited', retryAfterMs: acq.retryAfterMs }));
    return;
  }
  // Resolve owning session (active first, then closed-store fallback). The
  // locate marker is a bare @-mention of the session's owner — no other text,
  // no AppLink redirect on the frontend. The notification on the user's
  // device is enough to navigate them back to the topic.
  const ds = findActiveBySessionId(sid);
  const closed = ds ? null : sessionStore.getSession(sid);
  const ctx = ds
    ? {
        larkAppId: ds.larkAppId,
        rootMessageId: ds.session.rootMessageId,
        ownerOpenId: ds.session.ownerOpenId,
      }
    : closed
      ? {
          larkAppId: closed.larkAppId ?? '',
          rootMessageId: closed.rootMessageId,
          ownerOpenId: closed.ownerOpenId,
        }
      : null;
  if (!ctx || !ctx.larkAppId) {
    return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  }
  if (!ctx.ownerOpenId) {
    return jsonRes(res, 422, { ok: false, error: 'no_owner' });
  }
  // No-transport session (apiOnly bot or HTTP virtual chat) has no Feishu thread
  // to @-locate the owner in — the replyMessage below would dial Feishu.
  if (sessionTransportDisabled({ chatId: ds?.chatId ?? closed?.chatId, larkAppId: ctx.larkAppId })) {
    return jsonRes(res, 200, { ok: false, error: 'no_feishu_transport' });
  }
  try {
    const messageId = await replyMessage(
      ctx.larkAppId,
      ctx.rootMessageId,
      `<at user_id="${ctx.ownerOpenId}"></at>`,
      'text',
      true,
    );
    jsonRes(res, 200, { ok: true, messageId });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: String(err) });
  }
});

// ─── Schedules ─────────────────────────────────────────────────────────────

export interface ScheduleRow {
  id: string;
  name: string;
  schedule: string;
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  rootMessageId?: string;
  scope?: 'thread' | 'chat';
  executionPosition?: ScheduleExecutionPosition;
  topicTitle?: string;
  larkAppId?: string;
  botName?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  repeat?: { times: number | null; completed: number };
  deliver?: 'origin' | 'local' | 'new-topic';
  silent?: boolean;
  feishuChatLink: string;
}

function composeScheduleRow(t: ScheduledTask): ScheduleRow {
  return {
    id: t.id,
    name: t.name,
    schedule: t.schedule,
    parsed: t.parsed,
    prompt: t.prompt,
    workingDir: t.workingDir,
    chatId: t.chatId,
    rootMessageId: t.rootMessageId,
    scope: t.scope,
    executionPosition: scheduler.resolveTaskExecutionPosition(t),
    topicTitle: t.topicTitle,
    larkAppId: t.larkAppId,
    botName: getBotName(),
    enabled: t.enabled,
    createdAt: t.createdAt,
    lastRunAt: t.lastRunAt,
    nextRunAt: t.nextRunAt,
    lastStatus: t.lastStatus,
    lastError: t.lastError,
    repeat: t.repeat,
    deliver: t.deliver ?? 'origin',
    silent: t.silent,
    feishuChatLink: feishuChatLink(t.chatId, getBotBrand(t.larkAppId)),
  };
}

ipcRoute('GET', '/api/schedules', (_req, res) => {
  // Filter to tasks owned by this daemon's bot (multi-bot setups run one
  // daemon per bot — each only manages its own schedules).  belongsToOwner
  // falls through to "all tasks" when no owner filter is configured (tests).
  const all = scheduleStore.listTasks().filter(t => scheduler.belongsToOwner(t));
  jsonRes(res, 200, { schedules: all.map(composeScheduleRow) });
});

ipcRoute('POST', '/api/schedules/:id/run',    (_req, res, p) => jsonRes(res, 200, scheduler.runNow(p.id)));
ipcRoute('POST', '/api/schedules/:id/pause',  (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, false)));
ipcRoute('POST', '/api/schedules/:id/resume', (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, true)));
// Backward-compatible route used by Lark cards and cached dashboard clients.
// Modern callers send an exact target; body-less legacy callers keep the
// historical toggle behavior, now cycling topic → top-level → fresh topic.
ipcRoute('POST', '/api/schedules/:id/delivery', async (req, res, p) => {
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  const requested = body && typeof body === 'object'
    ? (body as Record<string, unknown>).executionPosition
    : undefined;
  if (requested !== undefined) {
    if (requested !== 'top-level' && requested !== 'topic' && requested !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_execution_position', field: 'executionPosition' });
    }
    const result = scheduler.updateTask(p.id, { executionPosition: requested });
    return jsonRes(res, 200, result.ok ? { ...result, executionPosition: requested } : result);
  }
  return jsonRes(res, 200, scheduler.toggleDelivery(p.id));
});

// Create a new scheduled task from the dashboard. chatId selects which chat
// the task fires into; workingDir defaults to the daemon's cwd.
ipcRoute('POST', '/api/schedules', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  if (body === null || typeof body !== 'object') {
    return jsonRes(res, 400, { ok: false, error: 'body_must_be_object' });
  }
  const b = body as Record<string, unknown>;
  // Runtime validation — never trust the TS cast alone.
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const schedule = typeof b.schedule === 'string' ? b.schedule.trim() : '';
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  const chatId = typeof b.chatId === 'string' ? b.chatId.trim() : '';
  const rootMessageId = typeof b.rootMessageId === 'string' ? b.rootMessageId.trim() : '';
  // Validate silent type — if present, must be boolean (no silent degradation).
  let silent = false;
  if (b.silent !== undefined) {
    if (typeof b.silent !== 'boolean') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'silent' });
    }
    silent = b.silent;
  }
  let executionPosition: ScheduleExecutionPosition = 'top-level';
  if (b.executionPosition !== undefined) {
    if (b.executionPosition !== 'top-level' && b.executionPosition !== 'topic' && b.executionPosition !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_execution_position', field: 'executionPosition' });
    }
    executionPosition = b.executionPosition;
  }
  const topicTitle = typeof b.topicTitle === 'string' ? b.topicTitle.trim() : '';
  if (b.topicTitle !== undefined && typeof b.topicTitle !== 'string') {
    return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'topicTitle' });
  }
  if (Array.from(topicTitle).length > 200) {
    return jsonRes(res, 400, { ok: false, error: 'topic_title_too_long', field: 'topicTitle' });
  }
  // Legacy clients sending deliver:new-topic retain the historical meaning:
  // open a fresh topic/session on every run.
  let deliver: 'origin' | 'new-topic' = 'origin';
  if (b.deliver !== undefined) {
    if (b.deliver !== 'origin' && b.deliver !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_deliver', field: 'deliver' });
    }
    deliver = b.deliver;
    if (b.executionPosition === undefined && deliver === 'new-topic') executionPosition = 'new-topic';
  }
  // Validate required fields are present AND non-empty after trim.
  if (!name) return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'name' });
  if (!schedule) return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'schedule' });
  if (!prompt.trim()) return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'prompt' });
  if (!chatId) return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'chatId' });
  if (executionPosition === 'topic' && !rootMessageId) {
    return jsonRes(res, 400, { ok: false, error: 'topic_root_required', field: 'rootMessageId' });
  }
  // Note: bot↔chat membership is intentionally NOT validated here.
  // listChatBotMembers returns [] both when the API is unavailable and when
  // no bot has been observed in the chat yet, so we cannot reliably tell
  // "bot not in chat" (should 400) from "unknown" (should fail-open).
  // A task whose bot is not in the target chat will fail at fire time with
  // a clear lastError, which is the pre-existing behavior for CLI-created
  // tasks. Adding a flaky gate here would block valid creates.
  try {
    const task = scheduler.addTask({
      name,
      schedule,
      prompt,
      workingDir: typeof b.workingDir === 'string' ? b.workingDir : process.cwd(),
      chatId,
      rootMessageId: rootMessageId || undefined,
      scope: executionPosition === 'topic' ? 'thread' : 'chat',
      executionPosition,
      topicTitle: topicTitle || undefined,
      chatType: 'group',
      larkAppId: cachedLarkAppId,
      deliver,
      silent,
    });
    dashboardEventBus.publish({ type: 'schedule.created', body: { schedule: composeScheduleRow(task) } });
    jsonRes(res, 200, { ok: true, task: composeScheduleRow(task) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jsonRes(res, 400, { ok: false, error: msg });
  }
});

// Update editable fields of an existing task. Execution position is explicit;
// topic execution requires a retained/provided topic root message id.
ipcRoute('PATCH', '/api/schedules/:id', async (req, res, p) => {
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  if (body === null || typeof body !== 'object') {
    return jsonRes(res, 400, { ok: false, error: 'body_must_be_object' });
  }
  const b = body as Record<string, unknown>;
  const updates: {
    name?: string; prompt?: string; schedule?: string;
    deliver?: 'origin' | 'new-topic'; silent?: boolean;
    executionPosition?: ScheduleExecutionPosition; rootMessageId?: string; topicTitle?: string;
  } = {};
  // If a field is present, it must be the correct type and (for strings)
  // non-empty after trim — otherwise 400, never silently ignore.
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'name' });
    }
    updates.name = b.name.trim();
  }
  if (b.prompt !== undefined) {
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'prompt' });
    }
    updates.prompt = b.prompt;
  }
  if (b.schedule !== undefined) {
    if (typeof b.schedule !== 'string' || !b.schedule.trim()) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'schedule' });
    }
    updates.schedule = b.schedule.trim();
  }
  if (b.deliver !== undefined) {
    if (b.deliver !== 'origin' && b.deliver !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_deliver', field: 'deliver' });
    }
    updates.deliver = b.deliver;
  }
  if (b.executionPosition !== undefined) {
    if (b.executionPosition !== 'top-level' && b.executionPosition !== 'topic' && b.executionPosition !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_execution_position', field: 'executionPosition' });
    }
    updates.executionPosition = b.executionPosition;
  }
  if (b.rootMessageId !== undefined) {
    if (typeof b.rootMessageId !== 'string') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'rootMessageId' });
    }
    updates.rootMessageId = b.rootMessageId.trim();
  }
  if (b.topicTitle !== undefined) {
    if (typeof b.topicTitle !== 'string') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'topicTitle' });
    }
    const topicTitle = b.topicTitle.trim();
    if (Array.from(topicTitle).length > 200) {
      return jsonRes(res, 400, { ok: false, error: 'topic_title_too_long', field: 'topicTitle' });
    }
    updates.topicTitle = topicTitle;
  }
  if (b.silent !== undefined) {
    if (typeof b.silent !== 'boolean') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'silent' });
    }
    updates.silent = b.silent;
  }
  const result = scheduler.updateTask(p.id, updates);
  if (!result.ok) return jsonRes(res, 400, result);
  const task = scheduleStore.getTask(p.id);
  jsonRes(res, 200, { ok: true, task: task ? composeScheduleRow(task) : undefined });
});

// Delete a scheduled task.
ipcRoute('DELETE', '/api/schedules/:id', (_req, res, p) => {
  jsonRes(res, 200, scheduler.removeTaskForDashboard(p.id));
});

ipcRoute('POST', '/api/trigger', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, errorCode: 'bot_not_found', error: 'larkAppId_not_set' });
  const activeSessions = getActiveSessionsRegistry();
  if (!activeSessions) return jsonRes(res, 503, { ok: false, errorCode: 'trigger_failed', error: 'active session registry unavailable' });
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, errorCode: 'bad_json', error: 'invalid JSON body' });
  }
  const valid = validateTriggerRequest(body);
  if (!valid.ok) return jsonRes(res, valid.status, valid.body);
  if (valid.request.target.botId && valid.request.target.botId !== cachedLarkAppId) {
    return jsonRes(res, 400, {
      ok: false,
      errorCode: 'bot_not_found',
      error: `request target botId ${valid.request.target.botId} does not match daemon ${cachedLarkAppId}`,
    });
  }
  if (valid.request.target.kind === 'turn' && valid.request.target.sessionId) {
    const receiverTarget = [...activeSessions.values()].find(
      (candidate) => candidate.session.sessionId === valid.request.target.sessionId,
    );
    if (receiverTarget?.session.vcMeetingReceiver) {
      return jsonRes(res, 403, {
        ok: false,
        errorCode: 'managed_receiver_requires_delivery_endpoint',
        error: 'dedicated meeting receiver sessions accept only fenced delivery or explicit IM routing',
      });
    }
  }
  try {
    if (valid.request.target.kind === 'workflow') {
      return jsonRes(res, 410, {
        ok: false,
        errorCode: 'legacy_workflow_retired',
        error: 'v2 workflow trigger targets are retired; migrate the definition and run it through /workflow',
      });
    }
    const activeSessions = getActiveSessionsRegistry();
    if (!activeSessions) {
      return jsonRes(res, 503, {
        ok: false,
        errorCode: 'trigger_failed',
        error: 'active session registry unavailable',
      });
    }
    const result = await triggerSessionTurn(valid.request, {
      ownerBotId: getBot(cachedLarkAppId).botId!,
      larkAppId: cachedLarkAppId,
      activeSessions,
    });
    const status = result.ok
      ? 200
      // An idempotent retry that resolves to a durable `failed` async state is a
      // successful HTTP call reporting a terminal outcome (like a 200 completed/
      // queued), not a request error — surface it 200 so the caller reads `state`.
      : result.state === 'failed'
        ? 200
      : result.errorCode === 'idempotency_conflict'
        ? 409
      : result.errorCode === 'bot_not_in_chat'
        ? 403
        : result.errorCode === 'session_not_found'
          ? 404
        : result.errorCode === 'wait_timeout'
          ? 504
        : result.errorCode === 'target_required' || result.errorCode === 'bad_request'
          ? 400
          : 500;
    return jsonRes(res, status, result);
  } catch (e: any) {
    return jsonRes(res, 500, { ok: false, errorCode: 'trigger_failed', error: e?.message ?? String(e) });
  }
});

// ─── Exact chat grants (talk-only) ─────────────────────────────────────────

/**
 * Apply/read/revoke a receiver-scoped chatGrant. The receiver identity comes
 * from this daemon's cached larkAppId, never from the caller. The body repeats
 * it only as an anti-misrouting assertion (e.g. a stale daemon descriptor).
 *
 * This permission write is loopback-HMAC protected: a sandboxed worker that
 * merely discovers an ipcPort must not be able to grant itself access.
 */
ipcRoute('POST', '/api/grants/chat', async (req, res) => {
  const localPort = req.socket.localPort;
  const authBind = localPort ? cliAuthBind('POST', '/api/grants/chat', localPort) : undefined;
  if (!authBind || !tokenRouteAuthorized(req, authBind)) {
    return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }
  if (!cachedLarkAppId) {
    return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  }
  let body: {
    operation?: unknown;
    receiverLarkAppId?: unknown;
    chatId?: unknown;
    subjectOpenIds?: unknown;
    subjectLarkAppIds?: unknown;
  };
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  if (body.receiverLarkAppId !== cachedLarkAppId) {
    return jsonRes(res, 409, {
      ok: false,
      error: 'receiver_mismatch',
      receiverLarkAppId: cachedLarkAppId,
    });
  }
  const hasSubjectOpenIds = Object.prototype.hasOwnProperty.call(body, 'subjectOpenIds');
  const hasSubjectLarkAppIds = Object.prototype.hasOwnProperty.call(body, 'subjectLarkAppIds');
  if (hasSubjectOpenIds === hasSubjectLarkAppIds) {
    return jsonRes(res, 400, {
      ok: false,
      error: 'exactly_one_subject_identity_required',
      message: 'Provide exactly one of subjectOpenIds or subjectLarkAppIds',
    });
  }
  if (hasSubjectLarkAppIds && body.operation !== 'grant') {
    return jsonRes(res, 400, {
      ok: false,
      error: 'subject_lark_app_ids_grant_only',
      message: 'subjectLarkAppIds may only be used with operation=grant',
    });
  }
  const result = hasSubjectLarkAppIds
    ? await exactChatGrantHandler({
        operation: body.operation,
        receiverLarkAppId: cachedLarkAppId,
        chatId: body.chatId,
        subjectLarkAppIds: body.subjectLarkAppIds,
      })
    : await exactChatGrantHandler({
        operation: body.operation,
        receiverLarkAppId: cachedLarkAppId,
        chatId: body.chatId,
        subjectOpenIds: body.subjectOpenIds,
      });
  if (!result.ok) {
    const { status, ...responseBody } = result;
    return jsonRes(res, status, responseBody);
  }
  return jsonRes(res, 200, result);
});

// ─── Groups (Phase B) ──────────────────────────────────────────────────────

ipcRoute('GET', '/api/groups', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const chats = await groupsStore.listChats(cachedLarkAppId);
    // Stamp a firstSeenAt timestamp for every chat (preserve existing values,
    // backfill new ones with Date.now()). Lark doesn't expose chat create_time
    // anywhere, so the dashboard sorts by this client-side proxy instead.
    const seenMap = chatFirstSeenStore.markSeenBulk(chats.map(c => c.chatId));
    // Annotate each chat with its oncall binding (if any) so the dashboard
    // matrix can show toggle state without a second round-trip.
    const enriched = chats.map(c => {
      const oncall = oncallStore.getOncallStatus(cachedLarkAppId, c.chatId);
      const hasRole = resolveRoleFile(cachedLarkAppId, c.chatId) !== null;
      const hasMessageListener = getMessageListenerConfig(cachedLarkAppId, c.chatId)?.enabled === true;
      // /introduce 记录的外部 botmux 机器人（按名字）——dashboard 团队看板用
      // 它识别「介绍过同团队机器人的协作群」。
      const observedBotNames = observedBotsStore
        .listObservedBots(config.session.dataDir, cachedLarkAppId, c.chatId)
        .map(b => b.name);
      return { ...c, oncallChat: oncall ?? null, firstSeenAt: seenMap.get(c.chatId) ?? null, hasRole, hasMessageListener, observedBotNames };
    });
    jsonRes(res, 200, { chats: enriched });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

ipcRoute('GET', '/api/groups/:chatId/membership', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const inChat = await groupsStore.isInChat(cachedLarkAppId, p.chatId);
    jsonRes(res, 200, { inChat });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

ipcRoute('POST', '/api/groups/:chatId/add-bots', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { larkAppIds?: unknown };
  try {
    body = await readJsonBody<{ larkAppIds?: string[] }>(req);
  } catch {
    return jsonRes(res, 400, { error: 'bad_json' });
  }
  if (!Array.isArray(body.larkAppIds) || !body.larkAppIds.every(x => typeof x === 'string')) {
    return jsonRes(res, 400, { error: 'larkAppIds_required' });
  }
  try {
    const result = await groupsStore.addBotToChat(cachedLarkAppId, p.chatId, body.larkAppIds as string[]);
    jsonRes(res, 200, { result });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

// Disband (delete) a chat from this bot's identity. Public route picks an
// in-chat bot as the executor; this just performs the call.
ipcRoute('POST', '/api/groups/:chatId/disband', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const r = await groupsStore.disbandChat(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, r);
});

// Make this bot leave the chat. Always works on a member bot per Lark docs.
ipcRoute('POST', '/api/groups/:chatId/leave', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const r = await groupsStore.leaveChat(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, r);
});

// 平台团队大厅打卡：dashboard 在 team-sync 后编排本机 bot 往大厅（bot-only 群）
// 发登记消息。实测大厅只有「直接点名 @」会投递（普通消息/自 @/@all 全部静默），
// 所以打卡消息点名 @ 本机其他未入册 bot（mentionNames，open_id 由本 app 的
// cross-ref 解析——open_id 是 per-app 的，只有发送方自己能解析），被点到的 bot
// 从 mentions 学到自己的 union_id。回声路径保留（有 receive-all scope 的应用仍可
// 从自家消息学）。已入册且无人可教时幂等跳过。
ipcRoute('POST', '/api/platform/hall-announce', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  let body: { chatId?: unknown; mentionNames?: unknown };
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  if (!/^oc_[0-9a-f]+$/i.test(chatId)) return jsonRes(res, 400, { ok: false, error: 'bad_chat_id' });
  const mentionNames = Array.isArray(body.mentionNames)
    ? body.mentionNames.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  // 解析点名目标：name → 本 app 视角的 open_id（cross-ref，来自历史 @ 事件）。解析不到的跳过。
  const resolved: Array<{ name: string; openId: string }> = [];
  if (mentionNames.length) {
    try {
      const map: Record<string, string> = JSON.parse(
        readFileSync(join(config.session.dataDir, `bot-openids-${cachedLarkAppId}.json`), 'utf-8'),
      );
      for (const name of mentionNames) {
        const openId = map[name];
        if (typeof openId === 'string' && openId.startsWith('ou_')) resolved.push({ name, openId });
      }
    } catch { /* 无 cross-ref → 全部解析失败，退化为普通打卡 */ }
  }
  if (getBotUnionId(config.session.dataDir, cachedLarkAppId) && resolved.length === 0) {
    return jsonRes(res, 200, { ok: true, skipped: 'already_learned' });
  }
  try {
    const atPrefix = resolved.map((r) => `<at user_id="${r.openId}">${r.name}</at> `).join('');
    // 自己还没入册 → 带 #hall-echo 请求回执：被点到的 bot 会 @ 回我们一次，
    // 我们从回执的 mentions[] 学到自己的 union_id（见 event-dispatcher hall 分支）。
    const echoTag = getBotUnionId(config.session.dataDir, cachedLarkAppId) ? '' : ' #hall-echo';
    await sendMessage(cachedLarkAppId, chatId, atPrefix + t('platform.hall_announce', undefined, localeForBot(cachedLarkAppId)) + echoTag, 'text');
    jsonRes(res, 200, { ok: true, mentioned: resolved.map((r) => r.name), unresolved: mentionNames.filter((n) => !resolved.some((r) => r.name === n)) });
  } catch (e) {
    jsonRes(res, 502, { ok: false, error: `send_failed: ${(e as Error).message}` });
  }
});

// ─── Oncall bindings (dashboard) ───────────────────────────────────────────
// PUT  /api/oncall/:chatId  body: {workingDir} — bind or update workingDir
// DELETE /api/oncall/:chatId — unbind
//
// Auth: dashboard's loopback token is the gate. No per-chat owner concept —
// allowedUsers governs who can operate via Lark too (see canOperate).

ipcRoute('PUT', '/api/oncall/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { workingDir?: unknown };
  try { body = await readJsonBody<{ workingDir?: string }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';
  if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });

  // Same validation as /oncall bind in Lark — exists + is a directory.
  const v = validateWorkingDir(workingDir);
  if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
  const resolvedPath = v.resolvedPath;

  const r = await oncallStore.bindOncall(cachedLarkAppId, p.chatId, workingDir);
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, entry: r.entry, created: r.created, resolvedPath });
});

ipcRoute('DELETE', '/api/oncall/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  // Idempotent: always succeeds. unbindOncall writes a tombstone into
  // defaultOncallAutoboundChats so the auto-bind judge won't reinstate this
  // chat on the next observation, even if it had no prior binding.
  const r = await oncallStore.unbindOncall(cachedLarkAppId, p.chatId);
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, wasBound: r.wasBound });
});

// ─── Role management (dashboard) ───────────────────────────────────────────
// POST   /api/roles/batch   body: {chatIds: string[]} → role snapshots
// GET    /api/roles/:chatId  → role, injection, and dispatch-completion settings
// PUT    /api/roles/:chatId  body: {content?, injectMode?, dispatchCompletionEnabled?}
// DELETE /api/roles/:chatId  → remove role file and metadata

const MAX_ROLE_BATCH_CHAT_IDS = 1_000;

function dashboardRolePayload(larkAppId: string, chatId: string): Record<string, unknown> {
  const content = resolveRoleFile(larkAppId, chatId);
  const effective = resolveRole(larkAppId, chatId);
  return {
    chatId,
    content,
    byteLength: content ? Buffer.byteLength(content, 'utf-8') : 0,
    hasRole: content !== null,
    injectMode: readRoleInjectMode(larkAppId, chatId),
    dispatchCompletionEnabled: readRoleDispatchCompletionEnabled(larkAppId, chatId),
    effectiveContent: effective.content,
    effectiveSource: effective.source,
    effectiveByteLength: effective.content ? Buffer.byteLength(effective.content, 'utf-8') : 0,
    hasEffectiveRole: effective.content !== null,
  };
}

ipcRoute('POST', '/api/roles/batch', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { chatIds?: unknown };
  try { body = await readJsonBody<{ chatIds?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (!Array.isArray(body.chatIds)) return jsonRes(res, 400, { ok: false, error: 'chat_ids_required' });
  if (body.chatIds.length > MAX_ROLE_BATCH_CHAT_IDS) {
    return jsonRes(res, 400, { ok: false, error: 'too_many_chat_ids' });
  }
  if (body.chatIds.some(chatId => typeof chatId !== 'string' || !isValidRoleChatId(chatId))) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  }
  const chatIds = [...new Set(body.chatIds as string[])];
  jsonRes(res, 200, { roles: chatIds.map(chatId => dashboardRolePayload(cachedLarkAppId!, chatId)) });
});

ipcRoute('GET', '/api/roles/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  jsonRes(res, 200, dashboardRolePayload(cachedLarkAppId, p.chatId));
});

ipcRoute('PUT', '/api/roles/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  let body: { content?: unknown; injectMode?: unknown; dispatchCompletionEnabled?: unknown };
  try { body = await readJsonBody<{ content?: string; injectMode?: string; dispatchCompletionEnabled?: boolean }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  // injectMode is a per-chat setting that can be updated on its own (no content)
  // — e.g. toggling "inject once" for a chat whose effective role is the team
  // default. Only 'every'/'once' are accepted; anything else is ignored.
  const injectMode: RoleInjectMode | undefined =
    body.injectMode === 'once' ? 'once' : body.injectMode === 'every' ? 'every' : undefined;
  const dispatchCompletionEnabled = typeof body.dispatchCompletionEnabled === 'boolean'
    ? body.dispatchCompletionEnabled
    : undefined;
  const hasContentField = typeof body.content === 'string';
  const content = hasContentField ? (body.content as string).trim() : '';
  if (!hasContentField && injectMode === undefined && dispatchCompletionEnabled === undefined) {
    return jsonRes(res, 400, { ok: false, error: 'role_setting_required' });
  }
  if (hasContentField && !content) return jsonRes(res, 400, { ok: false, error: 'content_required' });
  try {
    if (hasContentField) writeRoleFile(cachedLarkAppId, p.chatId, content);
    if (injectMode !== undefined) writeRoleInjectMode(cachedLarkAppId, p.chatId, injectMode);
    if (dispatchCompletionEnabled !== undefined) writeRoleDispatchCompletionEnabled(cachedLarkAppId, p.chatId, dispatchCompletionEnabled);
    // `changed` reflects whether the role FILE (→ hasRole in the groups matrix)
    // was written. A metadata-only PUT touches just the .meta.json sidecar and
    // leaves hasRole untouched, so it reports changed:false — the dashboard uses
    // this to avoid needlessly busting its 30s groups-matrix snapshot.
    jsonRes(res, 200, { ok: true, changed: hasContentField });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: String(e) });
  }
});

ipcRoute('DELETE', '/api/roles/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const existed = deleteRoleFile(cachedLarkAppId, p.chatId);
  deleteRoleMeta(cachedLarkAppId, p.chatId);
  // `changed` mirrors `existed`: a DELETE that removed nothing didn't flip
  // hasRole, so the dashboard skips invalidating its groups-matrix snapshot.
  jsonRes(res, 200, { ok: true, existed, changed: existed });
});

ipcRoute('GET', '/api/message-listeners/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  jsonRes(res, 200, {
    chatId: p.chatId,
    listener: getMessageListenerConfig(cachedLarkAppId, p.chatId),
    maxPromptBytes: MAX_MESSAGE_LISTENER_PROMPT_BYTES,
  });
});

ipcRoute('PUT', '/api/message-listeners/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const update = sanitizeMessageListenerUpdate(body);
  if (!update) return jsonRes(res, 400, { ok: false, error: 'invalid_listener' });
  const validation = validateMessageListenerUpdate(update);
  if (!validation.ok) return jsonRes(res, 400, { ok: false, error: validation.reason });
  if (update.prompt && Buffer.byteLength(update.prompt, 'utf-8') > MAX_MESSAGE_LISTENER_PROMPT_BYTES) {
    return jsonRes(res, 400, { ok: false, error: 'prompt_too_large' });
  }
  const result = await updateMessageListenerConfig(cachedLarkAppId, p.chatId, update);
  if (!result.ok) return jsonRes(res, ['prompt_required', 'sender_required'].includes(result.reason) ? 400 : 500, { ok: false, error: result.reason });
  jsonRes(res, 200, { ok: true, listener: result.listener });
});

function dashboardHistoryMessageSender(message: any): { senderOpenId?: string; senderName?: string; senderTypeRaw?: string; senderIdType?: string } {
  const sender = message?.sender ?? {};
  // Prefer `open_bot_id` (present on bot senders when with_sender_name=true): it
  // is the bot's per-app open_id, matching /members/bots and the stored sender
  // filters. Mirrors historyMessageSender in event-dispatcher so preview and the
  // 30s poll resolve a third-party bot identically. See that fn for detail.
  const senderId = sender.open_bot_id ?? sender.id ?? sender.open_id ?? sender.user_id ?? sender.app_id
    ?? message?.sender_id?.open_id ?? message?.sender_id?.user_id ?? message?.sender_id?.app_id;
  const senderName = sender.sender_name ?? sender.name ?? sender.user_name ?? message?.sender_name;
  const rawIdType = sender.id_type ?? sender.sender_id_type;
  const senderIdType = sender.open_bot_id ? 'open_id' : rawIdType;
  const senderTypeRaw = sender.sender_type ?? message?.sender_type ?? (rawIdType === 'app_id' ? 'app' : undefined);
  return {
    senderOpenId: typeof senderId === 'string' ? senderId : undefined,
    senderName: typeof senderName === 'string' && senderName.trim() ? senderName.trim() : undefined,
    senderTypeRaw: typeof senderTypeRaw === 'string' ? senderTypeRaw : undefined,
    senderIdType: typeof senderIdType === 'string' ? senderIdType : undefined,
  };
}

function dashboardMessageCreateTimeMs(message: any): number | undefined {
  const value = Number(message?.create_time ?? message?.createTime);
  return Number.isFinite(value) ? value : undefined;
}

async function readMessageListenerPreviewRequest(req: IncomingMessage): Promise<
  | { ok: true; listener: NonNullable<ReturnType<typeof sanitizeMessageListenerUpdate>>; limit: number }
  | { ok: false; status: number; error: string }
> {
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return { ok: false, status: 400, error: 'bad_json' }; }
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const listener = sanitizeMessageListenerUpdate(raw.listener ?? raw);
  if (!listener) return { ok: false, status: 400, error: 'invalid_listener' };
  const validation = validateMessageListenerUpdate(listener);
  if (!validation.ok) return { ok: false, status: 400, error: validation.reason };
  if (listener.prompt && Buffer.byteLength(listener.prompt, 'utf-8') > MAX_MESSAGE_LISTENER_PROMPT_BYTES) {
    return { ok: false, status: 400, error: 'prompt_too_large' };
  }
  return { ok: true, listener, limit: normalizeMessageListenerPreviewLimit(raw.limit) };
}

async function collectMessageListenerPreviewMatches(
  larkAppId: string,
  chatId: string,
  listener: NonNullable<ReturnType<typeof sanitizeMessageListenerUpdate>>,
  limit: number,
): Promise<MessageListenerPreviewMatch[]> {
  const bot = getBot(larkAppId);
  const previewListener: MessageListenerConfig = {
    enabled: true,
    ...(listener.name ? { name: listener.name } : {}),
    ...(listener.replyCardTitle ? { replyCardTitle: listener.replyCardTitle } : {}),
    ...(listener.workingDir ? { workingDir: listener.workingDir } : {}),
    prompt: listener.prompt,
    ...(listener.senderPolicy && Object.keys(listener.senderPolicy).length > 0 ? { senderPolicy: listener.senderPolicy } : {}),
    ...(listener.messagePolicy ? { messagePolicy: { ...listener.messagePolicy, scope: 'top_level' } } : { messagePolicy: { scope: 'top_level' } }),
    replyPolicy: { mode: 'thread', sessionMode: 'per_message' },
  };
  const previewBot = {
    ...bot,
    config: {
      ...bot.config,
      messageListeners: {
        ...(bot.config.messageListeners ?? {}),
        [chatId]: previewListener,
      },
    },
  };
  const cutoff = Date.now() - MESSAGE_LISTENER_PREVIEW_WINDOW_MS;
  const messages = await listChatMessagesUntil(larkAppId, chatId, {
    pageSize: 50,
    stopAfter: (message, seenCount) => {
      const createdAt = dashboardMessageCreateTimeMs(message);
      return seenCount >= Math.max(100, limit * 5) ||
        (Number.isFinite(createdAt) && (createdAt as number) < cutoff);
    },
  });
  const candidateBotAppIds = collectListenerBotAppIds(messages, dashboardHistoryMessageSender);
  const appIdToOpenId = await buildListenerBotAppIdToOpenId(larkAppId, chatId, candidateBotAppIds);
  const matches = previewMessageListenerMatches({
    bot: previewBot,
    chatId,
    messages,
    limit,
    senderForMessage: dashboardHistoryMessageSender,
    appIdToOpenId,
    // Mirror realtime/poll routing: a message that explicitly @mentions this bot
    // hands off to normal @-routing, NOT the listener — so preview/run-preview
    // must apply the same gate (else preview over-counts and run-preview would
    // spawn a session for a message live routing never sends to the listener).
    explicitlyMentionedThisBot: (message) => messageMentionsBot(message, larkAppId, bot.botOpenId),
  });
  // The listener matcher extracts card text from the SIMPLIFIED history view,
  // which drops button jump URLs. The live delivery path (handleNewTopic) fixes
  // this by re-extracting after resolveNonsupportMessage merges the card's two
  // representations. Preview/run-preview do NOT go through handleNewTopic, so
  // apply the equivalent merge here: run-preview spawns REAL turns off
  // match.messageText, and preview display should show the same links the live
  // listener will. Only interactive cards need it; a resolver miss keeps the
  // match-time text. Resolve concurrently — each match is an independent fetch.
  await Promise.all(matches.map(async (match) => {
    if (match.msgType !== 'interactive') return;
    const merged = await resolveMergedCardContent(larkAppId, match.messageId).catch(() => null);
    if (merged?.text?.trim()) match.messageText = merged.text;
  }));
  return matches;
}

function publicMessageListenerMatch(match: MessageListenerPreviewMatch): Record<string, unknown> {
  return {
    messageId: match.messageId,
    createTime: match.createTime,
    messageText: match.messageText,
    messageTitle: match.messageTitle,
    msgType: match.msgType,
    senderOpenId: match.senderOpenId,
    senderName: match.senderName,
    senderType: match.senderType,
  };
}

ipcRoute('POST', '/api/message-listeners/:chatId/preview', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const parsed = await readMessageListenerPreviewRequest(req);
  if (!parsed.ok) return jsonRes(res, parsed.status, { ok: false, error: parsed.error });
  try {
    const matches = await collectMessageListenerPreviewMatches(cachedLarkAppId, p.chatId, parsed.listener, parsed.limit);
    jsonRes(res, 200, {
      ok: true,
      requestedLimit: parsed.limit,
      matches: matches.map(publicMessageListenerMatch),
    });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

ipcRoute('POST', '/api/message-listeners/:chatId/run-preview', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const activeSessions = getActiveSessionsRegistry();
  if (!activeSessions) return jsonRes(res, 503, { ok: false, error: 'active session registry unavailable' });
  const parsed = await readMessageListenerPreviewRequest(req);
  if (!parsed.ok) return jsonRes(res, parsed.status, { ok: false, error: parsed.error });
  try {
    const matches = await collectMessageListenerPreviewMatches(cachedLarkAppId, p.chatId, parsed.listener, parsed.limit);
    const run = createMessageListenerRunPreview(cachedLarkAppId, p.chatId, matches.map(match => match.messageId));
    const results = [];
    for (const match of matches) {
      const triggerId = createMessageListenerRunPreviewTurnId();
      try {
        const result = await triggerSessionTurn({
          source: {
            type: 'ui',
            connectorId: 'message-listener-preview',
            requestId: `listener-preview:${match.messageId}`,
            receivedAt: new Date().toISOString(),
          },
          target: {
            kind: 'turn',
            botId: cachedLarkAppId,
            chatId: p.chatId,
            rootMessageId: match.messageId,
          },
          envelope: {
            format: 'message_listener',
            sourceName: match.name || 'Message Listener Preview',
            trusted: false,
            payload: publicMessageListenerMatch(match),
            rawText: match.messageText,
          },
          instruction: renderMessageListenerInstruction(match),
          presentation: { topicMessage: null },
        }, {
          ownerBotId: getBot(cachedLarkAppId).botId!,
          larkAppId: cachedLarkAppId,
          activeSessions,
        }, { stableTurnId: triggerId });
        const tracked = result.ok
          ? markMessageListenerRunPreviewTriggered(run.runId, match.messageId, {
              action: result.action,
              sessionId: result.target?.sessionId,
              triggerId: result.triggerId ?? triggerId,
            })
          : markMessageListenerRunPreviewFailed(run.runId, {
              messageId: match.messageId,
              sessionId: result.target?.sessionId,
              error: result.error,
            });
        results.push(tracked ?? {
          runId: run.runId,
          messageId: match.messageId,
          ok: result.ok,
          state: result.ok ? 'triggered' : 'failed',
          action: result.action,
          sessionId: result.target?.sessionId,
          triggerId: result.triggerId ?? triggerId,
          error: result.error,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const tracked = markMessageListenerRunPreviewFailed(run.runId, {
          messageId: match.messageId,
          error,
        });
        results.push(tracked ?? {
          runId: run.runId,
          messageId: match.messageId,
          ok: false,
          state: 'failed',
          error,
        });
      }
    }
    jsonRes(res, 200, {
      ok: results.every(result => result.ok),
      runId: run.runId,
      requestedLimit: parsed.limit,
      matches: matches.map(publicMessageListenerMatch),
      results,
    });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

ipcRoute('GET', '/api/message-listeners/:chatId/run-preview/:runId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const run = getMessageListenerRunPreview(p.runId);
  if (!run || run.larkAppId !== cachedLarkAppId || run.chatId !== p.chatId) {
    return jsonRes(res, 404, { ok: false, error: 'not_found' });
  }
  jsonRes(res, 200, {
    ok: true,
    runId: run.runId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    results: run.results,
  });
});

ipcRoute('DELETE', '/api/message-listeners/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const result = await updateMessageListenerConfig(cachedLarkAppId, p.chatId, { enabled: false, prompt: '' });
  if (!result.ok) return jsonRes(res, 500, { ok: false, error: result.reason });
  jsonRes(res, 200, { ok: true });
});

ipcRoute('GET', '/api/groups/:chatId/members-display', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  try {
    const members = await listChatMemberDisplays(cachedLarkAppId, p.chatId);
    jsonRes(res, 200, { members });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Role profile management (dashboard) ──────────────────────────────────
// Profiles are authoring/storage helpers only; applying one writes this bot's
// entry into the selected chat role and does not alter runtime role layering.

ipcRoute('GET', '/api/role-profiles', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const profiles = listRoleProfiles(config.session.dataDir).map(p => ({
    ...p,
    hasCurrentBotEntry: readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId) !== null,
  }));
  jsonRes(res, 200, { profiles, larkAppId: cachedLarkAppId });
});

ipcRoute('GET', '/api/role-profiles/:profileId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const entries = listRoleProfileEntries(config.session.dataDir, p.profileId);
  jsonRes(res, 200, { profileId: p.profileId, entries });
});

ipcRoute('GET', '/api/role-profiles/:profileId/:larkAppId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const content = readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  jsonRes(res, 200, {
    profileId: p.profileId,
    larkAppId: cachedLarkAppId,
    content,
    byteLength: content ? Buffer.byteLength(content, 'utf-8') : 0,
    hasEntry: content !== null,
  });
});

ipcRoute('PUT', '/api/role-profiles/:profileId/:larkAppId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  let body: { content?: unknown; allowEmpty?: unknown };
  try { body = await readJsonBody<{ content?: string; allowEmpty?: boolean }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const allowEmpty = body.allowEmpty === true;
  if (!content && !allowEmpty) return jsonRes(res, 400, { ok: false, error: 'content_required' });
  try {
    writeRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId, content, { allowEmpty });
    jsonRes(res, 200, { ok: true, byteLength: Math.min(Buffer.byteLength(content, 'utf-8'), MAX_ROLE_PROFILE_ENTRY_BYTES) });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: String(e) });
  }
});

ipcRoute('DELETE', '/api/role-profiles/:profileId/:larkAppId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const existed = deleteRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  deleteRoleProfileIfEmpty(config.session.dataDir, p.profileId);
  jsonRes(res, 200, { ok: true, existed });
});

ipcRoute('POST', '/api/role-profiles/:profileId/apply', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  let body: { chatId?: unknown; larkAppId?: unknown; force?: unknown; preview?: unknown };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const chatId = typeof body.chatId === 'string' && body.chatId.trim() ? body.chatId.trim() : '';
  const larkAppId = typeof body.larkAppId === 'string' && body.larkAppId.trim() ? body.larkAppId.trim() : '';
  if (!chatId || !larkAppId) return jsonRes(res, 400, { ok: false, error: 'chatId_and_larkAppId_required' });
  if (!isValidRoleChatId(chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  if (larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  const content = readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  if (content === null) return jsonRes(res, 200, { ok: false, error: 'missing_entry', changed: false });
  const existing = resolveRoleFile(cachedLarkAppId, chatId);
  const preview = body.preview === true;
  const force = body.force === true;
  if (preview) {
    return jsonRes(res, 200, {
      ok: true,
      preview: true,
      changed: false,
      wouldOverwrite: existing !== null,
      wouldRefuse: existing !== null && !force,
      content,
      byteLength: Buffer.byteLength(content, 'utf-8'),
    });
  }
  if (existing && !force) return jsonRes(res, 409, { ok: false, error: 'chat_role_exists', changed: false });
  if (!content) {
    const existed = deleteRoleFile(cachedLarkAppId, chatId);
    return jsonRes(res, 200, { ok: true, changed: existed, byteLength: 0, deleted: existed });
  }
  writeRoleFile(cachedLarkAppId, chatId, content);
  jsonRes(res, 200, { ok: true, changed: true, byteLength: Buffer.byteLength(content, 'utf-8') });
});

// ─── Per-bot defaultOncall (dashboard) ─────────────────────────────────────
// GET  /api/bot-default-oncall → returns this daemon's current config
// PUT  /api/bot-default-oncall  body: { enabled, workingDir }
//
// Forward-only policy: enabling does not backfill or distinguish "old vs new"
// chats. Any group the bot is in — present or future — auto-binds on its
// next observed topic if it has no existing oncall binding and is not in
// the tombstone list. `since` is stamped purely as informational metadata
// (UI shows "上次启用时间").

ipcRoute('GET', '/api/bot-default-oncall', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const { defaultOncall, autoboundChats } = oncallStore.getBotDefaultOncall(cachedLarkAppId);
  const cardPrefs = cardPrefsStore.getBotCardPrefs(cachedLarkAppId);
  const grantPrefs = grantPrefsStore.getBotGrantPrefs(cachedLarkAppId);
  let p2pMode: 'thread' | 'chat' = 'chat';
  try { if (getBot(cachedLarkAppId).config.p2pMode === 'thread') p2pMode = 'thread'; } catch { /* default chat */ }
  let skillInjection: 'global' | 'prompt' | 'off' | null = null;
  // How this bot's CLI delivers botmux skills, so the dashboard can render the
  // control correctly: 'dynamic' = per-session --plugin-dir (claude-family, not
  // configurable); 'global' = global skills dir (codex-family, prompt/global/off
  // selectable); 'none' = CLI has no skill dir at all (control hidden).
  let skillInjectionSupport: 'dynamic' | 'global' | 'none' = 'none';
  try {
    const cfg = getBot(cachedLarkAppId).config;
    const s = cfg.skillInjection;
    if (s === 'global' || s === 'prompt' || s === 'off') skillInjection = s;
    skillInjectionSupport = resolveSkillInjectionSupport(cfg.cliId, cfg.cliPathOverride);
  } catch { /* unset → machine default; support → none */ }
  let cliId = '';
  let cliRuntime: CliRuntimeConfig | null = null;
  let cliPathOverride: string | null = null;
  let wrapperCli: string | null = null;
  let model: string | null = null;
  let agentSelectionKey = '';
  try {
    const cfg = getBot(cachedLarkAppId).config;
    cliId = cfg.cliId;
    cliRuntime = cfg.cliRuntime ?? null;
    // Parsed structured runtimes mirror their executable into cliPathOverride
    // for legacy adapter call sites. Expose only a genuine legacy path here so
    // the Dashboard can render an explicit migration state instead of
    // misclassifying every structured runtime as legacy.
    cliPathOverride = !cfg.cliRuntime && typeof cfg.cliPathOverride === 'string' && cfg.cliPathOverride.trim()
      ? cfg.cliPathOverride
      : null;
    wrapperCli = typeof cfg.wrapperCli === 'string' && cfg.wrapperCli.trim() ? cfg.wrapperCli : null;
    model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model : null;
    agentSelectionKey = selectionKeyForBot(cliId, wrapperCli ?? undefined);
  } catch { /* no registered bot */ }
  let maxLiveWorkers: number | null = null;
  try {
    const m = getBot(cachedLarkAppId).config.maxLiveWorkers;
    if (typeof m === 'number' && Number.isInteger(m) && m > 0) maxLiveWorkers = m;
  } catch { /* default unlimited */ }
  let logicalSessionCount = 0;
  let residentSessionCount = 0;
  let dormantSessionCount = 0;
  const registry = getActiveSessionsRegistry();
  if (registry) {
    logicalSessionCount = registry.size;
    for (const ds of registry.values()) {
      if (ds.worker && !ds.worker.killed) residentSessionCount++;
      else if (!ds.session.queued) dormantSessionCount++;
    }
  }
  // startupCommands → newline-joined for the dashboard textarea (one per line).
  let startupCommands = '';
  try {
    const sc = getBot(cachedLarkAppId).config.startupCommands;
    if (Array.isArray(sc) && sc.length) startupCommands = sc.join('\n');
  } catch { /* none */ }
  // customPassthroughCommands / canTalkDaemonCommands → space-joined for the
  // dashboard slash-command editors. Empty string = not configured (回默认).
  let customPassthroughCommands = '';
  let canTalkDaemonCommands = '';
  try {
    const cfg = getBot(cachedLarkAppId).config;
    if (Array.isArray(cfg.customPassthroughCommands) && cfg.customPassthroughCommands.length) {
      customPassthroughCommands = cfg.customPassthroughCommands.join(' ');
    }
    if (Array.isArray(cfg.canTalkDaemonCommands) && cfg.canTalkDaemonCommands.length) {
      canTalkDaemonCommands = cfg.canTalkDaemonCommands.join(' ');
    }
  } catch { /* none */ }
  // Per-bot env → pretty JSON for the dashboard textarea. The dashboard is
  // owner-authenticated, so showing the real values here is acceptable (same
  // as editing bots.json directly); the chat-facing /config get masks them.
  let env = '';
  try {
    const e = getBot(cachedLarkAppId).config.env;
    if (e && typeof e === 'object' && Object.keys(e).length) env = JSON.stringify(e, null, 2);
  } catch { /* none */ }
  // defaultWorkingDir — the "仅默认目录" mode source. Mutually exclusive with
  // defaultOncall in the dashboard 3-way selector; the frontend derives the
  // current mode from (defaultOncall.enabled ? oncall : defaultWorkingDir ? default : off).
  let defaultWorkingDir: string | null = null;
  let defaultWorkingDirAutoWorktree = false;
  try {
    const cfg = getBot(cachedLarkAppId).config;
    if (typeof cfg.defaultWorkingDir === 'string' && cfg.defaultWorkingDir.trim()) defaultWorkingDir = cfg.defaultWorkingDir;
    defaultWorkingDirAutoWorktree = cfg.defaultWorkingDirAutoWorktree === true;
  } catch { /* none */ }
  // 展示名编辑框数据：displayName = 自定义备注名（null = 未设，跟随飞书名称）；
  // larkBotName = 飞书探测到的应用名（供 placeholder /「恢复默认」提示用）。
  let displayName: string | null = null;
  let larkBotName: string | null = null;
  try {
    const bot = getBot(cachedLarkAppId);
    displayName = bot.config.displayName ?? null;
    larkBotName = bot.botName ?? null;
  } catch { /* none */ }
  jsonRes(res, 200, {
    larkAppId: cachedLarkAppId,
    botName: getBotName(),
    displayName,
    larkBotName,
    cliId,
    cliRuntime,
    cliPathOverride,
    wrapperCli,
    model,
    agentSelectionKey,
    defaultOncall: defaultOncall ?? { enabled: false, workingDir: '', since: 0 },
    defaultWorkingDir,
    defaultWorkingDirAutoWorktree,
    autoboundChatCount: autoboundChats.length,
    brandLabel: brandStore.getBotBrandLabel(cachedLarkAppId) ?? null,
    sandbox: sandboxStore.getBotSandbox(cachedLarkAppId),
    sandboxPaths: sandboxStore.getBotSandboxPaths(cachedLarkAppId) ?? null,
    readIsolation: sandboxStore.getBotReadIsolation(cachedLarkAppId),
    // Full enforceability (adapter support + no wrapperCli + macOS) — the UI
    // disables the toggle wherever the worker would fail-close on it.
    readIsolationSupported: readIsolationEnforceable(cachedLarkAppId),
    backendType: backendTypeStore.getBotBackendType(cachedLarkAppId) ?? null,
    usageDisplay: cardPrefs.usageDisplay,
    // Whether this bot's CLI can produce native usage at all. When false the
    // dashboard hides the usage-display control (offering it would be a knob
    // that is always empty — the CLI has no resolvable transcript).
    usageSupported: cliSupportsNativeUsage(cliId),
    disableStreamingCard: cardPrefs.disableStreamingCard,
    silentTurnReactions: cardPrefs.silentTurnReactions,
    codexAppCleanInput: cardPrefs.codexAppCleanInput,
    writableTerminalLinkInCard: cardPrefs.writableTerminalLinkInCard,
    privateCard: cardPrefs.privateCard,
    overloadAlert: cardPrefs.overloadAlert,
    botToBotSameDir: cardPrefs.botToBotSameDir,
    autoStartOnGroupJoin: cardPrefs.autoStartOnGroupJoin,
    autoStartOnGroupJoinPrompt: cardPrefs.autoStartOnGroupJoinPrompt,
    autoStartOnNewTopic: cardPrefs.autoStartOnNewTopic,
    regularGroupReplyMode: cardPrefs.regularGroupReplyMode,
    regularGroupMentionMode: cardPrefs.regularGroupMentionMode,
    substituteMode: substituteModeStore.getBotSubstituteMode(cachedLarkAppId) ?? null,
    docSubscribeDefaultMode: cardPrefs.docSubscribeDefaultMode,
    restrictGrantCommands: grantPrefs.restrictGrantCommands,
    autoGrantRequestCards: grantPrefs.autoGrantRequestCards,
    messageQuotaDefaultLimit: grantPrefs.messageQuotaDefaultLimit,
    grantDefaultDurationMs: grantPrefs.grantDefaultDurationMs,
    p2pMode,
    skillInjection,
    skillInjectionSupport,
    // Resolved machine-wide default → the dashboard shows it as the pre-selected
    // value when this bot has no explicit override (prompt/global/off).
    skillInjectionDefault: globalBuiltinSkillInjectionDefault(),
    maxLiveWorkers,
    logicalSessionCount,
    residentSessionCount,
    dormantSessionCount,
    startupCommands,
    customPassthroughCommands,
    canTalkDaemonCommands,
    launchShell: getBot(cachedLarkAppId).config.launchShell ?? '',
    env,
    riff: redactRiffForClient(getBot(cachedLarkAppId).config.riff),
    summaryRange: summaryRangeFromBotConfig(getBot(cachedLarkAppId).config),
    skills: getBot(cachedLarkAppId).config.skills ?? null,
  });
});

// Per-bot card-behaviour toggles. Body may carry any subset of booleans; only
// present keys are applied.
ipcRoute('PUT', '/api/bot-card-prefs', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: {
    usageDisplay?: unknown;
    disableStreamingCard?: unknown; silentTurnReactions?: unknown; codexAppCleanInput?: unknown; writableTerminalLinkInCard?: unknown; privateCard?: unknown;
    botToBotSameDir?: unknown;
    autoStartOnGroupJoin?: unknown; autoStartOnGroupJoinPrompt?: unknown; autoStartOnNewTopic?: unknown;
    regularGroupReplyMode?: unknown; regularGroupMentionMode?: unknown; docSubscribeDefaultMode?: unknown;
    overloadAlert?: unknown; summaryMemory?: unknown; summaryMemoryPath?: unknown;
  };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const patch: {
    usageDisplay?: UsageDisplayMode;
    disableStreamingCard?: boolean; silentTurnReactions?: boolean; codexAppCleanInput?: boolean; writableTerminalLinkInCard?: boolean; privateCard?: boolean;
    botToBotSameDir?: boolean;
    autoStartOnGroupJoin?: boolean; autoStartOnGroupJoinPrompt?: string; autoStartOnNewTopic?: boolean;
    regularGroupReplyMode?: ChatReplyMode; regularGroupMentionMode?: 'always' | 'topic' | 'never' | 'ambient';
    docSubscribeDefaultMode?: 'mention-only' | 'all';
    overloadAlert?: boolean; summaryMemory?: boolean; summaryMemoryPath?: string;
  } = {};
  if (body.usageDisplay === 'streaming' || body.usageDisplay === 'footer' || body.usageDisplay === 'off') patch.usageDisplay = body.usageDisplay;
  if (typeof body.disableStreamingCard === 'boolean') patch.disableStreamingCard = body.disableStreamingCard;
  if (typeof body.botToBotSameDir === 'boolean') patch.botToBotSameDir = body.botToBotSameDir;
  if (typeof body.silentTurnReactions === 'boolean') patch.silentTurnReactions = body.silentTurnReactions;
  if (typeof body.codexAppCleanInput === 'boolean') patch.codexAppCleanInput = body.codexAppCleanInput;
  if (typeof body.writableTerminalLinkInCard === 'boolean') patch.writableTerminalLinkInCard = body.writableTerminalLinkInCard;
  if (typeof body.privateCard === 'boolean') patch.privateCard = body.privateCard;
  if (typeof body.overloadAlert === 'boolean') patch.overloadAlert = body.overloadAlert;
  if (typeof body.summaryMemory === 'boolean') patch.summaryMemory = body.summaryMemory;
  if (typeof body.summaryMemoryPath === 'string') patch.summaryMemoryPath = body.summaryMemoryPath;
  if (typeof body.autoStartOnGroupJoin === 'boolean') patch.autoStartOnGroupJoin = body.autoStartOnGroupJoin;
  if (typeof body.autoStartOnGroupJoinPrompt === 'string') patch.autoStartOnGroupJoinPrompt = body.autoStartOnGroupJoinPrompt;
  if (typeof body.autoStartOnNewTopic === 'boolean') patch.autoStartOnNewTopic = body.autoStartOnNewTopic;
  if (typeof body.regularGroupReplyMode === 'string') {
    const m = normalizeChatReplyMode(body.regularGroupReplyMode);
    if (m) patch.regularGroupReplyMode = m;
  }
  if (body.regularGroupMentionMode === 'always' || body.regularGroupMentionMode === 'topic' || body.regularGroupMentionMode === 'never' || body.regularGroupMentionMode === 'ambient') {
    patch.regularGroupMentionMode = body.regularGroupMentionMode;
  }
  if (body.docSubscribeDefaultMode === 'mention-only' || body.docSubscribeDefaultMode === 'all') {
    patch.docSubscribeDefaultMode = body.docSubscribeDefaultMode;
  }
  if (Object.keys(patch).length === 0) return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });

  const r = await cardPrefsStore.updateBotCardPrefs(cachedLarkAppId, patch);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, ...r.prefs });
});

ipcRoute('PUT', '/api/bot-substitute-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const rec = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  // Resolve the submitted email / union_id entries into runtime-matchable
  // open_ids (+ fresh display names) using this bot's own credentials before
  // persisting; unresolvable entries are dropped but reported back for the UI.
  const { targets, resolution } = await substituteModeStore.resolveSubstituteTargets(
    cachedLarkAppId,
    rec.targets,
    { resolveRaw: resolveAllowedUsersWithMap, getProfile: getUserProfileStrict },
  );
  const chats = Array.isArray(rec.chats)
    ? [...new Set(rec.chats.map(String).map(s => s.trim()).filter(Boolean))]
    : [];
  const excludedChats = Array.isArray(rec.excludedChats)
    ? [...new Set(rec.excludedChats.map(String).map(s => s.trim()).filter(Boolean))]
    : [];
  const r = await substituteModeStore.updateBotSubstituteMode(cachedLarkAppId, {
    enabled: rec.enabled === true,
    targets,
    disclosure: rec.disclosure === 'none' ? 'none' : 'prefix',
    replyMode: rec.replyMode === 'quote' ? 'quote' : 'thread',
    disableControlCard: rec.disableControlCard === true,
    ...(chats.length ? { chats } : {}),
    ...(excludedChats.length ? { excludedChats } : {}),
    // 话题群开关：显式 false 才关（旧客户端不带字段 → normalize 缺省开）。
    topicGroups: rec.topicGroups,
    topicActiveSessionTrigger: rec.topicActiveSessionTrigger,
  });
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason, resolution });
  jsonRes(res, 200, { ok: true, substituteMode: r.substituteMode, resolution });
});

// Preview resolution for a single substitute target without persisting anything.
// Used by the dashboard to auto-fill name/avatar while the user is typing.
ipcRoute('POST', '/api/bot-substitute-targets/resolve', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const rec = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const target = rec.target && typeof rec.target === 'object' && !Array.isArray(rec.target) ? rec.target : {};
  const { resolution } = await substituteModeStore.resolveSubstituteTargets(
    cachedLarkAppId,
    [target],
    { resolveRaw: resolveAllowedUsersWithMap, getProfile: getUserProfileStrict },
  );
  jsonRes(res, 200, { ok: true, resolution: resolution[0] ?? null });
});

// Per-bot explicit `/summary` history range. Body `{ limit, sinceHours }`.
ipcRoute('PUT', '/api/bot-summary-range', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const r = await updateDashboardSummaryRange(cachedLarkAppId, raw);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, summaryRange: r.summaryRange });
});

// Backward-compatible dashboard endpoint from the short-lived keyword-trigger UI.
ipcRoute('PUT', '/api/bot-summary-trigger', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const body = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { limit: (raw as Record<string, unknown>).limit, sinceHours: (raw as Record<string, unknown>).sinceHours }
    : raw;
  const r = await updateDashboardSummaryRange(cachedLarkAppId, body);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, summaryRange: r.summaryRange });
});

// Per-bot 授权偏好。Body 任意子集：
//   • restrictGrantCommands: boolean       — 限制被授权人只能纯对话
//   • autoGrantRequestCards: boolean       — 未授权 @ 被挡住时是否发 grant 申请卡
//   • messageQuotaDefaultLimit: number|null — 卡片/Oncall 额度覆盖（null = 卡片内置 3 条、Oncall 不限）
//   • grantDefaultDurationMs: number|null   — 新授权默认有限时长（null = 产品默认 1 小时）
ipcRoute('PUT', '/api/bot-grant-prefs', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  // 顶层必须是对象：JSON `null` / 数字 / 字符串等都拒（null 解引用会抛 → 500）。
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });
  }
  const body = raw as {
    restrictGrantCommands?: unknown;
    autoGrantRequestCards?: unknown;
    messageQuotaDefaultLimit?: unknown;
    grantDefaultDurationMs?: unknown;
  };

  const patch: {
    restrictGrantCommands?: boolean;
    autoGrantRequestCards?: boolean;
    messageQuotaDefaultLimit?: number | null;
    grantDefaultDurationMs?: number | null;
  } = {};
  if (typeof body.restrictGrantCommands === 'boolean') patch.restrictGrantCommands = body.restrictGrantCommands;
  if (typeof body.autoGrantRequestCards === 'boolean') patch.autoGrantRequestCards = body.autoGrantRequestCards;
  // null（含 JSON null）= 恢复内置额度策略；number = 设定覆盖值（store 内校验 1–1000）。
  if (body.messageQuotaDefaultLimit === null) patch.messageQuotaDefaultLimit = null;
  else if (typeof body.messageQuotaDefaultLimit === 'number') patch.messageQuotaDefaultLimit = body.messageQuotaDefaultLimit;
  // null = 恢复产品默认 1 小时；number 由 store 按卡片有限选项白名单校验。
  if (body.grantDefaultDurationMs === null) patch.grantDefaultDurationMs = null;
  else if (typeof body.grantDefaultDurationMs === 'number') patch.grantDefaultDurationMs = body.grantDefaultDurationMs;
  if (Object.keys(patch).length === 0) return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });

  const r = await grantPrefsStore.updateBotGrantPrefs(cachedLarkAppId, patch);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, ...r.prefs });
});

// Per-bot card footer brand label. Body `{ brandLabel: string | null }`:
//   • string (incl. '')  → store verbatim ('' = brand off)
//   • null / absent      → clear the key (revert to default botmux brand)
ipcRoute('PUT', '/api/bot-brand-label', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { brandLabel?: unknown };
  try { body = await readJsonBody<{ brandLabel?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const next: string | null = typeof body.brandLabel === 'string' ? body.brandLabel : null;
  const r = await brandStore.updateBotBrandLabel(cachedLarkAppId, next);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, brandLabel: r.brandLabel });
});

// 机器人改名（dashboard 档案头 ✎ 入口）。Body `{ name: string }`。
// 主路径：daemon 注册的 renamer 走开放平台自动化真改飞书应用名（改基础信息 +
// 建版发布，群内显示名生效）；失败（Web 登录态过期 / 非协作者 / lark 租户等）
// 自动降级为仅改 botmux 展示名 displayName，并把原因作为 warning 返回给前端。
// 响应：{ ok, mode: 'feishu'|'local', botName, warning?, message? }。
ipcRoute('PUT', '/api/bot-rename', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { name?: unknown };
  try { body = await readJsonBody<{ name?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('displayName');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.name === 'string' ? body.name.trim() : '';
  if (!raw) return jsonRes(res, 400, { ok: false, error: 'name_required' });
  // 长度等校验与 IM /config 入口共用（字段 spec 的 maxLen，coerceConfigValue 执行）。
  const c = coerceConfigValue(spec, raw);
  if (!c.ok) return jsonRes(res, 400, { ok: false, error: c.reason });
  const name = c.value as string;

  // 主路径：开放平台真改名（daemon 注册；成功时 daemon 侧已同步 botName /
  // descriptor / bots-info 并清掉冗余的 displayName）。
  if (botRenamer) {
    let renamed: BotRenameOutcome;
    try {
      renamed = await botRenamer(name);
    } catch (err) {
      renamed = { ok: false, reason: 'api_error', message: err instanceof Error ? err.message : String(err) };
    }
    if (renamed.ok) {
      return jsonRes(res, 200, { ok: true, mode: 'feishu', botName: getBotName() });
    }
    // 降级：仅改 botmux 展示名，带上飞书侧失败原因让前端明示。
    const fallback = await applyConfigField(cachedLarkAppId, spec, name);
    if (!fallback.ok) return jsonRes(res, 400, { ok: false, error: fallback.reason, warning: renamed.reason, message: renamed.message });
    return jsonRes(res, 200, { ok: true, mode: 'local', botName: getBotName(), warning: renamed.reason, message: renamed.message });
  }

  // 无 renamer（daemon 未注册，理论上只在测试环境出现）→ 直接走本地展示名。
  const r = await applyConfigField(cachedLarkAppId, spec, name);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, mode: 'local', botName: getBotName(), warning: 'renamer_not_wired' });
});

// 机器人改头像（dashboard 档案头头像入口）。Body `{ imageBase64: string }`——
// 512×512 PNG 的 base64（可带 data URL 前缀，前端 canvas 归一化产出）。走开放
// 平台自动化真改飞书应用头像（上传图片 + 改基础信息 + 建版发布，群内头像生效）。
// 头像没有本地降级等价物：失败直接把结构化原因返回（no_session / session_expired
// 时前端引导扫码重登）。响应：{ ok, avatarUrl?, versionId? } | { ok:false, error, message }。
ipcRoute('PUT', '/api/bot-avatar', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { imageBase64?: unknown } | null;
  try { body = await readJsonBody<{ imageBase64?: unknown } | null>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  // JSON 顶层可以是 null / 数组 / 标量——属性访问前先收窄成普通对象（400 而非 500）。
  const rawB64 = typeof body?.imageBase64 === 'string'
    ? body.imageBase64.replace(/^data:image\/[a-z+.-]+;base64,/i, '').trim()
    : '';
  if (!rawB64) return jsonRes(res, 400, { ok: false, error: 'image_required' });
  // 512×512 PNG 远小于此上限；超出即拒，避免把任意大 payload 灌进 console 上传。
  if (rawB64.length > 3_000_000) return jsonRes(res, 413, { ok: false, error: 'image_too_large' });
  const image = Buffer.from(rawB64, 'base64');

  if (!botAvatarChanger) return jsonRes(res, 501, { ok: false, error: 'avatar_not_wired' });
  let changed: BotAvatarOutcome;
  try {
    changed = await botAvatarChanger(image);
  } catch (err) {
    changed = { ok: false, reason: 'api_error', message: err instanceof Error ? err.message : String(err) };
  }
  if (changed.ok) {
    return jsonRes(res, 200, { ok: true, avatarUrl: changed.avatarUrl, versionId: changed.versionId });
  }
  // invalid_image 是调用方参数问题（4xx），其余是飞书侧/环境失败（502）。
  const status = changed.reason === 'invalid_image' ? 400 : 502;
  jsonRes(res, status, { ok: false, error: changed.reason, message: changed.message });
});

// Per-bot agent launch settings. Body `{ cliId, model, cliRuntime? }` where `cliId` is the
// dashboard selection key (plain adapter id or a wrapper option such as
// `ttadk-x-codex`). Changes affect the next spawned CLI session; existing
// sessions frozen on a different cliId/wrapperCli are closed immediately, so
// a later lazy resume can't resurrect the old CLI (#346 covered the restart
// path; this covers the hot-switch path).
ipcRoute('PUT', '/api/bot-agent', async (req, res) => {
  let body: {
    cliId?: unknown;
    model?: unknown;
    cliRuntime?: unknown;
    operationId?: unknown;
  } & Record<string, unknown>;
  try {
    body = await readJsonBody<typeof body>(req);
  }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const operationId = sessionOperationId(req, body);
  if (!operationId.ok) return jsonRes(res, 400, { ok: false, error: operationId.error });
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });

  const key = typeof body.cliId === 'string' && body.cliId.trim() ? body.cliId.trim() : '';
  if (!key) return jsonRes(res, 400, { ok: false, error: 'cli_required' });
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const runtimeFieldPresent = Object.prototype.hasOwnProperty.call(body, 'cliRuntime');
  const maintenance = dashboardHostMaintenance;
  if (!maintenance) {
    return jsonRes(res, 503, { ok: false, error: 'session_runtime_not_ready' });
  }
  const outcome = await maintenance.changeAgent({
    operationId: operationId.value,
    cliId: key,
    model,
    cliRuntimePresent: runtimeFieldPresent,
    cliRuntime: body.cliRuntime,
  });
  if (outcome.kind === 'completed') return jsonRes(res, 200, outcome.response);
  if (outcome.kind === 'conflict') {
    return jsonRes(res, 409, {
      ok: false,
      error: 'idempotency_conflict',
      message: outcome.message,
    });
  }
  if (outcome.kind === 'blocked') {
    return jsonRes(res, 409, {
      ok: false,
      error: outcome.error,
      blockingSessions: outcome.blockingSessions,
    });
  }
  if (outcome.kind === 'invalid') {
    return jsonRes(res, 400, {
      ok: false,
      error: outcome.error,
      ...(outcome.message ? { message: outcome.message } : {}),
    });
  }
  return jsonRes(res, 503, {
    ok: false,
    error: outcome.error,
    message: outcome.message,
  });
});

// Per-bot 私聊单聊模式 p2pMode。Body `{ p2pMode: 'chat' | 'thread' }`:
//   • 'chat'（默认）    → 私聊走扁平连续 chat-scope 会话
//   • 'thread'          → 显式回到每条 DM 独立 thread-scope 会话
// 走 applyConfigField（与 /botconfig 同一写盘 + 热更新路径），保证一致。
ipcRoute('PUT', '/api/bot-p2p-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { p2pMode?: unknown };
  try { body = await readJsonBody<{ p2pMode?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('p2pMode');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  // 只有 'thread' 有意义；其它（含 'chat'，新默认)一律清回默认，bots.json 保持干净。
  const value = body.p2pMode === 'thread' ? 'thread' : null;
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, p2pMode: value ?? 'chat' });
});

// Per-bot 内置技能注入模式 skillInjection。Body `{ skillInjection: 'global'|'prompt'|'off'|'' }`:
//   • 'global'|'prompt'|'off' → 显式覆盖本 bot
//   • ''/其它                  → 清回机器级默认（config.json skills.builtinInjection）
// 走 applyConfigField（与 /config 同一写盘 + 热更新路径）。next-session 生效；
// 切到/离开 global 的全局盘安装受 once-cache 限，需重启 daemon 才完全生效。
ipcRoute('PUT', '/api/bot-skill-injection', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { skillInjection?: unknown };
  try { body = await readJsonBody<{ skillInjection?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('skillInjection');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const v = body.skillInjection;
  const value = v === 'global' || v === 'prompt' || v === 'off' ? v : null;
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, skillInjection: value });
});

// Per-bot 启动命令 startupCommands。Body `{ startupCommands: string }`（原始文本，
// 逗号/换行分隔，每条可带参数如 `/effort ultracode`）：空白 → 清除（不发任何命令）。
// 走 applyConfigField（与 /botconfig 文本子卡同一写盘 + 内存热更新路径），next-session
// 生效（下个会话起按序自动发）。
ipcRoute('PUT', '/api/bot-startup-commands', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { startupCommands?: unknown };
  try { body = await readJsonBody<{ startupCommands?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('startupCommands');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.startupCommands === 'string' ? body.startupCommands : '';
  let value: string[] | null;
  if (!raw.trim()) {
    value = null;  // 清除
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string[];
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, startupCommands: (value ?? []).join('\n') });
});

// Per-bot 透传 slash 命令 customPassthroughCommands。Body `{ customPassthroughCommands: string }`
// （原始文本，逗号/空格分隔；空白＝清除→回仅内置白名单）。走 stringList 的
// coerceConfigValue（用字段自带 parseList，与 /botconfig 同口径）+ applyConfigField
// （写盘 + 内存热更新），immediate 生效。回包 space-joined 供输入框回填。
ipcRoute('PUT', '/api/bot-custom-passthrough', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { customPassthroughCommands?: unknown };
  try { body = await readJsonBody<{ customPassthroughCommands?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('customPassthroughCommands');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.customPassthroughCommands === 'string' ? body.customPassthroughCommands : '';
  let value: string[] | null;
  if (!raw.trim()) {
    value = null;  // 清除 → 回仅内置白名单
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string[];
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, customPassthroughCommands: (value ?? []).join(' ') });
});

// Per-bot daemon 命令降权名单 canTalkDaemonCommands。Body
// `{ canTalkDaemonCommands: string }`（原始文本，逗号/空格分隔；空白＝清除→回全部
// 仅管理员）。走 stringList 的 coerceConfigValue（字段自带 parseList 只认 daemon
// 命令，透传/拼错条目被滤掉）+ applyConfigField（写盘 + 内存热更新），immediate 生效。
ipcRoute('PUT', '/api/bot-cantalk-daemon-commands', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { canTalkDaemonCommands?: unknown };
  try { body = await readJsonBody<{ canTalkDaemonCommands?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('canTalkDaemonCommands');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.canTalkDaemonCommands === 'string' ? body.canTalkDaemonCommands : '';
  let value: string[] | null;
  if (!raw.trim()) {
    value = null;  // 清除 → 回全部仅管理员
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string[];
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, canTalkDaemonCommands: (value ?? []).join(' ') });
});

// Per-bot launch-shell override launchShell。Body `{ launchShell: string }`：
// 空字符串＝清除（回 $SHELL）。走 applyConfigField（与 /config launchShell 同一写盘
// + 内存热更新路径），next-session 生效（下个会话起用新 shell 启动 CLI）。
ipcRoute('PUT', '/api/bot-launch-shell', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { launchShell?: unknown };
  try { body = await readJsonBody<{ launchShell?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('launchShell');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.launchShell === 'string' ? body.launchShell : '';
  let value: string | null;
  if (!raw.trim()) {
    value = null;  // 清除 → 回 $SHELL
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, launchShell: value ?? '' });
});

// Per-bot 环境变量 env。Body `{ env: string }`（原始 JSON 文本，如
// `{"ANTHROPIC_BASE_URL":"…","ANTHROPIC_AUTH_TOKEN":"…"}` 让本 bot 走 GLM/第三方
// 服务商）：空白 → 清除；否则按 json kind 解析 + sanitizePerBotEnv 过滤后落盘。
// 走 applyConfigField（与 /botconfig 同一写盘 + 内存热更新路径），next-session 生效
// （下个会话起注入到 CLI 进程）。回包返回脱敏后的 pretty JSON 供 textarea 回填。
ipcRoute('PUT', '/api/bot-env', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { env?: unknown };
  try { body = await readJsonBody<{ env?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('env');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.env === 'string' ? body.env : '';
  let value: Record<string, string> | null;
  if (!raw.trim()) {
    value = null;  // 清除
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as Record<string, string>;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, env: value ? JSON.stringify(value, null, 2) : '' });
});

// Per-bot riff 后端配置。Body `{ riff: string }`（原始 JSON 文本，如
// `{"baseUrl":"https://...","model":"gpt-5.5","reasoningEffort":"high"}`）：
// 空白 → 清除；否则按 json kind 解析后落盘。走 applyConfigField（与 /botconfig
// 同一写盘 + 内存热更新路径），next-session 生效。仅 backendType=riff 时使用。
/** riff 配置里 dashboard 可编辑的字段——PUT /bot-riff 只覆盖这些，其余保留。 */
// injectStatusLines 已从 dashboard UI 移除（恒默认开启）——不在此集合中意味着
// 存量 bots.json 值按「隐藏字段」原样保留。
const RIFF_UI_EDITABLE_KEYS = new Set(['baseUrl', 'sandboxCluster', 'model', 'reasoningEffort', 'jwtEnv', 'systemPrompt', 'setupCommands']);

/** 发给浏览器前脱敏：明文 jwt / env（可能含各类密钥）绝不进 dashboard 响应。 */
function redactRiffForClient(riff: unknown): Record<string, unknown> | null {
  if (!riff || typeof riff !== 'object') return null;
  const { jwt: _jwt, env: _env, ...safe } = riff as Record<string, unknown>;
  return safe;
}

ipcRoute('PUT', '/api/bot-riff', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { riff?: unknown };
  try { body = await readJsonBody<{ riff?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('riff');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.riff === 'string' ? body.riff : '';
  let value: Record<string, unknown> | null;
  if (!raw.trim()) {
    value = null;  // 清除（显式清空整份 riff 配置，含隐藏字段）
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as Record<string, unknown>;
    // 合并保存：dashboard 只回写 UI 展示的字段；接口支持但 UI 未展示的字段
    // （templateId / jwt / env / logLevel / repos…）必须原样保留，否则用户只改
    // 一个 model 就会静默删掉认证等隐藏配置。
    const prev = (getBot(cachedLarkAppId).config.riff ?? {}) as Record<string, unknown>;
    const preserved = Object.fromEntries(Object.entries(prev).filter(([k]) => !RIFF_UI_EDITABLE_KEYS.has(k)));
    // Older dashboard clients do not send sandboxCluster. Preserve a valid
    // existing selection for them; a brand-new config follows Riff's BOE
    // default. New clients always submit the explicit dropdown value.
    const sandboxCluster = value.sandboxCluster ?? prev.sandboxCluster ?? 'boe';
    if (!isValidRiffSandboxCluster(sandboxCluster)) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_sandbox_cluster' });
    }
    value = { ...preserved, ...value, sandboxCluster };
    if (!isValidRiffBaseUrl(value.baseUrl)) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_base_url' });
    }
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, riff: value ? JSON.stringify(redactRiffForClient(value), null, 2) : '' });
});

// Per-bot 最大同时活跃会话数 maxLiveWorkers。Body `{ maxLiveWorkers: number | null }`:
//   • 正整数  → 设上限；超过后 idle-worker sweeper 把最久未用的会话休眠到上限内
//   • null    → 清除（回落到内置默认 30）
// 走 applyConfigField（与 /config 同一写盘 + 内存热更新路径）：sweeper 每分钟读
// 实时 bot.config.maxLiveWorkers，免重启即生效。
ipcRoute('PUT', '/api/bot-max-live-workers', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });
  }
  const body = raw as { maxLiveWorkers?: unknown };
  const spec = findConfigField('maxLiveWorkers');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });

  // null（含 JSON null）= 清除上限；number 走 coerce 校验正整数。
  let value: number | null;
  if (body.maxLiveWorkers === null || body.maxLiveWorkers === undefined) {
    value = null;
  } else {
    const c = coerceConfigValue(spec, body.maxLiveWorkers);
    if (!c.ok || typeof c.value !== 'number') return jsonRes(res, 400, { ok: false, error: 'invalid_number' });
    value = c.value;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, maxLiveWorkers: value });
});

// Per-bot skill policy. Dashboard uses this for attach/detach; JSON policy
// still shares the same applyConfigField path as /botconfig.
ipcRoute('PUT', '/api/bot-skills', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  const body = raw as { action?: unknown; name?: unknown; policy?: unknown };
  const spec = findConfigField('skills');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });

  const current = getBot(cachedLarkAppId).config.skills;
  let next = current;
  if (body.action === 'attach') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonRes(res, 400, { ok: false, error: 'name_required' });
    if (!readSkillRegistry().skills[name]) return jsonRes(res, 400, { ok: false, error: 'skill_not_installed' });
    next = attachSkillPolicy(current, name);
  } else if (body.action === 'detach') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonRes(res, 400, { ok: false, error: 'name_required' });
    next = detachSkillPolicy(current, name);
  } else if (body.action === 'set') {
    if (body.policy === null) {
      next = undefined;
    } else {
      const parsed = readBotSkillPolicy(body.policy);
      if (!parsed) return jsonRes(res, 400, { ok: false, error: 'invalid_policy' });
      next = parsed;
    }
  } else {
    return jsonRes(res, 400, { ok: false, error: 'invalid_action' });
  }

  const r = await applyConfigField(cachedLarkAppId, spec, next ?? null);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, skills: getBot(cachedLarkAppId).config.skills ?? null });
});

// Per-bot file-sandbox toggle. Body `{ enabled: boolean }`. When on, this bot's
// CLI sessions run inside a per-session bwrap file sandbox (Linux). For oncall
// bots shared with semi-trusted users.
ipcRoute('PUT', '/api/bot-sandbox', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { enabled?: unknown };
  try { body = await readJsonBody<{ enabled?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  // File-sandbox policy is frozen onto each Session at creation and reused on
  // restore; this toggle is intentionally next-session-only and cannot mutate
  // a live pane's profile.
  const r = await sandboxStore.updateBotSandbox(cachedLarkAppId, body.enabled === true);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, sandbox: r.sandbox });
});

// Per-bot sandboxPaths (three-tier whitelist: readWrite / readOnly / deny).
// Body `{ readWrite?: string[]; readOnly?: string[]; deny?: string[] }`. Highest-
// precedence layer of the FsPolicy — an empty/absent tier falls back to the
// deny-by-default baseline. Passing all-empty CLEARS the field. next-session
// 生效：running sessions keep their spawn-time policy, only new spawns re-read it.
ipcRoute('PUT', '/api/bot-sandbox-paths', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { readWrite?: unknown; readOnly?: unknown; deny?: unknown };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const asList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const r = await sandboxStore.updateBotSandboxPaths(cachedLarkAppId, {
    readWrite: asList(body.readWrite),
    readOnly: asList(body.readOnly),
    deny: asList(body.deny),
  });
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, sandboxPaths: r.sandboxPaths ?? null });
});

// Per-bot read-isolation toggle. Body `{ enabled: boolean }`. When on, this bot's
// CLI sessions run under macOS Seatbelt read-deny (siblings' creds/sessions/content
// unreadable). The macOS counterpart of the file sandbox above.
ipcRoute('PUT', '/api/bot-read-isolation', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const larkAppId = cachedLarkAppId;
  let body: { enabled?: unknown };
  try { body = await readJsonBody<{ enabled?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const enable = body.enabled === true;
  return withBotTurnMutation(larkAppId, async () => {
    // An idempotent request changes neither the durable policy nor any pane.
    // Return before pending/active/teardown guards so a dashboard refresh that
    // repeats the authoritative value cannot be rejected merely because the
    // bot is doing work.
    if (sandboxStore.getBotReadIsolation(larkAppId) === enable) {
      return jsonRes(res, 200, {
        ok: true,
        readIsolation: enable,
        suspendedSessions: 0,
        changed: false,
      });
    }
    // Close admission first and drain handlers that may already be awaiting
    // downloads/noteTurnReceived. Ledger preflight alone cannot see those
    // pre-accept turns; draining prevents a post-sweep send into a killed ds.
    const activeBotSessions = listActiveSessions().filter(ds => ds.larkAppId === larkAppId);
    // Registry state alone is insufficient: partial restore, an anchor
    // collision, or a failed staggered reattach can omit a durable active row
    // while its persistent pane still survives. Consult the same persisted
    // session source a restart will hydrate. Legacy unscoped active rows are
    // conservatively treated as this daemon's until explicitly closed.
    const persistedBotSessions = sessionStore.listSessions().filter(session =>
      session.larkAppId === larkAppId || !session.larkAppId,
    );
    const persistedActiveBotSessions = persistedBotSessions.filter(session =>
      session.status === 'active',
    );
    if (rejectProtectedSessionMutation(res, [
      ...activeBotSessions,
      ...persistedActiveBotSessions,
    ])) return;
    // Crash-transactional safety boundary: bots.json is the restart source of
    // truth, while a live tmux/herdr/zellij pane retains its old in-memory
    // Seatbelt profile. Persisting the new flag before tearing those panes down
    // creates an unrecoverable crash window because the restart path cannot
    // prove which exact read/write isolation profile a surviving pane runs.
    // Require explicit close first; with no active logical session there is no
    // owned pane a restart can reattach under the newly persisted policy.
    if (activeBotSessions.length > 0 || persistedActiveBotSessions.length > 0) {
      return jsonRes(res, 409, {
        ok: false,
        error: 'read_isolation_active_sessions',
      });
    }
    // `/close` intentionally returns after sending worker close IPC and marking
    // the row closed; persistent-pane destruction can lag. A closed row's pid
    // is deliberately not probed: PID alone has no birth identity and may have
    // been reused by an unrelated process. closeSession clears it atomically.
    // For current rows, the stamped persistent backend is the teardown proof.
    // Pre-stamp closed rows are not synchronously probed across three CLIs here:
    // that legacy shell fan-out blocks the daemon event loop, while any active
    // legacy row has already failed the active-session guard above.
    for (const session of persistedBotSessions) {
      if (session.adoptedFrom || session.title?.startsWith('Adopt:')) continue;
      const backendTypes: persistentBackend.PersistentBackendType[] =
        persistentBackend.isSuspendableBackendType(session.backendType)
          ? [session.backendType]
          : [];
      for (const backendType of backendTypes) {
        const backingName = persistentBackend.persistentSessionName(
          backendType,
          session.sessionId,
        );
        if (persistentBackend.probePersistentSession(backendType, backingName) !== 'missing') {
          return jsonRes(res, 409, {
            ok: false,
            error: 'read_isolation_teardown_unverified',
          });
        }
      }
    }
    // The worker FAIL-CLOSES (refuses to start the session) for a configured
    // readIsolation that cannot be enforced. Check this after the active-session
    // safety boundary so even an unsupported enable cannot obscure a surviving
    // old-policy pane with a less important validation error.
    if (enable && !readIsolationEnforceable(larkAppId)) {
      return jsonRes(res, 400, { ok: false, error: 'read_isolation_unenforceable' });
    }
    // With the gate closed and no active logical session, persistence is the
    // only mutation. updateBotReadIsolation writes bots.json atomically and
    // then publishes the same value to the daemon runtime before resolving.
    // A crash at any point can only lead to a cold spawn under the old or new
    // durable policy; there is no owned pane to reattach.
    const r = await sandboxStore.updateBotReadIsolation(larkAppId, enable);
    if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
    jsonRes(res, 200, {
      ok: true,
      readIsolation: r.readIsolation,
      suspendedSessions: 0,
      changed: true,
    });
  });
});

// Per-bot session backend override (pty | tmux | herdr | zellij | zmx), or clear it
// ('' / 'auto' / null → follow the daemon default). next-session 生效：running
// sessions keep their spawn-time backend (Session.backendType stamp), only new
// spawns read the new value — so switching here can't strand live sessions.
ipcRoute('PUT', '/api/bot-backend-type', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { backendType?: unknown };
  try { body = await readJsonBody<{ backendType?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const raw = body.backendType;
  let next: BackendType | null;
  if (raw == null || raw === '' || raw === 'auto') next = null;
  else if (backendTypeStore.isEditableBackendType(raw)) next = raw;
  else return jsonRes(res, 400, { ok: false, error: 'invalid_backendType' });
  const effectiveBackendType = next ?? config.daemon.backendType;
  const availability = await ensureBackendAvailable(effectiveBackendType);
  if (!availability.ok) {
    return jsonRes(res, 409, {
      ok: false,
      error: 'backend_unavailable',
      backendType: effectiveBackendType,
      reason: availability.reason,
      manualCommand: availability.manualCommand,
    });
  }
  const r = await backendTypeStore.updateBotBackendType(cachedLarkAppId, next);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, backendType: r.backendType, effectiveBackendType, version: availability.version });
});

// 实时切换 UI 语言（locale），无需重启 daemon。`botmux lang` / Dashboard 语言开关
// 写盘后 POST 这个端点，让本 daemon 从磁盘重新读 locale 并热更新：
//   • 全局默认（~/.botmux/config.json 的 `lang`）→ setDefaultLocale（缺省回落 'zh'）；
//   • 本 bot 的 per-bot 覆盖（bots.json 的 `lang`）→ 同步进内存 bot.config.lang
//     （与 applyConfigField 同口径），让 `botmux lang --bot N` 跨进程写入也免重启。
// 卡片都在 daemon 端按消息实时渲染（localeForBot），所以下一条消息/卡片立即生效。
// 文件是单一事实源，本端点只是“立即重读”信号——不在此落盘（写入方已落盘）。
ipcRoute('POST', '/api/locale/reload', async (_req, res) => {
  const globalLang = readGlobalConfig().lang;
  const resolvedDefault: Locale = isLocale(globalLang) ? globalLang : 'zh';
  setDefaultLocale(resolvedDefault);

  let botLang: Locale | null = null;
  if (cachedLarkAppId) {
    try {
      const raw = await readRawConfig(requireConfigPath());
      const idx = findEntryIndex(raw, cachedLarkAppId);
      const entryLang = idx >= 0 ? raw[idx]?.lang : undefined;
      botLang = isLocale(entryLang) ? entryLang : null;
      getBot(cachedLarkAppId).config.lang = botLang ?? undefined;
    } catch { /* bot 未注册 / 读盘失败：全局已应用，per-bot 维持原值 */ }
  }

  // Push the resolved locale to this bot's live workers too. Cards render on the
  // daemon (already switched above), but a few user-facing strings originate in
  // the worker process (submit notices, CoCo adopt notes) — without this they'd
  // stay in the spawn-time language until the session restarts.
  const workerLocale: Locale = botLang ?? resolvedDefault;
  const reg = getActiveSessionsRegistry();
  if (cachedLarkAppId && reg) {
    for (const ds of reg.values()) {
      if (ds.larkAppId !== cachedLarkAppId || !ds.worker || ds.worker.killed) continue;
      try { ds.worker.send({ type: 'set_locale', locale: workerLocale }); } catch { /* worker gone */ }
    }
  }

  jsonRes(res, 200, { ok: true, defaultLocale: resolvedDefault, botLang });
});

// Hot-reload the current daemon's per-bot config from bots.json after another
// process edits the shared config file. Keep the live Lark client / resolved
// allowlist intact; VC listener routing only needs the vcMeetingAgent block.
ipcRoute('POST', '/api/bot-config/reload', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  try {
    const latest = loadBotConfigs().find(bot => bot.larkAppId === cachedLarkAppId);
    if (!latest) return jsonRes(res, 404, { ok: false, error: 'bot_not_in_config' });
    getBot(cachedLarkAppId).config.vcMeetingAgent = latest.vcMeetingAgent;
    jsonRes(res, 200, { ok: true, larkAppId: cachedLarkAppId, vcMeetingAgentEnabled: latest.vcMeetingAgent?.enabled === true });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: err?.message ?? String(err) });
  }
});

ipcRoute('PUT', '/api/bot-default-oncall', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { enabled?: unknown; workingDir?: unknown };
  try { body = await readJsonBody<{ enabled?: boolean; workingDir?: string }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const enabled = body.enabled === true;
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';

  // Validate workingDir when enabling. Allow blank workingDir only when
  // disabling — the on-disk record keeps the last value so the UI can
  // round-trip after a disable.
  let resolvedPath = '';
  if (enabled) {
    if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });
    const v = validateWorkingDir(workingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    resolvedPath = v.resolvedPath;
  }

  const r = await oncallStore.updateBotDefaultOncall(cachedLarkAppId, { enabled, workingDir });
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, defaultOncall: r.defaultOncall, resolvedPath: resolvedPath || undefined });
});

// Per-bot「默认工作目录模式」三选一（dashboard 单选；两个底层字段互斥）：
//   • off     → 清 defaultWorkingDir + 关 defaultOncall（新会话弹「选仓库」卡）
//   • default → 写 defaultWorkingDir + 关 defaultOncall（钉目录、跳过选仓库、不改权限）
//   • oncall  → 开 defaultOncall(+dir) + 清 defaultWorkingDir（新群自动绑+开放对话；
//               该目录经 resolveBotDefaultWorkingDir 的 layer-4 兜底覆盖该 bot 所有会话）
// 两字段在 oncallStore.setWorkingDirMode 的**同一个 rmwBotEntry 锁内**一次性原子写盘 +
// 同步内存：否则两个并发请求分别加锁写各自字段会交错，最终留下 defaultOncall.enabled 与
// defaultWorkingDir 同时存在的不一致态（GET/前端按 enabled 显示 oncall，但 runtime 的
// effectiveDefaultWorkingDir 优先用 defaultWorkingDir → UI 与实际目录背离；PR #311 Codex 评审）。
// next-session 生效（运行中会话需 /restart）。
ipcRoute('PUT', '/api/bot-working-dir-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { mode?: unknown; workingDir?: unknown; autoWorktree?: unknown };
  try { body = await readJsonBody<{ mode?: unknown; workingDir?: unknown; autoWorktree?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const mode = body.mode;
  if (mode !== 'off' && mode !== 'default' && mode !== 'oncall') {
    return jsonRes(res, 400, { ok: false, error: 'invalid_mode' });
  }
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';
  // 「仅默认目录」模式下的「自动创建 worktree」开关；其余模式 setWorkingDirMode 会强制清掉。
  const autoWorktree = body.autoWorktree === true;

  // 非「关闭」模式必须给一个真实存在的目录。
  let resolvedPath = '';
  if (mode !== 'off') {
    if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });
    const v = validateWorkingDir(workingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    resolvedPath = v.resolvedPath;
  }

  const r = await oncallStore.setWorkingDirMode(cachedLarkAppId, mode, workingDir, autoWorktree);
  if (!r.ok) return jsonRes(res, 400, r);
  return jsonRes(res, 200, {
    ok: true, mode,
    defaultWorkingDir: r.defaultWorkingDir,
    defaultWorkingDirAutoWorktree: r.defaultWorkingDirAutoWorktree,
    defaultOncall: r.defaultOncall,
    resolvedPath: resolvedPath || undefined,
  });
});

// Create a brand-new chat with this bot as creator/owner and `larkAppIds` as
// initial bot members. The dashboard's public route picks any online daemon
// to act as creator, then forwards here.
ipcRoute('POST', '/api/groups/create', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: {
    name?: unknown;
    larkAppIds?: unknown;
    userOpenIds?: unknown;
    ownerUnionIds?: unknown;
    transferOwnerUnionId?: unknown;
    transferOwnerTo?: unknown;
    notifyOwnerOpenId?: unknown;
    bindWorkingDir?: unknown;
    roleProfileId?: unknown;
  };
  try {
    body = await readJsonBody<{
      name?: string;
      larkAppIds?: string[];
      userOpenIds?: string[];
      ownerUnionIds?: string[];
      transferOwnerUnionId?: string;
      transferOwnerTo?: string;
      notifyOwnerOpenId?: string;
      bindWorkingDir?: string;
      roleProfileId?: string;
    }>(req);
  } catch {
    return jsonRes(res, 400, { error: 'bad_json' });
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  if (!Array.isArray(body.larkAppIds) || !body.larkAppIds.every(x => typeof x === 'string')) {
    return jsonRes(res, 400, { error: 'larkAppIds_required' });
  }
  // userOpenIds, transferOwnerTo, notifyOwnerOpenId are optional; pre-validated
  // upstream by the dashboard route. All open_ids MUST be in the calling bot's
  // app scope (caller is responsible — Lark open_ids are app-scoped, see
  // dashboard/operator-selector.ts).
  const userIds = Array.isArray(body.userOpenIds) && body.userOpenIds.every(x => typeof x === 'string')
    ? (body.userOpenIds as string[])
    : [];
  // Owner union_ids (tenant-stable) to pull bot owners into a federated group.
  const ownerUnionIds = Array.isArray(body.ownerUnionIds) && body.ownerUnionIds.every(x => typeof x === 'string')
    ? (body.ownerUnionIds as string[])
    : [];
  const transferOwnerUnionId = typeof body.transferOwnerUnionId === 'string' && body.transferOwnerUnionId.trim()
    ? body.transferOwnerUnionId.trim()
    : null;
  if (body.transferOwnerUnionId !== undefined
    && (!transferOwnerUnionId || !transferOwnerUnionId.startsWith('on_') || !ownerUnionIds.includes(transferOwnerUnionId))) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_transfer_owner_union_id' });
  }
  const transferTo = typeof body.transferOwnerTo === 'string' && body.transferOwnerTo.trim()
    ? body.transferOwnerTo.trim()
    : null;
  const notifyTo = typeof body.notifyOwnerOpenId === 'string' && body.notifyOwnerOpenId.trim()
    ? body.notifyOwnerOpenId.trim()
    : null;
  const roleProfileId = typeof body.roleProfileId === 'string' && body.roleProfileId.trim()
    ? body.roleProfileId.trim()
    : null;
  if (roleProfileId && !isValidRoleProfileId(roleProfileId)) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  }
  const bindWorkingDir = typeof body.bindWorkingDir === 'string' ? body.bindWorkingDir.trim() : '';
  let bindResolvedPath: string | undefined;
  if (bindWorkingDir) {
    const v = validateWorkingDir(bindWorkingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    bindResolvedPath = v.resolvedPath;
  }
  try {
    const r = await createGroupWithBots({
      creatorLarkAppId: cachedLarkAppId,
      larkAppIds: body.larkAppIds as string[],
      name,
      userOpenIds: userIds,
      ownerUnionIds,
      transferOwnerUnionId: transferOwnerUnionId ?? undefined,
      transferOwnerTo: transferTo ?? undefined,
      notifyOwnerOpenId: notifyTo ?? undefined,
      bindWorkingDir: bindWorkingDir || undefined,
      roleProfileId: roleProfileId ?? undefined,
    });
    jsonRes(res, 200, bindResolvedPath ? { ...r, bindResolvedPath } : r);
  } catch (e) {
    jsonRes(res, 502, { ok: false, error: String((e as Error).message ?? e) });
  }
});

// Complete a deferred team-group owner transfer after another deployment has
// added the operator to the chat. The caller sends union_id so no app-scoped
// open_id crosses the dashboard/daemon or federation boundary.
ipcRoute('POST', '/api/groups/transfer-owner', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { chatId?: unknown; ownerUnionId?: unknown };
  try {
    body = await readJsonBody<{ chatId?: string; ownerUnionId?: string }>(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  const ownerUnionId = typeof body.ownerUnionId === 'string' ? body.ownerUnionId.trim() : '';
  if (!chatId.startsWith('oc_') || !ownerUnionId.startsWith('on_')) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_owner_transfer' });
  }

  const transferred = await transferGroupOwner({
    creatorLarkAppId: cachedLarkAppId,
    chatId,
    ownerId: ownerUnionId,
    ownerIdType: 'union_id',
  });
  let notifyMessageId: string | null = null;
  let notifyError: string | null = null;
  if (transferred.ownerTransferredTo) {
    try {
      // Feishu accepts union_id in an @ tag; keeping it stable avoids a second
      // app-scope lookup after the owner was added by another deployment.
      notifyMessageId = await sendMessage(
        cachedLarkAppId,
        chatId,
        `<at user_id="${ownerUnionId}"></at>`,
        'text',
      );
    } catch (e: any) {
      notifyError = e?.message ?? String(e);
    }
  }
  return jsonRes(res, 200, {
    ok: true,
    ...transferred,
    notifyMessageId,
    notifyError,
  });
});

// ─── SSE event stream ──────────────────────────────────────────────────────

ipcRoute('GET', '/api/events', (_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
  });
  // Initial flush so the client sees the connection alive immediately.
  res.write('retry: 5000\n\n');

  const off = dashboardEventBus.subscribe(ev => {
    const body = 'sequence' in ev
      ? {
          ...ev.body,
          projectionEpoch: ev.projectionEpoch,
          sequence: ev.sequence,
        }
      : ev.body;
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(body)}\n\n`);
  });

  const hb = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 15_000);

  res.on('close', () => { off(); clearInterval(hb); });
});

export function startIpcServer(opts: {
  port: number;
  host: string;
  /** Enable the production trusted-host boundary. The verifier reloads the
   * tiny secret file for each request so concurrent fleet bootstrap or a
   * deliberate secret repair cannot strand a daemon on a stale cached key.
   * Tests that omit this option retain the lightweight in-process server. */
  authRequired?: boolean;
  /** Daemon restore barrier.  The socket/health route may come up early so its
   * descriptor is discoverable, but every state-bearing route waits until all
   * durable session owners have been registered. */
  ready?: Promise<void>;
  /** Upward-probe span on EADDRINUSE. Default DEFAULT_PROBE_SPAN (fleet daemons
   * step to the next free port so a port race can't crash boot). Core-only
   * (single in-sandbox service) sets 0 to BIND-OR-FAIL on the exact requested
   * port — riff's task-runner is told a fixed port and must not have the service
   * silently drift to another one. */
  maxProbe?: number;
  /** Core-only: additionally treat the tight riff-facing route allowlist
   * (routeIsCoreOnlyPublic) as public (no HMAC). Every OTHER route still requires
   * the trusted-host HMAC — this does NOT disable auth wholesale (codex P1). */
  coreOnlyPublicRoutes?: boolean;
}): Promise<IpcServerHandle> {
  let boundPort = opts.port;
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const method = req.method ?? 'GET';
      const coreOnlyPublic = opts.coreOnlyPublicRoutes === true && routeIsCoreOnlyPublic(method, url.pathname);
      const publicRoute = routeHasPublicAccess(method, url.pathname) || coreOnlyPublic;
      // Readiness barrier (codex P1): the core-only public control routes
      // (trigger / trigger-result / insight) must NOT enter their handlers until
      // restore completes — a trigger during 'starting' races durable restore.
      // Gate them at the server level so it doesn't depend on the caller probing
      // /healthz first. /healthz itself reports 503 via its own handler.
      if (coreOnlyPublic && coreOnlyNotReady()) {
        return jsonRes(res, 503, { ok: false, status: 'starting', error: 'core-only service is still restoring; retry after /healthz returns 200' });
      }
      const capabilityRoute = routeHasNarrowUntrustedAuth(method, url.pathname);
      if (opts.authRequired && !publicRoute) {
        const secret = ipcAuthSecret();
        const auth = secret
          ? trustedHostAuthorized(req, url.pathname, boundPort, secret)
          : { ok: false as const, reason: 'secret_unavailable' };
        if (auth.ok) {
          trustedHostRequests.add(req);
        } else if (!capabilityRoute) {
          return jsonRes(res, 401, { ok: false, error: 'unauthorized', reason: auth.reason });
        }
      }
      const runtimeStatusProbe = method === 'GET' && url.pathname === '/api/runtime-status';
      if (!publicRoute && opts.ready && !runtimeStatusProbe) await opts.ready;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        await r.handler(req, res, params);
        return;
      }
      jsonRes(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      logger.error('[dashboard-ipc] handler error', err);
      if (!res.headersSent) jsonRes(res, 500, { error: String(err) });
    }
  });
  // Probe upward on EADDRINUSE instead of a single fixed bind: a second botmux
  // instance resolving the same IPC port (BOTMUX_DAEMON_IPC_BASE_PORT + idx)
  // would otherwise reject and take the whole daemon down at startup (the caller
  // in daemon.ts awaits this unguarded). The daemon republishes the returned
  // (bound) port into its descriptor so the dashboard still discovers it.
  return listenWithProbe({
    server,
    port: opts.port,
    host: opts.host,
    maxProbe: opts.maxProbe,
    log: (m) => logger.warn(`[dashboard-ipc] ${m}`),
  }).then((port) => {
    boundPort = port;
    return {
    port,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
  });
}
