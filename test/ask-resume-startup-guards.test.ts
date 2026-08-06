import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Source-guard tests for two ask-resume behaviours that live inside large
 * closures (daemon.ts's `/api/asks` handler; cli.ts's `postAsk`) and can't be
 * unit-tested without booting the whole daemon / doing real daemon discovery.
 * The runtime contract they enforce IS unit-tested elsewhere:
 *   - the retry gate honouring `retryable`     → test/cmd-hook.test.ts
 *   - requestId/originKind parsing             → test/ask-api.test.ts
 *   - persistence / handoff / re-attach        → test/ask-resume-restart.test.ts
 * These assertions pin the two remaining seams so they can't be silently
 * removed (codex P1-2/P1-3 startup-503 + typed classifier).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8');

describe('daemon /api/asks startup readiness (codex P1-2)', () => {
  const daemon = read('src/daemon.ts');

  it('returns a RETRYABLE 503 startup_not_ready for an unknown session before restore completes', () => {
    // The guard must sit before the 403 origin_unproven authorization so a
    // reconnecting hook that races restoreActiveSessions gets 503 (retryable),
    // not a permanent 403 → passthrough → stuck native picker.
    expect(daemon).toMatch(/!askSession\s*&&\s*!sessionsRestored[\s\S]*?503[\s\S]*?startup_not_ready/);
  });

  it('flips sessionsRestored=true only AFTER restoreActiveSessions()', () => {
    const restoreIdx = daemon.indexOf('await restoreActiveSessions(activeSessions)');
    const flipIdx = daemon.indexOf('sessionsRestored = true');
    expect(restoreIdx).toBeGreaterThan(0);
    expect(flipIdx).toBeGreaterThan(restoreIdx); // set after, not before
  });
});

describe('postAsk error classification (codex P1-3)', () => {
  const cli = read('src/cli.ts');
  // Isolate the postAsk function body.
  const start = cli.indexOf('async function postAsk(');
  const body = cli.slice(start, start + 3000);

  it('only 502/503/504 HTTP responses are marked retryable (deterministic 4xx are not)', () => {
    expect(body).toMatch(/res\.status === 502 \|\| res\.status === 503 \|\| res\.status === 504/);
  });

  it('non-JSON daemon response is NOT retryable (retry cannot fix a malformed body)', () => {
    expect(body).toMatch(/返回非 JSON[\s\S]*?false/);
  });

  it('no-daemon and transport failures ARE retryable (restart-in-progress)', () => {
    // Both the "找不到 daemon" and "无法连接 daemon" throws pass retryable=true.
    expect(body).toMatch(/找不到 daemon[\s\S]*?true/);
    expect(body).toMatch(/无法连接 daemon[\s\S]*?true/);
  });
});
