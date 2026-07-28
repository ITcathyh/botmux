#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import type { CodexAppTurnInput } from './types.js';
import {
  buildCodexAppTurnStartParams,
  isCleanInputCapabilityError,
  isCodexAppTurnInput,
  parseCodexVersion,
  type CodexVersion,
} from './adapters/cli/codex-app-turn.js';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';

type JsonObject = Record<string, any>;

interface Args {
  sessionId: string;
  codexBin: string;
  cwd: string;
  threadId?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
  model?: string;
  reasoningEffort?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}

interface ActiveTurn {
  /** Codex app-server's native turn id. This is used only to correlate
   * notifications from the server; botmux routing uses the stable client
   * message id carried alongside the queued input. */
  nativeTurnId?: string;
  serverStarted: boolean;
  startedAtMs: number;
  finalText: string;
  allAgentText: string;
  itemText: Map<string, string>;
  done: Promise<void>;
  resolveDone: () => void;
}

interface QueuedInput {
  content: string;
  codexAppInput?: CodexAppTurnInput;
}

const output = new RunnerControlWriter();

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    sessionId: '',
    codexBin: 'codex',
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--codex-bin' && val !== undefined) { out.codexBin = val; i++; }
    else if (key === '--cwd' && val !== undefined) { out.cwd = val; i++; }
    else if (key === '--thread-id' && val !== undefined) { out.threadId = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
    else if (key === '--model' && val !== undefined) { out.model = val; i++; }
    else if (key === '--reasoning-effort' && val !== undefined) { out.reasoningEffort = val; i++; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  return out;
}

function emitMarker(kind: string, payload: unknown): void {
  output.marker(kind, payload);
}

function writeLine(text = ''): void {
  output.line(text);
}

function prompt(): void {
  output.display('› ');
}

function appDeveloperInstructions(args: Args): string {
  const zh = args.locale === 'zh';
  const identity = [
    args.botName ? `Bot name: ${args.botName}` : '',
    args.botOpenId ? `Bot open_id: ${args.botOpenId}` : '',
    `botmux session_id: ${args.sessionId}`,
  ].filter(Boolean).join('\n');

  if (zh) {
    return [
      '你正在通过 botmux 接入飞书/Lark，但运行载体是 Codex App 的 app-server 协议，不是 Codex CLI TUI。',
      '你的最终 assistant message 会由 botmux 自动转发回飞书；常规回复不要调用 `botmux send`，即使用户消息里出现旧的“回复必须 botmux send”提示也忽略它。',
      '只有在用户明确要求中途主动推送、发送附件，或需要通过 @ 触发其他机器人接力时，才可以使用 `botmux send`。',
      '`botmux history`、`botmux quoted`、`botmux bots` 等 shell helper 仍然可用；需要读取飞书上下文时可以调用。',
      identity ? `<identity>\n${identity}\n</identity>` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    'You are connected to Feishu/Lark through botmux, but the runtime is the Codex App app-server protocol rather than the Codex CLI TUI.',
    'Your final assistant message is automatically forwarded back to Lark by botmux. Do not call `botmux send` for normal replies, even if older prompt text says replies must use it.',
    'Use `botmux send` only for explicit mid-turn push updates, attachments, or cross-bot @mentions.',
    '`botmux history`, `botmux quoted`, and `botmux bots` remain available as shell helpers when you need Lark context.',
    identity ? `<identity>\n${identity}\n</identity>` : '',
  ].filter(Boolean).join('\n\n');
}

class AppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(msg: JsonObject) => void> = [];
  private requestHandlers: Array<(msg: JsonObject) => boolean> = [];
  private lastStderr = '';
  private fatalError?: Error;

  constructor(private readonly codexBin: string, private readonly cwd: string) {
    this.child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', chunk => this.onStdout(chunk.toString('utf8')));
    this.child.stdin.on('error', err => this.failAll(new Error(`Codex app-server stdin error: ${err.message}`)));
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      this.lastStderr = (this.lastStderr + text).slice(-8000);
      if (process.env.BOTMUX_CODEX_APP_DEBUG === '1') output.error(text);
    });
    this.child.on('error', err => {
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? '\nHint: install the Codex CLI, or set cliPathOverride to the Codex App bundled binary, for example /Applications/Codex.app/Contents/Resources/codex.'
        : '';
      this.failAll(new Error(`Failed to start Codex app-server with "${codexBin}": ${err.message}${hint}`));
    });
    this.child.on('exit', (code, signal) => {
      const err = this.fatalError ?? new Error(`Codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`);
      this.failAll(err);
    });
  }

  onNotification(handler: (msg: JsonObject) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (msg: JsonObject) => boolean): void {
    this.requestHandlers.push(handler);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'botmux-codex-app', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(asError(err));
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonObject = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  close(): void {
    try { this.child.kill(); } catch { /* already gone */ }
  }

  private write(msg: JsonObject): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private failAll(err: Error): void {
    this.fatalError = this.fatalError ?? err;
    const fatal = this.fatalError;
    for (const pending of this.pending.values()) pending.reject(fatal);
    this.pending.clear();
  }

  private onStdout(data: string): void {
    this.stdoutBuffer += data;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonObject;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonObject): void {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result);
      return;
    }

    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      for (const handler of this.requestHandlers) {
        if (handler(msg)) return;
      }
      this.respond(msg.id, { decision: 'decline' });
      return;
    }

    if (typeof msg.method === 'string') {
      for (const handler of this.notificationHandlers) handler(msg);
    }
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err: any) {
  output.error(`${err?.message ?? err}\n`);
  process.exit(2);
}

