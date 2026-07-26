#!/usr/bin/env node
/**
 * riff-codex-runner — a self-contained codex control bin for embedding inside
 * riff's in-sandbox task-runner (topology B).
 *
 * It spawns `codex app-server --listen stdio://`, drives one thread over the
 * app-server JSON-RPC protocol, and exposes a clean line-delimited (NDJSON)
 * JSON-RPC protocol to its OWN stdin/stdout for riff to control it:
 *
 *   riff → bin  (JSON-RPC request, has id — bin replies response(result|error)):
 *     run    { prompt, model?, reasoningEffort?, cwd, threadId?, codexHome? }
 *     answer { interactionId, text }
 *     cancel {}
 *   bin → riff  (JSON-RPC notification, no id; NDJSON, route by method):
 *     status         { state: 'running' }
 *     awaiting_input { interactionId, kind, question, details?, authChallenge? }
 *     output         { content }                         // incremental agent text
 *     completed      { content, usage? }                 // terminal
 *     failed         { errorCode, error }                // terminal
 *
 * ACK semantics (locked with riff): `run`'s response(result) means only "the
 * turn was accepted/started", NOT the final result — it is returned as soon as
 * the turn is dispatched, so a long turn never hangs the request. The terminal
 * outcome always arrives later as a `completed` / `failed` notification.
 *
 * MODEL-ROUTING INVARIANT (load-bearing — do not break):
 *   codex's model provider / base_url / bridge token / trust_level all come from
 *   riff's ~/.codex/config.toml, written into the sandbox by riff. This bin:
 *     - does NOT set CODEX_HOME (unless run.codexHome is explicitly given), so
 *       codex reads the default ~/.codex/config.toml;
 *     - does NOT pass -c model_provider / base_url / model_providers / any token;
 *     - only selects the model (thread/start config.model) and reasoning effort
 *       (thread/start config.model_reasoning_effort).
 *   i.e. the bin decides WHAT model/effort to drive codex with; WHERE codex
 *   connects and WHO gets billed is 100% riff's config.toml. It also does NOT set
 *   shell_environment_policy (codex default) — matching riff's codex_app_server
 *   adapter, keeping the sandbox env surface identical to riff's own path.
 *
 * Zero botmux-daemon / Feishu / bot-registry dependencies by design: only Node
 * built-ins + a tiny inlined JSON-RPC client.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

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

// ─── codex app-server JSON-RPC client (over the child's stdio) ───────────────

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

interface PendingInteraction {
  interactionId: string;
  /** The app-server JSON-RPC request id we must respond to when answered. */
  rpcId: number;
  method: string; // originating app-server method (drives how `answer` maps back)
}

class CodexAppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private fatal?: Error;

  constructor(codexBin: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', c => this.onStdout(c.toString('utf8')));
    this.child.stderr.on('data', () => { /* codex diagnostics; swallow */ });
    this.child.on('error', err => this.failAll(new Error(`codex spawn failed: ${err.message}`)));
    this.child.on('exit', (code, signal) => {
      this.failAll(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
    });
  }

  /** Server→client requests (approvals + interactions) are dispatched here. */
  onServerRequest?: (msg: Json) => void;
  /** Server→client notifications (turn/item lifecycle) are dispatched here. */
  onNotification?: (msg: Json) => void;

  request(method: string, params: unknown): Promise<any> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  respond(id: number, result: unknown): void { this.write({ jsonrpc: '2.0', id, result }); }
  notify(method: string, params?: unknown): void {
    const m: Json = { jsonrpc: '2.0', method };
    if (params !== undefined) m.params = params;
    this.write(m);
  }
  kill(): void { try { this.child.kill(); } catch { /* gone */ } }

  private write(msg: Json): void {
    if (this.fatal) throw this.fatal;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  private failAll(err: Error): void {
    this.fatal ??= err;
    for (const p of this.pending.values()) p.reject(this.fatal);
    this.pending.clear();
  }
  private onStdout(data: string): void {
    this.buffer += data;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { continue; }
      this.dispatch(msg);
    }
  }
  private dispatch(msg: Json): void {
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error?.message ?? 'app-server error'));
      else p.resolve(msg.result);
      return;
    }
    // Server→client request (has id + method) — approvals / interactions.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.onServerRequest?.(msg);
      return;
    }
    // Notification (method, no id).
    if (typeof msg.method === 'string') this.onNotification?.(msg);
  }
}

