/**
 * Integration test for riff-cli-runner (topology B, thin strategy A): drives the
 * runner's riff-facing NDJSON JSON-RPC protocol against a FAKE worker.js that
 * speaks the botmux WorkerToDaemon IPC protocol. Validates the full translation
 * riff ⇄ runner ⇄ worker without needing a real claude-code CLI.
 *
 * Run:  pnpm vitest run test/riff-cli-runner.integration.test.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const RUNNER = resolve('src/riff-cli-runner.ts');
const live = new Set<ChildProcessWithoutNullStreams>();

/** A fake worker.js: reads init/message over IPC (process.send/on) and emits the
 *  WorkerToDaemon messages the runner consumes. FAKE_WORKER_MODE tweaks behavior. */
function writeFakeWorker(dir: string): string {
  const path = join(dir, 'fake-worker.mjs');
  writeFileSync(path, `#!/usr/bin/env node
const mode = process.env.FAKE_WORKER_MODE ?? 'ok';
process.on('message', (msg) => {
  if (msg.type === 'init') {
    // Record whether this is a resume so the test can assert follow-up wiring.
    const resume = !!msg.resume;
    // Announce ready + composer up.
    process.send({ type: 'ready', port: 0, token: 't' });
    process.send({ type: 'prompt_ready' });
    // The runner will now send a { type:'message', content, turnId }.
    // (handled below)
    globalThis.__resume = resume;
    globalThis.__cliSessionId = msg.cliSessionId || ('cs_' + msg.sessionId.slice(0,8));
  }
  if (msg.type === 'message') {
    // Emit the persisted CLI session id, then stream output + final_output.
    process.send({ type: 'cli_session_id', cliSessionId: globalThis.__cliSessionId });
    if (mode === 'fail') {
      process.send({ type: 'error', message: 'boom' });
      return;
    }
    const answer = globalThis.__resume ? ('resumed: ' + msg.content) : ('did: ' + msg.content);
    process.send({ type: 'final_output', sessionId: msg.sessionId, content: answer, turnId: msg.turnId });
  }
  if (msg.type === 'close') { process.exit(0); }
});
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

function startRunner(fakeWorker: string, cwd: string, mode?: string): Harness {
  const child = spawn(process.execPath, ['--import', 'tsx', RUNNER], {
    cwd: resolve('.'),
    env: { ...process.env, RIFF_WORKER_PATH: fakeWorker, ...(mode ? { FAKE_WORKER_MODE: mode } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.add(child);
  const parsed: any[] = [];
  let buf = '';
  child.stdout.on('data', c => {
    buf += c.toString('utf8');
    for (;;) { const nl = buf.indexOf('\n'); if (nl < 0) break; const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; try { parsed.push(JSON.parse(line)); } catch { /* */ } }
  });
  child.once('exit', () => live.delete(child));
  return {
    child,
    send: o => child.stdin.write(JSON.stringify(o) + '\n'),
    lines: () => parsed,
    waitFor: (pred, ms = 4000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => { const hit = parsed.find(pred); if (hit) { clearInterval(iv); res(hit); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); } }, 20);
    }),
  };
}

afterEach(() => { for (const c of live) { try { c.kill('SIGKILL'); } catch { /* */ } } live.clear(); });

describe('riff-cli-runner protocol (headless PTY runner)', () => {
  it('run(claude-code) → running → completed{content,sessionId}; ack is immediate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-cli-'));
    try {
      const fake = writeFakeWorker(dir);
      const h = startRunner(fake, dir);
      h.send({ jsonrpc: '2.0', id: 1, method: 'run', params: { cliId: 'claude-code', cwd: dir, prompt: 'hello' } });
      const ack = await h.waitFor(m => m.id === 1 && m.result);
      expect(ack.result.ok).toBe(true);
      expect(ack.result.sessionId).toBeTruthy();
      await h.waitFor(m => m.method === 'status' && m.params?.state === 'running');
      const completed = await h.waitFor(m => m.method === 'completed');
      expect(completed.params.content).toBe('did: hello');
      expect(completed.params.sessionId).toBeTruthy(); // resume key echoed back
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('follow-up run{sessionId} resumes the prior session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-cli-resume-'));
    try {
      const fake = writeFakeWorker(dir);
      // First turn to obtain a sessionId.
      const h1 = startRunner(fake, dir);
      h1.send({ jsonrpc: '2.0', id: 1, method: 'run', params: { cliId: 'claude-code', cwd: dir, prompt: 'first' } });
      const c1 = await h1.waitFor(m => m.method === 'completed');
      const sid = c1.params.sessionId;
      expect(sid).toBeTruthy();
      h1.child.kill();
      // Follow-up in a fresh process with sessionId → resume path.
      const h2 = startRunner(fake, dir);
      h2.send({ jsonrpc: '2.0', id: 2, method: 'run', params: { cliId: 'claude-code', cwd: dir, prompt: 'answer', sessionId: sid } });
      await h2.waitFor(m => m.id === 2 && m.result);
      const c2 = await h2.waitFor(m => m.method === 'completed');
      expect(c2.params.content).toBe('resumed: answer'); // fake keys off init.resume
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('worker error → failed notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-cli-fail-'));
    try {
      const fake = writeFakeWorker(dir);
      const h = startRunner(fake, dir, 'fail');
      h.send({ jsonrpc: '2.0', id: 1, method: 'run', params: { cliId: 'claude-code', cwd: dir, prompt: 'x' } });
      await h.waitFor(m => m.id === 1 && m.result);
      const failed = await h.waitFor(m => m.method === 'failed');
      expect(failed.params.errorCode).toBe('worker_error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects run without cliId; cancel is acked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-cli-val-'));
    try {
      const fake = writeFakeWorker(dir);
      const h = startRunner(fake, dir);
      h.send({ jsonrpc: '2.0', id: 1, method: 'run', params: { cwd: dir, prompt: 'x' } });
      const err = await h.waitFor(m => m.id === 1 && m.error);
      expect(err.error.code).toBe(-32602);
      h.send({ jsonrpc: '2.0', id: 2, method: 'cancel', params: {} });
      const ack = await h.waitFor(m => m.id === 2 && m.result);
      expect(ack.result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
