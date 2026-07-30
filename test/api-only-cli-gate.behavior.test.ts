import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * BEHAVIORAL zero-touch test for the root-dispatch transport gate (codex round-10
 * requirement — not a source-lock). Spawns the REAL built CLI (dist/cli.js) as a
 * subprocess with a managed no-transport turn env and asserts every Lark-facing
 * command exits 2 BEFORE doing any work (so it never dials Feishu). Also asserts
 * the negative controls: a managed real-chat turn and a bare host-operator shell
 * are NOT transport-gated.
 *
 * Runs the compiled artifact, so `pnpm build` must have run. If dist is absent
 * the suite skips rather than failing spuriously in a source-only checkout.
 */
const CLI = resolve('dist/cli.js');
const LARK_FACING = ['send', 'dispatch', 'create-group', 'history', 'quoted', 'bots', 'grant', 'react'];

/** Run the CLI with a controlled env; return {code, out}. Never throws on non-zero. */
function runCli(args: string[], env: Record<string, string | undefined>): { code: number; out: string } {
  // Strip inherited BOTMUX_* (this test process may itself be daemon-spawned),
  // then apply only the explicit env for the scenario under test.
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('BOTMUX_') && v !== undefined) base[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k]; else base[k] = v;
  }
  try {
    const out = execFileSync('node', [CLI, ...args], { env: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const distReady = existsSync(CLI);
const d = distReady ? describe : describe.skip;

d('root-dispatch transport gate — behavioral (built CLI subprocess)', () => {
  beforeAll(() => {
    if (!distReady) console.warn('[skip] dist/cli.js not built — run pnpm build');
  });

  it('managed HTTP virtual turn: every Lark-facing command exits 2 with the transport message', () => {
    for (const cmd of LARK_FACING) {
      const { code, out } = runCli([cmd], {
        BOTMUX_SESSION_ID: 'sess_virtual',
        BOTMUX_CHAT_ID: 'http_async_zerocall',
        BOTMUX_LARK_APP_ID: 'cli_test',
      });
      expect(code, `${cmd} exit code`).toBe(2);
      expect(out, `${cmd} message`).toMatch(/unavailable|no Feishu chat|HTTP control-API/);
    }
  });

  it('negative control: managed turn in a REAL chat is NOT transport-gated', () => {
    // history in a real chat will fail for other reasons (no live session/creds
    // in this test), but it must NOT be refused by the transport gate.
    const { out } = runCli(['history'], {
      BOTMUX_SESSION_ID: 'sess_real',
      BOTMUX_CHAT_ID: 'oc_real_chat_123',
      BOTMUX_LARK_APP_ID: 'cli_test',
    });
    expect(out).not.toMatch(/HTTP control-API session|core-only \(apiOnly\)/);
  });

  it('negative control: bare host-operator shell (no managed marker) is NOT root-gated', () => {
    // No BOTMUX_SESSION_ID → not a managed turn. Even with a virtual-looking
    // chatId env, the ROOT gate must not fire (operator keeps access). It may
    // still exit non-zero for lack of a resolvable session — that is not our gate.
    const { out } = runCli(['create-group', '--bot', 'x'], {
      BOTMUX_SESSION_ID: undefined,
      BOTMUX_CHAT_ID: undefined,
      BOTMUX_LARK_APP_ID: undefined,
    });
    expect(out).not.toMatch(/managed turn runs in an HTTP control-API/);
  });
});
