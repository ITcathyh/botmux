#!/usr/bin/env node
/**
 * riff-cli-runner — a headless, registration-free botmux runner for PTY-class
 * CLIs (claude-code / gemini / cursor …) embedded inside riff's sandbox
 * (topology B, thin strategy A).
 *
 * It reuses botmux's proven daemon-free worker-fork primitive (the same one v3
 * `goal run` uses): fork `worker.js`, send an `init` with an INLINE PROFILE
 * (cliId / cwd / model + placeholder Lark identity — NO bots.json, NO bot
 * registration), drive one turn, capture the worker's `final_output`, and speak
 * a clean line-delimited (NDJSON) JSON-RPC protocol to its OWN stdin/stdout for
 * riff — the SAME shape as riff-codex-runner, so riff drives both with one
 * adapter + one channel codec:
 *
 *   riff → bin  (JSON-RPC request, has id — bin replies response(result|error)):
 *     run    { cliId, cwd, prompt, model?, sessionId?, codexHome? }
 *     cancel {}
 *   bin → riff  (JSON-RPC notification, no id; NDJSON, route by method):
 *     status    { state: 'running' }
 *     output    { content }                              // incremental agent text
 *     completed { content, sessionId, usage? }           // terminal; sessionId = resume key
 *     failed    { errorCode, error }                     // terminal
 *
 * `run.sessionId` resumes a prior turn's session (cross-process, via the CLI's
 * on-disk transcript + `--resume`), mirroring codex's threadId. `completed`
 * echoes the `sessionId` so the caller can resume for a follow-up.
 *
 * REGISTRATION-FREE / NO-FEISHU: the worker forks with BOTMUX_WORKFLOW=1 (chat
 * cards / screen analyzer / session-store writes suppressed) and a placeholder
 * larkAppId/larkAppSecret. Those never reach riff and never make a Lark network
 * call on the CLI-driving path — capture is via the CLI's own transcript files.
 *
 * v1 lifecycle: one task per process (spawn → run → stream → exit). Follow-up =
 * a fresh process with run.sessionId. No long-lived daemon, no port, no cleanup.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = Record<string, any>;

// ─── Outbound NDJSON to riff (stdout) ────────────────────────────────────────

function emit(method: string, params: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
function reply(id: number | string, result: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id: number | string, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// ─── Helpers (inlined from workflows/shared/worker-process to stay standalone) ─

function syntheticSessionUuid(rawId: string): string {
  const hash = createHash('sha256').update(rawId).digest('hex');
  const version = `4${hash.slice(13, 16)}`;
  const variantNibble = ((parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  const variant = `${variantNibble}${hash.slice(17, 20)}`;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${version}-${variant}-${hash.slice(20, 32)}`;
}
function expandWorkingDir(dir: string): string {
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2));
  return dir;
}
/** Resolve worker.js next to this compiled file (dist/worker.js). Overridable
 *  via RIFF_WORKER_PATH for tests / non-standard layouts. */
function resolveWorkerPath(): string {
  if (process.env.RIFF_WORKER_PATH) return process.env.RIFF_WORKER_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'worker.js');
}

// Placeholder Lark identity — headless, never used for a network call, never
// surfaced to riff. A stable-but-fake app id keeps per-session scoping happy.
const PLACEHOLDER_LARK_APP_ID = 'riff-headless';
const PLACEHOLDER_LARK_SECRET = 'riff-headless-no-secret';

// ─── Turn state ──────────────────────────────────────────────────────────────

interface RunState {
  worker: ChildProcess;
  sessionId: string;
  turnId: string;
  cliSessionId?: string;
  agentText: string;
  ready: boolean;
  promptReady: boolean;
  dispatched: boolean;
  done: boolean;
  prompt: string;
  webTerminal: boolean;
  webTerminalEmitted: boolean;
}

let current: RunState | undefined;