// ─── Interaction mapping (codex app-server request → riff awaiting_input) ─────

/** Map an app-server server→client request method to a riff interaction kind,
 *  or null when the request is NOT a human-facing interaction (approvals, which
 *  we auto-accept to match riff's trusted-project behavior). */
function interactionKindFor(method: string): 'clarification' | 'confirmation' | 'authentication' | null {
  switch (method) {
    case 'item/tool/requestUserInput': return 'clarification';
    case 'mcpServer/elicitation/request': return 'confirmation';
    default: return null; // approvals / permissions / tool-call: auto-handled
  }
}

/** The fixed auto-response for approval-style requests — trusted project, never
 *  bother the user (matches riff's own codex path + botmux's daemon runners). */
function autoApprovalResult(method: string): unknown | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'acceptForSession' };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'item/tool/call':
      return { contentItems: [], success: false };
    default:
      return undefined;
  }
}

/** Build the codex-app respond payload for an answered interaction. `text` is
 *  riff's free-text answer (the whole answer model is text — locked with riff). */
function interactionRespondPayload(method: string, text: string): unknown {
  if (method === 'item/tool/requestUserInput') {
    // answers is a keyed map; with a single free-text answer we key it under a
    // conventional field. codex tolerates a single-entry map for its prompt.
    return { answers: { answer: text } };
  }
  // elicitation: a text answer means "accept, with this content".
  return { action: 'accept', content: { answer: text }, _meta: null };
}

/** v1 auto-skip payload for an in-turn interaction: tell codex "no answer /
 *  cancel this ask" so the turn proceeds to completion without blocking. Matches
 *  the original auto-response shape the app-server expects per method. */
function interactionSkipResult(method: string): unknown {
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  // elicitation
  return { action: 'cancel', content: null, _meta: null };
}

// ─── Turn state ──────────────────────────────────────────────────────────────

interface TurnState {
  agentText: string;
  finalText: string;
  nativeTurnId?: string;
  done: boolean;
}

let server: CodexAppServer | undefined;
let threadId: string | undefined;
let turn: TurnState | undefined;
let interactionSeq = 0;
const pendingInteractions = new Map<string, PendingInteraction>();

function resetInteractions(): void {
  pendingInteractions.clear();
}

/** Best-effort token usage from a turn/completed payload. Shapes vary across
 *  codex versions, so probe a few known locations; absent → undefined. */
function extractUsage(turnObj: Json | undefined): Json | undefined {
  const u = turnObj?.usage ?? turnObj?.tokenUsage ?? turnObj?.tokens;
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u.inputTokens ?? u.input_tokens ?? u.input),
    outputTokens: n(u.outputTokens ?? u.output_tokens ?? u.output),
    cacheReadTokens: n(u.cacheReadTokens ?? u.cache_read_tokens ?? u.cachedInputTokens ?? u.cache_read),
    cacheCreateTokens: n(u.cacheCreateTokens ?? u.cache_creation_tokens ?? u.cache_create),
  };
}