const client = new AppServerClient(args.codexBin, args.cwd);
let threadId = args.threadId;
let threadReady = false;
let activeTurn: ActiveTurn | null = null;
const queue: QueuedInput[] = [];
let inputBuffer = '';
let processing = false;
let cleanInputUnsupported = false;
let codexVersionChecked = false;
let codexVersion: CodexVersion | undefined;
let cleanVersionWarningShown = false;

/** Structured interaction requests (requestUserInput / elicitation) that are
 *  held open awaiting a human/programmatic answer instead of being auto-declined.
 *  Keyed by a botmux-minted interactionId. `finish` maps the answer text to the
 *  codex-app protocol-shaped respond payload and replies to the app-server. */
interface PendingInteraction {
  interactionId: string;
  kind: 'clarification' | 'confirmation' | 'authentication';
  finish: (answerText: string) => void;
}
const pendingInteractions = new Map<string, PendingInteraction>();
let interactionSeq = 0;

/** codex-app's requestUserInput answer schema (Codex 0.145 generated types) is
 *  `{ answers: { [questionId]: { answers: string[] } } }` — a per-question map,
 *  each holding a string array. v1 collapses the single free-text reply (per the
 *  botmux↔riff plain-text contract) into the FIRST question's answers array; a
 *  multi-question schema is logged so it surfaces rather than silently dropping. */
function mapAnswerToRequestUserInput(params: any, answerText: string): { answers: Record<string, { answers: string[] }> } {
  const fieldIds: string[] = Array.isArray(params?.questions)
    ? params.questions.map((q: any) => q?.id).filter((x: any) => typeof x === 'string')
    : [];
  if (fieldIds.length > 1) {
    writeLine(`[codex-app] requestUserInput has ${fieldIds.length} questions; single text answer maps to first (id=${fieldIds[0]})`);
  }
  const key = fieldIds[0] ?? 'answer';
  return { answers: { [key]: { answers: [answerText] } } };
}

/** Best-effort question text from a codex-app interaction request. The exact
 *  param shape varies by codex version; try the common carriers and fall back
 *  to the caller's default. */
function extractInteractionQuestion(params: any): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const candidates = [
    params.message,
    params.prompt,
    params.question,
    Array.isArray(params.questions) ? params.questions[0]?.prompt ?? params.questions[0]?.question ?? params.questions[0]?.label : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}

function extractInteractionDetails(params: any): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const d = params.details ?? params.description ?? params.context;
  return typeof d === 'string' && d.trim() ? d.trim() : undefined;
}

/** Map an elicitation carrying OAuth/login links into the riff authChallenge
 *  shape. Returns undefined when no link-bearing structure is present (→ the
 *  interaction is treated as a plain clarification). */
function extractAuthChallenge(params: any): { links: { url: string; label?: string }[]; userCode?: string; instructions?: string; expiresAt?: string } | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const rawLinks = params.links ?? params.authLinks ?? (params.url ? [{ url: params.url }] : undefined);
  if (!Array.isArray(rawLinks)) return undefined;
  const links = rawLinks
    .map((l: any) => (typeof l === 'string' ? { url: l } : (l && typeof l.url === 'string' ? { url: l.url, label: typeof l.label === 'string' ? l.label : undefined } : undefined)))
    .filter((l: any): l is { url: string; label?: string } => !!l);
  if (!links.length) return undefined;
  return {
    links,
    userCode: typeof params.userCode === 'string' ? params.userCode : undefined,
    instructions: typeof params.instructions === 'string' ? params.instructions : undefined,
    expiresAt: typeof params.expiresAt === 'string' ? params.expiresAt : undefined,
  };
}

