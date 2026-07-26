/**
 * Integration test for riff-codex-runner (topology B): drives the bin's
 * riff-facing NDJSON JSON-RPC protocol against a fake codex app-server that
 * exercises the happy path + a structured interaction (awaiting_input → answer).
 *
 * The fake app-server is spawned as the bin's `codex` (RIFF_CODEX_BIN), speaking
 * the app-server protocol on its stdio, so this validates the full translation:
 *   riff request → bin → codex app-server, and codex events → bin → riff notif.
 *
 * Run:  pnpm vitest run test/riff-codex-runner.integration.test.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const RUNNER = resolve('src/riff-codex-runner.ts');
const live = new Set<ChildProcessWithoutNullStreams>();

/** A minimal fake `codex` that answers `app-server --listen stdio://` over its
 *  own stdin/stdout. `FAKE_MODE=interaction` fires one requestUserInput before
 *  finishing; default just streams an agent message and completes with usage. */
function writeFakeCodex(dir: string): string {
  const path = join(dir, 'fake-codex.mjs');
  writeFileSync(path, `#!/usr/bin/env node
let buf = '';
const mode = process.env.FAKE_MODE ?? 'success';
function send(o){ process.stdout.write(JSON.stringify(o)+'\\n'); }
function notify(method, params){ send({ jsonrpc:'2.0', method, params }); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (c) => {
  buf += c;
  for(;;){
    const nl = buf.indexOf('\\n'); if (nl<0) break;
    const line = buf.slice(0,nl).trim(); buf = buf.slice(nl+1);
    if(!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize'){ send({ jsonrpc:'2.0', id: msg.id, result:{ ok:true } }); continue; }
    if (msg.method === 'initialized') continue;
    if (msg.method === 'thread/start'){ send({ jsonrpc:'2.0', id: msg.id, result:{ thread:{ id:'thr_1' } } }); continue; }
    if (msg.method === 'turn/start'){
      send({ jsonrpc:'2.0', id: msg.id, result:{ turn:{ id:'turn_1' } } });
      notify('turn/started', { threadId:'thr_1', turn:{ id:'turn_1' } });
      if (mode === 'interaction'){
        // Ask the client (bin) for input; wait for its response before finishing.
        const reqId = 9001;
        send({ jsonrpc:'2.0', id: reqId, method:'item/tool/requestUserInput', params:{ prompt:'Which environment?' } });
        // The bin's response for reqId will arrive as a normal client→server
        // message; we detect it below and then finish.
        pendingAnswerId = reqId;
        return;
      }
      notify('item/agentMessage/delta', { threadId:'thr_1', turnId:'turn_1', delta:'Hello', itemId:'i1' });
      notify('item/completed', { threadId:'thr_1', turnId:'turn_1', item:{ type:'agentMessage', phase:'final_answer', text:'Hello world' } });
      notify('turn/completed', { threadId:'thr_1', turn:{ id:'turn_1', status:'completed', usage:{ inputTokens:11, outputTokens:22, cacheReadTokens:3, cacheCreateTokens:4 } } });
      continue;
    }
    // A response from the bin to our requestUserInput → finish the turn.
    if (msg.id === pendingAnswerId && msg.result){
      const ans = msg.result?.answers?.answer ?? '(none)';
      notify('item/completed', { threadId:'thr_1', turnId:'turn_1', item:{ type:'agentMessage', phase:'final_answer', text:'picked: '+ans } });
      notify('turn/completed', { threadId:'thr_1', turn:{ id:'turn_1', status:'completed', usage:{ inputTokens:5, outputTokens:6, cacheReadTokens:0, cacheCreateTokens:0 } } });
      pendingAnswerId = null;
      continue;
    }
  }
});
let pendingAnswerId = null;
`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

interface Harness {
  child: ChildProcessWithoutNullStreams;
  send: (o: unknown) => void;
  lines: () => any[];
  waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any>;
}

function startBin(fakeCodex: string, cwd: string, mode?: string, extraEnv?: Record<string, string>): Harness {
  const child = spawn(process.execPath, ['--import', 'tsx', RUNNER], {
    cwd: resolve('.'),
    env: { ...process.env, RIFF_CODEX_BIN: fakeCodex, ...(mode ? { FAKE_MODE: mode } : {}), ...(extraEnv ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.add(child);
  const parsed: any[] = [];
  let buf = '';
  child.stdout.on('data', c => {
    buf += c.toString('utf8');
    for (;;) {
      const nl = buf.indexOf('\n'); if (nl < 0) break;
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { parsed.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  child.once('exit', () => live.delete(child));
  return {
    child,
    send: o => child.stdin.write(JSON.stringify(o) + '\n'),
    lines: () => parsed,
    waitFor: (pred, ms = 4000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = parsed.find(pred);
        if (hit) { clearInterval(iv); res(hit); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout waiting for ' + pred)); }
      }, 20);
    }),
  };
}

afterEach(() => { for (const c of live) { try { c.kill('SIGKILL'); } catch { /* */ } } live.clear(); });

describe('riff-codex-runner protocol', () => {
  it('run → running status → output → completed with usage; ack is immediate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-runner-'));
    try {
      const fake = writeFakeCodex(dir);
      const h = startBin(fake, dir);
      h.send({ jsonrpc: '2.0', id: 1, method: 'run', params: { prompt: 'hi', cwd: dir } });

      const ack = await h.waitFor(m => m.id === 1 && m.result);
      expect(ack.result.ok).toBe(true);
      await h.waitFor(m => m.method === 'status' && m.params?.state === 'running');
      const completed = await h.waitFor(m => m.method === 'completed');
      expect(completed.params.content).toContain('Hello world');
      expect(completed.params.usage).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 3, cacheCreateTokens: 4 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v1 default: in-turn interaction is auto-skipped → turn completes, no awaiting_input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-runner-skip-'));
    try {
      const fake = writeFakeCodex(dir);
      const h = startBin(fake, dir, 'interaction'); // fake fires requestUserInput
      h.send({ jsonrpc: '2.0', id: 1, method: 'run', params: { prompt: 'deploy', cwd: dir } });
      await h.waitFor(m => m.id === 1 && m.result);
      // Auto-skip: bin answers codex's requestUserInput with {answers:{}}, the fake
      // then completes the turn. We must reach completed, and never see awaiting_input.
      const completed = await h.waitFor(m => m.method === 'completed');
      expect(completed.params.content).toContain('picked:');
      expect(h.lines().some(m => m.method === 'awaiting_input')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v2 opt-in (RIFF_CODEX_INTERACTIVE=1): awaiting_input → answer → resumes → completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-runner-int-'));
    try {
      const fake = writeFakeCodex(dir);
      const h = startBin(fake, dir, 'interaction', { RIFF_CODEX_INTERACTIVE: '1' });
      h.send({ jsonrpc: '2.0', id: 1, method: 'run', params: { prompt: 'deploy', cwd: dir } });
      await h.waitFor(m => m.id === 1 && m.result);
      const ai = await h.waitFor(m => m.method === 'awaiting_input');
      expect(ai.params.kind).toBe('clarification');
      expect(ai.params.question).toContain('environment');
      const interactionId = ai.params.interactionId;
      h.send({ jsonrpc: '2.0', id: 2, method: 'answer', params: { interactionId, text: 'prod' } });
      const ans = await h.waitFor(m => m.id === 2 && m.result);
      expect(ans.result.ok).toBe(true);
      const completed = await h.waitFor(m => m.method === 'completed');
      expect(completed.params.content).toContain('picked: prod');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancel is acked idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-runner-cancel-'));
    try {
      const fake = writeFakeCodex(dir);
      const h = startBin(fake, dir);
      h.send({ jsonrpc: '2.0', id: 7, method: 'cancel', params: {} });
      const ack = await h.waitFor(m => m.id === 7 && m.result);
      expect(ack.result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