function finish(outcome: { ok: true; content: string; usage?: Json } | { ok: false; errorCode: string; error: string }): void {
  if (!current || current.done) return;
  current.done = true;
  if (outcome.ok) {
    emit('completed', {
      content: outcome.content,
      sessionId: current.cliSessionId ?? current.sessionId,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    });
  } else {
    emit('failed', { errorCode: outcome.errorCode, error: outcome.error });
  }
  try { current.worker.send({ type: 'close' } as never); } catch { /* gone */ }
  const w = current.worker;
  current = undefined;
  // Give the worker a moment to close its CLI cleanly, then hard-kill.
  setTimeout(() => { try { if (w.exitCode === null) w.kill('SIGKILL'); } catch { /* */ } }, 1500);
}

/** Dispatch the actual turn once the worker is ready + composer is up. */
function maybeDispatch(): void {
  if (!current || current.dispatched || !current.ready || !current.promptReady) return;
  current.dispatched = true;
  emit('status', { state: 'running' });
  try {
    current.worker.send({ type: 'message', content: current.prompt, turnId: current.turnId } as never);
  } catch (err: any) {
    finish({ ok: false, errorCode: 'dispatch_failed', error: String(err?.message ?? err) });
  }
}

function onWorkerMessage(msg: Json): void {
  if (!current || current.done) return;
  switch (msg.type) {
    case 'ready':
      current.ready = true;
      // Emit the web-terminal URL as soon as the worker's HTTP server is up
      // (not waiting for completed) so the caller can open it live. The worker
      // returns the ACTUAL listening port; read access needs the viewToken.
      if (current.webTerminal && !current.webTerminalEmitted && typeof msg.port === 'number' && msg.port > 0) {
        current.webTerminalEmitted = true;
        const vt = typeof msg.viewToken === 'string' ? msg.viewToken : undefined;
        const url = `http://127.0.0.1:${msg.port}/${vt ? `?viewToken=${encodeURIComponent(vt)}` : ''}`;
        emit('web_terminal', { url, port: msg.port });
      }
      maybeDispatch();
      return;
    case 'prompt_ready':
      current.promptReady = true;
      maybeDispatch();
      return;
    case 'cli_session_id':
      if (typeof msg.cliSessionId === 'string') current.cliSessionId = msg.cliSessionId;
      return;
    case 'final_output':
      finish({ ok: true, content: String(msg.content ?? ''), usage: extractUsage(msg) });
      return;
    case 'error':
      finish({ ok: false, errorCode: 'worker_error', error: String(msg.message ?? 'worker error') });
      return;
    case 'claude_exit':
      // CLI exited; if we hadn't captured output this is a failure.
      finish({ ok: false, errorCode: 'cli_exited', error: `CLI exited (code=${msg.code ?? '?'}, signal=${msg.signal ?? '-'})` });
      return;
  }
}

/** final_output currently has no usage; a follow-up reads it from the transcript
 *  on the daemon side. For the headless runner we surface usage when the worker
 *  provides it inline (future-compatible), else omit. */
function extractUsage(msg: Json): Json | undefined {
  const u = msg.usage;
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cacheReadTokens: n(u.cacheReadTokens),
    cacheCreateTokens: n(u.cacheCreateTokens),
  };
}

// ─── run / cancel handlers ───────────────────────────────────────────────────

interface RunParams {
  cliId: string;
  cwd: string;
  prompt: string;
  model?: string;
  sessionId?: string;
  codexHome?: string;
  webTerminal?: boolean;
}