/** Register a held interaction and emit the awaiting_input marker to the worker
 *  (→ daemon → trigger-result). turnId is the runner's active botmux turn so the
 *  caller can correlate its answer. */
function beginInteraction(input: {
  kind: 'clarification' | 'confirmation' | 'authentication';
  question: string;
  details?: string;
  authChallenge?: { links: { url: string; label?: string }[]; userCode?: string; instructions?: string; expiresAt?: string };
  finish: (answerText: string) => void;
}): void {
  const interactionId = `cai_${args.sessionId}_${++interactionSeq}`;
  pendingInteractions.set(interactionId, { interactionId, kind: input.kind, finish: input.finish });
  emitMarker('awaiting_input', {
    interactionId,
    turnId: activeTurn?.nativeTurnId ?? undefined,
    kind: input.kind,
    question: input.question,
    ...(input.details ? { details: input.details } : {}),
    ...(input.authChallenge ? { authChallenge: input.authChallenge } : {}),
  });
}

/** Resolve a held interaction with answer text (from the runner input channel).
 *  Unknown/stale ids are ignored (the turn may have moved on). */
function answerInteraction(interactionId: string, text: string): void {
  const pending = pendingInteractions.get(interactionId);
  if (!pending) {
    writeLine(`[codex-app] answer for unknown interaction ${interactionId} (ignored)`);
    return;
  }
  pendingInteractions.delete(interactionId);
  try {
    pending.finish(text);
  } catch (err: any) {
    writeLine(`[codex-app] failed to deliver interaction answer: ${err?.message ?? err}`);
  }
}