function handleServerRequest(msg: Json): void {
  const method = String(msg.method);
  const kind = interactionKindFor(method);
  if (!kind) {
    const auto = autoApprovalResult(method);
    if (auto !== undefined) server?.respond(msg.id, auto);
    return;
  }
  // In-turn interaction (requestUserInput / elicitation).
  //
  // v1 (default): AUTO-SKIP. codex's requestUserInput/elicitation are turn-scoped
  // blocking JSON-RPC requests — the only faithful answer is a same-turn respond,
  // which would force the turn (and this bin + codex process) to hang waiting for
  // a human, defeating riff's turn-ending model and sandbox recoverability. riff's
  // own codex path (codex_app_server, trusted project) never uses this path either
  // — its clarifications are turn-ending (the model emits the question as its final
  // message and the turn completes). So we skip the in-turn request (turn keeps
  // running to completion) and let clarifications surface the turn-ending way.
  //
  // v2 (opt-in, RIFF_CODEX_INTERACTIVE=1): surface `awaiting_input` and HOLD the
  // request id open for a cross-boundary `answer`. Kept wired but off by default;
  // enabling it also needs the suspended-turn + recovery design on riff's side.
  if (process.env.RIFF_CODEX_INTERACTIVE !== '1') {
    const skip = interactionSkipResult(method);
    if (skip !== undefined) server?.respond(msg.id, skip);
    return;
  }
  // Human-facing interaction: surface it to riff and HOLD the app-server request
  // id open until `answer` resolves it (or the turn dies).
  const params = msg.params ?? {};
  const interactionId = `int_${++interactionSeq}`;
  pendingInteractions.set(interactionId, { interactionId, rpcId: msg.id, method });
  const question = String(
    params.prompt ?? params.message ?? params.question ?? params.title ?? 'The agent needs your input.',
  );
  const details = typeof params.details === 'string' ? params.details : undefined;
  emit('awaiting_input', { interactionId, kind, ...(question ? { question } : {}), ...(details ? { details } : {}) });
}

function handleNotification(msg: Json): void {
  if (!turn) return;
  const params = msg.params ?? {};
  switch (msg.method) {
    case 'turn/started':
      turn.nativeTurnId = params.turn?.id ?? params.turnId ?? turn.nativeTurnId;
      return;
    case 'item/agentMessage/delta': {
      const delta = String(params.delta ?? '');
      turn.agentText += delta;
      if (delta) emit('output', { content: delta });
      return;
    }
    case 'item/completed': {
      const item = params.item;
      if (item?.type === 'agentMessage' && item.phase === 'final_answer') {
        turn.finalText = String(item.text ?? '');
      }
      return;
    }
    case 'turn/completed': {
      const t = params.turn;
      if (t?.error?.message && !turn.finalText) {
        finishTurn({ ok: false, errorCode: 'turn_failed', error: String(t.error.message) });
        return;
      }
      finishTurn({ ok: true, content: (turn.finalText || turn.agentText).trim(), usage: extractUsage(t) });
      return;
    }
    case 'turn/failed': {
      finishTurn({ ok: false, errorCode: 'turn_failed', error: String(params.error?.message ?? 'turn failed') });
      return;
    }
  }
}

function finishTurn(outcome: { ok: true; content: string; usage?: Json } | { ok: false; errorCode: string; error: string }): void {
  if (!turn || turn.done) return;
  turn.done = true;
  resetInteractions();
  if (outcome.ok) emit('completed', { content: outcome.content, ...(outcome.usage ? { usage: outcome.usage } : {}) });
  else emit('failed', { errorCode: outcome.errorCode, error: outcome.error });
  turn = undefined;
}

// ─── codex thread bootstrap ──────────────────────────────────────────────────

function threadConfig(model?: string, effort?: ReasoningEffort): Json {
  // INVARIANT: only model + reasoning effort. Never provider/base_url/token, and
  // NOT shell_environment_policy (codex default) — see file header.
  const cfg: Json = {};
  if (model && model.trim()) cfg.model = model.trim();
  if (effort) cfg.model_reasoning_effort = effort;
  return cfg;
}

async function ensureThread(cwd: string, model?: string, effort?: ReasoningEffort, resumeThreadId?: string): Promise<string> {
  if (threadId) return threadId;
  const s = server!;
  if (resumeThreadId) {
    try {
      const r = await s.request('thread/resume', {
        threadId: resumeThreadId, cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
        config: threadConfig(model, effort), excludeTurns: true, persistExtendedHistory: true,
      });
      threadId = String(r.thread.id);
      return threadId;
    } catch { /* fall through to fresh */ }
  }
  const started = await s.request('thread/start', {
    cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
    config: threadConfig(model, effort), serviceName: 'riff-codex-runner',
    ephemeral: false, persistExtendedHistory: true,
  });
  threadId = String(started.thread.id);
  return threadId;
}

