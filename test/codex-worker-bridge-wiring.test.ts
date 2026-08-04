import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('Codex worker structured-bridge wiring', () => {
  it('reattaches an incorrectly discovered rollout after writeInput verifies the session id', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('// Already attached — first-attach-wins for most CLIs.', start);
    const notify = workerSource.slice(start, end);
    const codexStart = notify.indexOf('if (structuredBridgeIsCodex())');
    const codex = notify.slice(codexStart);

    expect(codexStart).toBeGreaterThanOrEqual(0);
    expect(codex).toContain('codexSessionIdFromRolloutPath(codexBridgeRolloutPath)');
    expect(codex).toContain("resolveFileBridgePath('codex', { sessionId: cliSessionId })");
    expect(codex.indexOf('codexBridgeDetachFile();')).toBeLessThan(codex.indexOf('codexBridgeAttach(next, attachMode);'));
    expect(codex).toContain("lastInitConfig?.adoptMode ? 'split-live' : 'fresh-empty'");
    expect(codex).toContain('codexBridgePendingSessionId = cliSessionId;');
  });
});