function detectedCodexVersion(): CodexVersion | undefined {
  if (codexVersionChecked) return codexVersion;
  codexVersionChecked = true;
  try {
    const result = spawnSync(args.codexBin, ['--version'], {
      cwd: args.cwd,
      env: process.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    codexVersion = parseCodexVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } catch {
    codexVersion = undefined;
  }
  return codexVersion;
}

function makeTurn(): ActiveTurn {
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  return {
    startedAtMs: Date.now(),
    serverStarted: false,
    finalText: '',
    allAgentText: '',
    itemText: new Map(),
    done,
    resolveDone,
  };
}

function handleServerRequest(msg: JsonObject): boolean {
  const method = msg.method;
  if (method === 'item/commandExecution/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/fileChange/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/permissions/requestApproval') {
    client.respond(msg.id, { permissions: {}, scope: 'turn' });
    return true;
  }
  if (method === 'item/tool/requestUserInput') {
    // Structured clarification: hold the request open and surface it as an
    // awaiting_input interaction. The answer text arrives later via the runner
    // input channel and is mapped back to codex-app's keyed `answers` shape.
    const params: any = msg.params ?? {};
    const question = extractInteractionQuestion(params)
      ?? 'The agent needs additional input to continue.';
    const details = extractInteractionDetails(params);
    beginInteraction({
      kind: 'clarification',
      question,
      details,
      finish: (text) => client.respond(msg.id, mapAnswerToRequestUserInput(params, text)),
    });
    return true;
  }
  if (method === 'mcpServer/elicitation/request') {
    const params: any = msg.params ?? {};
    const question = extractInteractionQuestion(params)
      ?? (typeof params.message === 'string' ? params.message : 'The agent is requesting input.');
    const authChallenge = extractAuthChallenge(params);
    beginInteraction({
      kind: authChallenge ? 'authentication' : 'clarification',
      question,
      details: extractInteractionDetails(params),
      authChallenge,
      // v1: any answered text = accept + single-field content; cancel is only
      // used on timeout/no-answer (handled daemon-side, not here).
      finish: (text) => client.respond(msg.id, { action: 'accept', content: { answer: text }, _meta: null }),
    });
    return true;
  }
  if (method === 'item/tool/call') {
    client.respond(msg.id, { contentItems: [], success: false });
    return true;
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    client.respond(msg.id, { decision: 'approved_for_session' });
    return true;
  }
  return false;
}

function handleNotification(msg: JsonObject): void {
  const params = msg.params ?? {};
  if (!activeTurn || params.threadId !== threadId) return;
  if (activeTurn.nativeTurnId && params.turnId && params.turnId !== activeTurn.nativeTurnId) return;

  if (msg.method === 'turn/started') {
    activeTurn.serverStarted = true;
    activeTurn.nativeTurnId = params.turn?.id ?? params.turnId ?? activeTurn.nativeTurnId;
    return;
  }

  if (msg.method === 'item/started') {
    const item = params.item;
    if (item?.type === 'commandExecution') {
      writeLine(`\n$ ${item.command}`);
    } else if (item?.type === 'fileChange') {
      writeLine('\n[files changed]');
    }
    return;
  }

  if (msg.method === 'item/agentMessage/delta') {
    const delta = String(params.delta ?? '');
    const itemId = String(params.itemId ?? '');
    activeTurn.itemText.set(itemId, (activeTurn.itemText.get(itemId) ?? '') + delta);
    activeTurn.allAgentText += delta;
    output.display(delta);
    return;
  }

  if (msg.method === 'item/commandExecution/outputDelta' || msg.method === 'item/fileChange/outputDelta') {
    output.display(String(params.delta ?? ''));
    return;
  }

  if (msg.method === 'item/completed') {
    const item = params.item;
    if (item?.type === 'agentMessage') {
      if (item.phase === 'final_answer') activeTurn.finalText = String(item.text ?? '');
      else if (!activeTurn.itemText.has(item.id) && item.text) {
        activeTurn.allAgentText += String(item.text);
      }
    }
    return;
  }

  if (msg.method === 'turn/completed') {
    const turn = params.turn;
    if (turn?.id && activeTurn.nativeTurnId && turn.id !== activeTurn.nativeTurnId) return;
    if (turn?.error?.message && !activeTurn.finalText) {
      activeTurn.finalText = `Codex App turn failed: ${turn.error.message}`;
    }
    activeTurn.resolveDone();
  }
}

async function ensureThread(): Promise<string> {
  if (threadReady && threadId) return threadId;

  if (threadId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId,
        cwd: args.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        config: { shell_environment_policy: { inherit: 'all' } },
        developerInstructions: appDeveloperInstructions(args),
        excludeTurns: true,
        // Keep Codex App's rich history in sync with turns created by this
        // external runner so the desktop UI can render follow-up messages.
        persistExtendedHistory: true,
      });
      const resumedThreadId = String(resumed.thread.id);
      threadId = resumedThreadId;
      threadReady = true;
      emitMarker('thread', { threadId: resumedThreadId });
      return resumedThreadId;
    } catch (err: any) {
      writeLine(`[codex-app] resume failed, starting a fresh thread: ${err?.message ?? err}`);
      threadId = undefined;
      threadReady = false;
    }
  }

  const started = await client.request('thread/start', {
    cwd: args.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: {
      shell_environment_policy: { inherit: 'all' },
      // model_reasoning_effort is a codex config key (no top-level thread field).
      // 'xhigh' collapses to codex's max 'high'.
      ...(args.reasoningEffort ? { model_reasoning_effort: args.reasoningEffort === 'xhigh' ? 'high' : args.reasoningEffort } : {}),
    },
    // Per-turn model override → thread-level model (app-server's documented spot).
    ...(args.model && args.model.trim() ? { model: args.model.trim() } : {}),
    serviceName: 'botmux',
    developerInstructions: appDeveloperInstructions(args),
    ephemeral: false,
    experimentalRawEvents: false,
    // Keep Codex App's rich history in sync with turns created by this
    // external runner so the desktop UI can render follow-up messages.
    persistExtendedHistory: true,
  });
  const startedThreadId = String(started.thread.id);
  threadId = startedThreadId;
  threadReady = true;
  emitMarker('thread', { threadId: startedThreadId });
  try {
    await client.request('thread/name/set', {
      threadId: startedThreadId,
      name: `botmux ${args.sessionId.slice(0, 8)}`,
    });
  } catch { /* naming is cosmetic */ }
  return startedThreadId;
}