// ─── riff-facing request handlers (stdin, JSON-RPC requests with id) ─────────

interface RunParams {
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  cwd: string;
  threadId?: string;
  codexHome?: string;
}

async function handleRun(id: number | string, p: RunParams): Promise<void> {
  if (!p || typeof p.prompt !== 'string' || !p.prompt.trim()) {
    return replyError(id, -32602, 'run requires a non-empty prompt');
  }
  if (!p.cwd || typeof p.cwd !== 'string') {
    return replyError(id, -32602, 'run requires cwd');
  }
  if (turn && !turn.done) {
    return replyError(id, -32000, 'a turn is already in flight');
  }
  // Boot the app-server lazily on first run. Env: inherit ours, only override
  // CODEX_HOME when explicitly asked (default → codex reads ~/.codex/config.toml).
  if (!server) {
    const codexBin = process.env.RIFF_CODEX_BIN || 'codex';
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (p.codexHome) env.CODEX_HOME = p.codexHome;
    server = new CodexAppServer(codexBin, p.cwd, env);
    server.onServerRequest = handleServerRequest;
    server.onNotification = handleNotification;
    try {
      await server.request('initialize', { clientInfo: { name: 'riff-codex-runner', version: '0.0.0' }, capabilities: {} });
      server.notify('initialized');
    } catch (err: any) {
      server = undefined;
      return replyError(id, -32001, `codex initialize failed: ${err?.message ?? err}`);
    }
  }
  try {
    const tid = await ensureThread(p.cwd, p.model, p.reasoningEffort, p.threadId);
    turn = { agentText: '', finalText: '', done: false };
    // Dispatch the turn but DO NOT await its completion — ack now, results later.
    server.request('turn/start', { threadId: tid, input: { text: p.prompt } })
      .then(r => { if (turn) turn.nativeTurnId = r?.turn?.id ?? turn.nativeTurnId; })
      .catch(err => finishTurn({ ok: false, errorCode: 'turn_start_failed', error: String(err?.message ?? err) }));
    // ACK: the turn is accepted/started. Terminal outcome arrives via completed/failed.
    reply(id, { ok: true, threadId: tid });
    emit('status', { state: 'running' });
  } catch (err: any) {
    turn = undefined;
    replyError(id, -32002, `turn start failed: ${err?.message ?? err}`);
  }
}

function handleAnswer(id: number | string, p: { interactionId?: string; text?: string }): void {
  const interactionId = p?.interactionId;
  const text = typeof p?.text === 'string' ? p.text : '';
  if (!interactionId) return replyError(id, -32602, 'answer requires interactionId');
  const pend = pendingInteractions.get(interactionId);
  if (!pend) return replyError(id, -32003, 'interaction is no longer pending');
  pendingInteractions.delete(interactionId);
  try {
    server?.respond(pend.rpcId, interactionRespondPayload(pend.method, text));
    reply(id, { ok: true });
    // The turn resumes on its own; re-announce running for the poller's benefit.
    if (turn && !turn.done) emit('status', { state: 'running' });
  } catch (err: any) {
    replyError(id, -32004, `answer injection failed: ${err?.message ?? err}`);
  }
}

function handleCancel(id: number | string): void {
  // Idempotent: always ack. If a turn is live, tear the app-server down (kills
  // the turn); a fresh run re-boots it.
  const wasLive = !!(turn && !turn.done);
  if (wasLive) finishTurn({ ok: false, errorCode: 'cancelled', error: 'cancelled by caller' });
  try { server?.kill(); } catch { /* gone */ }
  server = undefined;
  threadId = undefined;
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
    if (id === undefined || typeof method !== 'string') continue; // riff→bin is always a request
    switch (method) {
      case 'run': void handleRun(id, params ?? {}); break;
      case 'answer': handleAnswer(id, params ?? {}); break;
      case 'cancel': handleCancel(id); break;
      default: replyError(id, -32601, `unknown method: ${method}`);
    }
  }
});
process.stdin.on('end', () => { try { server?.kill(); } catch { /* gone */ } process.exit(0); });