function handleRun(id: number | string, p: RunParams): void {
  if (!p || typeof p.cliId !== 'string' || !p.cliId) return replyError(id, -32602, 'run requires cliId');
  if (typeof p.prompt !== 'string' || !p.prompt.trim()) return replyError(id, -32602, 'run requires a non-empty prompt');
  if (!p.cwd || typeof p.cwd !== 'string') return replyError(id, -32602, 'run requires cwd');
  if (current && !current.done) return replyError(id, -32000, 'a turn is already in flight');

  const cwd = expandWorkingDir(p.cwd);
  // Resume a prior session (follow-up) or start fresh. sessionId is the botmux
  // session identity; when resuming we pass it as both the session id and the
  // CLI-native resume id (the worker's --resume path reloads from disk).
  const resume = !!p.sessionId;
  const sessionId = p.sessionId || syntheticSessionUuid(`riff-${Date.now()}-${Math.round(process.hrtime()[1])}`);
  const turnId = `trn_${sessionId}_${resume ? 'f' : '0'}`;
  const webTerminal = p.webTerminal === true;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BOTMUX_WORKFLOW: '1', // suppress chat cards / screen analyzer / session-store writes
    ...(p.codexHome ? { CODEX_HOME: p.codexHome } : {}),
    // Sandbox-internal only: confine the worker's web terminal to loopback so it
    // is reachable from the sandbox's own browser (VNC) but never exposed.
    ...(webTerminal ? { BOTMUX_WORKER_HTTP_HOST: '127.0.0.1' } : {}),
  };

  let worker: ChildProcess;
  try {
    // execArgv: [] so the forked worker never inherits the parent's loader flags
    // (e.g. `--import tsx` in dev, or `--input-type`) — those break loading a
    // plain worker.js child. The worker is plain compiled JS.
    worker = fork(resolveWorkerPath(), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd, env, execArgv: [] });
  } catch (err: any) {
    return replyError(id, -32001, `worker spawn failed: ${err?.message ?? err}`);
  }

  current = {
    worker, sessionId, turnId,
    cliSessionId: resume ? p.sessionId : undefined,
    agentText: '', ready: false, promptReady: false, dispatched: false, done: false,
    prompt: p.prompt,
    webTerminal, webTerminalEmitted: false,
  };

  worker.on('message', (m: unknown) => onWorkerMessage(m as Json));
  worker.on('error', err => finish({ ok: false, errorCode: 'worker_error', error: String(err?.message ?? err) }));
  worker.on('exit', () => { if (current && !current.done) finish({ ok: false, errorCode: 'worker_exited', error: 'worker exited before final output' }); });
  // Worker stderr is diagnostic; forward to our stderr only under a debug flag
  // (never to stdout — stdout is the riff NDJSON channel).
  if (process.env.RIFF_CLI_RUNNER_DEBUG === '1') worker.stderr?.on('data', d => process.stderr.write(`[worker] ${d}`));

  const init: Json = {
    type: 'init',
    sessionId,
    chatId: `riff-${sessionId}`,
    rootMessageId: `riff-root-${sessionId}`,
    workingDir: cwd,
    cliId: p.cliId,
    ...(p.model ? { model: p.model } : {}),
    disableCliBypass: false,
    backendType: 'pty',
    // webPort:0 → worker picks a free port and returns the actual one in `ready`.
    // Only set when a web terminal is requested (else the worker skips its HTTP
    // server / uses its own default).
    ...(webTerminal ? { webPort: 0 } : {}),
    prompt: '',
    resume,
    ...(resume ? { cliSessionId: p.sessionId, originalSessionId: p.sessionId } : {}),
    larkAppId: PLACEHOLDER_LARK_APP_ID,
    larkAppSecret: PLACEHOLDER_LARK_SECRET,
    locale: 'zh',
  };
  try {
    worker.send(init as never);
  } catch (err: any) {
    finish({ ok: false, errorCode: 'init_failed', error: String(err?.message ?? err) });
    return replyError(id, -32002, `init send failed: ${err?.message ?? err}`);
  }
  // ACK: turn accepted/started. Terminal outcome arrives via completed/failed.
  reply(id, { ok: true, sessionId });
}

function handleCancel(id: number | string): void {
  const wasLive = !!(current && !current.done);
  if (wasLive) finish({ ok: false, errorCode: 'cancelled', error: 'cancelled by caller' });
  reply(id, { ok: true, cancelled: wasLive });
}

// ─── stdin NDJSON request loop ───────────────────────────────────────────────

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdinBuffer += chunk;
  for (;;) {
    const nl = stdinBuffer.indexOf('\n');
    if (nl < 0) break;
    const line = stdinBuffer.slice(0, nl).trim();
    stdinBuffer = stdinBuffer.slice(nl + 1);
    if (!line) continue;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (id === undefined || typeof method !== 'string') continue;
    switch (method) {
      case 'run': handleRun(id, params ?? {}); break;
      case 'cancel': handleCancel(id); break;
      default: replyError(id, -32601, `unknown method: ${method}`);
    }
  }
});
process.stdin.on('end', () => { try { current?.worker.kill('SIGKILL'); } catch { /* */ } process.exit(0); });