async function runTurn(message: QueuedInput): Promise<void> {
  const tid = await ensureThread();
  const turn = makeTurn();
  activeTurn = turn;
  const version = message.codexAppInput ? detectedCodexVersion() : undefined;
  let built = buildCodexAppTurnStartParams({
    threadId: tid,
    cwd: args.cwd,
    legacyContent: message.content,
    codexAppInput: message.codexAppInput,
    codexVersion: version,
    structuredDisabled: cleanInputUnsupported,
  });
  if (message.codexAppInput && !built.structured && !cleanInputUnsupported && !cleanVersionWarningShown) {
    cleanVersionWarningShown = true;
    const found = version ? `${version.major}.${version.minor}.${version.patch}` : 'unknown';
    writeLine(`[codex-app] clean input requires codex >= 0.135.0 (found ${found}); using legacy prompt`);
  }
  for (const path of built.skippedImages) {
    writeLine(`[codex-app] skipped unreadable local image: ${path}`);
  }
  writeLine();
  writeLine('[user]');
  writeLine(built.structured && message.codexAppInput ? message.codexAppInput.text : message.content);
  writeLine();

  let result;
  try {
    result = await client.request('turn/start', built.params);
  } catch (err) {
    if (!built.structured || turn.serverStarted || !isCleanInputCapabilityError(err)) throw err;
    // The app-server explicitly rejected the experimental field before a turn
    // started. Disable structured input for this runner lifetime and retry the
    // preserved legacy prompt exactly once.
    cleanInputUnsupported = true;
    writeLine('[codex-app] clean input unsupported by app-server; retrying this turn with the legacy prompt');
    built = buildCodexAppTurnStartParams({
      threadId: tid,
      cwd: args.cwd,
      legacyContent: message.content,
      codexAppInput: message.codexAppInput,
      codexVersion: version,
      structuredDisabled: true,
    });
    result = await client.request('turn/start', built.params);
  }
  turn.nativeTurnId = result.turn?.id ?? turn.nativeTurnId;
  await turn.done;

  const finalText = (turn.finalText || turn.allAgentText).trim();
  const completedAtMs = Date.now();
  if (finalText) {
    // clientUserMessageId is the daemon-frozen botmux/Lark turn identity. The
    // app-server generates a different id for the same logical turn; exposing
    // that native id as `turnId` breaks daemon wait maps, VC suppression and
    // reply routing. When no structured sidecar exists, omit turnId so the
    // worker deliberately falls back to its current botmux turn attribution.
    const stableTurnId = message.codexAppInput?.clientUserMessageId;
    emitMarker('final', {
      ...(stableTurnId ? { turnId: stableTurnId } : {}),
      ...(turn.nativeTurnId ? { nativeTurnId: turn.nativeTurnId } : {}),
      content: finalText,
      startedAtMs: turn.startedAtMs,
      completedAtMs,
    });
  }
  writeLine();
  activeTurn = null;
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        await runTurn(next);
      } catch (err: any) {
        const message = `Codex App runner error: ${err?.message ?? err}`;
        const completedAtMs = Date.now();
        const stableTurnId = next.codexAppInput?.clientUserMessageId;
        const nativeTurnId = activeTurn?.nativeTurnId;
        writeLine(message);
        emitMarker('final', {
          ...(stableTurnId ? { turnId: stableTurnId } : {}),
          ...(nativeTurnId ? { nativeTurnId } : {}),
          content: message,
          startedAtMs: activeTurn?.startedAtMs ?? completedAtMs,
          completedAtMs,
        });
        activeTurn = null;
      }
      prompt();
    }
  } finally {
    processing = false;
  }
}

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('::botmux-codex-app:')) {
    const encoded = trimmed.slice('::botmux-codex-app:'.length);
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.type === 'answer' && typeof decoded.interactionId === 'string') {
        // Programmatic/human answer to a held structured interaction — resolve
        // the codex-app request rather than enqueue a new turn.
        answerInteraction(decoded.interactionId, typeof decoded.text === 'string' ? decoded.text : '');
        return;
      }
      if (decoded?.type === 'message' && typeof decoded.content === 'string') {
        const codexAppInput = isCodexAppTurnInput(decoded.codexAppInput)
          ? decoded.codexAppInput
          : undefined;
        if (decoded.codexAppInput !== undefined && !codexAppInput) {
          writeLine('[codex-app] ignored invalid structured input sidecar');
        }
        queue.push({ content: decoded.content, codexAppInput });
        void drainQueue();
      }
    } catch (err: any) {
      writeLine(`[codex-app] bad botmux input: ${err?.message ?? err}`);
    }
    return;
  }
  queue.push({ content: line });
  void drainQueue();
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    if (ch === '\u0003') {
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (ch === '\u007f' || ch === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  client.onRequest(handleServerRequest);
  client.onNotification(handleNotification);
  await client.initialize();
  await ensureThread();
  writeLine('Codex App connected.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  prompt();
}

process.on('SIGTERM', () => {
  client.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  client.close();
  process.exit(130);
});

main().catch(err => {
  output.error(`${err?.stack ?? err?.message ?? err}\n`);
  process.exit(1);
});
